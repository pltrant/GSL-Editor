import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fetchScriptContent, normalizeText } from "../agentToolOrchestrator";
import { MAX_LINE_LENGTH } from "../const";
import {
    ClientTask,
    EditorClientInterface,
    InitOptions,
    ScriptCompileStatus,
    ScriptMetadata,
    withOneShotEditorClient,
} from "../editorClient";
import { fetchFrozenResources } from "../frozenResources";
import { loadLoginConfig } from "../mcp/mcpConfig";
import { readFileNoSymlink } from "../util/noSymlinkFile";

/**
 * The only game this tool logs in to. It stays in code: a game code read from
 * a config would let that config pass its own check. DR follows by adding its
 * own entry here.
 */
export const DEV_INSTANCE = "GS4D";
/** The server's editor stops taking text one line short of its limit */
const MAX_SCRIPT_LINES = 39_998;
/** A file can have a problem on every line; the caller doesn't need them all */
const MAX_PROBLEMS_SHOWN = 20;
/** A slow compile must not be reported `unknown` after the 15s default */
const UPLOAD_TIMEOUT_MILLIS = 30_000;

/** The number a `S<number>.gsl` file uploads as, or 0 */
export const scriptNumber = (filePath: string) =>
    Number(path.basename(filePath).match(/^s(\d{1,6})\.gsl$/i)?.[1]);

/** From the login config; `withDevClient` adds the Dev gate */
export type DevLogin = Omit<InitOptions["login"], "requireDevelopment">;

export interface ScriptFile {
    script: number;
    path: string;
    text: string;
    /** Sent text, LF with one trailing newline, as a download normalizes it */
    sha256: string;
}

/** `refused` means nothing was written. See `sendAndVerify` for the rest. */
export interface UploadResult {
    outcome: "ok" | "compile_failed" | "refused" | "unknown" | "not_attempted";
    script: number;
    sha256: string;
    /** Dev's text, when it was read back */
    readback_sha256: string | null;
    detail: string;
}

export interface MetadataResult {
    outcome: "ok" | "unknown" | "not_attempted";
    script: number;
    /** `unavailable`: `/ss` timed out, errored or went unparsed */
    status: ScriptMetadata["status"] | "unavailable";
    modifier: string | null;
    epoch: number | null;
    detail: string;
}

/**
 * What Dev must still show for a script before its upload is sent. Only the
 * interactive command's `confirm` may answer `missing`, which allows creation.
 */
export type Expected = { epoch: number } | { missing: true };

export const errorMessage = (e: unknown) =>
    e instanceof Error ? e.message : `${e}`;

const sha256 = (text: string) =>
    createHash("sha256").update(text).digest("hex");

export const scriptLines = (text: string) =>
    text.replace(/\n$/, "").split("\n");

export const notAttempted = (script: number, sha256 = ""): UploadResult => ({
    outcome: "not_attempted",
    script,
    sha256,
    readback_sha256: null,
    detail: "Stopped before this script.",
});

export const notAttemptedMetadata = (
    script: number,
    detail = "Stopped before this script.",
): MetadataResult => ({
    outcome: "not_attempted",
    script,
    status: "unavailable",
    modifier: null,
    epoch: null,
    detail,
});

/**
 * Set by Claude Code, Codex and similar harnesses in their tool shells. The
 * checks are best effort against a determined agent; the rule that agents
 * never upload is the real barrier.
 */
const AGENT_ENV_VARS = [
    "CLAUDECODE",
    "CLAUDE_PID",
    "AI_AGENT",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_THREAD_ID",
];

/** The agent-session variables set in `env`, sorted */
export const agentEnvMarkers = (env: NodeJS.ProcessEnv): string[] =>
    Object.keys(env)
        .filter(
            (name) =>
                AGENT_ENV_VARS.includes(name) ||
                name.startsWith("CLAUDE_CODE_"),
        )
        .sort();

/** Hides `secret` in text that may be printed or logged */
export const makeScrub = (secret: string | undefined) => (text: string) =>
    secret ? text.split(secret).join("<redacted>") : text;

/** Scrubs every string in a result before it is JSON-encoded */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
    if (typeof value === "string") return scrub(value) as T;
    if (Array.isArray(value)) {
        return value.map((item) => scrubDeep(item, scrub)) as T;
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)]),
        ) as T;
    }
    return value;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Finds what the editor would not take as sent. A blank line ends the upload
 * and the lines after it run as editor commands, `~` counts as blank, a full
 * buffer does the same, and longer lines are split. Downloads trim the end of
 * the text, so a read-back can't check spaces after the last line.
 */
function textProblems(text: string): string[] {
    const lines = scriptLines(text);
    const problems: string[] = [];
    if (lines.length > MAX_SCRIPT_LINES) {
        problems.push(`${lines.length} lines, limit ${MAX_SCRIPT_LINES}`);
    }
    if (/\s$/.test(lines[lines.length - 1])) {
        problems.push(`line ${lines.length}: trailing whitespace on last line`);
    }
    lines.forEach((line, index) => {
        const report = (reason: string) =>
            problems.push(`line ${index + 1}: ${reason}`);
        if (!line.trim()) report("blank line");
        if (line.startsWith("~")) report("starts with ~");
        if (line.length > MAX_LINE_LENGTH) {
            report(`${line.length} characters, limit ${MAX_LINE_LENGTH}`);
        }
        const badCharacter = line.match(/[^\t\x20-\x7e]/);
        if (badCharacter) {
            const code = badCharacter[0].codePointAt(0)!;
            const hex = code.toString(16).toUpperCase().padStart(4, "0");
            report(
                `character U+${hex} at column ${badCharacter.index! + 1} is not printable ASCII or tab`,
            );
        }
    });
    return problems;
}

/** Reads `S<number>.gsl` files; any problem refuses the whole run. */
export function loadScriptFiles(paths: string[]): ScriptFile[] {
    if (paths.length === 0)
        throw new Error("Give at least one S<number>.gsl file.");
    const seen = new Map<number, string>();
    return paths.map((filePath) => {
        const script = scriptNumber(filePath);
        if (!script) {
            throw new Error(
                `${filePath}: expected a file named S<number>.gsl, numbered from 1.`,
            );
        }
        const other = seen.get(script);
        if (other) {
            throw new Error(
                `Script ${script} is listed twice: ${other} and ${filePath}.`,
            );
        }
        seen.set(script, filePath);
        // CRLF is folded, as the hash already does; a lone CR is refused below.
        const text = readFileNoSymlink(filePath).replace(/\r\n/g, "\n");
        const problems = textProblems(text);
        if (problems.length > 0) {
            const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).join("; ");
            const hidden = problems.length - MAX_PROBLEMS_SHOWN;
            throw new Error(
                `${filePath}: ${hidden > 0 ? `${shown}; ${hidden} more` : shown}`,
            );
        }
        return {
            script,
            path: filePath,
            text,
            sha256: sha256(normalizeText(text)),
        };
    });
}

export function parseScriptNumbers(values: string[]): number[] {
    if (values.length === 0)
        throw new Error("Give at least one script number.");
    return values.map((value) => {
        // Leading zeros are allowed, as in a file name; only zero is refused.
        if (!/^\d{1,6}$/.test(value) || Number(value) === 0) {
            throw new Error(`${value} is not a script number.`);
        }
        return Number(value);
    });
}

/** `N=<epoch>`, digits only, exactly one per script; `0` means blank */
export function parseExpected(
    values: string[],
    scripts: number[],
): { epoch: number }[] {
    const expected = new Map<number, { epoch: number }>();
    for (const value of values) {
        const match = value.match(/^(\d+)=(\d+)$/);
        if (!match || !scripts.includes(Number(match[1]))) {
            throw new Error(
                `--expect ${value} does not name a listed script as <number>=<epoch>.`,
            );
        }
        const [, script, epoch] = match;
        if (expected.has(Number(script))) {
            throw new Error(`--expect names script ${script} twice.`);
        }
        expected.set(Number(script), { epoch: Number(epoch) });
    }
    return scripts.map((script) => {
        const found = expected.get(script);
        if (!found) {
            throw new Error(
                `--expect ${script}=<epoch> is required: pass the epoch metadata showed, 0 for blank.`,
            );
        }
        return found;
    });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** `--config`, else the environment the MCP server already uses */
const loginConfigPath = (
    configPath: string | undefined,
    env: NodeJS.ProcessEnv,
) => configPath ?? env.GSL_LOGIN_CONFIG_FILE;

export function devLogin(
    configPath: string | undefined,
    env: NodeJS.ProcessEnv,
): DevLogin {
    const resolved = loginConfigPath(configPath, env);
    if (!resolved) {
        throw new Error(
            "Pass --config <loginConfig.json> or set GSL_LOGIN_CONFIG_FILE.",
        );
    }
    const { credentials, configError } = loadLoginConfig({
        ...env,
        GSL_LOGIN_CONFIG_FILE: resolved,
    });
    if (configError) throw new Error(configError);
    const [login, ...others] = credentials.get("dev") ?? [];
    if (!login || others.length > 0) {
        throw new Error("Set devInstance and exactly one dev character.");
    }
    // Login would crash on anything else, outside any promise.
    if (typeof login.account !== "string") {
        throw new Error("account must be a string.");
    }
    assertDevInstance(login.instance);
    return login;
}

function assertDevInstance(instance: string): void {
    if (instance !== DEV_INSTANCE) {
        throw new Error(
            `Refusing instance ${instance}: this tool only runs on ${DEV_INSTANCE}.`,
        );
    }
}

/**
 * The one way from here to the game: a one-shot session that refuses any
 * instance outside the allow-list and any game EAccess does not report as
 * DEVELOPMENT, so no caller can connect anywhere else by leaving the gate out.
 */
export async function withDevClient<T>(
    login: DevLogin,
    task: ClientTask<Promise<T>>,
    signal?: AbortSignal,
): Promise<T> {
    assertDevInstance(login.instance);
    return withOneShotEditorClient(
        { ...login, requireDevelopment: true },
        task,
        signal,
    );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append-only JSON lines. Opening it before login refuses a run it can't
 * record. A later write failure is kept in `failure` rather than thrown, so
 * it can't turn a finished upload into a report that nothing was written.
 */
export class AuditLog {
    private readonly fd: number;
    private readonly user: string;
    private readonly host = os.hostname();
    failure: string | undefined;

    constructor(
        readonly path: string,
        private readonly scrub: (text: string) => string,
    ) {
        const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.fd = fs.openSync(
            path,
            O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW,
            0o600,
        );
        try {
            this.user = os.userInfo().username;
        } catch {
            this.user = String(process.getuid?.());
        }
    }

    record(fields: Record<string, unknown>): void {
        const entry = {
            ts: new Date().toISOString(),
            user: this.user,
            host: this.host,
            target: DEV_INSTANCE,
            ...fields,
        };
        try {
            fs.writeSync(
                this.fd,
                `${JSON.stringify(scrubDeep(entry, this.scrub))}\n`,
            );
            fs.fsyncSync(this.fd);
        } catch (e) {
            this.failure ??= errorMessage(e);
        }
    }

    close(): void {
        try {
            fs.closeSync(this.fd);
        } catch {
            // Already reported through `failure`, or nothing left to record.
        }
    }
}

const dirname = (filePath: string) => path.dirname(path.resolve(filePath));

/** Opens the audit log at `--audit-log`, else beside the login config */
export const openAuditLog = (
    options: { config?: string; "audit-log"?: string },
    env: NodeJS.ProcessEnv,
    scrub: (text: string) => string,
) =>
    new AuditLog(
        options["audit-log"] ??
            path.join(
                dirname(loginConfigPath(options.config, env)!),
                "dev-upload-audit.log",
            ),
        scrub,
    );

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Reads each script's Dev metadata in turn. After a timeout the rest are
 * skipped, so its late reply can't be read as another script's.
 */
async function readMetadata(
    client: EditorClientInterface,
    scripts: number[],
): Promise<MetadataResult[]> {
    const results: MetadataResult[] = [];
    let timedOut = false;
    for (const script of scripts) {
        const result = notAttemptedMetadata(
            script,
            "Skipped after an earlier /ss timeout.",
        );
        if (!timedOut) {
            result.outcome = "ok";
            result.detail = "";
            try {
                const { status, modifier, epoch } =
                    await client.showScriptRaw(script);
                result.status = status;
                result.modifier = modifier ?? null;
                result.epoch = epoch ?? null;
            } catch (e) {
                timedOut =
                    e instanceof Error && e.name === "ScriptCheckTimeoutError";
                result.outcome = "unknown";
                result.detail = errorMessage(e);
            }
        }
        results.push(result);
    }
    return results;
}

export const metadataSession = (
    login: DevLogin,
    scripts: number[],
    signal?: AbortSignal,
) => withDevClient(login, (client) => readMetadata(client, scripts), signal);

/** Scripts the server reports as FROZEN or LOCKED, verbs converted */
export const frozenSession = async (login: DevLogin, signal?: AbortSignal) =>
    Object.values(
        (await withDevClient(login, fetchFrozenResources, signal)).script ?? {},
    ).map(({ id, status }) => ({ script: Number(id), status }));

/**
 * Why Dev's script may not be written over, or nothing. Without an
 * expectation, only a missing script is refused: a verb's metadata can't be
 * read, so it is uploaded unchecked.
 */
function refusal(
    expected: Expected | undefined,
    dev: ScriptMetadata,
): string | undefined {
    if (!expected) {
        return dev.status === "missing"
            ? "the script is not on Dev, and only the interactive command creates one"
            : undefined;
    }
    if ("missing" in expected) {
        return dev.status === "missing"
            ? undefined
            : "it exists on Dev now, but was missing when listed";
    }
    if (dev.status === "missing") {
        return "Dev now reports it as missing, but it existed when listed";
    }
    if (dev.status === "verb") {
        return "Dev answers with the verb redirect, which shows no metadata to compare";
    }
    const epoch = dev.status === "blank" ? 0 : dev.epoch;
    if (!epoch && dev.status !== "blank") {
        return "Dev shows a modifier but no date, which --expect cannot check";
    }
    return epoch === expected.epoch
        ? undefined
        : `Dev's copy changed after it was listed (epoch ${epoch}, expected ${expected.epoch})`;
}

type Verdict = Pick<UploadResult, "outcome" | "readback_sha256" | "detail">;

/**
 * Sends the text with `Z` (or `C` for a new script), the lines, a blank line,
 * `G` and `Q`, then reads Dev back on the same login. A failed compile reports
 * with no restore: `Q` after it has written the buffer, and the read-back
 * confirms Dev holds the sent text. Anything short of `Compile OK` going live
 * for this script number throws, so the caller drops the connection; by
 * then `Q` may already have written the buffer, so the result is `unknown`.
 */
async function sendAndVerify(
    client: EditorClientInterface,
    { script, text, sha256: expected }: ScriptFile,
    isNew: boolean,
): Promise<Verdict> {
    const compile = await client.sendScript(
        [...scriptLines(text), ""],
        isNew,
        UPLOAD_TIMEOUT_MILLIS,
    );
    const { Compiled, Failed } = ScriptCompileStatus;
    const failed = compile.script === script && compile.status === Failed;
    if (
        !failed &&
        (compile.script !== script ||
            compile.status !== Compiled ||
            !compile.live)
    ) {
        throw new Error(`Script ${script} did not compile and go live.`);
    }
    const { content } = await fetchScriptContent(client, script);
    const readback_sha256 = sha256(content);
    const matched = readback_sha256 === expected;
    if (failed) {
        const errors = compile.errorList.map(
            ({ line, message }) => `line ${line}: ${message}`,
        );
        return {
            outcome: matched ? "compile_failed" : "unknown",
            readback_sha256,
            detail:
                `Compile failed with ${compile.errors} errors` +
                (matched ? "" : ", and Dev does not hold the sent text") +
                `. ${errors.join("; ")}`,
        };
    }
    return {
        outcome: matched ? "ok" : "unknown",
        readback_sha256,
        detail: matched
            ? "Compile OK and the read-back matched."
            : "Compile OK, but the read-back does not match the sent text.",
    };
}

/** After a drop: a read-back on a new login shows which text Dev holds, not whether it compiled. */
async function readBack(
    login: DevLogin,
    { script, sha256: expected }: ScriptFile,
    failure: string,
    signal?: AbortSignal,
): Promise<Verdict> {
    try {
        const { content } = await withDevClient(
            login,
            (client) => fetchScriptContent(client, script),
            signal,
        );
        const readback = sha256(content);
        const holds = readback === expected ? "holds" : "does not hold";
        return {
            outcome: "unknown",
            readback_sha256: readback,
            detail: `${failure} Dev ${holds} the sent text.`,
        };
    } catch (e) {
        return {
            outcome: "unknown",
            readback_sha256: null,
            detail: `${failure} Read-back failed: ${errorMessage(e)}`,
        };
    }
}

/**
 * Uploads the files in order on one login, stopping at the first script that
 * is not `ok`. Before each upload `/freeze` must not list the script, `/ss`
 * must still show the epoch `expected` gives for it, and `/ms` must agree
 * with `/ss`. A `/freeze` read that fails stops the run there, unwritten,
 * since an unknown freeze is treated as one. With `confirm` instead, the
 * metadata is read first and the session waits, still open, for it to return
 * what each upload must match, or nothing to decline them all.
 *
 * Once text may have gone out, any failure drops the connection rather than
 * typing `Q` or `quit` at `Edt:`, which would write the buffer, and reads Dev
 * back on a new login. Nothing reconnects or resends. A run-level failure, such
 * as a login refusal, leaves every script `not_attempted` with the reason in
 * `detail`. An abort of `signal` is such a failure too: the connection is
 * dropped at once.
 */
export async function uploadSession({
    login,
    files,
    audit,
    signal,
    ...mode
}: {
    login: DevLogin;
    files: ScriptFile[];
    audit: AuditLog;
    signal?: AbortSignal;
} & (
    | { expected: { epoch: number }[] }
    | {
          confirm: (
              metadata: MetadataResult[],
          ) => Promise<(Expected | undefined)[] | undefined>;
      }
)): Promise<{ detail: string; scripts: UploadResult[] }> {
    const scripts = files.map(({ script, sha256 }) =>
        notAttempted(script, sha256),
    );
    let required: (Expected | undefined)[] =
        "expected" in mode ? mode.expected : [];
    const refused = (index: number, detail: string) => {
        scripts[index] = { ...scripts[index], outcome: "refused", detail };
    };
    audit.record({
        event: "start",
        scripts: files.map(({ script, path, sha256 }) => ({
            script,
            path,
            sha256,
        })),
    });
    if (audit.failure) {
        throw new Error(`Audit log write failed: ${audit.failure}`);
    }
    let current: number | undefined;
    /** Set while this script's text may have reached the editor */
    let sent: number | undefined;
    let detail = "";
    try {
        await withDevClient(
            login,
            async (client) => {
                if ("confirm" in mode) {
                    const shown = await readMetadata(
                        client,
                        files.map(({ script }) => script),
                    );
                    const confirmed = await mode.confirm(shown);
                    if (!confirmed) {
                        files.forEach((_, i) =>
                            refused(i, "Not confirmed; nothing was uploaded."),
                        );
                        return;
                    }
                    required = confirmed;
                }
                for (let i = 0; i < files.length; i++) {
                    current = i;
                    const file = files[i];
                    // Read again for each script: the earlier uploads' time
                    // would otherwise be a gap a freeze could land in.
                    const frozen = (await fetchFrozenResources(client))
                        .script?.[file.script];
                    if (frozen) {
                        refused(
                            i,
                            `Nothing was uploaded: Dev reports the script as ${frozen.status}.`,
                        );
                        break;
                    }
                    const dev = await client.showScriptRaw(file.script);
                    const reason = refusal(required[i], dev);
                    if (reason) {
                        refused(i, `Nothing was uploaded: ${reason}.`);
                        break;
                    }
                    audit.record({
                        event: "sending",
                        script: file.script,
                        sha256: file.sha256,
                        dev,
                    });
                    if (audit.failure) {
                        refused(
                            i,
                            `Nothing was uploaded: audit log write failed: ${audit.failure}`,
                        );
                        break;
                    }
                    const { new: isNew } = await client.modifyScript(
                        file.script,
                        true,
                    );
                    if (isNew !== (dev.status === "missing")) {
                        // Thrown, not exited: `Q` at `Edt:` writes the buffer.
                        throw new Error(
                            "/ms disagrees with /ss about whether the script exists.",
                        );
                    }
                    sent = i;
                    scripts[i] = {
                        ...scripts[i],
                        ...(await sendAndVerify(client, file, isNew)),
                    };
                    sent = undefined;
                    audit.record({ event: "result", ...scripts[i] });
                    if (scripts[i].outcome !== "ok") break;
                }
            },
            signal,
        );
    } catch (e) {
        // A cancelled login reports the cancellation, not why.
        const message = errorMessage(signal?.aborted ? signal.reason : e);
        if (sent !== undefined) {
            const failure = `Upload failed: ${message}`;
            scripts[sent] = {
                ...scripts[sent],
                ...(await readBack(login, files[sent], failure, signal)),
            };
            audit.record({ event: "result", ...scripts[sent] });
        } else if (current !== undefined) {
            refused(current, `Nothing was uploaded: ${message}`);
        } else {
            detail = message;
        }
    }
    audit.record({ event: "end", detail, scripts });
    if (audit.failure && !detail) {
        detail = `Audit log write failed: ${audit.failure}`;
    }
    return { detail, scripts };
}

/**
 * `ok` only when every script is; otherwise the first other outcome. A
 * run-level `detail` is `refused` while nothing was attempted, and `unknown`
 * once something was.
 */
export const runOutcome = (detail: string, scripts: { outcome: string }[]) => {
    if (!detail) {
        return scripts.find(({ outcome }) => outcome !== "ok")?.outcome ?? "ok";
    }
    return scripts.every(({ outcome }) => outcome === "not_attempted")
        ? "refused"
        : "unknown";
};
