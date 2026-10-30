import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Refuses a path with a symlink in any directory or as the file itself. MCP
 * callers can be sandboxed and the daemon can reach files they can't, so a
 * planted symlink must not redirect the daemon. An agent can't create a
 * root-owned symlink, so those (macOS /tmp, Fedora Atomic /home) are allowed,
 * unless the daemon is itself root or on Windows, which reports every owner
 * as 0 and has no getuid.
 */
export function refuseSymlinksInPath(filePath: string): void {
    const fullPath = path.resolve(filePath);
    const trustRootOwned = (process.getuid?.() ?? 0) !== 0;
    for (
        let current = fullPath;
        current !== path.dirname(current);
        current = path.dirname(current)
    ) {
        const stats = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stats?.isSymbolicLink() && !(trustRootOwned && stats.uid === 0)) {
            throw new Error(
                `${fullPath} has a symlink in its path; use the real path.`,
            );
        }
    }
}

/**
 * Reads a regular file for an MCP tool with `refuseSymlinksInPath`'s guarantee.
 * O_NOFOLLOW and fstat check the opened file itself if the path is swapped
 * after that check, and O_NONBLOCK stops a FIFO hanging the open. Windows lacks
 * both flags (undefined ORs as 0), so the swap stays possible there. Swapping a
 * parent directory stays possible everywhere, but only reaches a regular file
 * with the same name, and callers only use .gsl names.
 *
 * Hard links stay open: gsl_compile_check can read an outside file through one
 * if a sandbox allows the link. An `nlink` check doesn't close this, as a
 * caller linking and unlinking in a loop gets past it.
 *
 * `extraFlags` is ORed into the open flags.
 */
export function readFileNoSymlink(filePath: string, extraFlags = 0): string {
    refuseSymlinksInPath(filePath);
    const fullPath = path.resolve(filePath);
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const fd = fs.openSync(
        fullPath,
        O_RDONLY | O_NOFOLLOW | O_NONBLOCK | extraFlags,
    );
    try {
        if (!fs.fstatSync(fd).isFile()) {
            throw new Error(`${fullPath} is not a regular file.`);
        }
        return fs.readFileSync(fd, "utf8");
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Writes a file for an MCP tool by renaming a new file over it. Nothing is
 * written through an existing file, so neither a hard link nor a symlink swapped
 * in at the file itself after the check can redirect the write. Swapping a
 * parent directory has `readFileNoSymlink`'s limit. A replaced file's mode isn't
 * kept. The temp name is dot-prefixed because a name starting with the script
 * number would match the extension's `S[0-9]{5}.*` language pattern.
 */
export function writeFileNoSymlink(filePath: string, text: string): void {
    refuseSymlinksInPath(filePath);
    const fullPath = path.resolve(filePath);
    const tempPath = path.join(path.dirname(fullPath), `.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx" });
        renameWithRetry(tempPath, fullPath);
    } catch (e) {
        try {
            fs.rmSync(tempPath, { force: true, maxRetries: 5 });
        } catch {
            // The temp is harmless and `e` is the error the caller needs.
        }
        throw e;
    }
}

/**
 * Windows refuses the rename while anything has the target open, often only a
 * scanner for a moment, so it gets about a second. A read-only target fails the
 * same way, so it waits too. There is deliberately no in-place fallback, which
 * would write through a hard link.
 */
function renameWithRetry(from: string, to: string): void {
    for (let attempt = 1; ; attempt++) {
        try {
            return fs.renameSync(from, to);
        } catch (e) {
            const { code } = e as NodeJS.ErrnoException;
            const busy =
                process.platform === "win32" &&
                (code === "EPERM" || code === "EBUSY" || code === "EACCES");
            if (!busy) {
                throw e;
            }
            if (attempt === 20) {
                throw new Error(
                    `${to} could not be replaced (${code}). It is probably read-only or open in another program; make it writable or close it, then try again.`,
                );
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}
