import {
    Pseudoterminal,
    EventEmitter,
    window,
    Terminal,
    ExtensionTerminalOptions,
} from "vscode";

import { BaseGameClient } from "./gameClients";

export class GameTerminal {
    readonly terminal: Terminal;
    private allowInput = true;

    get inputEnabled() {
        return this.allowInput;
    }

    set inputEnabled(enabled: boolean) {
        if (this.allowInput === enabled) return;
        this.allowInput = enabled;
        if (this.isConnected) this.reportInputState();
    }

    get isConnected() {
        return !!this.gameClient;
    }

    private reportInputState() {
        this.write(
            this.inputEnabled
                ? "[Ready for input.]\r\n"
                : "[Connected. Input locked while rollout is in progress.]\r\n",
        );
    }

    connecting() {
        this.write(
            "[Waiting for a game connection: signing in or reusing an existing session...]\r\n",
        );
    }

    connectionFailed(message: string) {
        this.write(`[Connection unavailable: ${message}]\r\n`);
    }
    isClosed = false;
    private opened = false;
    private pendingOutput = "";
    private markReady!: () => void;
    readonly ready = new Promise<void>((resolve) => {
        this.markReady = resolve;
    });

    write(text: string) {
        if (this.isClosed) return;
        if (this.opened) this.writeEmitter.fire(text);
        else this.pendingOutput += text;
    }

    dispose() {
        this.terminal.dispose();
    }

    get onDidClose() {
        return this.closeEmitter.event;
    }

    private closeEmitter: EventEmitter<number>;
    private writeEmitter: EventEmitter<string>;

    private gameClient?: BaseGameClient;
    private unbindCurrentClient?: () => void;

    private ptyInputBuffer: string;
    private ptyInputIndex: number;
    private ptyOriginalInput: string;
    private ptyInputHistory: Array<string>;

    private clearInput() {
        if (this.ptyInputBuffer.length > 0) {
            this.writeEmitter.fire(
                "\u001b[" + this.ptyInputBuffer.length + "D\u001b[K",
            );
        }
    }

    private handleEnterKey() {
        this.ptyInputHistory.push(this.ptyInputBuffer);
        while (this.ptyInputHistory.length > 50) {
            this.ptyInputHistory.shift();
        }
        this.writeEmitter.fire("\r\n");
        this.gameClient?.send(this.ptyInputBuffer, false);
        this.ptyInputBuffer = "";
        this.ptyOriginalInput = "";
        this.ptyInputIndex = 0;
    }

    private handleBackspaceKey() {
        if (this.ptyInputBuffer.length === 0) {
            return;
        }
        this.ptyInputBuffer = this.ptyInputBuffer.substring(
            0,
            this.ptyInputBuffer.length - 1,
        );
        this.writeEmitter.fire("\x08 \x08");
    }

    private handleUpArrowKey() {
        if (this.ptyInputHistory.length <= this.ptyInputIndex) {
            return;
        }
        if (this.ptyInputIndex === 0) {
            this.ptyOriginalInput = this.ptyInputBuffer;
        }
        this.ptyInputIndex += 1;
        this.clearInput();
        this.ptyInputBuffer =
            this.ptyInputHistory[
                this.ptyInputHistory.length - this.ptyInputIndex
            ];
        this.writeEmitter.fire(this.ptyInputBuffer);
    }

    private handleDownArrowKey() {
        if (this.ptyInputIndex === 0) {
            return;
        }
        this.ptyInputIndex -= 1;
        this.clearInput();
        this.ptyInputBuffer =
            this.ptyInputIndex === 0
                ? this.ptyOriginalInput
                : this.ptyInputHistory[
                      this.ptyInputHistory.length - this.ptyInputIndex
                  ];
        this.writeEmitter.fire(this.ptyInputBuffer);
    }

    private handleInputData(buffer: Buffer) {
        const input = buffer.toString();
        this.ptyInputBuffer += input;
        this.writeEmitter.fire(input);
    }

    private handleMetaSequence(buffer: Buffer) {
        switch (buffer[1]) {
            case 0x5b: // movement
                switch (buffer[2]) {
                    //             case 0x32: // insert
                    //             case 0x33: // delete
                    //             case 0x35: // page up 0x7e
                    //             case 0x36: // page down 0x7e
                    case 0x41: // up
                        this.handleUpArrowKey();
                        break;
                    case 0x42: // down
                        this.handleDownArrowKey();
                        break;
                    //             case 0x43: // right
                    //             case 0x44: // left
                    //             case 0x46: // end
                    //             case 0x48: // home
                    //             case 0x5A: // shift + tab ??
                }
        }
    }

    constructor(
        closed: () => void,
        options: Partial<
            Pick<ExtensionTerminalOptions, "name" | "location">
        > = {},
    ) {
        this.closeEmitter = new EventEmitter<number>();
        this.writeEmitter = new EventEmitter<string>();

        this.ptyInputBuffer = "";
        this.ptyInputIndex = 0;
        this.ptyInputHistory = [];
        this.ptyOriginalInput = "";

        const pty: Pseudoterminal = {
            onDidClose: this.closeEmitter.event,
            onDidWrite: this.writeEmitter.event,
            open: () => {
                this.opened = true;
                this.writeEmitter.fire(
                    "[Initializing GSL terminal...]\r\n" + this.pendingOutput,
                );
                this.pendingOutput = "";
                this.markReady();
            },
            close: () => {
                this.isClosed = true;
                this.markReady();
                this.closeEmitter.fire(0);
                this.closeEmitter.dispose();
                this.writeEmitter.dispose();
            },
            handleInput: (data: string) => {
                if (!this.inputEnabled || !this.isConnected) return;
                const buffer = Buffer.from(data, "binary");
                switch (buffer[0]) {
                    // case 0x09: // tab
                    //     break
                    case 0x0d: // enter
                        this.handleEnterKey();
                        break;
                    case 0x7f: // backspace
                        this.handleBackspaceKey();
                        break;
                    case 0x1b: // meta?
                        this.handleMetaSequence(buffer);
                        break;
                    default:
                        if (buffer[0] < 32 || buffer[0] === 127) {
                            /* non-printable */
                        } else {
                            this.handleInputData(buffer);
                        }
                        break;
                }
            },
        };

        this.closeEmitter.event(() => closed());

        this.terminal = window.createTerminal({
            name: "GSL Development",
            ...options,
            pty,
        });
    }

    show(preserveFocus?: boolean) {
        this.terminal.show(preserveFocus);
    }

    hide() {
        this.terminal.hide();
    }

    bindClient(client: BaseGameClient) {
        if (this.isClosed) return;
        if (this.gameClient === client) return;
        if (this.gameClient) {
            this.unbindCurrentClient?.();
        }

        const unbindClient = () => {
            client.off("error", handleClientError);
            client.off("hello", handleClientHello);
            client.off("quit", handleClientQuit);
            client.off("text", handleClientText);
            client.off("echo", handleClientEcho);
            closeEvent.dispose();
            this.gameClient = undefined;
            this.unbindCurrentClient = undefined;
        };

        const handleClientError = (error: Error) => {
            this.connectionFailed(error.message);
            void window.showErrorMessage(error.message);
            unbindClient();
        };

        const handleClientHello = () => {
            this.write("[Game server connected.]\r\n");
        };

        const handleClientQuit = () => {
            this.write(
                "[Disconnected. Reconnect before entering commands.]\r\n",
            );
            unbindClient();
        };

        const handleClientText = (text: string) => {
            if (this.ptyInputBuffer.length > 0) {
                this.write(
                    "\u001b[" + this.ptyInputBuffer.length + "D\u001b[K",
                );
                this.write(text);
                this.write(this.ptyInputBuffer);
            } else {
                this.write(text);
            }
        };

        const handleClientEcho = (text: string) => {
            if (this.ptyInputBuffer.length > 0) {
                this.write(
                    "\u001b[" + this.ptyInputBuffer.length + "D\u001b[K",
                );
                this.write(text);
                this.write("\r\n");
                this.write(this.ptyInputBuffer);
            } else {
                this.write(text);
                this.write("\r\n");
            }
        };

        const closeEvent = this.closeEmitter.event(unbindClient);

        client.on("error", handleClientError);
        client.on("hello", handleClientHello);
        client.on("quit", handleClientQuit);
        client.on("text", handleClientText);
        client.on("echo", handleClientEcho);

        this.gameClient = client;
        this.unbindCurrentClient = unbindClient;
        this.write("[Game session attached. Terminal initialized.]\r\n");
        this.reportInputState();
    }
}
