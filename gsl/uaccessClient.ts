
import { EventEmitter } from 'events'
import { Socket } from 'net'

import { SAL } from './sal'

const RX_TAB_NL = /[\t\n]/

const EVENT_READY  = 'ready'
	, EVENT_GAMES  = 'games'
	, EVENT_CHARS  = 'chars'
	, EVENT_LAUNCH = 'launch'
	, EVENT_ERROR = 'error'
	, EVENT_PROBLEM = 'problem'
	, EVENT_CLOSE = 'close'
	, EVENT_END = 'end'

const STATUS_NEW = 0
    , STATUS_CONNECTING = 1
    , STATUS_READY = 2
    , STATUS_CLOSED = 3
    , STATUS_ERROR = -1

const ERROR_NORECORD = 'NORECORD'
	, ERROR_PASSWORD = 'PASSWORD'
	, ERROR_UNKNOWN = '?'

export interface GameOption {
    code: string, name: string, access: string | null,
    production: boolean, development: boolean,
		storm: boolean, trial: boolean,
		[index: string]: any
}

export interface GameFilter {
	development?: boolean, [index: string]: any
}

export interface CharacterOption {
    code: string, name: string, [index: string]: any
}

export interface LoginDetails {
    account: string,
    game: string,
    character: string,
    mode: string,
    label: string
}

export interface GameOptionCollection { [index: string]: GameOption }
export interface CharacterOptionCollection { [index: string]: CharacterOption }

export class UAccessClient extends EventEmitter {

    private debug: boolean
    private console: { log (...args: any): void }

    private socket: Socket

    private status: number

    private hash: Buffer
    private port: number
    private host: string

    private account: string
    private key: string
    private owner: string

    private gameCodes: Array<string>
    private games: GameOptionCollection
    private selectedGame: GameOption
    private selectedGameCode: string

    private characterCodes: Array<string>
    private characters: CharacterOptionCollection
    private characterCount: number
    private characterSlots: number

    private selectedCharacterCode: string
    private selectedCharacter: CharacterOption
    private loginDetails: LoginDetails
    private connectionDetails: SAL

	constructor (options: any) {
		super()

        this.debug    = options.debug || false
        this.console  = options.console || { log () {} }
        this.socket   = new Socket ()
        this.status   = STATUS_NEW
		this.hash     = Buffer.alloc(0)
		this.port     = 7900
		this.host     = 'uaccess.play.net'
		this.account  = ''
		this.key      = ''
        this.owner    = ''
        
		this.gameCodes             = []
		this.games                 = {}
		this.selectedGame          = {} as GameOption
		this.selectedGameCode      = ''
		this.characterCodes        = []
		this.characters            = {}
		this.characterCount        = 0
		this.characterSlots        = 0
		this.selectedCharacterCode = ''
        this.selectedCharacter     = {} as CharacterOption        
        this.loginDetails          = {} as LoginDetails
		this.connectionDetails     = {} as SAL
	}

	close () {
        if (this.status !== STATUS_CLOSED) {
            this.socket.end()
            this.socket.destroy()
            this.status = STATUS_CLOSED
        }
	}

	connect () {
        if (this.status === STATUS_NEW) {
            if (this.debug) {
                this.socket.on('data', data => this.console.log("UAccess:socket:data", JSON.stringify(data.toString('ascii'))))
            }
            this.socket.on('error', (err) => {
                if (this.debug) { this.console.log('UAccess:socket:error', err) }
                this.emit(EVENT_ERROR, err)
                this.close()
            })
            this.socket.on('end', () => {
                if (this.debug) { this.console.log('UAccess:socket:end') }
                this.emit(EVENT_END)
                this.close()
            })
            this.socket.on('close', (errored) => {
                if (this.debug) { this.console.log('UAccess:socket:close', errored ? '(with error)' : '(ok)')}
                this.emit(EVENT_CLOSE)
            })
            this.socket.once('data', data => { this.hash = data; this.status = STATUS_READY; this.emit(EVENT_READY) })
            this.socket.connect(this.port, this.host, () => { this.socket.write('K\n') })
            this.status = STATUS_CONNECTING
            if (this.debug) { this.console.log('UAccess#connect : connecting to', this.host, 'on port', this.port)}
        } else {
            this.emit(EVENT_ERROR, new Error ("UAccessClient status must be new to connect."))
        }
	}

	authorize (account: string, password: string) {
        if (this.status == STATUS_READY) {
            let hashedp = this.hashPassword(password)
            this.socket.once('data', data => this.a11n_response(data))
            this.socket.write('A\t')
            this.socket.write(account)
            this.socket.write('\t')
            this.socket.write(hashedp)
            this.socket.write('\n')
        }
        else {
            this.emit(EVENT_ERROR, new Error ("UAccessClient status must be ready to authorize."))
        }
	}

	private hashPassword (password: string) {
        let n, nn, pw = Buffer.from(password), hash = Buffer.alloc(pw.length)
        if (this.hash === null) { return hash }
		for (n = 0, nn = pw.length; n < nn; n++) {
			hash[n] = ((pw[n] - 0x20) ^ this.hash[n]) + 0x20
		}
		return hash
	}

	private a11n_response (data: Buffer) {
		let response = data.toString('ascii')
		let reply = response.split(RX_TAB_NL)
		let [code, account, result, key, owner] = reply
		if (this.debug) { this.console.log("UAccess: A =>", JSON.stringify(reply)) }
		switch (result) {
			case 'KEY':
				break
			case ERROR_NORECORD:
			case ERROR_PASSWORD:
				if (this.debug) { this.console.log("UAccess Error", result, response)}
				this.emit(EVENT_PROBLEM, result, response)
				this.close()
				return
			default:
				if (this.debug) { this.console.log("UAccess unhandled A response: %s", response) }
				this.emit(EVENT_PROBLEM, ERROR_UNKNOWN, response)
				this.close()
				return
		}
		this.account = account
		this.key = key
		this.owner = owner
		this.socket.once('data', data => this.receiveGameList(data))
		this.socket.write('M\n')
	}

	private receiveGameList (data: Buffer) {
		let response = data.toString('ascii')
		let reply = response.split(RX_TAB_NL)
		if (this.debug) { this.console.log("UAccess: M =>", JSON.stringify(reply)) }
		let codes = []
		for (let n = 1; n < reply.length - 1; n += 2) {
			let code = reply[n].trim()
			let name = reply[n + 1].trim()
			this.gameCodes.push(code)
			this.games[code] = { code, name, access: null, storm: false, trial: false, production: false, development: false }
			codes.push(code)
		}
		this.checkGameAccess(codes)
	}

	private checkGameAccess (codes: Array<string>) {
        let code: string = codes.shift() || ''
        if (!code) { return }
		this.socket.once('data', (data) => {
			let response = data.toString('ascii')
			let reply = response.split(RX_TAB_NL)
			let [tmp, access] = reply
			if (this.debug) { this.console.log("UAccess: F =>", JSON.stringify(reply)) }
            let game = this.games[code]
            if (game) { game.access = access.toLowerCase() }
			if (codes.length > 0) { this.checkGameAccess(codes) }
			else { this.emit(EVENT_GAMES, this.games, this.gameCodes) }
		})
		this.socket.write(`F\t${code}\n`)
	}

	selectGame (gameCode: string) {
		this.selectedGameCode = gameCode
		this.socket.once('data', data => this.selectGame_response(data))
		this.socket.write(`G\t${gameCode}\n`)
	}

	private selectGame_response (data: Buffer) {
		let response = data.toString('ascii')
		let reply = response.split(RX_TAB_NL)
		let [code, name, sub] = reply
		if (this.debug) { this.console.log("UAccess: G =>", JSON.stringify(reply)) }
		if (code !== 'G') {
			this.emit(EVENT_PROBLEM, code, response)
			this.close()
			return
		}
		this.socket.once('data', data => this.selectGame_N_response(data))
		this.socket.write(`N\t${this.selectedGameCode}\n`)
	}

	private selectGame_N_response (data: Buffer) {
		let response = data.toString('ascii')
		let reply = response.split(RX_TAB_NL)
		let [code, type] = reply
		if (this.debug) { this.console.log("UAccess: N =>", JSON.stringify(reply)) }
		if (code !== 'N') {
			this.emit(EVENT_PROBLEM, code, response)
			this.close()
			return
        }
		let game = this.selectedGame = this.games[this.selectedGameCode]
		let [env, storm, trial] = type.split('|')
		game.production = (env === 'PRODUCTION')
		game.development = (env === 'DEVELOPMENT')
		game.storm = (storm === 'STORM')
		game.trial = (trial === 'TRIAL')
		this.socket.once('data', data => this.selectGame_C_response(data))
		this.socket.write('C\n')
	}

	private selectGame_C_response (data: Buffer) {
		let response = data.toString('ascii')
		let reply = response.split(RX_TAB_NL)
		let [code, characterCount, characterSlots] = reply
		if (this.debug) { this.console.log("UAccess: C =>", JSON.stringify(reply)) }
		if (code !== 'C') {
			this.emit(EVENT_PROBLEM, code, response)
			this.close()
			return
		}
		this.characterCodes = []
		this.characters = {}
		this.characterCount = Number(characterCount)
		this.characterSlots = Number(characterSlots)
		for (let n = 5, nn = reply.length - 1; n < nn; n += 2) {
			let code = reply[n].trim()
				, name = reply[n + 1].trim()
			this.characters[code] = { code, name }
			this.characterCodes.push(code)
		}
		this.emit(EVENT_CHARS, this.characters, this.characterCodes)
	}

	selectCharacter (code: string, mode: string) {
		if (!(mode == 'play' || mode == 'storm')) { mode = 'play' }
		if (this.selectedGame.storm) { mode = 'storm' }
		this.selectedCharacterCode = code
		this.socket.once('data', (data) => this.selectedCharacter_L_response(data))
		this.socket.write(`L\t${code}\t${mode.toUpperCase()}\n`)
	}

	private selectedCharacter_L_response (data: Buffer) {
		let response = data.toString('ascii')
		let reply = response.split(RX_TAB_NL)
		let [code, status] = reply
		if (this.debug) { this.console.log("UAccess: L =>", JSON.stringify(reply)) }
		if (code !== 'L' || status !== 'OK'){
			this.emit(EVENT_PROBLEM, code, response)
			this.close()
			return
		}
		this.selectedCharacter = this.characters[this.selectedCharacterCode]
		this.connectionDetails = SAL.parseUAccessResponse(reply)
		this.loginDetails = {
			account: this.account,
			game: this.selectedGameCode,
			character: this.selectedCharacterCode,
			mode: this.selectedGame.storm ? 'storm' : 'play',
			label: `${this.selectedCharacter.name} - ${this.selectedGame.name}`
		}
		this.emit(EVENT_LAUNCH, this.connectionDetails, this.loginDetails)
		this.close()
	}

	/* quick login */

	static quickLogin (account: string, password: string, game: string, character: string, mode: string): Promise<SAL> {
		const options = { debug: true, console: this.console }
		return new Promise ((resolve, reject) => {
			const client = new this (options)
			client.once(EVENT_PROBLEM, (code: string) => reject(new Error (`Quick login failed due to ${code}`)))
			client.once(EVENT_ERROR, (error: Error) => reject(error))
			client.once(EVENT_READY, () => client.authorize(account, password))
			client.once(EVENT_GAMES, () => client.selectGame(game))
			client.once(EVENT_CHARS, () => client.selectCharacter(character, mode))
			client.once(EVENT_LAUNCH, (sal: SAL) => resolve(sal))
			client.connect()	
		})
	}

	/* promise api */

	static console: { log: (...args:any) => void }
	static debug: boolean = false

	static login (account: string, password: string, filter?: GameFilter): Promise<GameOptionChoice> {
		function applyFilter (games: GameOptionCollection, filter: GameFilter): GameOptionCollection {
			const newGames: GameOptionCollection = {}
			for (let code in games) {
				const game = games[code]
				let match: boolean = true
				for (let option in filter) {
					const value = filter[option]
					if (value instanceof RegExp) {
						match = match && value.test(game[option])
					} else {
						match = match && (game[option] === filter[option])
					}
					if (!match) { break }
				}
				if (match) { newGames[code] = game }
			}
			return newGames
		}
		return new Promise ((resolve, reject) => {
			const options = { debug: true, console: this.console }
			const client = new this (options)
			client.once(EVENT_CLOSE, () => reject(null))
			client.once(EVENT_PROBLEM, (code) => reject(new UAccessError (code)))
			client.once(EVENT_READY, () => client.authorize(account, password))
			client.once(EVENT_GAMES, (games: GameOptionCollection, codes: Array<string>) => {
				client.removeAllListeners(EVENT_PROBLEM)
				client.removeAllListeners(EVENT_CLOSE)
				if (filter) {
					games = applyFilter(games, filter)
					codes = Object.keys(games)
				}
				resolve(new GameOptionChoice(client, games, codes))
			})
			client.connect()
		})
	}
}

class GameOptionChoice {
	private client: UAccessClient
	private games: GameOptionCollection
	private codes: Array<string>
	constructor (client:UAccessClient, games: GameOptionCollection, codes: Array<string>) {
		this.client = client
		this.games = games
		this.codes = codes
	}
	toNameList (): Array<string> {
		return this.codes.map(code => this.games[code].name)
	}
	cancel() { this.client.close() }
	pick (name: string): string {
		return this.codes.find(code => this.games[code].name === name) || 'unknown'
	}
	select (code: string): Promise<CharacterOptionChoice> {
		return new Promise ((resolve, reject) => {
			this.client.once(EVENT_CLOSE, () => reject(null))
			this.client.once(EVENT_PROBLEM, (code) => reject(new UAccessError (code)))
			this.client.once(EVENT_CHARS, (characters: CharacterOptionCollection, codes: Array<string>) => {
				this.client.removeAllListeners(EVENT_PROBLEM)
				this.client.removeAllListeners(EVENT_CLOSE)
				resolve(new CharacterOptionChoice(this.client, characters, codes))
			})
			this.client.selectGame(code)
		})
	}
}

class CharacterOptionChoice {
	private client: UAccessClient
	private characters: CharacterOptionCollection
	private codes: Array<string>
	constructor (client: UAccessClient, characters: CharacterOptionCollection, codes: Array<string>) {
		this.client = client
		this.characters = characters
		this.codes = codes
	}
	toNameList(): Array<string> {
		return this.codes.map(code => this.characters[code].name)
	}
	cancel() { this.client.close() }
	pick (name: string): string {
		return this.codes.find(code => this.characters[code].name === name) || 'unknown'
	}
	select (code: string, mode?: string): Promise<{ sal: SAL, loginDetails: LoginDetails }> {
		return new Promise ((resolve, reject) => {
			this.client.once(EVENT_CLOSE, () => reject(null))
			this.client.once(EVENT_PROBLEM, (code) => reject(new UAccessError (code)))
			this.client.once(EVENT_LAUNCH, (sal: SAL, loginDetails: LoginDetails) => {
				this.client.removeAllListeners(EVENT_PROBLEM)
				this.client.removeAllListeners(EVENT_CLOSE)
				resolve({ sal, loginDetails })
			})
			this.client.selectCharacter(code, mode ?? 'storm')
		})
	}
}

class UAccessError extends Error {
	code: string;
	constructor (code: string) {
		const errorCodes: any = {
			[ERROR_NORECORD]: "Invalid account name or password.",
			[ERROR_PASSWORD]: "Invalid account name or password.",
			[ERROR_UNKNOWN]: "An unexpected authentication error has occured."
		}
		const message: string = errorCodes[code] || `An unknown error code ${code} has been encountered.`
		super(message)
		this.code = code

	}
}




