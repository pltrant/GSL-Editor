import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as net from "net";
import * as path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";

// Exercise the shipped entry point with real processes and IPC, but no game
// credentials. Identical JSON-RPC IDs across clients must remain independent.
class McpProcess {
    readonly child: ChildProcessWithoutNullStreams;
    private nextId = 0;
    private pending = new Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (error: Error) => void;
        }
    >();

    constructor(env: NodeJS.ProcessEnv) {
        this.child = spawn(
            process.execPath,
            [path.resolve(__dirname, "../../gsl/mcp/mcpServer.bundle.js")],
            { env, stdio: "pipe" },
        );
        this.child.stderr.resume();
        createInterface({ input: this.child.stdout }).on("line", (line) => {
            const message = JSON.parse(line);
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
        });
        const fail = (error: Error) => {
            for (const request of this.pending.values()) request.reject(error);
            this.pending.clear();
        };
        this.child.on("error", fail);
        this.child.on("exit", () => fail(new Error("MCP process exited")));
        this.child.stdin.on("error", fail);
    }

    async request(method: string, params: object = {}): Promise<any> {
        const id = ++this.nextId;
        let timer: NodeJS.Timeout | undefined;
        try {
            return await new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`Timed out: ${method}`));
                }, 15_000);
                this.child.stdin.write(
                    JSON.stringify({ jsonrpc: "2.0", id, method, params }) +
                        "\n",
                );
            });
        } finally {
            clearTimeout(timer);
        }
    }

    async initialize(): Promise<void> {
        await this.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "concurrency-test", version: "1" },
        });
        this.child.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
            }) + "\n",
        );
    }

    async author(): Promise<void> {
        const result = await this.request("tools/call", {
            name: "gsl_get_current_author",
            arguments: {},
        });
        assert.deepStrictEqual(result.content, [
            { type: "text", text: "Test/Author" },
        ]);
        assert.ok(!result.isError);
    }

    async stop(signal?: NodeJS.Signals): Promise<void> {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        const exited = new Promise<void>((resolve) =>
            this.child.once("exit", () => resolve()),
        );
        if (signal) this.child.kill(signal);
        else this.child.stdin.end();
        await exited;
    }
}

suite("MCP daemon process isolation", function () {
    this.timeout(60_000);

    test("concurrent clients survive the first harness exiting and idle cleanup", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-mcp-test-"));
        const socketPath =
            process.platform === "win32"
                ? `\\\\.\\pipe\\gsl-mcp-test-${process.pid}-${Date.now()}`
                : path.join(home, "daemon.sock");
        const configPath = path.join(home, "login.json");
        // No configured instances: enrichment cannot make a network connection.
        fs.writeFileSync(
            configPath,
            JSON.stringify({ account: "test", author: "Test/Author" }),
        );
        const env = {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            ELECTRON_RUN_AS_NODE: "1",
            GSL_LOGIN_CONFIG_FILE: configPath,
            GSL_PASSWORD: "test-only",
            GSL_MCP_SOCKET_PATH: socketPath,
            GSL_MCP_DEBUG: "1",
        };
        const clients: McpProcess[] = [];
        try {
            // Race cold starts, then terminate every possible first launcher.
            for (let i = 0; i < 5; i++) clients.push(new McpProcess(env));
            await Promise.all(clients.map((client) => client.initialize()));
            await Promise.all(clients.map((client) => client.author()));
            for (const client of clients.slice(0, 4)) {
                await client.stop("SIGTERM");
                await clients[4].author();
            }
            const newcomer = new McpProcess(env);
            clients.push(newcomer);
            await newcomer.initialize();
            await clients[4].stop("SIGKILL");
            await newcomer.author();
            const logPath = path.join(home, ".gsl", "mcp-daemon.log");
            const log = fs.readFileSync(logPath, "utf8");
            assert.strictEqual(
                (log.match(/Starting \/agent enrichment/g) ?? []).length,
                1,
                "only the election winner may access the game client",
            );
            await newcomer.stop();
            // The daemon must exit after the last client disconnects, including
            // clients killed without closing stdin cleanly.
            // It logs the idle timeout before shutting down, so also wait for
            // the shutdown to remove its socket.
            const deadline = Date.now() + 35_000;
            let idle = false;
            let socketRemoved = process.platform === "win32";
            while (!idle || !socketRemoved) {
                assert.ok(
                    Date.now() < deadline,
                    idle
                        ? "daemon did not remove its socket when idle"
                        : "daemon did not exit when idle",
                );
                await new Promise((resolve) => setTimeout(resolve, 100));
                idle ||= fs
                    .readFileSync(logPath, "utf8")
                    .includes("Idle timeout reached");
                socketRemoved ||= idle && !fs.existsSync(socketPath);
            }
        } finally {
            await Promise.all(clients.map((client) => client.stop("SIGKILL")));
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
    test("SIGTERM logs out the daemon's game session before exiting", async function () {
        // Windows has no signals: kill() terminates the process outright.
        if (process.platform === "win32") this.skip();
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-shutdown-"));
        const configPath = path.join(home, "login.json");
        // The /agent enrichment logs in to dev at startup.
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                account: "test",
                author: "Test/Author",
                devInstance: "GS4D",
                devCharacter: "TestChar",
            }),
        );
        const gameServer = net.createServer();
        await new Promise<void>((resolve) =>
            gameServer.listen(0, "127.0.0.1", resolve),
        );
        const connected = new Promise<net.Socket>((resolve) =>
            gameServer.once("connection", resolve),
        );
        const daemon = spawn(
            process.execPath,
            [
                "--require",
                path.resolve(__dirname, "fakePlayNetPreload.js"),
                path.resolve(__dirname, "../../gsl/mcp/mcpServer.bundle.js"),
                "--daemon",
            ],
            {
                env: {
                    ...process.env,
                    HOME: home,
                    USERPROFILE: home,
                    ELECTRON_RUN_AS_NODE: "1",
                    GSL_LOGIN_CONFIG_FILE: configPath,
                    GSL_PASSWORD: "test-only",
                    GSL_MCP_DEBUG: "1",
                    GSL_MCP_SOCKET_PATH: path.join(home, "daemon.sock"),
                    FAKE_GAME_PORT: String(
                        (gameServer.address() as net.AddressInfo).port,
                    ),
                },
                stdio: ["ignore", "ignore", "pipe"],
            },
        );
        // "close" waits for stderr to be read to the end.
        const exited = new Promise<number | null>((resolve) =>
            daemon.once("close", resolve),
        );
        // Fail at once, not at the test timeout, if the daemon dies early.
        const exitedEarly = exited.then((code) => {
            throw new Error(`daemon exited (${code}) before logging in`);
        });
        exitedEarly.catch(() => {});
        const stderr: string[] = [];
        createInterface({ input: daemon.stderr }).on("line", (line) => {
            stderr.push(line);
            // A prompt in the same read as the mode line is dropped, so send
            // it once the daemon logs the mode switch.
            if (line.includes("setConnectionMode")) {
                void connected.then((gameSocket) => gameSocket.write(">"));
            }
        });
        try {
            const gameSocket = await Promise.race([connected, exitedEarly]);
            gameSocket.write('<mode id="GAME"/>\n');
            let received = "";
            await Promise.race([
                new Promise<void>((resolve) =>
                    gameSocket.on("data", (data) => {
                        received += data.toString();
                        // Logged in: the enrichment sent its /agent command.
                        if (received.includes("/agent")) resolve();
                    }),
                ),
                exitedEarly,
            ]);
            const ended = new Promise((resolve) =>
                gameSocket.once("end", resolve),
            );

            daemon.kill("SIGTERM");
            await ended;

            assert.ok(received.endsWith("quit\n"));
            assert.strictEqual(await exited, 0);
            // The exit hook also writes the quit, but only the awaited
            // logout sees the socket close before the daemon exits.
            const shutdownAt = stderr.findIndex((line) =>
                line.includes("Shutting down"),
            );
            assert.ok(shutdownAt >= 0);
            assert.ok(
                stderr
                    .slice(shutdownAt)
                    .some((line) => line.includes("Connection#socketClose()")),
            );
        } finally {
            daemon.kill("SIGKILL");
            await new Promise((resolve) => gameServer.close(resolve));
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
    test("proxies reinitialize after disconnect and never replay interrupted calls", async () => {
        const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), "gsl-reconnect-"),
        );
        const socketPath =
            process.platform === "win32"
                ? `\\\\.\\pipe\\gsl-reconnect-${process.pid}`
                : path.join(directory, "daemon.sock");
        const sockets = new Set<net.Socket>();
        let initialized = 0;
        let calls = 0;
        let rejectInitialization = false;
        const fakeDaemon = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("error", () => {});
            socket.on("close", () => sockets.delete(socket));
            let ready = false;
            createInterface({ input: socket }).on("line", (line) => {
                const message = JSON.parse(line);
                if (message.method === "initialize") {
                    socket.write(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: message.id,
                            ...(rejectInitialization
                                ? {
                                      error: {
                                          code: -32603,
                                          message: "unavailable",
                                      },
                                  }
                                : {
                                      result: {
                                          protocolVersion: "2024-11-05",
                                          capabilities: {},
                                          serverInfo: {
                                              name: "test",
                                              version: "1",
                                          },
                                      },
                                  }),
                        }) + "\n",
                    );
                } else if (message.method === "notifications/initialized") {
                    ready = true;
                    initialized++;
                } else if (message.method === "tools/call") {
                    assert.ok(
                        ready,
                        "tool forwarded before session initialization",
                    );
                    calls++;
                    if (message.params.name === "hang") return;
                    socket.write(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: message.id,
                            result: {
                                content: [
                                    { type: "text", text: "Test/Author" },
                                ],
                            },
                        }) + "\n",
                    );
                }
            });
        });
        await new Promise<void>((resolve) =>
            fakeDaemon.listen(socketPath, resolve),
        );
        const env = {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            GSL_MCP_SOCKET_PATH: socketPath,
        };
        const clients = [new McpProcess(env), new McpProcess(env)];
        async function waitUntil(check: () => boolean) {
            const deadline = Date.now() + 5000;
            while (!check()) {
                assert.ok(
                    Date.now() < deadline,
                    "reconnect condition timed out",
                );
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        try {
            await Promise.all(clients.map((client) => client.initialize()));
            await waitUntil(() => initialized === 2);
            const interrupted = clients.map((client) =>
                assert.rejects(
                    client.request("tools/call", { name: "hang" }),
                    /outcome is unknown.*not replayed/,
                ),
            );
            await waitUntil(() => calls === 2);
            for (const socket of sockets) socket.destroy();
            await Promise.all(interrupted);
            await assert.rejects(
                clients[0].author(),
                /reconnecting; request was not sent/,
            );
            await waitUntil(() => initialized === 4);
            await Promise.all(clients.map((client) => client.author()));
            assert.strictEqual(
                calls,
                4,
                "interrupted calls must not be replayed",
            );
            // Repeated reconnect failures must eventually terminate the shim.
            rejectInitialization = true;
            for (const socket of sockets) socket.destroy();
            await waitUntil(() =>
                clients.every((client) => client.child.exitCode !== null),
            );
            for (const client of clients)
                assert.strictEqual(client.child.exitCode, 1);
        } finally {
            await Promise.all(clients.map((client) => client.stop("SIGKILL")));
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) =>
                fakeDaemon.close(() => resolve()),
            );
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
