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
import * as path from "path";
import { spawn } from "child_process";
import {
    AgentToolOrchestrator,
    AgentToolOrchestratorDeps,
} from "../agentToolOrchestrator.js";
import { loadLoginConfig } from "./mcpConfig.js";
import { TOOL_DEFINITIONS, createMcpToolHandler } from "./mcpTools.js";
import {
    tryConnectToDaemon,
    runAsProxy,
    startDaemonListener,
} from "./mcpDaemon.js";

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

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

    // Every harness owns only a proxy. The detached daemon must outlive the
    // harness that first starts it (including SIGTERM/SIGKILL of that proxy).
    if (!process.argv.includes("--daemon")) {
        let socket = await tryConnectToDaemon();
        if (!socket) {
            const logDir = path.join(os.homedir(), ".gsl");
            fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
            const logPath = path.join(logDir, "mcp-daemon.log");
            const logFd = fs.openSync(logPath, "a", 0o600);
            const child = spawn(process.execPath, [__filename, "--daemon"], {
                detached: true,
                stdio: ["ignore", "ignore", logFd],
                env: process.env,
                windowsHide: true,
            });
            fs.closeSync(logFd);
            let spawnError: Error | undefined;
            child.on("error", (error) => {
                spawnError = error;
            });
            child.unref();

            const deadline = Date.now() + 10_000;
            while (!socket && Date.now() < deadline) {
                if (spawnError) throw spawnError;
                await new Promise((resolve) => setTimeout(resolve, 100));
                socket = await tryConnectToDaemon();
            }
            if (!socket) {
                throw new Error(
                    `Daemon did not become reachable. See ${logPath}`,
                );
            }
        }
        runAsProxy(socket);
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

    let agentHelpText: string | undefined;

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

    const daemon = await startDaemonListener(
        { handlers, getToolList },
        debugLog,
    );

    // Losing election candidates never open game connections.
    if (!daemon) return;
    log(`Daemon listening on ${daemon.socketPath}`);

    // Fetch /agent subcommand list from dev for description enrichment.
    // Fired asynchronously so it does not block server startup.
    // Best-effort — failures are silently ignored so the server always starts.
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

    // Graceful shutdown
    const shutdown = () => {
        debugLog("Shutting down...");
        daemon.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("[gsl-mcp] Fatal error:", err);
    process.exit(1);
});
