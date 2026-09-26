import {
    EditorClientInterface,
    InitOptions,
    ScriptCompileResults,
    withClientForInstance,
} from "./editorClient";
import { throwOnControlCharacters } from "./strings";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type GameInstance = "dev" | "prime" | "shattered" | "platinum" | "test";

export interface LoginCredentials {
    account: string;
    instance: string;
    character: string;
    password: string;
}

export interface AgentToolOrchestratorDeps {
    getCredentials(
        instance: GameInstance,
    ): Promise<LoginCredentials | LoginCredentials[] | undefined>;
    getCurrentAuthor(): string | undefined;
    downloadLocation: string;
    console: { log: (...args: any[]) => void };
}

// ---------------------------------------------------------------------------
// ToolOrchestrator
// ---------------------------------------------------------------------------

export class AgentToolOrchestrator {
    private pools = new Map<
        string,
        {
            available: LoginCredentials[];
            waiting: Array<(credentials: LoginCredentials) => void>;
        }
    >();

    constructor(
        private deps: AgentToolOrchestratorDeps,
        private runWithClient: typeof withClientForInstance = withClientForInstance,
    ) {}

    get downloadLocation(): string {
        return this.deps.downloadLocation;
    }

    // -- credential helpers ------------------------------------------------

    private initOptionsFor(
        instance: GameInstance,
        creds: LoginCredentials,
    ): InitOptions {
        return {
            login: creds,
            console: this.deps.console,
            downloadLocation: this.deps.downloadLocation,
            loggingEnabled: false,
            onCreate: () => {
                this.deps.console.log(
                    `Client connected to ${instance} as ${creds.character}`,
                );
            },
        };
    }

    private async withClient<T>(
        instance: GameInstance,
        task: (
            client: EditorClientInterface,
            credentials: LoginCredentials,
        ) => Promise<T>,
    ): Promise<T> {
        const configured = await this.deps.getCredentials(instance);
        if (
            !configured ||
            (Array.isArray(configured) && configured.length === 0)
        ) {
            throw new Error(
                `${instance} server not configured. ` +
                    `Add ${instance}Instance and ${instance}Character or ${instance}Characters to your login config file.`,
            );
        }
        if (!Array.isArray(configured)) {
            // Preserve the extension's shared single-character editor queue.
            return this.runWithClient(
                instance,
                this.initOptionsFor(instance, configured),
                (client) => task(client, configured),
            );
        }

        const unique = new Map(
            configured.map((creds) => [
                JSON.stringify(
                    [creds.account, creds.instance, creds.character].map(
                        (part) => part.trim().toLowerCase(),
                    ),
                ),
                creds,
            ]),
        );
        const poolKey = JSON.stringify([instance, [...unique.keys()].sort()]);
        let pool = this.pools.get(poolKey);
        if (!pool) {
            pool = { available: [...unique.values()], waiting: [] };
            this.pools.set(poolKey, pool);
        }
        // Reserve a free character for the entire operation. Pending requests
        // go to the next worker to finish, rather than queueing behind a busy one.
        const creds =
            pool.available.shift() ??
            (await new Promise<LoginCredentials>((resolve) =>
                pool.waiting.push(resolve),
            ));
        const workerKey = JSON.stringify(
            ["mcp", creds.account, creds.instance, creds.character].map(
                (part) => part.trim().toLowerCase(),
            ),
        );
        try {
            return await this.runWithClient(
                workerKey,
                this.initOptionsFor(instance, creds),
                (client) => task(client, creds),
            );
        } finally {
            const next = pool.waiting.shift();
            if (next) next(creds);
            else pool.available.push(creds);
        }
    }

    // -- executeShowCommand ------------------------------------------------

    private async executeShowCommand(
        client: EditorClientInterface,
        command: string,
        captureStart: RegExp,
        captureEnd: RegExp,
        abortPattern: RegExp,
        { includeStartLine = true, includeEndLine = true } = {},
    ): Promise<string> {
        const TIMEOUT_MS = 15000;
        const lines = await client.executeCommand(command, {
            captureStart,
            captureEnd,
            abortPattern,
            timeoutMillis: TIMEOUT_MS,
            includeStartLine,
            includeEndLine,
        });
        return lines.join("\n");
    }

    private async executeShowCommandOnInstance(
        instance: GameInstance,
        command: string,
        captureStart: RegExp,
        captureEnd: RegExp,
        abortPattern: RegExp,
        { includeStartLine = true, includeEndLine = true } = {},
    ): Promise<string> {
        const task = (client: EditorClientInterface) =>
            this.executeShowCommand(
                client,
                command,
                captureStart,
                captureEnd,
                abortPattern,
                { includeStartLine, includeEndLine },
            );

        return this.withClient(instance, task);
    }

    // -- tool methods ------------------------------------------------------

    getCurrentAuthor(): string | undefined {
        return this.deps.getCurrentAuthor();
    }

    async getRoomData(roomId: number, instance: GameInstance): Promise<string> {
        return this.withClient(instance, async (client) => {
            await this.executeAgentCommandWithClient(
                client,
                `/load room ${roomId}`,
            );
            return this.executeShowCommand(
                client,
                `/sr ${roomId}`,
                /^Showing room #\d+/,
                /^Flags:/,
                /does not exist or could not be loaded for some reason/,
            );
        });
    }

    async getExistenceData(
        existenceId: number,
        instance: GameInstance,
    ): Promise<string> {
        return this.executeShowCommandOnInstance(
            instance,
            `/se ${existenceId}`,
            /^Showing /,
            /^Flags:/,
            /^Existence ".*?" not found\./,
        );
    }

    async getPlayerVarfields(
        playerName: string,
        verbosity: "Full" | "NoTables" | "SkipDefaults",
        instance: GameInstance,
    ): Promise<string> {
        throwOnControlCharacters(playerName);
        return this.executeShowCommandOnInstance(
            instance,
            `/svf ${playerName} ${verbosity}`,
            /^Variable Fields Attached to player /,
            /^Flags:/,
            /^Player .+ not found$/,
        );
    }

    async executeAgentCommand(
        command: string,
        instance: GameInstance,
    ): Promise<string> {
        throwOnControlCharacters(command);
        return this.withClient(instance, (client) =>
            this.executeAgentCommandWithClient(client, command),
        );
    }

    private async executeAgentCommandWithClient(
        client: EditorClientInterface,
        command: string,
    ): Promise<string> {
        const fullCommand = command ? `/agent ${command}` : "/agent";
        return this.executeShowCommand(
            client,
            fullCommand,
            /^<<<beginning of output>>>/,
            /^<<<end of output>>>/,
            /(?!)/,
            { includeStartLine: false, includeEndLine: false },
        );
    }

    async getVerbData(
        verb: string,
        instance: GameInstance = "dev",
    ): Promise<string> {
        throwOnControlCharacters(verb);
        return this.withClient(instance, (client) =>
            this.executeShowCommand(
                client,
                `/sv ${verb}`,
                /^Information about the verb /,
                /^On /,
                /does not exist\.$/,
            ),
        );
    }

    async getScriptData(scriptId: number, gameCode: string): Promise<string> {
        throwOnControlCharacters(gameCode);
        return this.withClient("dev", (client) =>
            this.executeShowCommand(
                client,
                `/ss ${scriptId} ${gameCode} raw`,
                /^Game: /,
                /^On |^Unspecified Date/,
                /^Invalid script/,
            ),
        );
    }

    async getGlobalTableData(
        tableId: number,
        instance: GameInstance = "dev",
    ): Promise<string> {
        return this.withClient(instance, (client) =>
            this.executeShowCommand(
                client,
                `/sl ${tableId}`,
                /^Table \[\d+\] Header Information/,
                /^\s+Table Type:/,
                /^ERROR:.*Trouble loading table/,
            ),
        );
    }

    // -- prime service operations ------------------------------------------

    async fetchScript(
        script: number,
        instance: GameInstance = "dev",
    ): Promise<{ content: string; isNew: boolean }> {
        return this.withClient(instance, (client) =>
            fetchScriptContent(client, script),
        );
    }

    // -- compile check -----------------------------------------------------

    /**
     * Uploads script content to the game's safety script on the dev server for
     * compilation, and returns the compile results.
     */
    async uploadAndCompileScript(
        content: string,
    ): Promise<ScriptCompileResults> {
        if (!content || content.match(/^\s*$/)) {
            throw new Error("Cannot upload an empty script file.");
        }
        return this.withClient("dev", async (client, creds) => {
            const safetyScript = creds.instance.startsWith("DR")
                ? 16224
                : 24661;
            const props = await client.modifyScript(safetyScript, true);
            try {
                const lines = content.split(/\r?\n/);
                if (lines[lines.length - 1] !== "") {
                    lines.push("");
                }
                const results = await client.sendScript(lines, props.new);
                return results;
            } catch (e) {
                try {
                    await client.exitModifyScript();
                } catch {
                    // connection teardown will handle it
                }
                throw e;
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}

/**
 * Shared fetch primitive: opens a script for editing on the server,
 * captures its content, and returns the normalised text.
 */
export async function fetchScriptContent(
    client: EditorClientInterface,
    script: number,
): Promise<{ content: string; isNew: boolean }> {
    const props = await client.modifyScript(script, true);
    if (props.new) {
        await client.exitModifyScript();
        return { content: "", isNew: true };
    }
    try {
        const content = await client.captureScript();
        return { content: normalizeText(content), isNew: false };
    } catch (e) {
        try {
            await client.exitModifyScript();
        } catch {
            // connection teardown will handle it
        }
        throw e;
    }
}
