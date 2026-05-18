import * as vscode from "vscode";
import * as path from "path";
import { createTwoFilesPatch, structuredPatch } from "diff";

import { GSL_LANGUAGE_ID } from "./const";
import { scriptNumberFromFileName } from "./util/scriptUtil";
import { ScriptCompileResults, ScriptCompileStatus } from "./editorClient";
import type { VSCodeIntegration } from "../extension";

/** Re-use the module-level reference set by `activate()`. */
let vscRef: VSCodeIntegration | undefined;
const rx_script_number = /^\d{1,6}$/;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface IDiffWithPrimeParams {
    scriptNumber: number;
    context?: number;
    ignoreWhitespace?: boolean;
}

interface IFetchPrimeScriptParams {
    scriptNumber?: number;
}

interface IUploadScriptParams {
    filename: string;
}

type IGetCurrentAuthorParams = Record<string, never>;

interface IGetRoomDataParams {
    roomId: number;
    instance?: "prime" | "dev";
}

interface IGetExistenceDataParams {
    existenceId: number;
    instance?: "prime" | "dev";
}

interface IGetPlayerVarfieldsParams {
    playerName: string;
    verbosity?: "Full" | "NoTables" | "SkipDefaults";
    instance?: "prime" | "dev";
}

interface IAgentCommandParams {
    command?: string;
    instance?: "prime" | "dev";
}

type ScriptDataInstance = "dev" | "shattered" | "platinum" | "prime" | "test";

const SCRIPT_DATA_GAME_CODES: Record<ScriptDataInstance, string> = {
    dev: "GS4D",
    shattered: "GSF",
    prime: "GS4",
    test: "GST",
    platinum: "GS4X",
};

interface IGetScriptDataParams {
    scriptId: number;
    instance?: ScriptDataInstance;
}

interface IGetVerbDataParams {
    verb: string;
}

interface IGetGlobalTableDataParams {
    tableId: number;
}

const AGENT_UPLOAD_SCRIPT_NUMBER = 24661;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseScriptNumber(value: number | undefined): number | undefined {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 1 || value > 999999) {
        throw new Error(
            "Invalid scriptNumber. Expected an integer between 1 and 999999.",
        );
    }
    return value;
}

function parseRequiredScriptNumber(value: number | undefined): number {
    const scriptNumber = parseScriptNumber(value);
    if (scriptNumber === undefined) {
        throw new Error(
            "Missing scriptNumber. Provide an integer between 1 and 999999.",
        );
    }
    return scriptNumber;
}

function parseDiffContext(value: number | undefined): number {
    if (value === undefined) return 3;
    if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error(
            "Invalid context. Expected an integer between 0 and 100.",
        );
    }
    return value;
}

function createPrimeToolInvocationMessage(invocationMessage: string) {
    return {
        invocationMessage,
    };
}

class ToolCancellationError extends Error {
    constructor() {
        super("Operation cancelled.");
        this.name = "ToolCancellationError";
    }
}

function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new ToolCancellationError();
    }
}

function isToolCancelled(error: unknown): error is ToolCancellationError {
    return error instanceof ToolCancellationError;
}

function createCancelledToolResult(
    message: string,
): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message),
    ]);
}

function withCancellation<T>(
    operation: PromiseLike<T>,
    token: vscode.CancellationToken,
): Promise<T> {
    throwIfCancelled(token);
    return new Promise<T>((resolve, reject) => {
        const cancellationListener = token.onCancellationRequested(() => {
            reject(new ToolCancellationError());
        });
        Promise.resolve(operation)
            .then((value) => {
                if (token.isCancellationRequested) {
                    reject(new ToolCancellationError());
                    return;
                }
                resolve(value);
            }, reject)
            .finally(() => cancellationListener.dispose());
    });
}

function formatCompileResults(
    filename: string,
    scriptNumber: number,
    compileResults: ScriptCompileResults,
): string {
    const compiledScript = compileResults.script || scriptNumber;
    if (compileResults.status === ScriptCompileStatus.Failed) {
        const messages = compileResults.errorList.length
            ? compileResults.errorList
                  .map((error) => `line ${error.line}: ${error.message}`)
                  .join("\n")
            : "(No line-level compiler errors were captured.)";
        return [
            `Compile failed for ${filename} (uploaded as script ${compiledScript}).`,
            `Errors: ${compileResults.errors}, warnings: ${compileResults.warnings}.`,
            "",
            messages,
        ].join("\n");
    }

    if (compileResults.status === ScriptCompileStatus.Compiled) {
        const bytesRemaining = compileResults.maxBytes - compileResults.bytes;
        return [
            `Compile OK for ${filename} (uploaded as script ${compiledScript}).`,
            `Warnings: ${compileResults.warnings}.`,
            `Size: ${compileResults.bytes.toLocaleString()} bytes (${bytesRemaining.toLocaleString()} bytes remaining).`,
            compileResults.path ? `Server path: ${compileResults.path}` : "",
        ]
            .filter(Boolean)
            .join("\n");
    }

    return `Upload finished for ${filename}, but compiler status was inconclusive.`;
}

async function openUploadDocument(
    filename: string,
): Promise<vscode.TextDocument> {
    if (!filename || !filename.trim()) {
        throw new Error("Missing filename. Provide a .gsl file path.");
    }

    const trimmed = filename.trim();
    const fileUri = path.isAbsolute(trimmed)
        ? vscode.Uri.file(trimmed)
        : vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(
                vscode.workspace.workspaceFolders[0].uri,
                trimmed,
            )
          : undefined;

    if (!fileUri) {
        throw new Error(
            "No workspace folder is open. Provide an absolute file path.",
        );
    }

    try {
        return await vscode.workspace.openTextDocument(fileUri);
    } catch {
        const matches = await vscode.workspace.findFiles(
            `**/${path.basename(trimmed)}`,
        );
        if (matches.length === 0) {
            throw new Error(`File not found: ${trimmed}`);
        }
        if (matches.length > 1) {
            throw new Error(
                `Filename is ambiguous: ${trimmed}. Provide a workspace-relative path.`,
            );
        }
        return vscode.workspace.openTextDocument(matches[0]);
    }
}

/**
 * Resolves a script number from an optional explicit value or the
 * active editor.
 */
function resolveScriptNumber(scriptNumber?: number): number {
    if (scriptNumber !== undefined) {
        return parseRequiredScriptNumber(scriptNumber);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== GSL_LANGUAGE_ID) {
        throw new Error(
            "No active GSL script editor and no scriptNumber provided. " +
                "Open a GSL script or specify a scriptNumber.",
        );
    }
    const scriptNumberStr = scriptNumberFromFileName(editor.document.fileName);
    if (!rx_script_number.test(scriptNumberStr)) {
        throw new Error(
            "Could not determine script number from the active editor filename.",
        );
    }
    return parseRequiredScriptNumber(Number(scriptNumberStr));
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Language model tool that exposes the "Diff with Prime" functionality
 * to GitHub Copilot agent mode.  When invoked the tool downloads the
 * Prime (production) and Dev copies of a GSL script, compares them,
 * and returns the textual diff so the LLM can analyse it.
 * `scriptNumber` is required.
 * Does NOT open any UI — the diff content is returned directly to the
 * agent in the tool result.
 */
class DiffWithPrimeTool implements vscode.LanguageModelTool<IDiffWithPrimeParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDiffWithPrimeParams>,
        _token: vscode.CancellationToken,
    ) {
        parseRequiredScriptNumber(options.input.scriptNumber);
        return createPrimeToolInvocationMessage(
            "Fetching and diffing script from Prime and Dev servers\u2026",
        );
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDiffWithPrimeParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const scriptNumber = parseRequiredScriptNumber(
                options.input.scriptNumber,
            );

            const diffContext = parseDiffContext(options.input.context);
            const ignoreWhitespace = options.input.ignoreWhitespace ?? false;

            const { devContent, primeContent, isNewOnPrime, isNewOnDev } =
                await withCancellation(
                    vscRef.fetchPrimeAndDevScriptDiff(scriptNumber),
                    token,
                );

            if (isNewOnPrime && isNewOnDev) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: Not found on either Prime or Dev server.`,
                    ),
                ]);
            }

            if (isNewOnPrime) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: Not found on Prime server (appears to be new in Dev).`,
                    ),
                ]);
            }

            if (isNewOnDev) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: Not found on Dev server.`,
                    ),
                ]);
            }

            const patch = structuredPatch(
                `s${scriptNumber} (Prime)`,
                `s${scriptNumber} (Dev)`,
                primeContent,
                devContent,
                undefined,
                undefined,
                {
                    context: diffContext,
                    ignoreWhitespace,
                },
            );

            if (patch.hunks.length === 0) {
                const noDiffMessage = ignoreWhitespace
                    ? `Script ${scriptNumber}: No differences between Prime and Dev (ignoring leading/trailing whitespace).`
                    : `Script ${scriptNumber}: No differences between Prime and Dev.`;
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(noDiffMessage),
                ]);
            }

            const diffText = createTwoFilesPatch(
                `s${scriptNumber} (Prime)`,
                `s${scriptNumber} (Dev)`,
                primeContent,
                devContent,
                undefined,
                undefined,
                {
                    context: diffContext,
                    ignoreWhitespace,
                },
            );

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Script ${scriptNumber}: Differences found between Prime and Dev.\n\n` +
                        "```diff\n" +
                        diffText +
                        "\n```",
                ),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Diff with prime was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to diff script ${
                    options.input.scriptNumber ?? "(missing scriptNumber)"
                } with Prime and Dev: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

/**
 * Language model tool that fetches the Prime (production) copy of a GSL
 * script and returns its full content to the agent.  Unlike the diff tool
 * this does NOT compare — it simply returns the raw script text.
 */
class FetchPrimeScriptTool implements vscode.LanguageModelTool<IFetchPrimeScriptParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFetchPrimeScriptParams>,
        _token: vscode.CancellationToken,
    ) {
        parseScriptNumber(options.input.scriptNumber);
        return createPrimeToolInvocationMessage(
            "Fetching script from Prime server\u2026",
        );
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFetchPrimeScriptParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const scriptNumber = resolveScriptNumber(
                options.input.scriptNumber,
            );

            const { content: primeContent, isNew } = await withCancellation(
                vscRef.fetchPrimeScript(scriptNumber),
                token,
            );

            if (isNew) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: Not found on Prime server (new script).`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Script ${scriptNumber} from Prime server:\n\n` +
                        "```gsl\n" +
                        primeContent +
                        "\n```",
                ),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Fetch prime script was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to fetch script ${
                    options.input.scriptNumber ?? "active script"
                } from prime: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }
}

class CheckCompilerErrorsTool implements vscode.LanguageModelTool<IUploadScriptParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IUploadScriptParams>,
        _token: vscode.CancellationToken,
    ) {
        return {
            invocationMessage: "Checking GSL script for compiler errors...",
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IUploadScriptParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const sourceDocument = await withCancellation(
                openUploadDocument(options.input.filename),
                token,
            );
            const sourceContent = sourceDocument.getText();
            if (sourceContent.match(/^\s*$/)) {
                throw new Error("Cannot upload an empty script file.");
            }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
            const safetyScriptUri = workspaceRoot
                ? vscode.Uri.joinPath(workspaceRoot, "S24661.gsl")
                : vscode.Uri.joinPath(
                      vscode.Uri.file(path.dirname(sourceDocument.fileName)),
                      "S24661.gsl",
                  );
            await withCancellation(
                vscode.workspace.fs.writeFile(
                    safetyScriptUri,
                    Buffer.from(sourceContent, "utf8"),
                ),
                token,
            );
            const safetyDocument = await withCancellation(
                vscode.workspace.openTextDocument(safetyScriptUri),
                token,
            );

            const compileResults = await withCancellation(
                vscRef.uploadScriptForAgent(
                    AGENT_UPLOAD_SCRIPT_NUMBER,
                    safetyDocument,
                ),
                token,
            );

            if (!compileResults) {
                throw new Error(
                    "Unable to upload script. Confirm development server login is configured.",
                );
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    formatCompileResults(
                        options.input.filename,
                        AGENT_UPLOAD_SCRIPT_NUMBER,
                        compileResults,
                    ),
                ),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Compile check was cancelled before completion.",
                );
            }
            throw e;
        }
    }
}

class GetCurrentAuthorTool implements vscode.LanguageModelTool<IGetCurrentAuthorParams> {
    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<IGetCurrentAuthorParams>,
        _token: vscode.CancellationToken,
    ) {
        return {
            invocationMessage: "Retrieving configured GSL author...",
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<IGetCurrentAuthorParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const author = vscRef.getCurrentAuthor()?.trim();
            if (!author) {
                throw new Error(
                    "Author is not configured. Run 'GSL: User Setup'.",
                );
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(author),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get current author was cancelled.",
                );
            }
            throw e;
        }
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Validates and returns a room ID.
 */
function parseRequiredRoomId(value: number | undefined): number {
    if (value === undefined || !Number.isInteger(value) || value < 1) {
        throw new Error(
            "Missing or invalid roomId. Provide a positive integer.",
        );
    }
    return value;
}

/**
 * Validates and returns an existence ID (positive or negative integer).
 */
function parseRequiredExistenceId(value: number | undefined): number {
    if (value === undefined || !Number.isInteger(value) || value === 0) {
        throw new Error(
            "Missing or invalid existenceId. Provide a non-zero integer.",
        );
    }
    return value;
}

class GetExistenceDataTool implements vscode.LanguageModelTool<IGetExistenceDataParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetExistenceDataParams>,
        _token: vscode.CancellationToken,
    ) {
        parseRequiredExistenceId(options.input.existenceId);
        const instance = options.input.instance ?? "dev";
        return {
            invocationMessage: `Fetching existence ${options.input.existenceId} from ${instance} server\u2026`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetExistenceDataParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const existenceId = parseRequiredExistenceId(
                options.input.existenceId,
            );
            const instance = options.input.instance ?? "dev";

            const rawOutput = await withCancellation(
                vscRef.getExistenceData(existenceId, instance),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Existence ${existenceId}: No data returned from ${instance} server. ` +
                            `The existence may not exist.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get existence data was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to get existence data for ${options.input.existenceId ?? "(missing existenceId)"}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

class GetRoomDataTool implements vscode.LanguageModelTool<IGetRoomDataParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetRoomDataParams>,
        _token: vscode.CancellationToken,
    ) {
        parseRequiredRoomId(options.input.roomId);
        const instance = options.input.instance ?? "dev";
        return {
            invocationMessage: `Fetching room ${options.input.roomId} from ${instance} server\u2026`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetRoomDataParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const roomId = parseRequiredRoomId(options.input.roomId);
            const instance = options.input.instance ?? "dev";

            const rawOutput = await withCancellation(
                vscRef.getRoomData(roomId, instance),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Room ${roomId}: No data returned from ${instance} server. ` +
                            `The room may not exist.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get room data was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to get room data for room ${
                    options.input.roomId ?? "(missing roomId)"
                }: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }
}

const VALID_SVF_VERBOSITIES = new Set(["Full", "NoTables", "SkipDefaults"]);

class GetPlayerVarfieldsTool implements vscode.LanguageModelTool<IGetPlayerVarfieldsParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetPlayerVarfieldsParams>,
        _token: vscode.CancellationToken,
    ) {
        const { playerName, verbosity, instance } = options.input;
        if (!playerName?.trim()) {
            throw new Error(
                "Missing playerName. Provide the player name to look up.",
            );
        }
        if (verbosity && !VALID_SVF_VERBOSITIES.has(verbosity)) {
            throw new Error(
                `Invalid verbosity '${verbosity}'. Must be Full, NoTables, or SkipDefaults.`,
            );
        }
        const resolvedInstance = instance ?? "dev";
        const resolvedVerbosity = verbosity ?? "NoTables";
        return {
            invocationMessage: `Fetching varfields for ${playerName.trim()} (${resolvedVerbosity}) from ${resolvedInstance} server\u2026`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetPlayerVarfieldsParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const { playerName, verbosity, instance } = options.input;
            if (!playerName?.trim()) {
                throw new Error(
                    "Missing playerName. Provide the player name to look up.",
                );
            }
            if (verbosity && !VALID_SVF_VERBOSITIES.has(verbosity)) {
                throw new Error(
                    `Invalid verbosity '${verbosity}'. Must be Full, NoTables, or SkipDefaults.`,
                );
            }
            const resolvedInstance = instance ?? "dev";
            const resolvedVerbosity = verbosity ?? "NoTables";

            const rawOutput = await withCancellation(
                vscRef.getPlayerVarfields(
                    playerName.trim(),
                    resolvedVerbosity,
                    resolvedInstance,
                ),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Player ${playerName.trim()}: No data returned from ${resolvedInstance} server. ` +
                            `The player may not exist or may not be logged in.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get player varfields was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to get varfields for player ${options.input.playerName ?? "(missing playerName)"}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

class GetScriptDataTool implements vscode.LanguageModelTool<IGetScriptDataParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetScriptDataParams>,
        _token: vscode.CancellationToken,
    ) {
        parseRequiredScriptNumber(options.input.scriptId);
        const instance = options.input.instance ?? "dev";
        return {
            invocationMessage: `Fetching script ${options.input.scriptId} data (${instance}) from dev server\u2026`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetScriptDataParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const scriptId = parseRequiredScriptNumber(options.input.scriptId);
            const instance = options.input.instance ?? "dev";
            const gameCode = SCRIPT_DATA_GAME_CODES[instance];
            if (!gameCode) {
                throw new Error(
                    `Invalid instance '${instance}'. Must be one of: ${Object.keys(SCRIPT_DATA_GAME_CODES).join(", ")}.`,
                );
            }

            const rawOutput = await withCancellation(
                vscRef.getScriptData(scriptId, gameCode),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptId}: No data returned for ${instance} (${gameCode}). ` +
                            `The script may not exist on that instance.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get script data was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to get script data for ${options.input.scriptId ?? "(missing scriptId)"}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

class GetGlobalTableDataTool implements vscode.LanguageModelTool<IGetGlobalTableDataParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetGlobalTableDataParams>,
        _token: vscode.CancellationToken,
    ) {
        parseRequiredScriptNumber(options.input.tableId);
        return {
            invocationMessage: `Fetching global table ${options.input.tableId} data from dev server\u2026`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetGlobalTableDataParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const tableId = parseRequiredScriptNumber(options.input.tableId);

            const rawOutput = await withCancellation(
                vscRef.getGlobalTableData(tableId),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Table ${tableId}: No data returned. The table may not exist.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get global table data was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to get global table data for ${options.input.tableId ?? "(missing tableId)"}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

class GetVerbDataTool implements vscode.LanguageModelTool<IGetVerbDataParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetVerbDataParams>,
        _token: vscode.CancellationToken,
    ) {
        if (!options.input.verb?.trim()) {
            throw new Error("Missing verb. Provide the verb name to look up.");
        }
        return {
            invocationMessage: `Fetching verb data for '${options.input.verb.trim()}'\u2026`,
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetVerbDataParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const verb = options.input.verb?.trim();
            if (!verb) {
                throw new Error(
                    "Missing verb. Provide the verb name to look up.",
                );
            }

            const rawOutput = await withCancellation(
                vscRef.getVerbData(verb),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Verb '${verb}': No data returned. The verb may not exist.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Get verb data was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to get verb data for '${options.input.verb ?? "(missing verb)"}': ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

class AgentCommandTool implements vscode.LanguageModelTool<IAgentCommandParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IAgentCommandParams>,
        _token: vscode.CancellationToken,
    ) {
        const command = options.input.command?.trim();
        const instance = options.input.instance ?? "dev";
        const message = command
            ? `Running /agent ${command} on ${instance} server\u2026`
            : `Listing available /agent subcommands on ${instance} server\u2026`;
        return { invocationMessage: message };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IAgentCommandParams>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            throwIfCancelled(token);
            if (!vscRef) {
                throw new Error(
                    "GSL extension is not active. Open a GSL file to activate it.",
                );
            }

            const command = options.input.command?.trim() ?? "";
            const instance = options.input.instance ?? "dev";

            const rawOutput = await withCancellation(
                vscRef.executeAgentCommand(command, instance),
                token,
            );

            if (!rawOutput || rawOutput.trim().length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `No output returned from /agent ${command} on ${instance} server.`,
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(rawOutput),
            ]);
        } catch (e) {
            if (isToolCancelled(e)) {
                return createCancelledToolResult(
                    "Agent command was cancelled before completion.",
                );
            }
            throw new Error(
                `Failed to run /agent ${options.input.command ?? "(missing command)"}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
}

/**
 * Registers the Copilot language-model tools.  Call from `activate()`.
 *
 * @param context - the extension context (for subscriptions)
 * @param vsc     - the live `VSCodeIntegration` instance
 */
export function registerCopilotTools(
    context: vscode.ExtensionContext,
    vsc: VSCodeIntegration,
): void {
    vscRef = vsc;

    if (!(vscode.lm && typeof vscode.lm.registerTool === "function")) {
        return;
    }

    context.subscriptions.push(
        vscode.lm.registerTool("gsl_diff_with_prime", new DiffWithPrimeTool()),
        vscode.lm.registerTool(
            "gsl_fetch_prime_script",
            new FetchPrimeScriptTool(),
        ),
        vscode.lm.registerTool(
            "gsl_compile_check",
            new CheckCompilerErrorsTool(),
        ),
        vscode.lm.registerTool(
            "gsl-get-current-author",
            new GetCurrentAuthorTool(),
        ),
        vscode.lm.registerTool("gsl_get_room_data", new GetRoomDataTool()),
        vscode.lm.registerTool(
            "gsl_get_existence_data",
            new GetExistenceDataTool(),
        ),
        vscode.lm.registerTool(
            "gsl_get_player_varfields",
            new GetPlayerVarfieldsTool(),
        ),
        vscode.lm.registerTool(
            "gsl_slash_agent_command",
            new AgentCommandTool(),
        ),
        vscode.lm.registerTool("gsl_get_script_data", new GetScriptDataTool()),
        vscode.lm.registerTool("gsl_get_verb_data", new GetVerbDataTool()),
        vscode.lm.registerTool(
            "gsl_get_table_metadata",
            new GetGlobalTableDataTool(),
        ),
    );
}
