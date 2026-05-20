import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch } from "diff";
import { AgentToolOrchestrator, GameInstance } from "../agentToolOrchestrator";
import { TOOL_DEFINITIONS } from "./toolDefinitions";

export { TOOL_DEFINITIONS };

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface McpToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function parseRequiredPositiveInt(value: unknown, label: string): number {
    if (
        value === undefined ||
        value === null ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 999999
    ) {
        throw new Error(
            `Missing or invalid ${label}. Expected an integer between 1 and 999999.`,
        );
    }
    return value;
}

function parseDiffContext(value: unknown): number {
    if (value === undefined || value === null) return 3;
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 100
    ) {
        throw new Error(
            "Invalid context. Expected an integer between 0 and 100.",
        );
    }
    return value;
}

function parseRequiredRoomId(value: unknown): number {
    if (
        value === undefined ||
        value === null ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1
    ) {
        throw new Error(
            "Missing or invalid roomId. Provide a positive integer.",
        );
    }
    return value;
}

function parseRequiredExistenceId(value: unknown): number {
    if (
        value === undefined ||
        value === null ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value === 0
    ) {
        throw new Error(
            "Missing or invalid existenceId. Provide a non-zero integer.",
        );
    }
    return value;
}

const VALID_SVF_VERBOSITIES = new Set(["Full", "NoTables", "SkipDefaults"]);

const VALID_INSTANCES = new Set<GameInstance>([
    "dev",
    "prime",
    "shattered",
    "platinum",
    "test",
]);

function parseInstance(
    value: unknown,
    defaultValue: GameInstance,
): GameInstance {
    if (value === undefined || value === null) return defaultValue;
    if (
        typeof value !== "string" ||
        !VALID_INSTANCES.has(value as GameInstance)
    ) {
        throw new Error(
            `Invalid instance '${value}'. Must be one of: ${[...VALID_INSTANCES].join(", ")}.`,
        );
    }
    return value as GameInstance;
}

const SCRIPT_DATA_GAME_CODES: Record<GameInstance, string> = {
    dev: "GS4D",
    shattered: "GSF",
    prime: "GS4",
    test: "GST",
    platinum: "GS4X",
};

// ---------------------------------------------------------------------------
// Tool handler factory
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

function textResult(text: string): McpToolResult {
    return { content: [{ type: "text", text }] };
}

function errorResult(message: string): McpToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
}

function formatCompileResults(
    filename: string,
    compileResults: {
        status: number;
        script: number;
        path: string;
        bytes: number;
        maxBytes: number;
        errors: number;
        warnings: number;
        errorList: Array<{ line: number; message: string }>;
    },
): string {
    // ScriptCompileStatus.Failed === 5
    if (compileResults.status === 5) {
        const messages = compileResults.errorList.length
            ? compileResults.errorList
                  .map((error) => `line ${error.line}: ${error.message}`)
                  .join("\n")
            : "(No line-level compiler errors were captured.)";
        return [
            `Compile failed for ${filename} (uploaded as script ${compileResults.script || 24661}).`,
            `Errors: ${compileResults.errors}, warnings: ${compileResults.warnings}.`,
            "",
            messages,
        ].join("\n");
    }

    // ScriptCompileStatus.Compiled === 4
    if (compileResults.status === 4) {
        const bytesRemaining = compileResults.maxBytes - compileResults.bytes;
        return [
            `Compile OK for ${filename} (uploaded as script ${compileResults.script || 24661}).`,
            `Warnings: ${compileResults.warnings}.`,
            `Size: ${compileResults.bytes.toLocaleString()} bytes (${bytesRemaining.toLocaleString()} bytes remaining).`,
            compileResults.path ? `Server path: ${compileResults.path}` : "",
        ]
            .filter(Boolean)
            .join("\n");
    }

    return `Upload finished for ${filename}, but compiler status was inconclusive.`;
}

/**
 * Creates an MCP tool handler function for the given tool name.
 * The handler takes validated arguments and returns an MCP-compatible result.
 */
export function createMcpToolHandler(
    name: string,
    orchestrator: AgentToolOrchestrator,
): ToolHandler {
    switch (name) {
        case "gsl_get_current_author":
            return async () => {
                const author = orchestrator.getCurrentAuthor()?.trim();
                if (!author) {
                    return errorResult(
                        "Author is not configured. Run 'GSL: User Setup'.",
                    );
                }
                return textResult(author);
            };

        case "gsl_get_room_data":
            return async (args) => {
                try {
                    const roomId = parseRequiredRoomId(args.roomId);
                    const instance = parseInstance(args.instance, "dev");
                    const output = await orchestrator.getRoomData(
                        roomId,
                        instance,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `Room ${roomId}: No data returned from ${instance} server. The room may not exist.`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_get_existence_data":
            return async (args) => {
                try {
                    const existenceId = parseRequiredExistenceId(
                        args.existenceId,
                    );
                    const instance = parseInstance(args.instance, "dev");
                    const output = await orchestrator.getExistenceData(
                        existenceId,
                        instance,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `Existence ${existenceId}: No data returned from ${instance} server. The existence may not exist.`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_get_player_varfields":
            return async (args) => {
                try {
                    const playerName = args.playerName as string | undefined;
                    if (!playerName?.trim()) {
                        throw new Error(
                            "Missing playerName. Provide the player name to look up.",
                        );
                    }
                    const verbosity =
                        (args.verbosity as
                            | "Full"
                            | "NoTables"
                            | "SkipDefaults") ?? "NoTables";
                    if (!VALID_SVF_VERBOSITIES.has(verbosity)) {
                        throw new Error(
                            `Invalid verbosity '${verbosity}'. Must be Full, NoTables, or SkipDefaults.`,
                        );
                    }
                    const instance = parseInstance(args.instance, "dev");
                    const output = await orchestrator.getPlayerVarfields(
                        playerName.trim(),
                        verbosity,
                        instance,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `Player ${playerName.trim()}: No data returned from ${instance} server. The player may not exist or may not be logged in.`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_slash_agent_command":
            return async (args) => {
                try {
                    const raw = args.command;
                    const command =
                        raw === undefined || raw === null
                            ? ""
                            : String(raw).trim();
                    const instance = parseInstance(args.instance, "dev");
                    const output = await orchestrator.executeAgentCommand(
                        command,
                        instance,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `No output returned from /agent ${command} on ${instance} server.`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_get_script_ss_metadata":
            return async (args) => {
                try {
                    const scriptId = parseRequiredPositiveInt(
                        args.scriptId,
                        "scriptId",
                    );
                    const instance = parseInstance(args.instance, "dev");
                    const gameCode = SCRIPT_DATA_GAME_CODES[instance];
                    const output = await orchestrator.getScriptData(
                        scriptId,
                        gameCode,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `Script ${scriptId}: No data returned for ${instance} (${gameCode}).`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_get_verb_data":
            return async (args) => {
                try {
                    const verb = (args.verb as string)?.trim();
                    if (!verb) {
                        throw new Error(
                            "Missing verb. Provide the verb name to look up.",
                        );
                    }
                    const instance = parseInstance(args.instance, "dev");
                    const output = await orchestrator.getVerbData(
                        verb,
                        instance,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `Verb '${verb}': No data returned. The verb may not exist.`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_get_table_metadata":
            return async (args) => {
                try {
                    const tableId = parseRequiredPositiveInt(
                        args.tableId,
                        "tableId",
                    );
                    const instance = parseInstance(args.instance, "dev");
                    const output = await orchestrator.getGlobalTableData(
                        tableId,
                        instance,
                    );
                    if (!output || output.trim().length === 0) {
                        return textResult(
                            `Table ${tableId}: No data returned. The table may not exist.`,
                        );
                    }
                    return textResult(output);
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        case "gsl_diff_script_across_instances":
            return async (args) => {
                try {
                    const scriptNumber = parseRequiredPositiveInt(
                        args.scriptNumber,
                        "scriptNumber",
                    );
                    const baseInstance = parseInstance(
                        args.baseInstance,
                        "prime",
                    );
                    const compareInstance = parseInstance(
                        args.compareInstance,
                        "dev",
                    );
                    const diffContext = parseDiffContext(args.context);
                    const ignoreWhitespace =
                        (args.ignoreWhitespace as boolean) ?? false;

                    const [base, compare] = await Promise.all([
                        orchestrator.fetchScript(scriptNumber, baseInstance),
                        orchestrator.fetchScript(scriptNumber, compareInstance),
                    ]);

                    if (base.isNew && compare.isNew) {
                        return textResult(
                            `Script ${scriptNumber}: Not found on either ${baseInstance} or ${compareInstance}.`,
                        );
                    }
                    if (base.isNew) {
                        return textResult(
                            `Script ${scriptNumber}: Not found on ${baseInstance} (exists only on ${compareInstance}).`,
                        );
                    }
                    if (compare.isNew) {
                        return textResult(
                            `Script ${scriptNumber}: Not found on ${compareInstance} (exists only on ${baseInstance}).`,
                        );
                    }

                    const diffText = createTwoFilesPatch(
                        `S${scriptNumber}.gsl (${baseInstance})`,
                        `S${scriptNumber}.gsl (${compareInstance})`,
                        base.content,
                        compare.content,
                        undefined,
                        undefined,
                        { context: diffContext, ignoreWhitespace },
                    );

                    if (!diffText.includes("@@")) {
                        const msg = ignoreWhitespace
                            ? `Script ${scriptNumber}: No differences between ${baseInstance} and ${compareInstance} (ignoring whitespace).`
                            : `Script ${scriptNumber}: No differences between ${baseInstance} and ${compareInstance}.`;
                        return textResult(msg);
                    }

                    return textResult(
                        `Script ${scriptNumber}: Differences found (${baseInstance} → ${compareInstance}).\n\n` +
                            "```diff\n" +
                            diffText +
                            "\n```",
                    );
                } catch (e) {
                    return errorResult(
                        `Failed to diff script: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            };

        case "gsl_download_script":
            return async (args) => {
                try {
                    const scriptNumber = parseRequiredPositiveInt(
                        args.scriptNumber,
                        "scriptNumber",
                    );
                    const instance = parseInstance(args.instance, "dev");
                    const { content, isNew } = await orchestrator.fetchScript(
                        scriptNumber,
                        instance,
                    );
                    if (isNew) {
                        return textResult(
                            `Script ${scriptNumber}: Not found on ${instance} server (new script).`,
                        );
                    }
                    const filename = `S${String(scriptNumber).padStart(5, "0")}.${instance}.mcp.gsl`;
                    const filePath = path.join(
                        orchestrator.downloadLocation,
                        filename,
                    );
                    fs.writeFileSync(filePath, content, "utf8");
                    return textResult(
                        `Script ${scriptNumber} downloaded from ${instance} to: ${filePath}`,
                    );
                } catch (e) {
                    return errorResult(
                        `Failed to fetch script: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            };

        case "gsl_compile_check":
            return async (args) => {
                try {
                    const filename = args.filename as string | undefined;
                    if (!filename?.trim()) {
                        throw new Error(
                            "Missing filename. Provide a .gsl file path.",
                        );
                    }
                    const resolvedPath = path.resolve(filename.trim());
                    if (!resolvedPath.endsWith(".gsl")) {
                        throw new Error("File must have a .gsl extension.");
                    }
                    // Trust boundary: MCP callers control file paths.
                    // This is standard for MCP tool servers.
                    const content = fs.readFileSync(resolvedPath, "utf8");
                    const compileResults =
                        await orchestrator.uploadAndCompileScript(content);
                    return textResult(
                        formatCompileResults(filename.trim(), compileResults),
                    );
                } catch (e) {
                    return errorResult(
                        e instanceof Error ? e.message : String(e),
                    );
                }
            };

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
