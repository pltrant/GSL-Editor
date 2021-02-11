import { ServerConnection, ServerConnectionOptions, ServerConnectionMode } from "./serverConnection";
import { SAL } from "./sal";
import { EventEmitter } from "events";
import { maxHeaderSize } from "http";
import * as fs from 'fs';
import { WriteStream } from "fs";

export interface GameClientOptions {
	debug?: boolean, echo?: boolean,
	console?: { log: (...args: any) => void },
	quit?: () => void,
	sal: SAL, log?: string, logging?: boolean
}

const defaultConsole = { log: () => {} }

export class BaseGameClient extends EventEmitter {
	protected server: ServerConnection

	private serverOptions: ServerConnectionOptions

	private newLine: string

	private debug: boolean
	private echo: boolean

	private log: string

	private console?: { log: (...args: any) => void }

	private logStream?: WriteStream

	constructor (options: GameClientOptions) {
		super()

		const { debug, echo, console, log, logging } = options
		const { gamehost: host, gameport: port, key } = options.sal

		this.newLine = '\n'

		this.debug = (debug === undefined ? false : debug)
		this.echo = (echo === undefined ? false : echo)

		this.log = (log === undefined ? 'game-client.log' : log)

		this.console = console

		this.serverOptions = { host, port, key, debug, console }
		this.server = new ServerConnection(this.serverOptions)

		if (logging === true) {
			this.logStream = fs.createWriteStream(this.log, { flags: 'a' })
		}

		this.initializeServer()
	}

	private initializeServer() {
		this.server.on('text', text => this.serverText(text))
		this.server.on('error', error => this.serverError(error))
		this.server.on('close', () => this.serverClosed())
		this.server.on('mode', mode => this.serverMode(mode))
		this.server.on('connect', () => this.serverConnect())
	}

	protected serverConnect() {
		this.server.send('/FE:JAVA /VERSION:1.0 /P:WIN_UNKNOWN\n')
		this.emit('hello')
	}

	protected serverMode(mode: ServerConnectionMode) {
	}

	protected serverClosed() {
		if (this.console) { this.console.log("server socket has closed") }
		this.emit('quit')
	}

	protected serverError(error: Error) {
		if (this.console) { this.console.log("server socket errored", error) }
		this.emit('error', error)
	}

	protected serverText(text: string) {
		this.logStream?.write(text)
		this.emit('text', text)
	}

	connect() {
		this.server.connect()
		return this
	}

	quit() {
		this.server.close('quit')
	}

	send(command: string, echo: boolean = true) {
		if (echo) { this.emit('echo', command) }
		this.logStream?.write(command + '\r\n')
		this.server.send(command + this.newLine)
	}

	toggleLogging() {
		if (this.logStream) {
			this.logStream.end()
			this.logStream = undefined
		} else {
			this.logStream = fs.createWriteStream(this.log, { flags: 'a' })
		}
	}
}

class WizardGameClient extends BaseGameClient {
	constructor(options: GameClientOptions) {
		super(options)
	}
	protected serverConnect() {
		this.server.send('/FE:WIZARD /VERSION:1.0.1.22 /P:WIN_UNKNOWN\n')
	}
}

class StormGameClient extends BaseGameClient {
	constructor(options: GameClientOptions) {
		super(options)
	}
	protected serverConnect() {
		this.server.send('/FE:STORMFRONT /VERSION:1.0.1.26 /P:WIN_UNKNOWN /XML\n')
	}
}
