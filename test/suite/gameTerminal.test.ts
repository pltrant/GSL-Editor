import * as assert from "assert";
import {
    ExtensionTerminalOptions,
    Pseudoterminal,
    Terminal,
    window,
} from "vscode";
import { BaseGameClient } from "../../gsl/gameClients";
import { GameTerminal } from "../../gsl/gameTerminal";

suite("Game terminal lifecycle", () => {
    test("reports cached session readiness, locks input, and handles reset", () => {
        const createTerminal = window.createTerminal;
        let pty!: Pseudoterminal;
        let output = "";
        const sent: string[] = [];
        const client = new BaseGameClient({});
        client.send = (command: string) => {
            sent.push(command);
        };
        window.createTerminal = ((options: ExtensionTerminalOptions) => {
            pty = options.pty;
            pty.onDidWrite((text) => {
                output += text;
            });
            return { dispose: () => pty.close() } as Terminal;
        }) as typeof window.createTerminal;
        let terminal: GameTerminal | undefined;
        try {
            terminal = new GameTerminal(() => {});
            terminal.connecting();
            pty.open(undefined);
            assert.match(output, /Initializing GSL terminal/);
            assert.match(output, /Waiting for a game connection/);
            pty.handleInput!("ignored\r");
            assert.deepStrictEqual(sent, []);

            // Cached clients never emit another hello event when attached.
            terminal.inputEnabled = false;
            terminal.bindClient(client);
            assert.match(output, /Terminal initialized/);
            assert.match(output, /Input locked/);
            assert.doesNotMatch(output, /Ready for input/);
            pty.handleInput!("\r");
            assert.deepStrictEqual(sent, []);

            terminal.inputEnabled = true;
            assert.match(output, /Ready for input/);
            pty.handleInput!("look");
            pty.handleInput!("\r");
            assert.deepStrictEqual(sent, ["look"]);

            client.destroy();
            assert.strictEqual(terminal.isConnected, false);
            assert.match(output, /Disconnected/);
            pty.handleInput!("\r");
            assert.deepStrictEqual(sent, ["look"]);
        } finally {
            terminal?.dispose();
            window.createTerminal = createTerminal;
        }
    });
});
