
import { Pseudoterminal, EventEmitter, window, Terminal } from "vscode";

import { BaseGameClient } from "./gameClients";

export class GameTerminal {
    private terminal: Terminal

    private closeEmitter: EventEmitter<number>
    private writeEmitter: EventEmitter<string>

    private gameClient?: BaseGameClient

    private ptyInputBuffer: string
    private ptyInputIndex: number
    private ptyOriginalInput: string
    private ptyInputHistory: Array<string>

    private clearInput () {
        if (this.ptyInputBuffer.length > 0) {
            this.writeEmitter.fire('\u001b[' + this.ptyInputBuffer.length + 'D\u001b[K')
        }
    }

    private handleEnterKey () {
        this.ptyInputHistory.push(this.ptyInputBuffer)
        while (this.ptyInputHistory.length > 50) { this.ptyInputHistory.shift() }
        this.writeEmitter.fire('\r\n')
        this.gameClient?.send(this.ptyInputBuffer, false)
        this.ptyInputBuffer = ''
        this.ptyOriginalInput = ''
        this.ptyInputIndex = 0
    }

    private handleBackspaceKey () {
        if (this.ptyInputBuffer.length === 0) { return }
        this.ptyInputBuffer = this.ptyInputBuffer.substring(
            0, this.ptyInputBuffer.length - 1
        )
        this.writeEmitter.fire('\x08 \x08')
    }

    private handleUpArrowKey () {
        if (this.ptyInputHistory.length <= this.ptyInputIndex) { return }
        if (this.ptyInputIndex === 0) { this.ptyOriginalInput = this.ptyInputBuffer }
        this.ptyInputIndex += 1
        this.clearInput()
        this.ptyInputBuffer = this.ptyInputHistory[this.ptyInputHistory.length - this.ptyInputIndex]
        this.writeEmitter.fire(this.ptyInputBuffer)
    }

    private handleDownArrowKey () {
        if (this.ptyInputIndex === 0) { return }
        this.ptyInputIndex -= 1
        this.clearInput()
        this.ptyInputBuffer = (this.ptyInputIndex === 0)
            ? this.ptyOriginalInput
            : this.ptyInputHistory[this.ptyInputHistory.length - this.ptyInputIndex]
        this.writeEmitter.fire(this.ptyInputBuffer)
    }

    private handleInputData (buffer: Buffer) {
        const input = buffer.toString()
        this.ptyInputBuffer += input
        this.writeEmitter.fire(input)
    }

    private handleMetaSequence (buffer: Buffer) {
        switch (buffer[1]) {
            case 0x5B: // movement
                switch (buffer[2]) {
                    //             case 0x32: // insert
                    //             case 0x33: // delete
                    //             case 0x35: // page up 0x7e
                    //             case 0x36: // page down 0x7e
                    case 0x41: // up
                        this.handleUpArrowKey()
                        break
                    case 0x42: // down
                        this.handleDownArrowKey()
                        break
                    //             case 0x43: // right
                    //             case 0x44: // left
                    //             case 0x46: // end
                    //             case 0x48: // home
                    //             case 0x5A: // shift + tab ??
                }
        }
    }

    constructor (closed: () => void) {

        this.closeEmitter = new EventEmitter<number>()
        this.writeEmitter = new EventEmitter<string>()

        this.ptyInputBuffer = ''
        this.ptyInputIndex = 0
        this.ptyInputHistory = []
        this.ptyOriginalInput = ''

        const pty: Pseudoterminal = {
            onDidClose: this.closeEmitter.event,
            onDidWrite: this.writeEmitter.event,
            open: () => {
                this.writeEmitter.fire('[Terminal is ready for development server connections.]\r\n')
            },
            close: () => {
                this.closeEmitter.fire(0)
            },
            handleInput: (data: string) => {
                const buffer = Buffer.from(data, 'binary')
                switch (buffer[0]) {
                    // case 0x09: // tab
                    //     break
                    case 0x0D: // enter
                        this.handleEnterKey()
                        break
                    case 0x7F: // backspace
                        this.handleBackspaceKey()
                        break
                    case 0x1B: // meta?
                        this.handleMetaSequence(buffer)
                        break
                    default:
                        if (buffer[0] < 32 || buffer[0] === 127) {
                            /* non-printable */
                        } else {
                            this.handleInputData(buffer)
                        }
                        break
                }
            }
        }

        this.closeEmitter.event(() => closed())

        this.terminal = window.createTerminal({ name: 'GSL Development', pty })
    }

    show (preserveFocus?: boolean) { this.terminal.show(preserveFocus) }

    hide () { this.terminal.hide() }

    bindClient (client: BaseGameClient) {
        if (this.gameClient === client) return
        if (this.gameClient) { throw new Error ("Game client is already bound?") }
    
        const unbindClient = () => {
            client.off('error', handleClientError)
            client.off('hello', handleClientHello)
            client.off('quit', handleClientQuit)
            client.off('text', handleClientText)
            client.off('echo', handleClientEcho)
            closeEvent.dispose()
            this.gameClient = undefined
        }

        const handleClientError = (error: Error) => {
            window.showErrorMessage(error.message)
            unbindClient()
        }

        const handleClientHello = () => {
            this.writeEmitter.fire("[ *** Connected To Server *** ]\r\n")
        }

        const handleClientQuit = () => {
            this.writeEmitter.fire("[ *** Disconnected from Server *** ]\r\n")
            unbindClient()
        }

        const handleClientText = (text: string) => {
            if (this.ptyInputBuffer.length > 0) {
                this.writeEmitter.fire('\u001b[' + this.ptyInputBuffer.length + 'D\u001b[K')
                this.writeEmitter.fire(text)
                this.writeEmitter.fire(this.ptyInputBuffer)
            } else {
                this.writeEmitter.fire(text)
            }
        }

        const handleClientEcho = (text: string) => {
            if (this.ptyInputBuffer.length > 0) {
                this.writeEmitter.fire('\u001b[' + this.ptyInputBuffer.length + 'D\u001b[K')
                this.writeEmitter.fire(text)
                this.writeEmitter.fire('\r\n')
                this.writeEmitter.fire(this.ptyInputBuffer)
            } else {
                this.writeEmitter.fire(text)
                this.writeEmitter.fire('\r\n')
            }
        }

        const closeEvent = this.closeEmitter.event(unbindClient)

        client.on('error', handleClientError)
        client.on('hello', handleClientHello)
        client.on('quit', handleClientQuit)
        client.on('text', handleClientText)
        client.on('echo', handleClientEcho)

        this.gameClient = client
    }
}

