import * as path from "path";

import { BaseGameClient, GameClientOptions } from "./gameClients";
import { EAccessClient } from "./eaccessClient";

/** Output of `/ms` or `/mv`; captured by `modifyScript()` */
export interface ScriptProperties {
    lastModifiedDate: Date;
    name: string;
    desc: string;
    owner: string;
    modifier: string;
    path: string;
    lines: number;
    new: boolean;
    verb?: string;
}

/**
 * Output of `/ss`; captured by `checkScript()`.
 * The value of `owner` may differ from `ScriptProperties.owner`.
 */
export type ShowScriptOutput = Pick<
    ScriptProperties,
    "lastModifiedDate" | "name" | "desc" | "owner" | "modifier"
>;

export interface ScriptCompileResults {
    status: ScriptCompileStatus;
    script: number;
    path: string;
    bytes: number;
    maxBytes: number;
    errors: number;
    warnings: number;
    errorList: Array<ScriptError>;
}

export interface ScriptError {
    line: number;
    message: string;
}

export enum ScriptCompileStatus {
    Unknown,
    Uploading,
    Uploaded,
    Compiling,
    Compiled,
    Failed,
}

const rx_login_complete =
    /^ \* (?<name>\S+) \[(?<account>\S+) \((?<client>[^\)]+)\) (?<index>\d+)] joins the adventure\.$/;

const rx_quest_status = /QUEST STATUS/;
const rx_aborted = /(?:Script edit|Modification) aborted\./;
const rx_getverb =
    /Error: Script #(?<script>\d+) is a verb\. Please use (?<command>.*?) instead\./;
const rx_noscript = /Error\: Script \#\d+ has not been created yet\./;
const rx_noverb = /Verb not found\./;
const rx_ss_check = /\s\s+\d+\s\s+.*?\s\s+.*?\s\s+.*?/;

const rx_ready = /(?:READY FOR ASCII UPLOAD)|(?:Continuing\:)/;

const rx_compiling =
    /^Compiling GSL script\: (?<script>\d+) \[(\d+)\]\[(?<path>.*?)\]$/;
const rx_compile_ok =
    /^Compile OK\.  (?<warnings>\d+) Warnings\.  Size\: (?<bytes>[0-9,]+) bytes \(of (?<maxBytes>[0-9,]+) available\)$/;
const rx_compile_fail =
    /^Compile Failed w\/(?<errors>\d+) errors and (?<warnings>\d+) warnings\.$/;

const rx_compile_error = /^\s*(?<line>\d+)\s:\s(?<message>.*?)$/;

const rx_compiled = /Compile ok\./;

const rx_modified =
    /On\s(?<dow>\w+)\s(?<month>\w+) \s?(?<day>\d+) (?<hh>\d+)\:(?<mm>\d+)\:(?<ss>\d+) (?<year>\d+)$/;
const rx_details =
    /(?:^Name\: (?<name>.*?)$)|(?:^Desc\: (?<desc>.*?)$)|(?:^Owned by: (?<owner>.*?)$)|(?:^Last modified by: (?<modifier>.*?)$)|(?:^(New)? ?File\: (?<path>.*?)(?:, (?<lines>\d+) lines?)?\.$)/;

const monthList = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

const clientTimeout = 15000;
const taskQueueTimeout = 30000;
const ssCheckeditTimeout = 7500;

export type InitOptions = {
    login: {
        account: string;
        instance: string;
        character: string;
        password: string;
    };
    console: { log: (...args: any[]) => void };
    downloadLocation: string;
    onCreate: (client: EditorClient) => void;
} & ({ loggingEnabled: true; logFileName: string } | { loggingEnabled: false });

/**
 * An operation requiring an editor client. If a promise is returned
 * it will be processed as if it is part of the task.
 * @see withEditorClient
 */
export type ClientTask<T> = (client: EditorClient) => T;

/**
 * Provides an `EditorClient` object that is guaranteed to be exclusively owned
 * by the caller, so long as all other callers are using this function. This
 * prevents callers from sending conflicting commands to the game.
 *
 * @returns a promise that resolves when the task has been processed
 * successfully, or rejects if the task fails.
 */
export const withEditorClient = async <T>(
    initOptions: InitOptions,
    task: ClientTask<T>,
): Promise<T> => {
    return withClientForInstance("dev", initOptions, task);
};

/**
 * Like `withEditorClient`, but connects to the prime (production) server.
 * Uses its own independent connection and task queue. Intended for
 * read-only operations such as downloading scripts for diffing.
 */
export const withPrimeEditorClient = async <T>(
    initOptions: InitOptions,
    task: ClientTask<T>,
): Promise<T> => {
    return withClientForInstance("prime", initOptions, task);
};

type TaskController<T> = {
    task: ClientTask<T>;
    initOptions: InitOptions;
    resolve: (result: T) => void;
    reject: (error: Error) => void;
};

type TaskExecution = {
    leaseId: number;
    abortController: AbortController;
};

class EditorClientTaskTimeoutError extends Error {
    constructor(timeoutMillis: number) {
        super(`Editor client task timed out after ${timeoutMillis}ms.`);
        this.name = "EditorClientTaskTimeoutError";
    }
}

class EditorClientLoginTimeoutError extends Error {
    constructor(timeoutMillis: number) {
        super(`Editor client login prompt timed out after ${timeoutMillis}ms.`);
        this.name = "EditorClientLoginTimeoutError";
    }
}

class StaleEditorClientTaskError extends Error {
    constructor() {
        super("Stale editor client task was ignored.");
        this.name = "StaleEditorClientTaskError";
    }
}

const NON_RESETTABLE_ERROR_NAMES = new Set([
    "AbortError",
    "StaleEditorClientTaskError",
    "QuickLoginCancelledError",
    "EditorClientMissingVerbError",
    "EditorClientMissingScriptError",
]);

function getErrorCode(error: Error): string | undefined {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function shouldResetClient(error: Error): boolean {
    if (NON_RESETTABLE_ERROR_NAMES.has(error.name)) {
        return false;
    }
    // Known expected quick-login failures (auth/config) should not reset.
    if (error.name === "QuickLoginError") {
        const errorCode = getErrorCode(error);
        if (errorCode === "NORECORD" || errorCode === "PASSWORD") {
            return false;
        }
    }
    // Reset for network and unexpected errors by default.
    return true;
}

function createNamedError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

function createAbortError(message: string): Error {
    return createNamedError("AbortError", message);
}

function throwIfAborted(signal?: AbortSignal, message?: string): void {
    if (signal?.aborted) {
        throw createAbortError(message ?? "Operation cancelled.");
    }
}

class TaskQueueProcessor {
    /** Frequency of queue processing */
    private static FREQUENCY_MILLIS = 250;
    /** Max time a task may hold the editor client lock */
    private static TASK_TIMEOUT_MILLIS = taskQueueTimeout;

    private client: EditorClient | undefined;
    private pendingClient: EditorClient | undefined;
    private taskQueue: TaskController<any>[];
    private isProcessingTask: boolean;
    private nextTaskLeaseId: number;
    private activeTaskLeaseId: number | undefined;
    private nextTick: NodeJS.Timeout | undefined;

    constructor() {
        this.taskQueue = [];
        this.pendingClient = undefined;
        this.isProcessingTask = false;
        this.nextTaskLeaseId = 0;
        this.activeTaskLeaseId = undefined;
        this.nextTick = undefined;
    }

    enqueueTask<T>(initOptions: InitOptions, task: ClientTask<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.taskQueue.push({ initOptions, task, resolve, reject });
            this.scheduleTick(0);
        });
    }

    /** Schedule the queue to be processed */
    scheduleTick(milliseconds: number): void {
        clearTimeout(this.nextTick);
        this.nextTick = setTimeout(() => this.tick(), milliseconds);
    }

    /** Process the next task in the queue, if any */
    async tick(): Promise<void> {
        clearTimeout(this.nextTick);
        if (this.taskQueue.length === 0) return;
        if (this.isProcessingTask) {
            this.scheduleTick(TaskQueueProcessor.FREQUENCY_MILLIS);
            return;
        }
        const { initOptions, task, resolve, reject } = this.taskQueue.shift()!;
        const taskExecution = this.createTaskExecution();

        this.isProcessingTask = true;
        try {
            const result = await this.runTaskWithTimeout(
                async () => {
                    const client = await this.ensureClient(
                        initOptions,
                        taskExecution,
                    );
                    this.assertTaskActive(taskExecution);
                    return task(client);
                },
                () => taskExecution.abortController.abort(),
            );
            if (!this.isTaskLeaseActive(taskExecution.leaseId)) {
                reject(new StaleEditorClientTaskError());
                return;
            }
            resolve(result);
        } catch (e: unknown) {
            const error = e instanceof Error ? e : new Error(String(e));
            if (shouldResetClient(error)) {
                this.resetClients();
            }
            reject(error);
        } finally {
            this.endTaskLease(taskExecution.leaseId);
            this.isProcessingTask = false;
            if (this.taskQueue.length > 0) {
                this.scheduleTick(TaskQueueProcessor.FREQUENCY_MILLIS);
            }
        }
    }

    private runTaskWithTimeout<T>(
        task: () => Promise<T> | T,
        onTimeout: () => void,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                onTimeout();
                reject(
                    new EditorClientTaskTimeoutError(
                        TaskQueueProcessor.TASK_TIMEOUT_MILLIS,
                    ),
                );
            }, TaskQueueProcessor.TASK_TIMEOUT_MILLIS);

            Promise.resolve()
                .then(() => task())
                .then(resolve, reject)
                .finally(() => clearTimeout(timeout));
        });
    }

    private createTaskExecution(): TaskExecution {
        return {
            leaseId: this.startTaskLease(),
            abortController: new AbortController(),
        };
    }

    private assertTaskActive(taskExecution: TaskExecution): void {
        if (!this.isTaskLeaseActive(taskExecution.leaseId)) {
            throw new StaleEditorClientTaskError();
        }
        throwIfAborted(
            taskExecution.abortController.signal,
            "Editor client task cancelled.",
        );
    }

    private clearClientRefs(client: EditorClient): void {
        if (this.pendingClient === client) {
            this.pendingClient = undefined;
        }
        if (this.client === client) {
            this.client = undefined;
        }
    }

    private disposeClient(client: EditorClient): void {
        client.destroy();
        this.clearClientRefs(client);
    }

    private resetClients(): void {
        if (this.pendingClient && this.pendingClient !== this.client) {
            this.disposeClient(this.pendingClient);
        }
        if (this.client) {
            this.disposeClient(this.client);
        }
    }

    private pruneDisconnectedClient(): void {
        if (this.client && !this.client.hasServerConnection()) {
            this.resetClients();
        }
    }

    private createEditorClient(options: InitOptions): EditorClient {
        const { downloadLocation, console, loggingEnabled } = options;
        const logFileName = options.loggingEnabled
            ? options.logFileName
            : undefined;
        return new EditorClient({
            ...(logFileName
                ? { log: path.join(downloadLocation, logFileName) }
                : {}),
            logging: loggingEnabled,
            debug: true,
            echo: true,
            console,
        });
    }

    private attachClientInvalidationHandlers(client: EditorClient): void {
        const clearCreatedClientRefs = () => this.clearClientRefs(client);
        client.on("error", clearCreatedClientRefs);
        client.on("quit", clearCreatedClientRefs);
    }

    private startTaskLease(): number {
        const taskLeaseId = ++this.nextTaskLeaseId;
        this.activeTaskLeaseId = taskLeaseId;
        return taskLeaseId;
    }

    private isTaskLeaseActive(taskLeaseId: number): boolean {
        return this.activeTaskLeaseId === taskLeaseId;
    }

    private endTaskLease(taskLeaseId: number): void {
        if (this.activeTaskLeaseId === taskLeaseId) {
            this.activeTaskLeaseId = undefined;
        }
    }

    async ensureClient(
        options: InitOptions,
        taskExecution: TaskExecution,
    ): Promise<EditorClient> {
        this.assertTaskActive(taskExecution);
        this.pruneDisconnectedClient();
        this.assertTaskActive(taskExecution);
        if (this.client) {
            return this.client;
        }

        const { login, onCreate } = options;
        const createdClient = this.createEditorClient(options);
        this.pendingClient = createdClient;
        this.attachClientInvalidationHandlers(createdClient);
        try {
            await createdClient.login(
                login,
                taskExecution.abortController.signal,
            );
            this.assertTaskActive(taskExecution);
        } catch (e) {
            this.disposeClient(createdClient);
            throw e;
        }
        this.clearClientRefs(createdClient);
        this.client = createdClient;
        onCreate(createdClient);
        return createdClient;
    }
}
const processorSingleton = new TaskQueueProcessor();
const primeProcessorSingleton = new TaskQueueProcessor();

const processorRegistry = new Map<string, TaskQueueProcessor>([
    ["dev", processorSingleton],
    ["prime", primeProcessorSingleton],
]);

/**
 * Provides an `EditorClient` for a named instance, using a per-instance
 * task queue. Creates a new queue on first use for instances beyond
 * the built-in "dev" and "prime".
 */
export const withClientForInstance = async <T>(
    instanceKey: string,
    initOptions: InitOptions,
    task: ClientTask<T>,
): Promise<T> => {
    let processor = processorRegistry.get(instanceKey);
    if (!processor) {
        processor = new TaskQueueProcessor();
        processorRegistry.set(instanceKey, processor);
    }
    return processor.enqueueTask(initOptions, task);
};

/**
 * The interface of an `EditorClient` instance. This layer of indirection
 * is necessary in order to prevent export of `EditorClient`. We want
 * to keep `EditorClient` private to this module so as to manage it as
 * a singleton.
 */
export type EditorClientInterface = InstanceType<typeof EditorClient>;

class EditorClient extends BaseGameClient {
    private interactive: boolean;
    private loginDetails: any;
    private retryCommand: string;

    constructor(options: GameClientOptions) {
        super(options);
        this.interactive = false;
        this.retryCommand = "";
    }

    private isInteractive(abortSignal?: AbortSignal): Promise<void> {
        if (this.interactive === true) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const output = new OutputProcessor((line: string) => {
                let match = line.match(rx_login_complete);
                if (match && match.groups) {
                    // character name, account name, index
                }
            });
            let settled = false;
            const cleanup = () => {
                this.off("text", waitForPrompt);
                clearTimeout(timeout);
                abortSignal?.removeEventListener("abort", onAbort);
            };
            const settle = (handler: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                handler();
            };
            function onAbort() {
                settle(() =>
                    reject(createAbortError("Editor client login cancelled.")),
                );
            }
            const timeout = setTimeout(() => {
                settle(() =>
                    reject(new EditorClientLoginTimeoutError(clientTimeout)),
                );
            }, clientTimeout);
            const waitForPrompt = (text: string) => {
                output.accumulate(text);
                if (output.peek(1) === ">") {
                    this.interactive = true;
                    settle(() => resolve());
                }
            };
            this.on("text", waitForPrompt);
            if (abortSignal) {
                abortSignal.addEventListener("abort", onAbort, { once: true });
                if (abortSignal.aborted) {
                    onAbort();
                }
            }
        });
    }

    private trySend(command: string, echo?: boolean): void {
        this.retryCommand = command;
        this.send(command, echo);
    }

    protected serverError(error: any): void {
        // attempt to reconnect on reset connections
        if (error.code === "ECONNRESET") {
            this.cleanupServer();
            this.reconnect()
                .then(() => {
                    if (this.retryCommand.length > 0) {
                        this.send(this.retryCommand);
                        this.retryCommand = "";
                    }
                })
                .catch(() => {
                    // Reconnect failed; emit error so the task queue
                    // resets the client on the next operation.
                    this.emit("error", error);
                });
        } else {
            super.serverError(error);
        }
    }

    showScript(script: number): Promise<ShowScriptOutput> {
        const result: Partial<ShowScriptOutput> = {};
        return new Promise((resolve, reject) => {
            const output = new OutputProcessor((line: string) => {
                let match: RegExpMatchArray | null;
                match = line.match(rx_modified);
                if (match && match.groups) {
                    let { year, month, day, hh, mm, ss } = match.groups;
                    let date = new Date(
                        Number(year),
                        monthList.indexOf(month),
                        Number(day),
                        Number(hh),
                        Number(mm),
                        Number(ss),
                    );
                    result.lastModifiedDate = date;
                    this.off("text", processText);
                    clearTimeout(timeout);
                    resolve(result as ShowScriptOutput);
                    return;
                }
                match = line.match(rx_details);
                if (match && match.groups) {
                    for (let property in match.groups) {
                        if (match.groups[property]) {
                            result[property as keyof ShowScriptOutput] = match
                                .groups[property] as any;
                        }
                    }
                    return;
                }
            });
            const processText = (text: string) => output.accumulate(text);
            const timeout = setTimeout(() => {
                this.off("text", processText);
                reject(new Error("Script check timed out."));
            }, clientTimeout);
            this.on("text", processText);
            this.trySend(`/ss ${script}`);
        });
    }

    showScriptCheckStatus(script: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const output = new OutputProcessor((line) => {
                if (!line.match(rx_ss_check)) return;
                const tokens = line.split(/\s\s+/);
                clearTimeout(timeout);
                this.off("text", processText);
                resolve(tokens[tokens.length - 1]);
            });
            const processText = (text: string) => output.accumulate(text);
            const timeout = setTimeout(() => {
                this.off("text", processText);
                reject(new Error("Script check timed out."));
            }, ssCheckeditTimeout);
            this.on("text", processText);
            this.trySend(`/ss check ${script}`);
        });
    }

    modifyScript(
        script: number | string,
        keepalive?: boolean,
    ): Promise<ScriptProperties> {
        const scriptProperties: Partial<ScriptProperties> = { new: false };
        return new Promise((resolve, reject) => {
            const modifyFailed = (reason: string, errorName?: string) => {
                clearTimeout(timeout);
                this.off("text", processText);
                reject(
                    errorName
                        ? createNamedError(errorName, reason)
                        : new Error(reason),
                );
            };
            const output = new OutputProcessor((line: string) => {
                let match: RegExpMatchArray | null;
                if (rx_noverb.test(line)) {
                    return modifyFailed(
                        `Verb '${script}' does not exist.`,
                        "EditorClientMissingVerbError",
                    );
                }
                if (rx_noscript.test(line)) {
                    return modifyFailed(
                        `Script ${script} has not yet been created.`,
                        "EditorClientMissingScriptError",
                    );
                }
                match = line.match(rx_getverb);
                if (match && match.groups) {
                    scriptProperties.verb = match.groups.command
                        .split(" ")
                        .slice(1)
                        .join(" ");
                    this.send(match.groups.command, true);
                    return;
                }
                match = line.match(rx_modified);
                if (match && match.groups) {
                    let { year, month, day, hh, mm, ss } = match.groups;
                    let date = new Date(
                        Number(year),
                        monthList.indexOf(month),
                        Number(day),
                        Number(hh),
                        Number(mm),
                        Number(ss),
                    );
                    scriptProperties.lastModifiedDate = date;
                    return;
                }
                match = line.match(rx_details);
                if (match && match.groups) {
                    for (let property in match.groups) {
                        if (match.groups[property]) {
                            scriptProperties[
                                property as keyof ScriptProperties
                            ] = match.groups[property] as any;
                        }
                    }
                    return;
                }
            });
            const timeout = setTimeout(
                () => modifyFailed("Modification timed out."),
                clientTimeout,
            );
            const processText = async (text: string) => {
                output.accumulate(text);
                let done = false;
                if (output.peek(5) === "001] ") {
                    this.off("text", processText);
                    this.send("");
                    done = true;
                    scriptProperties.new = true;
                } else if (output.peek(4) === "Edt:") {
                    this.off("text", processText);
                    done = true;
                }
                if (done) {
                    clearTimeout(timeout);
                    if (!keepalive) {
                        try {
                            await this.exitModifyScript();
                        } catch (e) {
                            reject(
                                e instanceof Error ? e : new Error(String(e)),
                            );
                            return;
                        }
                    }
                    resolve(scriptProperties as ScriptProperties);
                }
            };
            this.on("text", processText);
            this.trySend(
                `/${typeof script === "number" ? "ms" : "mv"} ${script}`,
            );
        });
    }

    exitModifyScript(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.off("text", processText);
                reject(new Error("Modification exit timed out."));
            }, clientTimeout);
            const processText = (text: string) => output.accumulate(text);
            const output = new OutputProcessor((line: string) => {
                if (!line.match(rx_aborted) && !line.match(rx_quest_status)) {
                    return;
                }
                this.off("text", processText);
                clearTimeout(timeout);
                resolve();
            });
            this.on("text", processText);
            this.trySend("Q");
        });
    }

    captureScript(): Promise<string> {
        return new Promise((resolve, reject) => {
            const captureFailed = (reason: string) => {
                clearTimeout(timeout);
                this.off("text", processText);
                reject(new Error(reason));
            };
            const scriptLines: Array<string> = [];
            const output = new OutputProcessor((line: string) =>
                scriptLines.push(line),
            );
            const timeout = setTimeout(
                () => captureFailed("Capture timed out."),
                clientTimeout,
            );
            const processText = async (text: string) => {
                output.accumulate(text);
                if (output.peek(4) === "Edt:") {
                    clearTimeout(timeout);
                    this.off("text", processText);
                    try {
                        await this.exitModifyScript();
                    } catch (e) {
                        reject(e instanceof Error ? e : new Error(String(e)));
                        return;
                    }
                    resolve(scriptLines.join("\r\n"));
                }
            };
            this.on("text", processText);
            this.trySend("P");
        });
    }

    sendScript(
        lines: Array<string>,
        newScript: boolean,
    ): Promise<ScriptCompileResults> {
        return new Promise((resolve, reject) => {
            const compileResults: ScriptCompileResults = {
                script: 0,
                path: "",
                bytes: 0,
                maxBytes: 0,
                errors: 0,
                warnings: 0,
                errorList: [],
                status: ScriptCompileStatus.Unknown,
            };
            const sendFailed = (reason: string) => {
                clearTimeout(timeout);
                this.off("text", processText);
                reject(new Error(reason));
            };
            const timeout = setTimeout(
                () => sendFailed("Script upload timed out."),
                clientTimeout,
            );
            const output = new OutputProcessor((line: string) => {
                let match: RegExpMatchArray | null;
                if (rx_aborted.test(line) || rx_compiled.test(line)) {
                    clearTimeout(timeout);
                    this.off("text", processText);
                    resolve(compileResults);
                    return;
                }
                if (rx_ready.test(line)) {
                    compileResults.status = ScriptCompileStatus.Uploading;
                    lines.forEach((line) => this.send(line));
                    compileResults.status = ScriptCompileStatus.Uploaded;
                    return;
                }
                match = line.match(rx_compiling);
                if (match && match.groups) {
                    compileResults.status = ScriptCompileStatus.Compiling;
                    compileResults.script = Number(match.groups.script);
                    compileResults.path = match.groups.path;
                    return;
                }
                match = line.match(rx_compile_error);
                if (match && match.groups) {
                    const line = Number(match.groups.line);
                    const message = match.groups.message;
                    compileResults.errorList.push({ line, message });
                    return;
                }
                match = line.match(rx_compile_ok);
                if (match && match.groups) {
                    compileResults.status = ScriptCompileStatus.Compiled;
                    compileResults.warnings = Number(match.groups.warnings);
                    compileResults.bytes = Number(
                        match.groups.bytes.replace(/,/g, ""),
                    );
                    compileResults.maxBytes = Number(
                        match.groups.maxBytes.replace(/,/g, ""),
                    );
                    return;
                }
                match = line.match(rx_compile_fail);
                if (match && match.groups) {
                    compileResults.status = ScriptCompileStatus.Failed;
                    compileResults.errors = Number(match.groups.errors);
                    compileResults.warnings = Number(match.groups.warnings);
                    return;
                }
            });
            const processText = async (text: string) => {
                output.accumulate(text);
                if (output.peek(4) === "Edt:") {
                    if (
                        compileResults.status === ScriptCompileStatus.Uploaded
                    ) {
                        this.send("G");
                    } else if (
                        compileResults.status ===
                            ScriptCompileStatus.Compiled ||
                        compileResults.status === ScriptCompileStatus.Failed
                    ) {
                        try {
                            await this.exitModifyScript();
                        } catch (e) {
                            clearTimeout(timeout);
                            this.off("text", processText);
                            reject(
                                e instanceof Error ? e : new Error(String(e)),
                            );
                            return;
                        }
                    }
                    output.flush();
                }
            };
            this.on("text", processText);
            this.trySend(newScript ? this.newLine + "C" : "Z");
        });
    }

    async reconnect(abortSignal?: AbortSignal) {
        throwIfAborted(abortSignal, "Editor client login cancelled.");
        const error: any = (e: Error) => {
            error.caught = e;
        };
        const { account, password, instance, character } = this.loginDetails;
        const sal = await EAccessClient.quickLogin(
            account,
            password,
            instance,
            character,
            "storm",
            abortSignal,
        ).catch(error);
        if (error.caught) {
            return Promise.reject(error.caught);
        }
        throwIfAborted(abortSignal, "Editor client login cancelled.");
        this.interactive = false;
        this.connect(sal);
        return await this.isInteractive(abortSignal);
    }

    async login(loginDetails: any, abortSignal?: AbortSignal) {
        this.loginDetails = loginDetails;
        return await this.reconnect(abortSignal);
    }

    /**
     * Executes the given `command`.
     * @returns game output lines seen between `start` and `end`
     */
    executeCommand(
        command: string,
        {
            captureStart,
            captureEnd,
            abortPattern,
            timeoutMillis,
            includeStartLine,
            includeEndLine,
        }: {
            captureStart: RegExp;
            captureEnd: RegExp;
            /** If matched before captureStart, resolves immediately with that line. */
            abortPattern?: RegExp;
            timeoutMillis: number;
            includeStartLine?: boolean;
            includeEndLine?: boolean;
        },
    ): Promise<string[]> {
        const lines: string[] = [];

        return new Promise((resolve, reject) => {
            let seenStart = false;

            // Process game output between `start` and `end`
            const output = new OutputProcessor((line: string) => {
                // Check capture start
                if (!seenStart) {
                    // Check abort pattern before start marker
                    if (abortPattern && line.match(abortPattern)) {
                        this.off("text", processText);
                        clearTimeout(timeout);
                        resolve([line]);
                        return;
                    }
                    if (line.match(captureStart)) {
                        seenStart = true;
                        if (includeStartLine) {
                            lines.push(line);
                        }
                    }
                    return;
                }

                // Check capture end
                if (line.match(captureEnd)) {
                    if (includeEndLine) lines.push(line);
                    this.off("text", processText);
                    clearTimeout(timeout);
                    resolve(lines);
                    return;
                }

                // Capture line
                lines.push(line);
            });

            // Pipe text to OutputProcessor
            const processText = (text: string) => output.accumulate(text);
            this.on("text", processText);

            // Handle timeout
            const timeout = setTimeout(() => {
                this.off("text", processText);
                reject(new Error(`Command timed out: ${command}`));
            }, timeoutMillis);

            // Send command
            this.trySend(command);
        });
    }
}

class OutputProcessor {
    private buffer: string;
    private handler: (text: string) => void;
    constructor(handler: (text: string) => void) {
        this.buffer = "";
        this.handler = handler;
    }
    accumulate(text: string) {
        this.buffer += text;
        let last = -2,
            nl = this.buffer.indexOf("\r\n");
        while (nl > -1) {
            let line = this.buffer.substring(last + 2, nl);
            this.handler(line);
            last = nl;
            nl = this.buffer.indexOf("\r\n", nl + 2);
        }
        if (last !== -2) {
            this.buffer = this.buffer.substring(last + 2);
        }
    }
    peek(n: number = 0): string {
        return n <= 0
            ? this.buffer
            : this.buffer.substring(this.buffer.length - n, this.buffer.length);
    }
    flush(): string {
        return (this.buffer = "");
    }
}
