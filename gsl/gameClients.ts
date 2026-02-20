import { ServerConnection, ServerConnectionMode } from "./serverConnection";
import { SAL } from "./sal";
import { EventEmitter } from "events";
import * as fs from "fs";
import { WriteStream } from "fs";

export interface GameClientOptions {
    debug?: boolean;
    echo?: boolean;
    console?: { log: (...args: any) => void };
    // quit?: () => void,
    log?: string;
    logging?: boolean;
}

export class BaseGameClient extends EventEmitter {
    protected server?: ServerConnection;

    protected newLine: string;

    private debug: boolean;
    private echo: boolean;

    private log: string;

    private console?: { log: (...args: any) => void };

    private logStream?: WriteStream;

    constructor(options: GameClientOptions) {
        super();

        const { debug, echo, console, log, logging } = options;

        this.debug = debug === undefined ? false : debug;
        this.echo = echo === undefined ? false : echo;

        this.log = log === undefined ? "game-client.log" : log;

        this.console = console;

        this.newLine = "\n";

        if (logging === true) {
            this.logStream = fs.createWriteStream(this.log, { flags: "a" });
        }
    }

    public hasServerConnection(): boolean {
        return Boolean(this.server);
    }

    private initializeServer(options: any) {
        this.server = new ServerConnection(options);
        this.server.on("text", (text) => this.serverText(text));
        this.server.on("error", (error) => this.serverError(error));
        this.server.on("close", () => this.serverClosed());
        this.server.on("mode", (mode) => this.serverMode(mode));
        this.server.on("connect", () => this.serverConnect());
        this.server.connect();
    }

    protected cleanupServer() {
        if (!this.server) return;
        this.server.removeAllListeners("text");
        this.server.removeAllListeners("error");
        this.server.removeAllListeners("close");
        this.server.removeAllListeners("mode");
        this.server.removeAllListeners("connect");
        this.server = undefined;
    }

    protected serverMode(mode: ServerConnectionMode) {}

    protected serverClosed() {
        if (this.console) {
            this.console.log("server socket has closed");
        }
        this.emit("quit");
        this.cleanupServer();
    }

    protected serverError(error: Error) {
        if (this.console) {
            this.console.log("server socket errored", error);
        }
        this.emit("error", error);
        this.cleanupServer();
    }

    protected serverText(text: string) {
        this.logStream?.write(text);
        this.emit("text", text);
    }

    protected serverConnect() {
        if (!this.server) throw new Error("not connected");
        this.server.send("/FE:JAVA /VERSION:1.0 /P:WIN_UNKNOWN\n");
        this.emit("hello");
    }

    connect(sal: SAL) {
        if (this.server) {
            throw new Error("already connected");
        }
        const { gamehost: host, gameport: port, key } = sal;
        const options = {
            host,
            port,
            key,
            console: this.console,
            debug: this.debug,
        };
        this.initializeServer(options);
    }

    quit() {
        if (!this.server) throw new Error("not connected");
        this.server.close("quit");
    }

    send(command: string, echo: boolean = true) {
        if (!this.server) throw new Error("not connected");
        if (echo) {
            this.emit("echo", command);
        }
        this.logStream?.write(command + "\r\n");
        this.server.send(command + this.newLine);
    }

    /** @returns true if logging will be enabled */
    toggleLogging(): boolean {
        if (this.logStream) {
            this.logStream.end();
            this.logStream = undefined;
            return false;
        }
        this.logStream = fs.createWriteStream(this.log, { flags: "a" });
        return true;
    }
}

class WizardGameClient extends BaseGameClient {
    constructor(options: GameClientOptions) {
        super(options);
    }
    protected serverConnect() {
        // this.server.send('/FE:WIZARD /VERSION:1.0.1.22 /P:WIN_UNKNOWN\n')
    }
}

class StormGameClient extends BaseGameClient {
    constructor(options: GameClientOptions) {
        super(options);
    }
    protected serverConnect() {
        // this.server.send('/FE:STORMFRONT /VERSION:1.0.1.26 /P:WIN_UNKNOWN /XML\n')
    }
}
