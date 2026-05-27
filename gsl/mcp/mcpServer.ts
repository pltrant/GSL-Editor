#!/usr/bin/env node

/**
 * GSL MCP Server
 *
 * Exposes GSL Editor tooling over the Model Context Protocol (MCP) so that
 * non-VS-Code agent harnesses (Claude Code, Codex CLI, etc.) can query
 * the game server.
 *
 * Configuration is via environment variables:
 *   GSL_LOGIN_CONFIG_FILE  – Absolute path to JSON config file (created by GSL: User Setup)
 *   GSL_PASSWORD           – Play.net password (REQUIRED, never stored in file)
 *   GSL_DOWNLOAD_PATH      – Absolute path for script files (defaults to OS tmpdir)
 *
 * The login config file contains account, instance, character, and author
 * values. See the extension README for the expected shape.
 */

import * as fs from "fs";
import * as os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
    AgentToolOrchestrator,
    AgentToolOrchestratorDeps,
    LoginCredentials,
    GameInstance,
} from "../agentToolOrchestrator.js";
import { TOOL_DEFINITIONS, createMcpToolHandler } from "./mcpTools.js";
import {
    tryConnectToDaemon,
    runAsProxy,
    startDaemonListener,
} from "./mcpDaemon.js";

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

interface LoginConfigFile {
    account?: string;
    devInstance?: string;
    devCharacter?: string;
    primeInstance?: string;
    primeCharacter?: string;
    shatteredInstance?: string;
    shatteredCharacter?: string;
    platinumInstance?: string;
    platinumCharacter?: string;
    testInstance?: string;
    testCharacter?: string;
    author?: string;
    downloadPath?: string;
}

const INSTANCE_FILE_KEYS: Record<
    GameInstance,
    { instance: keyof LoginConfigFile; character: keyof LoginConfigFile }
> = {
    dev: { instance: "devInstance", character: "devCharacter" },
    prime: { instance: "primeInstance", character: "primeCharacter" },
    shattered: {
        instance: "shatteredInstance",
        character: "shatteredCharacter",
    },
    platinum: {
        instance: "platinumInstance",
        character: "platinumCharacter",
    },
    test: { instance: "testInstance", character: "testCharacter" },
};

function loadLoginConfig(): {
    credentials: Map<GameInstance, LoginCredentials>;
    author: string | undefined;
    downloadPath: string;
    configError: string | undefined;
} {
    const loginConfigPath = process.env.GSL_LOGIN_CONFIG_FILE;
    if (!loginConfigPath) {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                "GSL_LOGIN_CONFIG_FILE environment variable is not set. " +
                "Point it at your loginConfig.json (typically ~/.gsl/loginConfig.json). " +
                "Run 'GSL: User Setup' in VS Code to create one, or see the extension README.",
        };
    }

    let file: LoginConfigFile = {};
    if (fs.existsSync(loginConfigPath)) {
        try {
            file = JSON.parse(fs.readFileSync(loginConfigPath, "utf8"));
        } catch (e) {
            return {
                credentials: new Map(),
                author: undefined,
                downloadPath: os.tmpdir(),
                configError:
                    `Failed to parse login config file at ${loginConfigPath}: ` +
                    `${e instanceof Error ? e.message : e}`,
            };
        }
    } else {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                `Login config file not found at ${loginConfigPath}. ` +
                "Run 'GSL: User Setup' in VS Code to create one, or see the extension README.",
        };
    }

    const account = file.account;
    const password = process.env.GSL_PASSWORD;

    if (!password) {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                "GSL_PASSWORD environment variable is not set. " +
                "The MCP server requires GSL_PASSWORD to authenticate with the game server.",
        };
    }

    if (!account) {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                'No account configured. Add "account" to your login config file.',
        };
    }

    const author = file.author;
    const downloadPath =
        process.env.GSL_DOWNLOAD_PATH ?? file.downloadPath ?? os.tmpdir();

    const credentials = new Map<GameInstance, LoginCredentials>();

    for (const [key, cfg] of Object.entries(INSTANCE_FILE_KEYS)) {
        const instance = file[cfg.instance] as string | undefined;
        const character = file[cfg.character] as string | undefined;
        if (instance && character) {
            credentials.set(key as GameInstance, {
                account,
                password,
                instance,
                character,
            });
        }
    }

    return { credentials, author, downloadPath, configError: undefined };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const debug = !!process.env.GSL_MCP_DEBUG;
    const log = (...args: any[]) => console.error("[gsl-mcp]", ...args);
    const debugLog = debug
        ? (...args: any[]) =>
              console.error(`[gsl-mcp ${new Date().toISOString()}]`, ...args)
        : () => {};

    // -----------------------------------------------------------------------
    // Singleton coordination: if a daemon is already running, become a proxy.
    // -----------------------------------------------------------------------
    const existingDaemon = await tryConnectToDaemon();
    if (existingDaemon) {
        log("Connected to existing daemon, running as proxy.");
        runAsProxy(existingDaemon);
        return;
    }

    const { credentials, author, downloadPath, configError } =
        loadLoginConfig();

    const deps: AgentToolOrchestratorDeps = {
        getCredentials: async (instance) => credentials.get(instance),
        getCurrentAuthor: () => author,
        downloadLocation: downloadPath,
        console: {
            log: (...args: any[]) => debugLog(...args),
        },
    };

    const orchestrator = new AgentToolOrchestrator(deps);

    // Fetch /agent subcommand list from dev for description enrichment.
    // Fired asynchronously so it does not block server startup.
    // Best-effort — failures are silently ignored so the server always starts.
    let agentHelpText: string | undefined;
    if (!configError) {
        const startTime = Date.now();
        debugLog("Starting /agent enrichment fetch on dev...");
        orchestrator
            .executeAgentCommand("", "dev")
            .then((output) => {
                if (output?.trim()) {
                    const trimmed = output.trim();
                    agentHelpText =
                        trimmed.length > 2000
                            ? trimmed.slice(0, 2000) + "\n...truncated..."
                            : trimmed;
                    log(
                        `Fetched /agent subcommand list (${Date.now() - startTime}ms).`,
                    );
                }
            })
            .catch((err) => {
                debugLog(
                    `Failed to fetch /agent subcommand list (${Date.now() - startTime}ms):`,
                    err instanceof Error ? err.message : err,
                );
            });
    }

    // Build handler lookup
    const handlers = new Map<
        string,
        (args: Record<string, unknown>) => Promise<{
            content: Array<{ type: "text"; text: string }>;
            isError?: boolean;
        }>
    >();
    for (const def of TOOL_DEFINITIONS) {
        if (configError) {
            // Server starts but every tool reports the config problem
            handlers.set(def.name, async () => ({
                content: [{ type: "text" as const, text: configError }],
                isError: true,
            }));
        } else {
            handlers.set(
                def.name,
                createMcpToolHandler(def.name, orchestrator),
            );
        }
    }

    const server = new Server(
        { name: "gsl-tools", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );

    // Shared tool-list getter (used by both primary server and daemon)
    function getToolList() {
        return TOOL_DEFINITIONS.map((def) => ({
            name: def.name,
            description:
                def.name === "gsl_slash_agent_command" && agentHelpText
                    ? def.description +
                      "\n\nLast seen /agent output on dev:\n" +
                      agentHelpText
                    : def.description,
            inputSchema: def.inputSchema,
        }));
    }

    // tools/list
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: getToolList(),
    }));

    // tools/call
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const handler = handlers.get(name);
        if (!handler) {
            return {
                content: [
                    { type: "text" as const, text: `Unknown tool: ${name}` },
                ],
                isError: true,
            };
        }
        return handler(args ?? {});
    });

    // -------------------------------------------------------------------
    // Daemon listener: accept additional MCP clients over IPC.
    // -------------------------------------------------------------------
    const daemon = await startDaemonListener(
        { handlers, getToolList },
        debugLog,
    );

    // If startDaemonListener returns undefined, the socket was already
    // owned by another daemon. Fall back to proxy mode.
    if (!daemon) {
        log("Socket in use, retrying as proxy.");
        const retrySocket = await tryConnectToDaemon();
        if (retrySocket) {
            runAsProxy(retrySocket);
            return;
        }
        // Extremely unlikely: the owner died between our listen attempt
        // and this connect. Exit and let the harness restart us.
        log("Daemon unreachable. Exiting.");
        process.exit(1);
    }

    log(`Daemon listening on ${daemon.socketPath}`);

    // Start stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("Server started on stdio");

    // Allow the daemon to close the primary MCP server before idle exit.
    daemon.onBeforeIdleExit(async () => {
        debugLog("Closing primary server before idle exit.");
        await server.close();
    });

    // Detect primary stdio EOF directly (not via SDK onclose which may
    // be overwritten). This triggers the idle countdown reliably.
    process.stdin.on("end", () => {
        debugLog("Primary stdio client disconnected (stdin EOF).");
        daemon.notifyStdioClosed();
    });
    process.stdin.on("close", () => {
        daemon.notifyStdioClosed();
    });

    // Graceful shutdown
    const shutdown = async () => {
        debugLog("Shutting down...");
        daemon.close();
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("[gsl-mcp] Fatal error:", err);
    process.exit(1);
});
