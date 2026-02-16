import * as vscode from "vscode";
import { createTwoFilesPatch } from "diff";

import { GSL_LANGUAGE_ID } from "./const";
import { scriptNumberFromFileName } from "./util/scriptUtil";
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
}

interface IFetchPrimeScriptParams {
    scriptNumber?: number;
}

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

function createPrimeToolConfirmationMessages(
    invocationMessage: string,
    title: string,
    scriptNum: number | undefined,
    withScriptMessage: (scriptNumber: number) => string,
    activeScriptMessage: string,
) {
    return {
        invocationMessage,
        confirmationMessages: {
            title,
            message: new vscode.MarkdownString(
                scriptNum !== undefined
                    ? withScriptMessage(scriptNum)
                    : activeScriptMessage,
            ),
        },
    };
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
        const scriptNum = parseScriptNumber(options.input.scriptNumber);
        return createPrimeToolConfirmationMessages(
            "Fetching and diffing script from Prime server\u2026",
            "Diff with Prime Server",
            scriptNum,
            (scriptNumber) =>
                `Fetch and diff script ${scriptNumber} with the Prime server?`,
            "Fetch and diff the active script with the Prime server?",
        );
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDiffWithPrimeParams>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
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

        try {
            const { localContent, primeContent, isNewOnPrime } =
                await vscRef.fetchPrimeScriptDiff(scriptNumber, document);

            if (isNewOnPrime) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: Not found on Prime server (appears to be new in Dev).`,
                    ),
                ]);
            }

            if (localContent === primeContent) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Script ${scriptNumber}: No differences between Prime and Dev.`,
                    ),
                ]);
            }

            const diffText = createTwoFilesPatch(
                `s${scriptNumber} (Prime)`,
                `s${scriptNumber} (Dev)`,
                primeContent,
                localContent,
                undefined,
                undefined,
                { context: diffContext },
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
            throw new Error(
                `Failed to diff script ${scriptNumber} with prime: ${
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
        const scriptNum = parseScriptNumber(options.input.scriptNumber);
        return createPrimeToolConfirmationMessages(
            "Fetching script from Prime server\u2026",
            "Fetch from Prime Server",
            scriptNum,
            (scriptNumber) =>
                `Fetch script ${scriptNumber} from the Prime server?`,
            "Fetch the active script from the Prime server?",
        );
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFetchPrimeScriptParams>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!vscRef) {
            throw new Error(
                "GSL extension is not active. Open a GSL file to activate it.",
            );
        }

        const { scriptNumber } = resolveScriptNumber(
            options.input.scriptNumber,
        );

        try {
            const { content: primeContent, isNew } =
                await vscRef.fetchPrimeScript(scriptNumber);

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
            throw new Error(
                `Failed to fetch script ${scriptNumber} from prime: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
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
    );
}
