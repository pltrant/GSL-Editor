import * as assert from "assert";
import * as os from "os";
import { AddressInfo, createServer, Server, Socket } from "net";
import {
    OutputProcessor,
    closeAllEditorClients,
    stripGamePrompt,
    withClientForInstance,
} from "../../gsl/editorClient";
import { BaseGameClient } from "../../gsl/gameClients";
import { EAccessClient } from "../../gsl/eaccessClient";

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
    let reconnects = 0;
    /** False to keep the real in-place reconnect */
    let stubReconnect = true;

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
            if (stubReconnect) {
                this.reconnect = async () => {
                    reconnects++;
                };
            }
            return originalOn.apply(this, args as any);
        };
    });
    teardown(() => {
        BaseGameClient.prototype.on = originalOn;
        stubReconnect = true;
    });

    // Each test uses its own queue so failures do not carry over.
    const run = (queue: string, log: (message: string) => void = () => {}) =>
        withClientForInstance(
            queue,
            {
                login: {
                    account: "test",
                    instance: "GS4D",
                    character: "TestChar",
                    password: "testpass",
                },
                console: { log },
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

    test("a socket ETIMEDOUT marks the client dead and the next call logs in again", async function () {
        this.timeout(5_000);
        const first = await run("liveClientTimeoutTest");
        assert.doesNotThrow(() => emitSocketTimeout(first));
        assert.strictEqual(first.hasServerConnection(), false);
        const second = await run("liveClientTimeoutTest");
        assert.notStrictEqual(second, first);
        assert.ok(second.hasServerConnection());
        second.destroy();
    });

    test("closing all clients logs out and closes the game socket", async () => {
        const connected = new Promise<Socket>((resolve) =>
            gameServer.once("connection", resolve),
        );
        const client = await run("closeAllClientsTest");
        const gameSocket = await connected;
        let received = "";
        gameSocket.on("data", (data) => (received += data.toString()));
        const ended = new Promise((resolve) => gameSocket.once("end", resolve));

        await closeAllEditorClients();
        await ended;

        assert.ok(received.endsWith("quit\n"));
        assert.strictEqual(client.hasServerConnection(), false);
        // Shutdown must not log in a session it will never log out.
        await assert.rejects(run("closeAllClientsTest"), /shutting down/);
    });

    test("closing during the login retry delay does not log in", async () => {
        const connectingOn = BaseGameClient.prototype.on;
        let logins = 0;
        BaseGameClient.prototype.on = function (this: any, ...args: any[]) {
            const result = connectingOn.apply(this, args as any);
            this.login = async () => {
                logins++;
                throw Object.assign(new Error("connect ECONNREFUSED"), {
                    code: "ECONNREFUSED",
                });
            };
            return result;
        };
        // Waits 500ms after the failed login before retrying once.
        let retrying!: () => void;
        const retryDelayStarted = new Promise<void>((resolve) => {
            retrying = resolve;
        });
        const login = run("closeDuringRetryDelayTest", (message) => {
            if (message.includes("retrying once")) retrying();
        });
        await retryDelayStarted;
        await closeAllEditorClients();

        await assert.rejects(login, /shutting down/);
        assert.strictEqual(logins, 1);
    });

    test("logins back off after repeated connection failures", async function () {
        this.timeout(10_000);
        const queue = "loginBackoffTest";
        let failedAt = 0;
        const backoffs: number[] = [];
        // The logged wait is what is left of the backoff since the failure,
        // so add back the time since: a slow machine must not change it.
        const log = (message: string) => {
            const match = /Waiting (\d+)ms/.exec(message);
            if (match) backoffs.push(Number(match[1]) + Date.now() - failedAt);
        };
        const timeRelogin = async (client: unknown) => {
            emitSocketTimeout(client);
            failedAt = Date.now();
            const next = await run(queue, log);
            return { next, elapsed: Date.now() - failedAt };
        };

        const first = await run(queue);
        const { next: second, elapsed: firstWait } = await timeRelogin(first);
        const { next: third, elapsed: secondWait } = await timeRelogin(second);

        // Each drop counts once: 1s, then 2s.
        assert.strictEqual(backoffs.length, 2);
        assert.ok(
            Math.abs(backoffs[0] - 1_000) <= 50,
            `first backoff was ${backoffs[0]}ms`,
        );
        assert.ok(
            Math.abs(backoffs[1] - 2_000) <= 50,
            `second backoff was ${backoffs[1]}ms`,
        );
        assert.ok(firstWait >= 950, `first wait was ${firstWait}ms`);
        assert.ok(secondWait >= 1_950, `second wait was ${secondWait}ms`);
        third.destroy();
    });

    test("a destroyed client does not reconnect after a reset", async () => {
        const client = await run("destroyedClientResetTest");
        client.destroy();
        const before = reconnects;
        const error = Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
        });
        assert.doesNotThrow(() =>
            (client as any).server.socket.emit("error", error),
        );
        assert.strictEqual(reconnects, before);
    });

    test("a client destroyed mid-reconnect does not log in again", async () => {
        const originalQuickLogin = EAccessClient.quickLogin;
        let releaseLogin!: () => void;
        const loginHeld = new Promise<void>((resolve) => {
            releaseLogin = resolve;
        });
        EAccessClient.quickLogin = (async () => {
            await loginHeld;
            return { gamehost: "127.0.0.1", gameport: gamePort, key: "key" };
        }) as any;
        stubReconnect = false;
        try {
            const queue = "destroyedMidReconnectTest";
            const first: any = await run(queue);
            let reconnecting!: Promise<void>;
            const { reconnect } = first;
            first.reconnect = () => (reconnecting = reconnect.call(first));
            // The replaced client must not open a game connection.
            first.connect = () => {
                throw new Error("Destroyed client connected");
            };
            const error = Object.assign(new Error("read ECONNRESET"), {
                code: "ECONNRESET",
            });
            // Starts an in-place reconnect, held at the play.net login.
            first.server.socket.emit("error", error);
            assert.strictEqual(first.hasServerConnection(), false);

            // A task in that window replaces the client.
            const second = await run(queue);
            assert.notStrictEqual(second, first);

            releaseLogin();
            await assert.rejects(reconnecting, /was destroyed/);
            assert.strictEqual(first.hasServerConnection(), false);
            second.destroy();
        } finally {
            EAccessClient.quickLogin = originalQuickLogin;
        }
    });

    test("closing during the login backoff does not log in", async function () {
        this.timeout(5_000);
        const connectingOn = BaseGameClient.prototype.on;
        let logins = 0;
        BaseGameClient.prototype.on = function (this: any, ...args: any[]) {
            const result = connectingOn.apply(this, args as any);
            const { login } = this;
            this.login = (...loginArgs: unknown[]) => {
                logins++;
                return login.apply(this, loginArgs);
            };
            return result;
        };
        const queue = "closeDuringBackoffTest";
        const first = await run(queue);
        emitSocketTimeout(first);
        // Waits out the 1s backoff before logging in again.
        let backingOff!: () => void;
        const backoffStarted = new Promise<void>((resolve) => {
            backingOff = resolve;
        });
        const relogin = run(queue, (message) => {
            if (message.includes("Waiting")) backingOff();
        });
        await backoffStarted;
        await closeAllEditorClients();

        await assert.rejects(relogin, /shutting down/);
        assert.strictEqual(logins, 1);
    });
});
