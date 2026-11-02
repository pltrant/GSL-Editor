/**
 * The interactive front of the Dev upload tool, the bundle's `interactive`
 * command. It needs a terminal, refuses agent sessions, shows Dev's metadata
 * for every file with a warning where an upload could surprise, and uploads
 * only after one typed phrase. It is the only way to create a script.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
    AuditLog,
    DEV_INSTANCE,
    Expected,
    MetadataResult,
    ScriptFile,
    agentEnvMarkers,
    devLogin,
    errorMessage,
    loadScriptFiles,
    makeScrub,
    openAuditLog,
    scriptLines,
    uploadSession,
} from "./devUpload";

/** Agent harnesses by process name or path; best effort, like the env check */
const AGENT_PROCESS_NAMES = ["claude", "codex", "claude-code"];
const AGENT_PROCESS_MARKERS = ["claude-code", "@anthropic-ai", "@openai/codex"];

export interface InteractiveIo {
    env: NodeJS.ProcessEnv;
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WritableStream & { isTTY?: boolean };
    stderr: NodeJS.WritableStream;
    /** Command names and arguments of every ancestor process */
    ancestors: string[];
}

/** Why this must not run here, or nothing */
export function guardReason({
    env,
    stdin,
    stdout,
    ancestors,
}: InteractiveIo): string | undefined {
    if (!(stdin.isTTY && stdout.isTTY)) {
        return "stdin and stdout must both be an interactive terminal.";
    }
    const markers = agentEnvMarkers(env);
    if (markers.length > 0) {
        return `agent-session environment variables are present (${markers.join(", ")}). Run it from a plain terminal, not from an agent.`;
    }
    const agent = ancestors.find(
        (name) =>
            AGENT_PROCESS_NAMES.includes(path.basename(name).toLowerCase()) ||
            AGENT_PROCESS_MARKERS.some((marker) =>
                name.toLowerCase().includes(marker),
            ),
    );
    if (agent) {
        return `it was started under an agent process (${agent}). Run it from a plain terminal, not from an agent.`;
    }
    return undefined;
}

/**
 * Names and arguments of every ancestor process, from /proc. Empty where
 * there is no /proc. Catches an agent that clears the environment and fakes
 * a terminal.
 */
export function processAncestors(): string[] {
    const names: string[] = [];
    const seen = new Set<number>();
    for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
        seen.add(pid);
        try {
            const read = (file: string) =>
                fs.readFileSync(`/proc/${pid}/${file}`, "utf8");
            const stat = read("stat");
            names.push(...read("cmdline").split("\0").filter(Boolean));
            names.push(read("comm").trim());
            // comm may contain spaces; the fields follow the last ")".
            pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        } catch {
            break;
        }
    }
    return names;
}

/** Reads a line without echo. Enter ends it, Ctrl+C rejects. */
function readHidden(
    { stdin, stdout }: InteractiveIo,
    prompt: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        stdout.write(prompt);
        let typed = "";
        const finish = () => {
            stdin.off("data", onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            stdout.write("\n");
        };
        const onData = (chunk: Buffer | string) => {
            for (const char of chunk.toString()) {
                if (char === "\r" || char === "\n") {
                    finish();
                    return resolve(typed);
                }
                if (char === "\u0003") {
                    finish();
                    return reject(new Error("Interrupted."));
                }
                if (char === "\u007f" || char === "\b")
                    typed = typed.slice(0, -1);
                else typed += char;
            }
        };
        stdin.setRawMode?.(true);
        stdin.on("data", onData);
        stdin.resume();
    });
}

/** Resolves with "" if the input closes first, which declines. */
const question = (rl: readline.Interface, prompt: string) =>
    new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(prompt, resolve);
    });

/** GSL-Editor's matchesRemoteAccount: the server truncates names, so compare by prefix. */
const matchesAccount = (account: string, modifier: string | null) =>
    !!modifier && `W_${account}`.startsWith(modifier);

const localTime = (epoch: number) => new Date(epoch * 1000).toLocaleString();

function describe({ status, modifier, epoch, detail }: MetadataResult): string {
    if (status === "missing") return "not found (new script)";
    if (status === "blank") return "metadata blank (no author/date recorded)";
    if (status === "unavailable") return `metadata unavailable (${detail})`;
    if (status === "verb") return "a verb (no metadata shown)";
    return `last modified by ${modifier ?? "?"}, ${epoch ? localTime(epoch) : "date unknown"}`;
}

function warnings(
    { script, path: filePath }: ScriptFile,
    { status, modifier, epoch, detail }: MetadataResult,
    account: string,
): string[] {
    if (status === "missing") {
        return [
            `script ${script} is not on Dev yet: uploading would create it`,
        ];
    }
    if (status === "blank") {
        return [
            `script ${script}: Dev metadata blank (no author/date recorded); couldn't check who changed it last or when`,
        ];
    }
    if (status === "unavailable" || status === "verb") {
        const why = status === "verb" ? "is a verb" : `unavailable (${detail})`;
        return [
            `Dev metadata for script ${script} ${why}; couldn't check who changed it last or when`,
        ];
    }
    const found: string[] = [];
    if (!matchesAccount(account, modifier)) {
        found.push(
            `script ${script} was last modified on Dev by someone else: ${modifier ?? "?"}`,
        );
    }
    const saved = fs.statSync(filePath).mtime;
    if (!epoch) {
        found.push(
            `couldn't read when script ${script} was last modified on Dev`,
        );
    } else if (epoch * 1000 > saved.getTime()) {
        found.push(
            `Dev's copy of script ${script} changed (${localTime(epoch)}) after the local file was saved (${saved.toLocaleString()}); the local copy may be stale`,
        );
    }
    return found;
}

/**
 * What the upload must still find on Dev, from what the list showed. Nothing
 * for a script with no readable date, which was warned about.
 */
function expectedFrom({ status, epoch }: MetadataResult): Expected | undefined {
    if (status === "missing") return { missing: true };
    if (status === "blank") return { epoch: 0 };
    if (status === "ok" && epoch) return { epoch };
    return undefined;
}

/** Returns the exit code: 0 only when every script uploaded. */
export async function runInteractive(
    paths: string[],
    options: { config?: string; "audit-log"?: string },
    io: InteractiveIo,
): Promise<number> {
    const { env, stdin, stdout, stderr } = io;
    const out = (text: string) => stdout.write(`${text}\n`);
    const err = (text: string) => stderr.write(`${text}\n`);
    const reason = guardReason(io);
    if (reason) {
        err(`REFUSED: ${reason}`);
        return 1;
    }
    let files: ScriptFile[];
    try {
        files = loadScriptFiles(paths);
    } catch (e) {
        err(`REFUSED: ${errorMessage(e)}`);
        return 1;
    }
    out(`DEV UPLOAD (${DEV_INSTANCE}). The normal path is Ctrl+U in VS Code.`);
    const password =
        env.GSL_PASSWORD ||
        (await readHidden(io, "Play.net password (not echoed): "));
    const scrub = makeScrub(password);
    let login, audit: AuditLog;
    try {
        login = devLogin(options.config, { ...env, GSL_PASSWORD: password });
        audit = openAuditLog(options, env, scrub);
    } catch (e) {
        err(`REFUSED: ${scrub(errorMessage(e))}`);
        return 1;
    }
    const { account, character } = login;
    out(
        `Logging in to ${DEV_INSTANCE} as ${character} to read Dev's metadata (nothing is uploaded before you confirm).`,
    );
    const rl = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: false,
    });
    try {
        const { detail, scripts } = await uploadSession({
            login,
            files,
            audit,
            confirm: async (metadata) => {
                out(
                    `These ${files.length} file(s) would be uploaded to ${DEV_INSTANCE} as ${character} and compiled:`,
                );
                const shown = files.map((file, i) => ({
                    script: file.script,
                    dev: metadata[i],
                    warnings: warnings(file, metadata[i], account),
                }));
                let total = 0;
                files.forEach(({ script, text, sha256, path: filePath }, i) => {
                    out(
                        `  ${script}  ${scriptLines(text).length} lines  ${Buffer.byteLength(text)} bytes  sha256 ${sha256.slice(0, 16)}  ${filePath}`,
                    );
                    out(`          Dev: ${scrub(describe(metadata[i]))}`);
                    for (const warning of shown[i].warnings) {
                        total++;
                        out(`          WARNING: ${scrub(warning)}`);
                    }
                });
                out(total ? `WARNINGS: ${total} warning(s).` : "No warnings.");
                const phrase = `upload ${files.length} to dev`;
                const typed = await question(
                    rl,
                    `Type '${phrase}' to upload all of them (anything else uploads nothing): `,
                );
                const confirmed = typed.trim() === phrase;
                audit.record({ event: "preflight", confirmed, scripts: shown });
                if (!confirmed) {
                    err(
                        "REFUSED: confirmation phrase did not match; nothing uploaded.",
                    );
                    return undefined;
                }
                out(`Uploading ${files.length} script(s)...`);
                return metadata.map(expectedFrom);
            },
        });
        if (detail) err(`FAILED: ${scrub(detail)}`);
        out("Summary:");
        for (const { script, outcome, detail } of scripts) {
            out(`  ${script}  ${outcome}  ${scrub(detail)}`);
        }
        out(`Audit log: ${audit.path}`);
        return !detail && scripts.every(({ outcome }) => outcome === "ok")
            ? 0
            : 1;
    } finally {
        rl.close();
        audit.close();
    }
}
