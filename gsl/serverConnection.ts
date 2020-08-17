
import { EventEmitter } from 'events'
import { Socket } from 'net'

const NO_BUFFERING = 0
const LINE_BUFFERING = 1

const DEFAULT_BUFFER_SIZE = 8192

export enum ServerConnectionMode {
	None, Unbuffered, LineBuffered
}

export enum ServerConnectionState {
	Initialized, Connecting, Connected, Closed, Error
}

export interface ServerConnectionOptions {
	debug?: boolean, console?: { log: (...args: any) => void },
	mode?: ServerConnectionMode,
	key: string, host: string, port: number
}

export class ServerConnection extends EventEmitter {

	private socket: Socket

	private options: any
	
	private debug: boolean
	private console: { log: (...args: any) => void }
	
	private key: string
	private host: string
	private port: number
	
	private connectionMode: ServerConnectionMode
	private gameMode: ServerConnectionMode

	private writeBuffer: string
	private receiveBuffer: string

	// private lineBuffer: Array<string>
	
	private bufferSize: number
	private bufferStart: number
	private bufferLength: number
	private buffer: Buffer
	
	state: ServerConnectionState

	constructor (options: any) {
		super()

		this.state = ServerConnectionState.Initialized

		this.socket = new Socket ()

		this.options = options

		this.debug = (options.debug === true) ? true : false
		this.console = options.console || global.console

		this.key = options.key

		this.host = options.host
		this.port = options.port

		this.connectionMode = ServerConnectionMode.None
		this.gameMode = options.mode ?? ServerConnectionMode.Unbuffered

		this.writeBuffer = ''
		this.receiveBuffer = ''

		// this.lineBuffer = []

		this.bufferSize = DEFAULT_BUFFER_SIZE
		this.bufferStart = 0
		this.bufferLength = 0

		this.buffer = Buffer.alloc(DEFAULT_BUFFER_SIZE)
	}

	/* public api */

	connect () {
		if (this.state !== ServerConnectionState.Initialized) { return }
		if (this.debug === true) { this.console.log('Connection#connect', JSON.stringify(this.options)) }
		if (this.key === null) { throw new Error("Cannot connect with null key.") }

		this.socket.once('connect', () => {
			this.state = ServerConnectionState.Connected
			this.send(this.key)
			this.send('\n')
			this.emit('connect')
		})

		this.socket.on('error', (error: Error) => void this.socketError(error))
		this.socket.on('close', () => void this.socketClose())
		this.socket.on('data', (data: Buffer) => void this.socketData(data))
		this.socket.on('end', () => void this.socketEnd())

		let { host, port } = this, options = { host, port }
		this.socket.connect(options)

		this.state = ServerConnectionState.Connecting
	}

	send (data: string) {
		if (this.debug === true) { this.console.log('Connection#send', JSON.stringify(data)) }
		if (this.state === ServerConnectionState.Connected) {
			if (this.socket.writable === true) {
				if (this.writeBuffer.length > 0) {
					this.socket.write(this.writeBuffer)
					this.writeBuffer = ''
				}
				this.socket.write(data)
			} else {
				this.writeBuffer += data
			}
		} else {
			this.writeBuffer += data
		}
	}

	close (quit?: string) {
		if (this.state === ServerConnectionState.Closed) { return }
		if (typeof quit === 'string') { this.send(quit) }
		if (this.debug === true) { this.console.log('Connection#close') }
		this.socketEnd()
	}

	/* private */

	private bufferText (text: string) {
		this.receiveBuffer += text
	}

	private processBuffer (newLine: string) {
		let eol = this.receiveBuffer.indexOf(newLine, 0), last = newLine.length * -1
		while (eol > -1) {
			let line = this.receiveBuffer.substring(last + newLine.length, eol)
			// this.lineBuffer.push(line)
			this.processLine(line)
			last = eol
			eol = this.receiveBuffer.indexOf(newLine, last + newLine.length)
		}
		if (last > -1) {
			this.receiveBuffer = this.receiveBuffer.substring(last + newLine.length)
		}
	}

	// private processLines () {
	// 	const lines = this.lineBuffer
	// 	while (lines.length > 0) {
	// 		const line = lines.shift()!
	// 		this.processLine(line)
	// 	}
	// }
	
	private processLine (line: string) {
		if (line === '<mode id="GAME"/>') { this.setConnectionMode(this.gameMode) }
		else if (line === '<mode id="CMGR"/>') { this.setConnectionMode(ServerConnectionMode.Unbuffered) }
		else { this.emit('line', line) }
	}

	private setConnectionMode (mode: ServerConnectionMode) {
		if (this.debug === true) { this.console.log('Connection#setConnectionMode()', mode.toString())}
		this.emit('mode', mode)
		this.connectionMode = mode
	}

	/* socket handlers and helpers */

	private socketCleanup() {
		if (this.debug === true) { this.console.log('Connection#socketCleanup()') }
		this.socket.removeAllListeners('error')
		this.socket.removeAllListeners('close')
		this.socket.removeAllListeners('data')
		this.socket.removeAllListeners('end')
	}
	private socketError (error: Error) {
		if (this.debug === true) { this.console.log('Connection#socketError()', error) }
		this.socketCleanup()
		this.socket.destroy()
		this.state = ServerConnectionState.Error
		this.emit('error', error)
	}
	private socketClose () {
		if (this.debug === true) { this.console.log('Connection#socketClose()') }
		this.socketCleanup()
		this.state = ServerConnectionState.Closed
		this.emit('close')
	}
	private socketData (data: Buffer) {
		let text: string = data.toString('ascii')
		if (this.debug === true) { this.console.log('Connection#socketData', JSON.stringify(text)) }
		switch (this.connectionMode) {
			case ServerConnectionMode.None:
				this.bufferText(text)
				this.processBuffer('\n')
				// this.processLines()
				break
			case ServerConnectionMode.LineBuffered:
				this.bufferText(text)
				this.processBuffer('\r\n')
				// this.processLines()
				break
			case ServerConnectionMode.Unbuffered:
				this.emit('text', text)
				break
		}
	}
	private socketEnd () {
		if (this.debug === true) { this.console.log('Connection#socketEnd()') }
		if (this.socket.writable === true) { this.socket.end() }
	}
}
