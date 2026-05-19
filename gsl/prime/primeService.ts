import {
    ExtensionContext,
    OutputChannel,
    TextDocument,
    workspace,
} from "vscode";

import { EditorClientInterface, withPrimeEditorClient } from "../editorClient";
import { GSLX_DISABLE_LOGIN, GSL_LANGUAGE_ID } from "../const";
import { GSLExtension } from "../../extension";
import { scriptNumberFromFileName } from "../util/scriptUtil";
import { fetchScriptContent, normalizeText } from "../agentToolOrchestrator";

const rx_script_number = /^\d{1,6}$/;

export interface PrimeServiceDependencies {
    context: ExtensionContext;
    outputChannel: OutputChannel;
    downloadLocation: string;
}

/**
 * Downloads a script from the Prime server and returns both the
 * normalised local and Prime content for comparison.
 *
 * @param script  - The script number
 * @param document - The local TextDocument to compare against Prime
 * @returns An object with `localContent` and `primeContent` strings
 */
export async function fetchPrimeScriptDiff(
    script: number,
    document: TextDocument,
    deps: PrimeServiceDependencies,
): Promise<{
    localContent: string;
    primeContent: string;
    isNewOnPrime: boolean;
}> {
    if (document.languageId !== GSL_LANGUAGE_ID) {
        throw new Error("Diff requires a GSL document for local comparison.");
    }

    const localScriptNumber = scriptNumberFromFileName(document.fileName);
    if (
        !rx_script_number.test(localScriptNumber) ||
        Number(localScriptNumber) !== script
    ) {
        throw new Error(
            `Local document does not match script ${script}. Open s${script}.gsl and retry.`,
        );
    }

    const { content: primeContent, isNew: isNewOnPrime } =
        await fetchPrimeScript(script, deps);

    return {
        localContent: normalizeText(document.getText()),
        primeContent,
        isNewOnPrime,
    };
}

export async function fetchPrimeScript(
    script: number,
    deps: PrimeServiceDependencies,
): Promise<{ content: string; isNew: boolean }> {
    return doPrimeEditorClientTask(
        (client) => fetchScriptContent(client, script),
        deps,
    );
}

/**
 * Provides an `EditorClient` connected to the prime (production) server.
 * Uses shared account credentials but separate game instance and character.
 * Intended for read-only operations (downloading scripts for diffing).
 */
export async function doPrimeEditorClientTask<T>(
    task: (client: EditorClientInterface) => T,
    { context, outputChannel, downloadLocation }: PrimeServiceDependencies,
): Promise<T> {
    if (workspace.getConfiguration(GSL_LANGUAGE_ID).get(GSLX_DISABLE_LOGIN)) {
        throw new Error("Game login is disabled.");
    }

    const creds = await GSLExtension.getLoginForInstance("prime", context);
    if (!creds) {
        throw new Error(
            "Prime server not configured. Run 'GSL: User Setup' first.",
        );
    }

    const consoleAdapter: { log: (...args: any) => void } = {
        log: (...args: any) => {
            outputChannel.append(`[prime: ${args.join(" ")}]\r\n`);
        },
    };

    return withPrimeEditorClient(
        {
            login: creds,
            console: consoleAdapter,
            downloadLocation,
            loggingEnabled: false,
            onCreate: () => {},
        },
        task,
    );
}
