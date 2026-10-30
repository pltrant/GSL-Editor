import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileNoSymlink, writeFileNoSymlink } from "./noSymlinkFile";

export type LineEnding = "\n" | "\r\n";

interface ScriptFileWrite {
    filePath: string;
    content: string;
    fallbackEol: LineEnding;
}

/**
 * Determines the line ending a script written to `filePath` should use:
 * the existing file's line endings, then the git eol settings of the
 * repository containing the file, then `fallback`.
 */
export function detectLineEnding({
    filePath,
    fallback,
}: {
    filePath: string;
    fallback: LineEnding;
}): LineEnding {
    return (
        existingFileLineEnding(filePath) ?? gitLineEnding(filePath) ?? fallback
    );
}

/**
 * Resolves VS Code's `files.eol` setting value, treating "auto" (or no
 * setting) as the OS default.
 */
export function resolveDefaultLineEnding(
    filesEol: string | undefined,
): LineEnding {
    if (filesEol === "\n" || filesEol === "\r\n") return filesEol;
    return os.EOL === "\r\n" ? "\r\n" : "\n";
}

export function convertLineEndings(text: string, eol: LineEnding): string {
    return text.replace(/\r?\n/g, eol);
}

/**
 * Writes downloaded script content, converting it to the local line ending
 * format (see `detectLineEnding`) so re-downloads don't produce
 * line-ending-only changes.
 */
export function writeScriptFile({
    filePath,
    content,
    fallbackEol,
}: ScriptFileWrite): void {
    const eol = detectLineEnding({ filePath, fallback: fallbackEol });
    fs.writeFileSync(filePath, convertLineEndings(content, eol), "utf8");
}

/**
 * `writeScriptFile` for MCP tools: refuses symlinks (see noSymlinkFile) and
 * skips git, because an agent can plant a .git in the download directory whose
 * config runs a program (core.fsmonitor) as the daemon.
 */
export function writeScriptFileNoSymlink({
    filePath,
    content,
    fallbackEol,
}: ScriptFileWrite): void {
    let existingText = "";
    try {
        existingText = readFileNoSymlink(filePath);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const eol = textLineEnding(existingText) ?? fallbackEol;
    writeFileNoSymlink(filePath, convertLineEndings(content, eol));
}

function existingFileLineEnding(filePath: string): LineEnding | undefined {
    let text: string;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch {
        return undefined;
    }
    return textLineEnding(text);
}

function textLineEnding(text: string): LineEnding | undefined {
    const crlfCount = text.match(/\r\n/g)?.length ?? 0;
    const lfCount = (text.match(/\n/g)?.length ?? 0) - crlfCount;
    if (crlfCount === 0 && lfCount === 0) return undefined;
    return crlfCount > lfCount ? "\r\n" : "\n";
}

function gitLineEnding(filePath: string): LineEnding | undefined {
    const cwd = path.dirname(filePath);
    const git = (args: string[]): string | undefined => {
        try {
            return execFileSync("git", args, {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 5000,
                windowsHide: true,
            });
        } catch {
            return undefined;
        }
    };
    const attrs = git([
        "check-attr",
        "eol",
        "text",
        "--",
        path.basename(filePath),
    ]);
    if (attrs === undefined) return undefined; // Not in a git repository
    const attr = (name: string) =>
        attrs.match(new RegExp(`: ${name}: (\\S+)`))?.[1];
    const eolAttr = attr("eol");
    if (eolAttr === "lf") return "\n";
    if (eolAttr === "crlf") return "\r\n";
    // Git doesn't treat the file as text, so it has no eol opinion
    if (attr("text") === "unset") return undefined;
    const autocrlf = git(["config", "--get", "core.autocrlf"])?.trim();
    if (autocrlf === "true") return "\r\n";
    if (autocrlf === "input") return "\n";
    const coreEol = git(["config", "--get", "core.eol"])?.trim();
    if (coreEol === "lf") return "\n";
    if (coreEol === "crlf") return "\r\n";
    return undefined;
}
