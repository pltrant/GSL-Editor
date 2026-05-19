#!/usr/bin/env node

/**
 * GSL MCP Server
 *
 * Exposes GSL Editor tooling over the Model Context Protocol (MCP) so that
 * non-VS-Code agent harnesses (Claude Code, Codex CLI, etc.) can query
 * the game server.
 *
 * Configuration is via environment variables:
 *   GSL_PASSWORD           – Play.net password (REQUIRED, never stored in file)
 *   GSL_ACCOUNT            – Play.net account name (or use login config file)
 *   GSL_DEV_INSTANCE       – Dev EAccess instance code  (e.g. GS4D)
 *   GSL_DEV_CHARACTER      – Dev character name
 *   GSL_PRIME_INSTANCE     – Prime EAccess instance code (e.g. GS3)
 *   GSL_PRIME_CHARACTER    – Prime character name
 *   GSL_SHATTERED_INSTANCE – Shattered EAccess instance code (e.g. GSF)
 *   GSL_SHATTERED_CHARACTER– Shattered character name
 *   GSL_PLATINUM_INSTANCE  – Platinum EAccess instance code (e.g. GS4X)
 *   GSL_PLATINUM_CHARACTER – Platinum character name
 *   GSL_TEST_INSTANCE      – Test EAccess instance code (e.g. GST)
 *   GSL_TEST_CHARACTER     – Test character name
 *   GSL_AUTHOR             – Changelog author (e.g. AlexB/Nyxus)
 *   GSL_DOWNLOAD_PATH      – Path for temporary script files (defaults to OS tmpdir)
 *
 * Alternatively, supply GSL_LOGIN_CONFIG_FILE pointing at a JSON file with
 * the same keys (camelCase) for non-secret values. The password must always
 * be provided via GSL_PASSWORD.
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

interface InstanceConfig {
    envInstance: string;
    envCharacter: string;
    fileInstance: keyof LoginConfigFile;
    fileCharacter: keyof LoginConfigFile;
}

const INSTANCE_CONFIGS: Record<GameInstance, InstanceConfig> = {
    dev: {
        envInstance: "GSL_DEV_INSTANCE",
        envCharacter: "GSL_DEV_CHARACTER",
        fileInstance: "devInstance",
        fileCharacter: "devCharacter",
    },
    prime: {
        envInstance: "GSL_PRIME_INSTANCE",
        envCharacter: "GSL_PRIME_CHARACTER",
        fileInstance: "primeInstance",
        fileCharacter: "primeCharacter",
    },
    shattered: {
        envInstance: "GSL_SHATTERED_INSTANCE",
        envCharacter: "GSL_SHATTERED_CHARACTER",
        fileInstance: "shatteredInstance",
        fileCharacter: "shatteredCharacter",
    },
    platinum: {
        envInstance: "GSL_PLATINUM_INSTANCE",
        envCharacter: "GSL_PLATINUM_CHARACTER",
        fileInstance: "platinumInstance",
        fileCharacter: "platinumCharacter",
    },
    test: {
        envInstance: "GSL_TEST_INSTANCE",
        envCharacter: "GSL_TEST_CHARACTER",
        fileInstance: "testInstance",
        fileCharacter: "testCharacter",
    },
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

    const account = process.env.GSL_ACCOUNT ?? file.account;
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
                "No account configured. Set GSL_ACCOUNT environment variable " +
                'or add "account" to your login config file.',
        };
    }

    const author = process.env.GSL_AUTHOR ?? file.author;
    const downloadPath =
        process.env.GSL_DOWNLOAD_PATH ?? file.downloadPath ?? os.tmpdir();

    const credentials = new Map<GameInstance, LoginCredentials>();

    for (const [key, cfg] of Object.entries(INSTANCE_CONFIGS)) {
        const instance =
            process.env[cfg.envInstance] ??
            (file[cfg.fileInstance] as string | undefined);
        const character =
            process.env[cfg.envCharacter] ??
            (file[cfg.fileCharacter] as string | undefined);
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
    const { credentials, author, downloadPath, configError } =
        loadLoginConfig();

    const deps: AgentToolOrchestratorDeps = {
        getCredentials: async (instance) => credentials.get(instance),
        getCurrentAuthor: () => author,
        downloadLocation: downloadPath,
        console: {
            log: (...args: any[]) => console.error("[gsl-mcp]", ...args),
        },
    };

    const orchestrator = new AgentToolOrchestrator(deps);

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

    // tools/list
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOL_DEFINITIONS.map((def) => ({
            name: def.name,
            description: def.description,
            inputSchema: def.inputSchema,
        })),
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

    // Start stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[gsl-mcp] Server started on stdio");

    // Graceful shutdown
    const shutdown = async () => {
        console.error("[gsl-mcp] Shutting down...");
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
