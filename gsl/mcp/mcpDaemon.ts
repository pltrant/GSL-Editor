/**
 * Singleton daemon coordination for the GSL MCP Server.
 *
 * Ensures only one process holds game client connections at a time.
 * The first MCP server process becomes the daemon (also serving its own
 * stdio client). Subsequent processes detect the daemon via a socket path
 * and run as thin proxies, piping stdio directly to the daemon.
 *
 * Cross-platform:
 *   - Windows: Named pipe (\\.\pipe\gsl-mcp-daemon) — kernel-managed lifecycle
 *   - Linux/macOS: Unix domain socket (~/.gsl/mcp-daemon.sock)
 *
 * Daemon election is atomic: listen() on the socket path either succeeds
 * (you are the daemon) or fails with EADDRINUSE (connect as proxy).
 * No lockfile, no TOCTOU race.
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Socket path (cross-platform)
// ---------------------------------------------------------------------------

const SOCKET_DIR = path.join(os.homedir(), ".gsl");
const SOCKET_PATH =
    process.platform === "win32"
        ? `\\\\.\\pipe\\gsl-mcp-daemon-${os.userInfo().username}`
        : path.join(SOCKET_DIR, "mcp-daemon.sock");

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
        const probe = net.connect(SOCKET_PATH);
        const timeout = setTimeout(() => {
            probe.destroy();
            tryUnlink();
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
            if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
                tryUnlink();
            }
            resolve();
        });
    });
}

function tryUnlink(): void {
    try {
        fs.unlinkSync(SOCKET_PATH);
    } catch {
        // Already gone or permission issue — move on.
    }
}

function ensureSocketDir(): void {
    if (process.platform === "win32") return;
    fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
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
            resolve(undefined);
        });
    });
}

/**
 * Proxy mode: forward stdin/stdout to/from the daemon socket.
 * The process exits when the connection closes.
 */
export function runAsProxy(socket: net.Socket): void {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);

    socket.on("close", () => process.exit(0));
    socket.on("error", () => process.exit(1));
    process.stdin.on("end", () => socket.end());
}

// ---------------------------------------------------------------------------
// Daemon listener
// ---------------------------------------------------------------------------

export interface DaemonHandle {
    socketPath: string;
    /** Signal that the primary stdio client has disconnected. */
    notifyStdioClosed(): void;
    /** Register a callback invoked before the daemon exits due to idle timeout. */
    onBeforeIdleExit(fn: () => Promise<void>): void;
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

    return new Promise((resolve) => {
        const clients = new Set<net.Socket>();
        let stdioClosed = false;
        let idleTimer: NodeJS.Timeout | undefined;
        let beforeIdleExitHook: (() => Promise<void>) | undefined;

        function checkIdle() {
            clearTimeout(idleTimer);
            if (clients.size === 0 && stdioClosed) {
                idleTimer = setTimeout(async () => {
                    debugLog("Idle timeout reached, daemon exiting.");
                    if (beforeIdleExitHook) {
                        await Promise.race([
                            beforeIdleExitHook(),
                            new Promise((r) => setTimeout(r, 5_000)),
                        ]).catch((e) =>
                            debugLog("beforeIdleExit hook error:", e),
                        );
                    }
                    cleanup();
                    process.exit(0);
                }, IDLE_TIMEOUT_MS);
            }
        }

        function cleanup() {
            clearTimeout(idleTimer);
            beforeIdleExitHook = undefined;
            ipcServer.close();
            for (const s of clients) s.destroy();
            if (process.platform !== "win32") tryUnlink();
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
                resolve(undefined);
            }
        });

        ipcServer.listen(SOCKET_PATH, () => {
            debugLog(`Daemon listening on ${SOCKET_PATH}`);

            // Only register cleanup once we own the socket.
            process.on("exit", () => {
                if (process.platform !== "win32") tryUnlink();
            });

            resolve({
                socketPath: SOCKET_PATH,
                notifyStdioClosed() {
                    stdioClosed = true;
                    checkIdle();
                },
                onBeforeIdleExit(fn: () => Promise<void>) {
                    beforeIdleExitHook = fn;
                },
                close: cleanup,
            });
        });
    });
}
