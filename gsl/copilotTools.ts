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
    scriptNumber?: number;
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
 * Resolves a script number (and its matching open document) from an
 * optional explicit value or the active editor.
 */
function resolveScriptNumber(scriptNumber?: number): {
    scriptNumber: number;
    document?: vscode.TextDocument;
} {
    if (scriptNumber !== undefined) {
        const parsedScriptNumber = parseScriptNumber(scriptNumber);
        if (parsedScriptNumber === undefined) {
            throw new Error(
                "No active GSL script editor and no scriptNumber provided. Open a GSL script or specify a scriptNumber.",
            );
        }
        // Find the open document whose filename matches the given script number
        const doc = vscode.workspace.textDocuments.find((d) => {
            if (d.languageId !== GSL_LANGUAGE_ID) return false;
            const num = scriptNumberFromFileName(d.fileName);
            return (
                rx_script_number.test(num) && Number(num) === parsedScriptNumber
            );
        });
        return { scriptNumber: parsedScriptNumber, document: doc };
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
    return {
        scriptNumber: parseScriptNumber(Number(scriptNumberStr))!,
        document: editor.document,
    };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Language model tool that exposes the "Diff with Prime" functionality
 * to GitHub Copilot agent mode.  When invoked the tool downloads the
 * Prime (production) copy of a GSL script, compares it with the local
 * version, and returns the textual diff so the LLM can analyse it.
 * If `scriptNumber` is provided, the matching local script must already
 * be open in the editor so local content can be read for comparison.
 * Does NOT open any UI — the diff content is returned directly to the
 * agent in the tool result.
 */
class DiffWithPrimeTool implements vscode.LanguageModelTool<IDiffWithPrimeParams> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDiffWithPrimeParams>,
        _token: vscode.CancellationToken,
    ) {
        parseScriptNumber(options.input.scriptNumber);
        return createPrimeToolInvocationMessage(
            "Fetching and diffing script from Prime server\u2026",
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

            const { scriptNumber, document } = resolveScriptNumber(
                options.input.scriptNumber,
            );

            if (!document) {
                throw new Error(
                    `Cannot diff script ${scriptNumber} with local content because it is not open. Open the local script and retry.`,
                );
            }

            const diffContext = parseDiffContext(options.input.context);
            const ignoreWhitespace = options.input.ignoreWhitespace ?? false;

            const { localContent, primeContent, isNewOnPrime } =
                await withCancellation(
                    vscRef.fetchPrimeScriptDiff(scriptNumber, document),
                    token,
                );

            if (isNewOnPrime) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: Not found on Prime server (appears to be new in Dev).`,
                    ),
                ]);
            }

            const patch = structuredPatch(
                `s${scriptNumber} (Prime)`,
                `s${scriptNumber} (Dev)`,
                primeContent,
                localContent,
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
                localContent,
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
                    options.input.scriptNumber ?? "active script"
                } with prime: ${e instanceof Error ? e.message : String(e)}`,
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

            const { scriptNumber } = resolveScriptNumber(
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
    );
}
