
import * as path from 'path'

import { BaseGameClient, GameClientOptions } from "./gameClients"
import { EAccessClient } from "./eaccessClient"

/** Output of `/ms` or `/mv`; captured by `modifyScript()` */
export interface ScriptProperties {
    lastModifiedDate: Date,
    name: string,
    desc: string,
    owner: string,
    modifier: string,
    path: string,
    lines: number,
    new: boolean,
    verb?: string,
}

/**
 * Output of `/ss`; captured by `checkScript()`.
 * The value of `owner` may differ from `ScriptProperties.owner`.
 */
export type ShowScriptOutput = Pick<
    ScriptProperties,
    'lastModifiedDate' | 'name' | 'desc' | 'owner' | 'modifier'
>

export interface ScriptCompileResults {
    status: ScriptCompileStatus,
    script: number,
    path: string,
    bytes: number,
    maxBytes: number,
    errors: number,
    warnings: number,
    errorList: Array<ScriptError>,
}

export interface ScriptError { line: number, message: string }

export enum ScriptCompileStatus {
    Unknown, Uploading, Uploaded, Compiling, Compiled, Failed
}

const rx_login_complete = /^ \* (?<name>\S+) \[(?<account>\S+) \((?<client>[^\)]+)\) (?<index>\d+)] joins the adventure\.$/

const rx_quest_status = /QUEST STATUS/
const rx_aborted = /(?:Script edit|Modification) aborted\./
const rx_getverb = /Error: Script #(?<script>\d+) is a verb\. Please use (?<command>.*?) instead\./
const rx_noscript = /Error\: Script \#\d+ has not been created yet\./
const rx_noverb = /Verb not found\./
const rx_ss_check = /\s\s+\d+\s\s+.*?\s\s+.*?\s\s+.*?/

const rx_ready = /(?:READY FOR ASCII UPLOAD)|(?:Continuing\:)/

const rx_compiling = /^Compiling GSL script\: (?<script>\d+) \[(\d+)\]\[(?<path>.*?)\]$/
const rx_compile_ok = /^Compile OK\.  (?<warnings>\d+) Warnings\.  Size\: (?<bytes>[0-9,]+) bytes \(of (?<maxBytes>[0-9,]+) available\)$/
const rx_compile_fail = /^Compile Failed w\/(?<errors>\d+) errors and (?<warnings>\d+) warnings\.$/

const rx_compile_error = /^\s*(?<line>\d+)\s:\s(?<message>.*?)$/

const rx_compiled = /Compile ok\./

const rx_modified = /On\s(?<dow>\w+)\s(?<month>\w+) \s?(?<day>\d+) (?<hh>\d+)\:(?<mm>\d+)\:(?<ss>\d+) (?<year>\d+)$/
const rx_details = /(?:^Name\: (?<name>.*?)$)|(?:^Desc\: (?<desc>.*?)$)|(?:^Owned by: (?<owner>.*?)$)|(?:^Last modified by: (?<modifier>.*?)$)|(?:^(New)? ?File\: (?<path>.*?)(?:, (?<lines>\d+) lines?)?\.$)/

const monthList = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const clientTimeout = 15000
const ssCheckeditTimeout = 7500

export interface InitOptions {
    login: {
        account: string
        instance: string
        character: string
        password: string
    }
    console: { log: (...args: any[]) => void }
    downloadLocation: string
    loggingEnabled: boolean
    onCreate: (client: EditorClient) => void
}

/**
 * An operation requiring an editor client. If a promise is returned
 * it will be processed as if it is part of the task.
 * @see withEditorClient
*/
export type ClientTask<T> = (client: EditorClient) => T

/**
 * Provides an `EditorClient` object that is guaranteed to be exclusively owned
 * by the caller, so long as all other callers are using this function. This
 * prevents callers from sending conflicting commands to the game.
 *
 * @returns a promise that resolves when the task has been processed
 * successfully, or rejects if the task fails.
 */
export const withEditorClient = async <T>(
    initOptions: InitOptions,
    task: ClientTask<T>
): Promise<T> => {
    return processorSingleton.enqueueTask(initOptions, task)
}

type TaskController<T> = {
    task: ClientTask<T>
    initOptions: InitOptions
    resolve: (result: T | Promise<T>) => void
    reject: (error: Error) => void
}

class TaskQueueProcessor {
    /** Frequency of queue processing */
    private static FREQUENCY_MILLIS = 250

    private client: EditorClient | undefined
    private taskQueue: TaskController<any>[]
    private isProcessingTask: boolean
    private nextTick: NodeJS.Timeout | undefined

    constructor() {
        this.taskQueue = []
        this.isProcessingTask = false
        this.nextTick = undefined
    }

    enqueueTask<T>(initOptions: InitOptions, task: ClientTask<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.taskQueue.push({ initOptions, task, resolve, reject })
            this.scheduleTick(0)
        });
    }

    /** Schedule the queue to be processed */
    scheduleTick(milliseconds: number): void {
        clearTimeout(this.nextTick)
        this.nextTick = setTimeout(() => this.tick(), milliseconds)
    }

    /** Process the next task in the queue, if any */
    async tick(): Promise<void> {
        clearTimeout(this.nextTick)
        if (this.taskQueue.length === 0) return
        if (this.isProcessingTask) {
            this.scheduleTick(TaskQueueProcessor.FREQUENCY_MILLIS)
            return
        }
        const { initOptions, task, resolve, reject } = this.taskQueue.shift()!

        this.isProcessingTask = true
        try {
            const client = await this.ensureClient(initOptions)
            let result = await task(client)
            while (result && result instanceof Promise) {
                result = await result
            }
            resolve(result)
        }
        catch (e: unknown) {
            reject(e instanceof Error ? e : new Error(String(e)))
        }
        finally {
            this.isProcessingTask = false
            if (this.taskQueue.length > 0) {
                this.scheduleTick(TaskQueueProcessor.FREQUENCY_MILLIS)
            }
        }
    }

    async ensureClient({
        downloadLocation,
        console,
        loggingEnabled,
        login,
        onCreate,
    }: InitOptions): Promise<EditorClient> {
        // Create a new client if needed
        if (this.client && !this.client.hasServerConnection()) {
            try {
                this.client.quit()
            } catch (e) {
                console.log(e)
            }
            this.client = undefined
        }
        if (!this.client) {
            this.client = new EditorClient ({
                log: path.join(downloadLocation, 'gsl-dev-server.log'),
                logging: loggingEnabled,
                debug: true,
                echo: true,
                console,
            })
            onCreate(this.client)
            this.client.on('error', () => { this.client = undefined })
            this.client.on('quit', () => { this.client = undefined })
            try {
                await this.client.login(login)
            } catch (e) {
                // Clear the client so subsequent calls can create a fresh one
                this.client = undefined
                throw e
            }
        }
        return this.client
    }
}
const processorSingleton = new TaskQueueProcessor()

/**
 * The interface of an `EditorClient` instance. This layer of indirection
 * is necessary in order to prevent export of `EditorClient`. We want
 * to keep `EditorClient` private to this module so as to manage it as
 * a singleton.
 */
export type EditorClientInterface = InstanceType<typeof EditorClient>

class EditorClient extends BaseGameClient {
    private interactive: boolean
    private loginDetails: any
    private retryCommand: string

    constructor (options: GameClientOptions) {
        super(options)
        this.interactive = false
        this.retryCommand = ''
    }

    private isInteractive(): Promise<void> {
        if (this.interactive === true) { return Promise.resolve() }
        return new Promise<void> ((resolve, reject) => {
            const output = new OutputProcessor ((line: string) => {
                let match = line.match(rx_login_complete)
                if (match && match.groups) {
                    // character name, account name, index
                }
            })
            const timeout = setTimeout(() => {
                this.off('text', waitForPrompt)
                reject()
            }, clientTimeout)
            const waitForPrompt = (text: string) => {
                output.accumulate(text)
                if (output.peek(1) === '>') {
                    this.interactive = true
                    this.off('text', waitForPrompt)
                    clearTimeout(timeout)
                    resolve()
                }
            }
            this.on('text', waitForPrompt)
        })
    }

    private trySend(command: string, echo?: boolean): void {
        this.retryCommand = command
        this.send(command, echo)
    }

    protected serverError(error: any): void {
        // attempt to reconnet on reset connections
        if (error.code === 'ECONNRESET') {
            this.cleanupServer()
            this.reconnect().then(() => {
                if (this.retryCommand.length > 0) {
                    this.send(this.retryCommand)
                    this.retryCommand = ''
                }
            })
        } else { super.serverError(error) }
    }

    showScript (script: number): Promise<ShowScriptOutput> {
        const result: Partial<ShowScriptOutput> = {}
        return new Promise ((resolve, reject) => {
            const output = new OutputProcessor ((line: string) => {
                let match: RegExpMatchArray | null
                match = line.match(rx_modified)
                if (match && match.groups) {
                    let { year, month, day, hh, mm, ss } = match.groups
                    let date = new Date (
                        Number(year), monthList.indexOf(month), Number(day),
                        Number(hh), Number(mm), Number(ss)
                    )
                    result.lastModifiedDate = date
                    this.off('text', processText)
                    clearTimeout(timeout)
                    resolve(result as ShowScriptOutput)
                    return
                }
                match = line.match(rx_details)
                if (match && match.groups) {
                    for (let property in match.groups) {
                        if (match.groups[property]) {
                            result[
                                property as keyof ShowScriptOutput
                            ] = match.groups[property] as any
                        }
                    }
                    return
                }
            })
            const processText = (text: string) => output.accumulate(text)
            const timeout = setTimeout(() => {
                this.off('text', processText)
                reject(new Error ("Script check timed out."))
            }, clientTimeout)
            this.on('text', processText)
            this.trySend(`/ss ${script}`)
        })
    }

    showScriptCheckStatus (script: number): Promise<string> {
        return new Promise ((resolve, reject) => {
            const output = new OutputProcessor (line => {
                if (!line.match(rx_ss_check)) return
                const tokens = line.split(/\s\s+/)
                clearTimeout(timeout)
                this.off('text', processText)
                resolve(tokens[tokens.length - 1])
            })
            const processText = (text: string) => output.accumulate(text)
            const timeout = setTimeout(() => {
                this.off('text', processText)
                reject(new Error ("Script check timed out."))
            }, ssCheckeditTimeout)
            this.on('text', processText)
            this.trySend(`/ss check ${script}`)
        })
    }

    modifyScript (script: number | string, keepalive?: boolean): Promise<ScriptProperties> {
        const scriptProperties: Partial<ScriptProperties> = {new: false}
        return new Promise ((resolve, reject) => {
            const modifyFailed = (reason: string) => {
                clearTimeout(timeout)
                this.off('text', processText)
                reject(new Error (reason))
            }
            const output = new OutputProcessor ((line: string) => {
                let match: RegExpMatchArray | null
                if (rx_noverb.test(line)) { return modifyFailed(`Verb '${script}' does not exist.`) }
                if (rx_noscript.test(line)) { return modifyFailed(`Script ${script} has not yet been created.`) }
                match = line.match(rx_getverb)
                if (match && match.groups) {
                    scriptProperties.verb = match.groups.command.split(' ').slice(1).join(' ')
                    this.send(match.groups.command, true)
                    return
                }
                match = line.match(rx_modified)
                if (match && match.groups) {
                    let { year, month, day, hh, mm, ss } = match.groups
                    let date = new Date (
                        Number(year), monthList.indexOf(month), Number(day),
                        Number(hh), Number(mm), Number(ss)
                    )
                    scriptProperties.lastModifiedDate = date
                    return
                }
                match = line.match(rx_details)
                if (match && match.groups) {
                    for (let property in match.groups) {
                        if (match.groups[property]) {
                            scriptProperties[
                                property as keyof ScriptProperties
                            ] = match.groups[property] as any
                        }
                    }
                    return
                }
            })
            const timeout = setTimeout(() => modifyFailed("Modification timed out."), clientTimeout)
            const processText = async (text: string) => {
                output.accumulate(text)
                let done = false
                if (output.peek(5) === '001] ') {
                    this.off('text', processText)
                    this.send('')
                    done = true
                    scriptProperties.new = true
                }
                else if (output.peek(4) === 'Edt:') {
                    this.off('text', processText)
                    done = true
                }
                if (done) {
                    clearTimeout(timeout)
                    if (!keepalive) await this.exitModifyScript()
                    resolve(scriptProperties as ScriptProperties)
                }
            }
            this.on('text', processText)
            this.trySend(`/${(typeof script === 'number' ? 'ms' : 'mv')} ${script}`)
        })
    }

    exitModifyScript (): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => {
                    this.off('text', processText)
                    reject('Modification exit timed out.')
                },
                clientTimeout
            );
            const processText = (text:string) => output.accumulate(text)
            const output = new OutputProcessor((line: string) => {
                if (!line.match(rx_aborted) && !line.match(rx_quest_status)) {
                    return
                }
                this.off('text', processText)
                clearTimeout(timeout)
                resolve()
            })
            this.on('text', processText)
            this.trySend('Q')
        })
    }

    captureScript (): Promise<string> {
        return new Promise ((resolve, reject) => {
            const captureFailed = (reason: string) => {
                clearTimeout(timeout)
                this.off('text', processText)
                reject(new Error (reason))
            }
            const scriptLines: Array<string> = []
            const output = new OutputProcessor ((line: string) => scriptLines.push(line))
            const timeout = setTimeout(() => captureFailed("Capture timed out."), clientTimeout)
            const processText = async (text: string) => {
                output.accumulate(text)
                if (output.peek(4) === 'Edt:') {
                    clearTimeout(timeout)
                    this.off('text', processText)
                    await this.exitModifyScript()
                    resolve(scriptLines.join('\r\n'))
                }
            }
            this.on('text', processText)
            this.trySend('P')
        })
    }

    sendScript (lines: Array<string>, newScript: boolean): Promise<ScriptCompileResults> {
        return new Promise ((resolve, reject) => {
            const compileResults: ScriptCompileResults = {
                script: 0, path: '', bytes: 0, maxBytes: 0, errors: 0, warnings: 0, errorList: [], status: ScriptCompileStatus.Unknown
            }
            const output = new OutputProcessor ((line: string) => {
                let match: RegExpMatchArray | null
                if (rx_aborted.test(line) || rx_compiled.test(line)) {
                    this.off('text', processText)
                    resolve(compileResults)
                    return
                }
                if (rx_ready.test(line)) {
                    compileResults.status = ScriptCompileStatus.Uploading
                    lines.forEach(line => this.send(line))
                    compileResults.status = ScriptCompileStatus.Uploaded
                    return
                }
                match = line.match(rx_compiling)
                if (match && match.groups) {
                    compileResults.status = ScriptCompileStatus.Compiling
                    compileResults.script = Number(match.groups.script)
                    compileResults.path = match.groups.path
                    return
                }
                match = line.match(rx_compile_error)
                if (match && match.groups) {
                    const line = Number(match.groups.line)
                    const message = match.groups.message
                    compileResults.errorList.push({ line, message })
                    return
                }
                match = line.match(rx_compile_ok)
                if (match && match.groups) {
                    compileResults.status = ScriptCompileStatus.Compiled
                    compileResults.warnings = Number(match.groups.warnings)
                    compileResults.bytes = Number(match.groups.bytes.replace(/,/g, ''))
                    compileResults.maxBytes = Number(match.groups.maxBytes.replace(/,/g, ''))
                    return
                }
                match = line.match(rx_compile_fail)
                if (match && match.groups) {
                    compileResults.status = ScriptCompileStatus.Failed
                    compileResults.errors = Number(match.groups.errors)
                    compileResults.warnings = Number(match.groups.warnings)
                    return
                }
            })
            const processText = async (text: string) => {
                output.accumulate(text)
                if (output.peek(4) === 'Edt:') {
                    if (compileResults.status === ScriptCompileStatus.Uploaded) {
                        this.send('G')
                    } else if (compileResults.status === ScriptCompileStatus.Compiled) {
                        await this.exitModifyScript()
                    } else if (compileResults.status === ScriptCompileStatus.Failed) {
                        await this.exitModifyScript()
                    }
                    output.flush()
                }
            }
            this.on('text', processText)
            this.trySend(newScript ? this.newLine + 'C' : 'Z')
        })
    }

    async reconnect () {
        const error: any = (e: Error) => { error.caught = e }
        const { account, password, instance, character } = this.loginDetails
        const sal = await EAccessClient.quickLogin(account, password, instance, character, 'storm').catch(error)
        if (error.caught) { return Promise.reject(error.caught) }
        this.interactive = false
        this.connect(sal)
        return await this.isInteractive()
    }

    async login (loginDetails: any) {
        this.loginDetails = loginDetails
        return await this.reconnect()
    }

    /**
     * Executes the given `command`.
     * @returns game output lines seen between `start` and `end`
     */
    executeCommand (
        command: string,
        {
            captureStart,
            captureEnd,
            timeoutMillis,
            includeStartLine,
            includeEndLine
        }: {
            captureStart: RegExp,
            captureEnd: RegExp,
            timeoutMillis: number,
            includeStartLine?: boolean,
            includeEndLine?: boolean
        }
    ): Promise<string[]> {
        const lines: string[] = []

        return new Promise ((resolve, reject) => {
            let seenStart = false

            // Process game output between `start` and `end`
            const output = new OutputProcessor ((line: string) => {
                // Check capture start
                if (!seenStart) {
                    if (line.match(captureStart)) {
                        seenStart = true
                        if (includeStartLine) {
                            lines.push(line)
                        }
                    }
                    return
                }

                // Check capture end
                if (line.match(captureEnd)) {
                    if (includeEndLine) lines.push(line)
                    this.off('text', processText)
                    clearTimeout(timeout)
                    resolve(lines)
                    return
                }

                // Capture line
                lines.push(line)
            })

            // Pipe text to OutputProcessor
            const processText = (text: string) => output.accumulate(text)
            this.on('text', processText)

            // Handle timeout
            const timeout = setTimeout(() => {
                this.off('text', processText)
                reject(new Error (`Command timed out: ${command}`))
            }, timeoutMillis)

            // Send command
            this.trySend(command)
        })
    }
}

class OutputProcessor {
    private buffer: string
    private handler: (text: string) => void
    constructor (handler: (text: string) => void) {
        this.buffer = ''
        this.handler = handler
    }
    accumulate (text: string) {
        this.buffer += text
        let last = -2, nl = this.buffer.indexOf('\r\n')
        while (nl > -1) {
            let line = this.buffer.substring(last + 2, nl)
            this.handler(line)
            last = nl
            nl = this.buffer.indexOf('\r\n', nl + 2)
        }
        if (last !== -2) {
            this.buffer = this.buffer.substring(last + 2)
        }
    }
    peek (n: number = 0): string { return (n <= 0) ? this.buffer : this.buffer.substring(this.buffer.length - n, this.buffer.length) }
    flush (): string { return this.buffer = '' }
}
