
import { BaseGameClient, GameClientOptions } from "./gameClients"
import { EAccessClient } from "./eaccessClient"

export interface ScriptProperties {
    lastModifiedDate: Date,
    name: string,
    desc: string,
    owner: string,
    modifier: string,
    new: boolean,
    path: string,
    lines: number
}

export interface ScriptCompileResults {
    status: ScriptCompileStatus,
    script: number,
    path: string,
    bytes: number,
    errors: number,
    warnings: number,
    errorList: Array<ScriptError>
}

export interface ScriptError { line: number, message: string }

export enum ScriptCompileStatus {
    Unknown, Uploading, Uploaded, Compiling, Compiled, Failed
}

const rx_login_complete = /^ \* (?<name>\S+) \[(?<account>\S+) \((?<client>[^\)]+)\) (?<index>\d+)] joins the adventure\.$/

const rx_aborted = /(?:Script edit|Modification) aborted\./
const rx_getverb = /Error: Script #(?<script>\d+) is a verb\. Please use (?<command>.*?) instead\./
const rx_noscript = /Error\: Script \#\d+ has not been created yet\./
const rx_noverb = /Verb not found\./
const rx_newscript = /New File\: \.\.\/scripts\/S(\d+)\.gsl\./

const rx_ready = /(?:READY FOR ASCII UPLOAD)|(?:Continuing\:)/

const rx_compiling = /^Compiling GSL script\: (?<script>\d+) \[(\d+)\]\[(?<path>.*?)\]$/
const rx_compile_ok = /^Compile OK\.  (?<warnings>\d+) Warnings\.  Size\: (?<bytes>[0-9,]+) bytes \(of (?<maxBytes>[0-9,]+) available\)$/
const rx_compile_fail = /^Compile Failed w\/(?<errors>\d+) errors and (?<warnings>\d+) warnings\.$/

const rx_compile_error = /^\s*(?<line>\d+)\s:\s(?<message>.*?)$/

const rx_compiled = /Compile ok\./

const rx_modified = /^On\s(?<dow>\w+)\s(?<month>\w+) \s?(?<day>\d+) (?<hh>\d+)\:(?<mm>\d+)\:(?<ss>\d+) (?<year>\d+)$/
const rx_details = /(?:^Name\: (?<name>.*?)$)|(?:^Desc\: (?<desc>.*?)$)|(?:^Owned by: (?<owner>.*?)$)|(?:^Last modified by: (?<modifier>.*?)$)|(?:^(?<new>New)? ?File\: (?<path>.*?)(?:, (?<lines>\d+) lines?)?\.$)/

const monthList = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const delay = 15000

export class EditorClient extends BaseGameClient {
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
            }, delay)
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

    checkScript (script: number): Promise<ScriptProperties> {
        const scriptProperties: any = {}
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
                    scriptProperties.lastModifiedDate = date
                    this.off('text', processText)
                    clearTimeout(timeout)
                    resolve(scriptProperties)
                    return
                }
                match = line.match(rx_details)
                if (match && match.groups) {
                    for (let property in match.groups) {
                        if (match.groups[property]) {
                            scriptProperties[property] = match.groups[property]
                        }
                    }
                    return
                }
            })
            const processText = (text: string) => output.accumulate(text)
            const timeout = setTimeout(() => {
                this.off('text', processText)
                reject(new Error ("Script check timed out."))
            }, delay)
            this.on('text', processText)
            this.trySend(`/ss ${script}`)
        })
    }
    
    modifyScript (script: number | string, noQuit?:boolean): Promise<ScriptProperties> {
        const scriptProperties: any = {}
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
                            scriptProperties[property] = match.groups[property]
                        }
                    }
                    return
                }
            })
            const timeout = setTimeout(() => modifyFailed("Modification timed out."), delay)
            const processText = (text: string) => {
                output.accumulate(text)
                switch (true) {
                case (output.peek(5) === '001] '):
                    if (noQuit !== true) {
                        this.send('')
                        this.send('Q')
                    }
                case (output.peek(4) === 'Edt:'):
                    clearTimeout(timeout)
                    this.off('text', processText)
                    resolve(scriptProperties)
                }
            }
            this.on('text', processText)
            this.trySend(`/${(typeof script === 'number' ? 'ms' : 'mv')} ${script}`)
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
            const timeout = setTimeout(() => captureFailed("Capture timed out."), delay)
            const processText = (text: string) => {
                output.accumulate(text)
                if (output.peek(4) === 'Edt:') {
                    clearTimeout(timeout)
                    this.off('text', processText)
                    this.send('Q')
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
                script: 0, path: '', bytes: 0, errors: 0, warnings: 0, errorList: [], status: ScriptCompileStatus.Unknown
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
            const processText = (text: string) => {
                output.accumulate(text)
                if (output.peek(4) === 'Edt:') {
                    if (compileResults.status === ScriptCompileStatus.Uploaded) {
                        this.send('G')
                    } else if (compileResults.status === ScriptCompileStatus.Compiled) {
                        this.send('Q')
                    } else if (compileResults.status === ScriptCompileStatus.Failed) {
                        this.send('Q')
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
