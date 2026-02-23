import {
    ExtensionContext,
    OutputChannel,
    TextDocument,
    workspace,
} from "vscode";

import {
    EditorClientInterface,
    withEditorClient,
    withPrimeEditorClient,
} from "../editorClient";
import {
    GSLX_DEV_CHARACTER,
    GSLX_DEV_ACCOUNT,
    GSLX_DEV_INSTANCE,
    GSLX_DEV_PASSWORD,
    GSLX_DISABLE_LOGIN,
    GSLX_PRIME_CHARACTER,
    GSLX_PRIME_INSTANCE,
    GSL_LANGUAGE_ID,
} from "../const";
import { scriptNumberFromFileName } from "../util/scriptUtil";

const rx_script_number = /^\d{1,6}$/;

function normalizeText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}

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

export async function fetchPrimeAndDevScriptDiff(
    script: number,
    deps: PrimeServiceDependencies,
): Promise<{
    devContent: string;
    primeContent: string;
    isNewOnPrime: boolean;
    isNewOnDev: boolean;
}> {
    const [{ content: primeContent, isNew: isNewOnPrime }, devScript] =
        await Promise.all([
            fetchPrimeScript(script, deps),
            fetchDevScript(script, deps),
        ]);

    return {
        devContent: devScript.content,
        primeContent,
        isNewOnPrime,
        isNewOnDev: devScript.isNew,
    };
}

export async function fetchPrimeScript(
    script: number,
    deps: PrimeServiceDependencies,
): Promise<{ content: string; isNew: boolean }> {
    const primeRaw = await doPrimeEditorClientTask(async (client) => {
        const scriptProperties = await client.modifyScript(script, true);
        if (scriptProperties.new) {
            await client.exitModifyScript();
            return { content: "", isNew: true };
        }

        try {
            const content = await client.captureScript();
            return { content, isNew: false };
        } catch (e) {
            await client.exitModifyScript();
            throw e;
        }
    }, deps);

    if (primeRaw.isNew) {
        return { content: "", isNew: true };
    }

    return { content: normalizeText(primeRaw.content), isNew: false };
}

export async function fetchDevScript(
    script: number,
    { context, outputChannel, downloadLocation }: PrimeServiceDependencies,
): Promise<{ content: string; isNew: boolean }> {
    if (workspace.getConfiguration(GSL_LANGUAGE_ID).get(GSLX_DISABLE_LOGIN)) {
        throw new Error("Game login is disabled.");
    }

    const account = context.globalState.get<string>(GSLX_DEV_ACCOUNT);
    const instance = context.globalState.get<string>(GSLX_DEV_INSTANCE);
    const character = context.globalState.get<string>(GSLX_DEV_CHARACTER);
    const password = await context.secrets.get(GSLX_DEV_PASSWORD);
    if (!account || !instance || !character || !password) {
        throw new Error(
            "Development server not configured. Run 'GSL: User Setup' first.",
        );
    }

    const consoleAdapter: { log: (...args: any) => void } = {
        log: (...args: any) => {
            outputChannel.append(`[dev: ${args.join(" ")}]\r\n`);
        },
    };

    const devRaw = await withEditorClient(
        {
            login: {
                account,
                instance,
                character,
                password,
            },
            console: consoleAdapter,
            downloadLocation,
            loggingEnabled: false,
            onCreate: () => {},
        },
        async (client) => {
            const scriptProperties = await client.modifyScript(script, true);
            if (scriptProperties.new) {
                await client.exitModifyScript();
                return { content: "", isNew: true };
            }

            try {
                const content = await client.captureScript();
                return { content, isNew: false };
            } catch (e) {
                await client.exitModifyScript();
                throw e;
            }
        },
    );

    if (devRaw.isNew) {
        return { content: "", isNew: true };
    }

    return { content: normalizeText(devRaw.content), isNew: false };
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

    const account = context.globalState.get<string>(GSLX_DEV_ACCOUNT);
    const instance = context.globalState.get<string>(GSLX_PRIME_INSTANCE);
    const character = context.globalState.get<string>(GSLX_PRIME_CHARACTER);
    const password = await context.secrets.get(GSLX_DEV_PASSWORD);
    if (!account || !instance || !character || !password) {
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
            login: {
                account,
                instance,
                character,
                password,
            },
            console: consoleAdapter,
            downloadLocation,
            loggingEnabled: false,
            onCreate: () => {},
        },
        task,
    );
}
