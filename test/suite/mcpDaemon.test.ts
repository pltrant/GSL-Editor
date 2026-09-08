import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
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
            const deadline = Date.now() + 35_000;
            while (
                !fs
                    .readFileSync(logPath, "utf8")
                    .includes("Idle timeout reached")
            ) {
                assert.ok(
                    Date.now() < deadline,
                    "daemon did not exit when idle",
                );
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (process.platform !== "win32")
                assert.ok(!fs.existsSync(socketPath));
        } finally {
            await Promise.all(clients.map((client) => client.stop("SIGKILL")));
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
