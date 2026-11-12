import * as fs from "fs";
import * as path from "path";

import { window } from "vscode";

type Game = "GemStone" | "DragonRealms";

/**
 * Guesses the game from the remotes of the git repository holding the file,
 * e.g. `GS-Dev-Snapshots` or `DR-Dev-Snapshots`. Only the repository name is
 * read, so that a host or user name can't decide it. Undefined when there is
 * no repository or remote, or when the remotes don't agree.
 */
function repoGame(filePath: string): Game | undefined {
    try {
        let dir = path.dirname(filePath);
        while (!fs.existsSync(path.join(dir, ".git"))) {
            const parent = path.dirname(dir);
            if (parent === dir) return;
            dir = parent;
        }
        let gitDir = path.join(dir, ".git");
        if (fs.statSync(gitDir).isFile()) {
            // A worktree: `.git` names its own directory, whose `commondir`
            // names the one holding the config.
            const pointer = fs.readFileSync(gitDir, "utf8");
            gitDir = path.resolve(dir, pointer.replace(/^gitdir:/, "").trim());
            const commonDir = path.join(gitDir, "commondir");
            if (fs.existsSync(commonDir)) {
                gitDir = path.resolve(
                    gitDir,
                    fs.readFileSync(commonDir, "utf8").trim(),
                );
            }
        }
        const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
        const games = new Set<Game>();
        // The first `url` line after each `[remote "..."]` header
        const remoteUrls =
            /^\s*\[remote [^\]]*\][^[]*?^\s*url\s*=\s*(\S+?)[\\/]*\s*$/gim;
        for (const [, url] of config.matchAll(remoteUrls)) {
            const name = url.split(/[\\/:]/).pop()!;
            if (/(?<![a-z])gs(?![a-z])|gemstone/i.test(name)) {
                games.add("GemStone");
            }
            if (/(?<![a-z])dr(?![a-z])|dragonrealms/i.test(name)) {
                games.add("DragonRealms");
            }
        }
        return games.size === 1 ? [...games][0] : undefined;
    } catch {
        return;
    }
}

/**
 * Asks before uploading a file whose repository looks like the other game's.
 * @returns false if the user declined the upload
 */
export async function confirmUploadGame(
    filePath: string,
    instance: string | undefined,
): Promise<boolean> {
    const target: Game | undefined = instance?.startsWith("DR")
        ? "DragonRealms"
        : instance?.startsWith("GS")
          ? "GemStone"
          : undefined;
    const local = repoGame(filePath);
    if (!local || !target || local === target) return true;
    const choice = await window.showWarningMessage(
        `This file is in a ${local} repository, but you are uploading to ${target} (${instance}).`,
        { modal: true },
        // First, so it is the default button and Enter doesn't upload
        "Don't upload",
        "Upload anyway",
    );
    return choice === "Upload anyway";
}
