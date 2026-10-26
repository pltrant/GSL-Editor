import * as assert from "assert";
import * as os from "os";
import { AddressInfo, createServer, Server, Socket } from "net";
import {
    OutputProcessor,
    stripGamePrompt,
    withClientForInstance,
} from "../../gsl/editorClient";
import { BaseGameClient } from "../../gsl/gameClients";

suite("OutputProcessor", () => {
    function collect(): { lines: string[]; output: OutputProcessor } {
        const lines: string[] = [];
        const output = new OutputProcessor((line) => lines.push(line));
        return { lines, output };
    }

    test("splits buffered text into lines", () => {
        const { lines, output } = collect();
        output.accumulate("one\r\ntwo\r\npartial");
        assert.deepStrictEqual(lines, ["one", "two"]);
        output.accumulate(" line\r\n");
        assert.deepStrictEqual(lines, ["one", "two", "partial line"]);
    });

    test("strips ANSI escape sequences from emitted lines", () => {
        const { lines, output } = collect();
        output.accumulate(
            "\x1b[0m<<<beginning of output>>>\r\n" +
                "\x1b[1;32mgreen\x1b[0m text\r\n" +
                "plain\r\n",
        );
        assert.deepStrictEqual(lines, [
            "<<<beginning of output>>>",
            "green text",
            "plain",
        ]);
    });

    test("strips OSC and single-character escape sequences", () => {
        const { lines, output } = collect();
        output.accumulate(
            "\x1b]0;window title\x07<<<beginning of output>>>\r\n" +
                "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ text\r\n" +
                "\x1b=keypad mode\r\n",
        );
        assert.deepStrictEqual(lines, [
            "<<<beginning of output>>>",
            "link text",
            "keypad mode",
        ]);
    });

    test("strips ANSI escape sequences split across chunks", () => {
        const { lines, output } = collect();
        output.accumulate("\x1b[");
        output.accumulate("0mShowing room #100\r\n");
        assert.deepStrictEqual(lines, ["Showing room #100"]);
    });
});

suite("Command response prompts", () => {
    test("recognizes the captured metadata header after a split ANSI prompt", () => {
        const lines: string[] = [];
        const output = new OutputProcessor((line) =>
            lines.push(stripGamePrompt(line)),
        );
        output.accumulate("\x1b[0mG");
        output.accumulate("N>");
        output.accumulate(
            "Game: GS4D\r\nName: GCommonProp\r\nOn Mon Sep 07 20:56:37 2026\r\n",
        );
        assert.ok(/^Game: /.test(lines[0]));
        assert.ok(/^On |^Unspecified Date/.test(lines[2]));
        assert.deepStrictEqual(lines, [
            "Game: GS4D",
            "Name: GCommonProp",
            "On Mon Sep 07 20:56:37 2026",
        ]);
    });

    test("handles repeated prompts and preserves non-prompt response text", () => {
        assert.strictEqual(
            stripGamePrompt("GN>G>>Invalid script number"),
            "Invalid script number",
        );
        assert.strictEqual(
            stripGamePrompt("><<<beginning of output>>>"),
            "<<<beginning of output>>>",
        );
        for (const line of [
            "Game: GS4",
            "<<<end of output>>>",
            "Text GN> text",
            "Name: Example>name",
        ]) {
            assert.strictEqual(stripGamePrompt(line), line);
        }
    });

    test("the shared processor preserves prompts for other consumers", () => {
        const lines: string[] = [];
        new OutputProcessor((line) => lines.push(line)).accumulate(
            "GN>Game: GS4D\r\n",
        );
        assert.deepStrictEqual(lines, ["GN>Game: GS4D"]);
    });
});

suite("Editor client login changes", () => {
    const originalOn = BaseGameClient.prototype.on;
    teardown(() => {
        BaseGameClient.prototype.on = originalOn;
    });

    const loginFor = (instance: string) => ({
        account: "test",
        instance,
        character: "TestChar",
        password: "testpass",
    });

    test("a cached client is replaced when the login changes", async () => {
        const closed: unknown[] = [];
        // Fake the network login on each new client before ensureClient calls it.
        BaseGameClient.prototype.on = function (this: any, ...args: any[]) {
            this.login = async (loginDetails: unknown) => {
                this.loginDetails = loginDetails;
                this.server = { close: () => closed.push(this) };
            };
            return originalOn.apply(this, args as any);
        };
        const run = (instance: string) =>
            withClientForInstance(
                "gameGuardLoginChangeTest",
                {
                    login: loginFor(instance),
                    console: { log: () => {} },
                    downloadLocation: os.tmpdir(),
                    loggingEnabled: false,
                    onCreate: () => {},
                },
                (client) => client,
            );

        const first = await run("GS4D");
        assert.strictEqual(await run("GS4D"), first);
        const second = await run("DRD");
        assert.notStrictEqual(second, first);
        assert.deepStrictEqual(closed, [first]);
        assert.ok(second.matchesLogin(loginFor("DRD")));
        second.destroy();
    });
});

suite("Editor client connections", () => {
    const originalOn = BaseGameClient.prototype.on;
    let gameServer: Server;
    let gamePort: number;
    const gameSockets: Socket[] = [];

    suiteSetup(async () => {
        gameServer = createServer((socket) => gameSockets.push(socket));
        await new Promise<void>((resolve) => gameServer.listen(0, resolve));
        gamePort = (gameServer.address() as AddressInfo).port;
    });
    suiteTeardown(async () => {
        gameSockets.forEach((socket) => socket.destroy());
        await new Promise((resolve) => gameServer.close(resolve));
    });
    setup(() => {
        // Fake the play.net login, but connect a real game socket.
        BaseGameClient.prototype.on = function (this: any, ...args: any[]) {
            this.login = async (loginDetails: unknown) => {
                this.loginDetails = loginDetails;
                const hello = new Promise((resolve) =>
                    originalOn.call(this, "hello", resolve),
                );
                this.connect({
                    gamehost: "127.0.0.1",
                    gameport: gamePort,
                    key: "key",
                });
                await hello;
            };
            return originalOn.apply(this, args as any);
        };
    });
    teardown(() => {
        BaseGameClient.prototype.on = originalOn;
    });

    // Each test uses its own queue so failures do not carry over.
    const run = (queue: string) =>
        withClientForInstance(
            queue,
            {
                login: {
                    account: "test",
                    instance: "GS4D",
                    character: "TestChar",
                    password: "testpass",
                },
                console: { log: () => {} },
                downloadLocation: os.tmpdir(),
                loggingEnabled: false,
                onCreate: () => {},
            },
            (client) => client,
        );
    const emitSocketTimeout = (client: unknown) => {
        const error = Object.assign(new Error("read ETIMEDOUT"), {
            code: "ETIMEDOUT",
        });
        (client as any).server.socket.emit("error", error);
    };

    test("a socket ETIMEDOUT on a reset client does not crash", async () => {
        const client = await run("resetClientTimeoutTest");
        // A reset client has no listeners but keeps its closing socket.
        client.destroy();
        assert.doesNotThrow(() => emitSocketTimeout(client));
    });

    test("a socket ETIMEDOUT marks the client dead and the next call logs in again", async () => {
        const first = await run("liveClientTimeoutTest");
        assert.doesNotThrow(() => emitSocketTimeout(first));
        assert.strictEqual(first.hasServerConnection(), false);
        const second = await run("liveClientTimeoutTest");
        assert.notStrictEqual(second, first);
        assert.ok(second.hasServerConnection());
        second.destroy();
    });
});
