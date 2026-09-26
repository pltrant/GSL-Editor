/**
 * Singleton daemon coordination for the GSL MCP Server.
 *
 * Ensures only one process holds game client connections at a time.
 * All MCP harness processes are proxies. A detached daemon owns game clients,
 * so terminating any one harness cannot disconnect the others.
 *
 * Cross-platform:
 *   - Windows: Named pipe (\\.\pipe\gsl-mcp-daemon) — kernel-managed lifecycle
 *   - Linux/macOS: Unix domain socket (~/.gsl/mcp-daemon.sock)
 *
 * Daemon election is atomic: listen() on the socket path either succeeds
 * (you are the daemon) or fails with EADDRINUSE (connect as proxy).
 * Stale Unix socket cleanup checks file identity before removing a refused socket.
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    JSONRPCRequest,
    RequestId,
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Socket path (cross-platform)
// ---------------------------------------------------------------------------

const SOCKET_DIR = path.join(os.homedir(), ".gsl");
const SOCKET_PATH =
    process.env.GSL_MCP_SOCKET_PATH ??
    (process.platform === "win32"
        ? `\\\\.\\pipe\\gsl-mcp-daemon-${os.userInfo().username}`
        : path.join(SOCKET_DIR, "mcp-daemon.sock"));

/** Grace period before daemon exits after all clients disconnect. */
const IDLE_TIMEOUT_MS = 30_000;
/** Timeout for proxy connection attempts. */
const CONNECT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Stale socket cleanup (Unix only — named pipes auto-clean on Windows)
// ---------------------------------------------------------------------------

/**
 * On Unix, a domain socket file persists after an unclean daemon exit.
 * Try to connect; if ECONNREFUSED the socket is stale and safe to unlink.
 */
function cleanStaleSocket(): Promise<void> {
    if (process.platform === "win32") return Promise.resolve();

    return new Promise((resolve) => {
        if (!fs.existsSync(SOCKET_PATH)) {
            resolve();
            return;
        }
        const staleSocket = fs.statSync(SOCKET_PATH, { throwIfNoEntry: false });
        const probe = net.connect(SOCKET_PATH);
        const timeout = setTimeout(() => {
            probe.destroy();
            // A busy daemon is not evidence of a stale socket.
            resolve();
        }, CONNECT_TIMEOUT_MS);
        probe.on("connect", () => {
            // Daemon is alive — leave socket alone, disconnect probe.
            clearTimeout(timeout);
            probe.destroy();
            resolve();
        });
        probe.on("error", (err: NodeJS.ErrnoException) => {
            clearTimeout(timeout);
            if (err.code === "ECONNREFUSED" && staleSocket) {
                tryUnlink(staleSocket);
            }
            resolve();
        });
    });
}

function tryUnlink(owner: fs.Stats): void {
    try {
        const current = fs.statSync(SOCKET_PATH);
        if (current.dev === owner.dev && current.ino === owner.ino) {
            fs.unlinkSync(SOCKET_PATH);
        }
    } catch {
        // Already gone or permission issue — move on.
    }
}

function ensureSocketDir(): void {
    if (process.platform === "win32") return;
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Daemon detection & proxy mode
// ---------------------------------------------------------------------------

/**
 * Attempts to connect to an already-running daemon.
 * Returns the connected socket, or undefined if no daemon is reachable.
 */
export function tryConnectToDaemon(): Promise<net.Socket | undefined> {
    return new Promise((resolve) => {
        const socket = net.connect(SOCKET_PATH);
        const timeout = setTimeout(() => {
            socket.destroy();
            resolve(undefined);
        }, CONNECT_TIMEOUT_MS);
        socket.on("connect", () => {
            clearTimeout(timeout);
            resolve(socket);
        });
        socket.on("error", () => {
            clearTimeout(timeout);
            socket.destroy();
            resolve(undefined);
        });
    });
}

/** Keeps the harness session open across daemon restarts; never replays tools. */
export async function runAsProxy(
    socket: net.Socket,
    connectDaemon: () => Promise<net.Socket>,
): Promise<void> {
    const frontend = new StdioServerTransport();
    const pending = new Set<RequestId>();
    let initialize: JSONRPCRequest | undefined;
    let backend: StdioServerTransport;
    let ready = false;
    let recovering = false;

    function failRequest(id: RequestId, message: string) {
        void frontend.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message },
        });
    }

    async function attach(next: net.Socket): Promise<void> {
        socket = next;
        backend = new StdioServerTransport(next, next);
        const transport = backend;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("Daemon initialization timed out."));
                next.destroy();
            }, 10_000);
            let initializing = recovering && initialize !== undefined;
            transport.onmessage = (message) => {
                if (
                    initializing &&
                    "id" in message &&
                    message.id === initialize?.id &&
                    !("method" in message)
                ) {
                    if ("error" in message) {
                        reject(new Error("Daemon initialization failed."));
                        next.destroy();
                        return;
                    }
                    void transport.send({
                        jsonrpc: "2.0",
                        method: "notifications/initialized",
                    });
                    initializing = false;
                    ready = true;
                    clearTimeout(timer);
                    resolve();
                    return;
                }
                if (
                    "id" in message &&
                    message.id !== undefined &&
                    !("method" in message)
                )
                    pending.delete(message.id);
                void frontend.send(message);
            };
            transport.onerror = () => next.destroy();
            next.on("error", () => next.destroy());
            next.on("close", () => {
                clearTimeout(timer);
                void transport.close();
                reject(new Error("Daemon disconnected during initialization."));
                if (socket !== next) return;
                ready = false;
                for (const id of pending) {
                    failRequest(
                        id,
                        "Daemon disconnected; operation outcome is unknown. Request was not replayed.",
                    );
                }
                pending.clear();
                if (!recovering) void recover();
            });
            void transport.start().then(() => {
                if (initializing) {
                    void transport.send(initialize!);
                } else {
                    ready = true;
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
    }

    async function recover() {
        recovering = true;
        for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((resolve) =>
                setTimeout(resolve, 250 * 2 ** attempt),
            );
            try {
                await attach(await connectDaemon());
                if (socket.destroyed) throw new Error("Daemon disconnected.");
                recovering = false;
                return;
            } catch {
                socket.destroy();
            }
        }
        console.error(
            "[gsl-mcp] Daemon reconnect failed after 3 attempts; restart the MCP connection.",
        );
        process.exit(1);
    }

    frontend.onmessage = (message) => {
        if (!ready || socket.destroyed) {
            if ("id" in message && "method" in message) {
                failRequest(
                    message.id,
                    "Daemon is reconnecting; request was not sent.",
                );
            }
            return;
        }
        if ("id" in message && "method" in message) {
            pending.add(message.id);
            if (message.method === "initialize") initialize = message;
        }
        void backend.send(message);
    };
    frontend.onerror = () => process.exit(1);
    process.stdin.on("end", () => process.exit(0));
    await attach(socket);
    await frontend.start();
}

// ---------------------------------------------------------------------------
// Daemon listener
// ---------------------------------------------------------------------------

export interface DaemonHandle {
    socketPath: string;
    /** Shut down the daemon listener and clean up. */
    close(): void;
}

type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

/**
 * Starts the daemon listener on a Unix domain socket (or Windows named pipe).
 * Creates a new MCP Server for each incoming connection, sharing the provided
 * handler infrastructure.
 *
 * Daemon election is atomic: if listen() succeeds, this process is the daemon.
 * If it fails with EADDRINUSE, returns undefined (caller should become proxy).
 */
export async function startDaemonListener(
    config: {
        handlers: Map<
            string,
            (args: Record<string, unknown>) => Promise<ToolResult>
        >;
        getToolList: () => Array<{
            name: string;
            description: string;
            inputSchema: object;
        }>;
    },
    debugLog: (...args: any[]) => void,
): Promise<DaemonHandle | undefined> {
    ensureSocketDir();
    await cleanStaleSocket();

    return new Promise((resolve, reject) => {
        const clients = new Set<net.Socket>();
        let idleTimer: NodeJS.Timeout | undefined;
        let ownedSocket: fs.Stats | undefined;

        function checkIdle() {
            clearTimeout(idleTimer);
            if (clients.size === 0) {
                idleTimer = setTimeout(() => {
                    debugLog("Idle timeout reached, daemon exiting.");
                    cleanup();
                    process.exit(0);
                }, IDLE_TIMEOUT_MS);
            }
        }

        function cleanup() {
            clearTimeout(idleTimer);
            ipcServer.close();
            for (const s of clients) s.destroy();
            if (ownedSocket) tryUnlink(ownedSocket);
        }

        const ipcServer = net.createServer((socket) => {
            clients.add(socket);
            clearTimeout(idleTimer);
            debugLog(`Client connected (total: ${clients.size})`);

            socket.on("error", (err) => {
                debugLog("Socket error:", err.message);
            });

            const transport = new StdioServerTransport(socket, socket);
            const server = new Server(
                { name: "gsl-tools", version: "1.0.0" },
                { capabilities: { tools: {} } },
            );

            server.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: config.getToolList(),
            }));
            server.setRequestHandler(CallToolRequestSchema, async (request) => {
                const { name, arguments: args } = request.params;
                const handler = config.handlers.get(name);
                if (!handler) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Unknown tool: ${name}`,
                            },
                        ],
                        isError: true,
                    };
                }
                return handler(args ?? {});
            });

            socket.on("close", () => {
                clients.delete(socket);
                server.close().catch(() => {});
                debugLog(`Client disconnected (remaining: ${clients.size})`);
                checkIdle();
            });

            server.connect(transport).catch((err) => {
                debugLog(
                    "Session setup failed:",
                    err instanceof Error ? err.message : err,
                );
                socket.destroy();
                clients.delete(socket);
                checkIdle();
            });
        });

        ipcServer.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                // Another daemon owns the socket — become proxy.
                debugLog("Socket in use, deferring to existing daemon.");
                resolve(undefined);
            } else {
                debugLog("Daemon listen error:", err.message);
                reject(err);
            }
        });

        ipcServer.listen(SOCKET_PATH, () => {
            debugLog(`Daemon listening on ${SOCKET_PATH}`);

            if (process.platform !== "win32") {
                ownedSocket = fs.statSync(SOCKET_PATH);
                fs.chmodSync(SOCKET_PATH, 0o600);
            }
            // Start the timer even if the spawning proxy exits before connecting.
            checkIdle();

            // Only register cleanup once we own the socket.
            process.on("exit", () => {
                if (ownedSocket) tryUnlink(ownedSocket);
            });

            resolve({
                socketPath: SOCKET_PATH,
                close: cleanup,
            });
        });
    });
}
