import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { window } from "vscode";
import { confirmUploadGame } from "../../gsl/commands/gameMismatch";

suite("Upload game mismatch", () => {
    const showWarningMessage = window.showWarningMessage;
    let root: string;
    let prompts: string[];
    let buttons: string[];
    let answer: string | undefined;

    /** Makes a repository with the given remotes, returning a script in it */
    const repoWith = (...remoteUrls: string[]) => {
        const repo = fs.mkdtempSync(path.join(root, "repo-"));
        fs.mkdirSync(path.join(repo, ".git"));
        fs.writeFileSync(
            path.join(repo, ".git", "config"),
            remoteUrls
                .map((url, i) => `[remote "remote${i}"]\n\turl = ${url}\n`)
                .join(""),
        );
        fs.mkdirSync(path.join(repo, "scripts"));
        return path.join(repo, "scripts", "S00029.gsl");
    };

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-game-"));
        prompts = [];
        buttons = [];
        answer = undefined;
        window.showWarningMessage = ((
            message: string,
            _options: unknown,
            ...items: string[]
        ) => {
            prompts.push(message);
            buttons = items;
            return Promise.resolve(answer);
        }) as typeof window.showWarningMessage;
    });

    teardown(() => {
        window.showWarningMessage = showWarningMessage;
        fs.rmSync(root, { recursive: true, force: true });
    });

    test("a GS repository uploading to DR warns, naming both games", async () => {
        answer = "Upload anyway";
        const file = repoWith("git@github.com:someone/GS-Dev-Snapshots.git");
        assert.strictEqual(await confirmUploadGame(file, "DRD"), true);
        assert.deepStrictEqual(prompts, [
            "This file is in a GemStone repository, but you are uploading to DragonRealms (DRD).",
        ]);
        // VS Code makes the first button the default
        assert.deepStrictEqual(buttons, ["Don't upload", "Upload anyway"]);
    });

    test("Cancel aborts the upload, from a worktree too", async () => {
        const main = path.dirname(
            path.dirname(
                repoWith("https://github.com/someone/DR-Dev-Snapshots"),
            ),
        );
        const gitDir = path.join(main, ".git", "worktrees", "wt");
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
        const worktree = fs.mkdtempSync(path.join(root, "wt-"));
        fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
        const file = path.join(worktree, "S00029.gsl");
        assert.strictEqual(await confirmUploadGame(file, "GS4D"), false);
        assert.strictEqual(prompts.length, 1);
    });

    test("a matching game does not warn", async () => {
        const gs = repoWith("https://github.com/someone/GS-Dev-Snapshots.git");
        const dr = repoWith("https://github.com/someone/DR-Dev-Snapshots.git");
        assert.strictEqual(await confirmUploadGame(gs, "GS4D"), true);
        assert.strictEqual(await confirmUploadGame(dr, "DRD"), true);
        assert.deepStrictEqual(prompts, []);
    });

    test("no repository, no remote or an unclear one does not warn", async () => {
        const loose = path.join(root, "S00029.gsl");
        assert.strictEqual(await confirmUploadGame(loose, "DRD"), true);
        assert.strictEqual(await confirmUploadGame(repoWith(), "DRD"), true);
        const unclear = repoWith("https://github.com/gs-dev/GSL-Editor.git");
        assert.strictEqual(await confirmUploadGame(unclear, "DRD"), true);
        assert.deepStrictEqual(prompts, []);
    });

    test("remotes for both games do not warn", async () => {
        const file = repoWith(
            "https://github.com/someone/GS-Dev-Snapshots.git",
            "https://github.com/someone/DR-Dev-Snapshots.git",
        );
        assert.strictEqual(await confirmUploadGame(file, "DRD"), true);
        assert.strictEqual(await confirmUploadGame(file, "GS4D"), true);
        assert.deepStrictEqual(prompts, []);
    });
});
