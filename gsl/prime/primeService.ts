import {
    ExtensionContext,
    OutputChannel,
    TextDocument,
    workspace,
} from "vscode";

import { EditorClientInterface, withClientForInstance } from "../editorClient";
import { GSLX_DISABLE_LOGIN, GSL_LANGUAGE_ID } from "../const";
import { GSLExtension } from "../../extension";
import { scriptNumberFromFileName } from "../util/scriptUtil";
import {
    fetchScriptContent,
    GameInstance,
    normalizeText,
} from "../agentToolOrchestrator";

const rx_script_number = /^\d{1,6}$/;

export interface PrimeServiceDependencies {
    context: ExtensionContext;
    outputChannel: OutputChannel;
    downloadLocation: string;
}

export async function fetchInstanceScriptDiff(
    script: number,
    document: TextDocument,
    instance: GameInstance,
    deps: PrimeServiceDependencies,
): Promise<{
    localContent: string;
    remoteContent: string;
    isNewOnRemote: boolean;
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

    const { content: remoteContent, isNew: isNewOnRemote } =
        await fetchInstanceScript(script, instance, deps);

    return {
        localContent: normalizeText(document.getText()),
        remoteContent,
        isNewOnRemote,
    };
}

export async function fetchInstanceScript(
    script: number,
    instance: GameInstance,
    deps: PrimeServiceDependencies,
): Promise<{ content: string; isNew: boolean }> {
    return doEditorClientTaskForInstance(
        instance,
        (client) => fetchScriptContent(client, script),
        deps,
    );
}

/**
 * Provides an `EditorClient` connected to a given game server instance.
 * Uses shared account credentials but separate game instance and character.
 * Intended for read-only operations (downloading scripts for diffing).
 */
export async function doEditorClientTaskForInstance<T>(
    instance: GameInstance,
    task: (client: EditorClientInterface) => T,
    { context, outputChannel, downloadLocation }: PrimeServiceDependencies,
): Promise<T> {
    if (workspace.getConfiguration(GSL_LANGUAGE_ID).get(GSLX_DISABLE_LOGIN)) {
        throw new Error("Game login is disabled.");
    }

    const creds = await GSLExtension.getLoginForInstance(instance, context);
    if (!creds) {
        throw new Error(
            `${instance} server not configured. Run 'GSL: User Setup' first.`,
        );
    }

    const consoleAdapter: { log: (...args: any) => void } = {
        log: (...args: any) => {
            outputChannel.append(`[${instance}: ${args.join(" ")}]\r\n`);
        },
    };

    return withClientForInstance(
        instance,
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
