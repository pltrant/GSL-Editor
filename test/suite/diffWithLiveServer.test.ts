import * as assert from "assert";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
    commands,
    Position,
    TextDocument,
    Uri,
    window,
    workspace,
    WorkspaceEdit,
} from "vscode";
import { GameInstance } from "../../gsl/agentToolOrchestrator";
import { runDiffWithLiveServerCommand } from "../../gsl/commands/diffWithLiveServer";

suite("Local file diff labels", () => {
    test("identical and missing scripts identify the selected server and local file", async () => {
        const showWarningMessage = window.showWarningMessage;
        const messages: string[] = [];
        window.showWarningMessage = ((message: string) => {
            messages.push(message);
            return Promise.resolve(undefined);
        }) as typeof window.showWarningMessage;
        try {
            for (const instance of [
                "dev",
                "prime",
                "platinum",
                "shattered",
                "test",
            ] as GameInstance[]) {
                const label =
                    instance.charAt(0).toUpperCase() + instance.slice(1);
                for (const isNewOnRemote of [false, true]) {
                    await runDiffWithLiveServerCommand({
                        script: 29,
                        document: {} as TextDocument,
                        instance,
                        fetchScriptDiff: async () => ({
                            localContent: "same",
                            remoteContent: "same",
                            isNewOnRemote,
                        }),
                    });
                    assert.strictEqual(
                        messages.pop(),
                        isNewOnRemote
                            ? `Script 29: Not found on ${label} server.`
                            : `Script 29: This file matches ${label} server.`,
                    );
                    assert.strictEqual(messages.length, 0);
                }
            }
        } finally {
            window.showWarningMessage = showWarningMessage;
        }
    });

    test("compares the dirty editor buffer and warns without blocking or saving", async () => {
        const executeCommand = commands.executeCommand;
        const tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "gsl-local-diff-"),
        );
        const localFile = path.join(tmpDir, "s29.gsl");
        await fs.writeFile(localFile, "saved contents");
        const document = await workspace.openTextDocument(Uri.file(localFile));
        const edit = new WorkspaceEdit();
        edit.insert(document.uri, new Position(0, 0), "unsaved changes\n");
        assert.ok(await workspace.applyEdit(edit));
        assert.ok(document.isDirty);
        const showWarningMessage = window.showWarningMessage;
        const warnings: unknown[][] = [];
        window.showWarningMessage = ((...args: unknown[]) => {
            warnings.push(args);
            // A notification must not wait for the user to dismiss it.
            return new Promise(() => {});
        }) as typeof window.showWarningMessage;
        let remoteUri: Uri | undefined;
        let diffArguments: unknown[] = [];
        let remoteContent: string | undefined;
        let editorContent: string | undefined;
        commands.executeCommand = (async (
            command: string,
            remote: Uri,
            local: Uri,
            title: string,
        ) => {
            remoteUri = remote;
            diffArguments = [command, local, title];
            remoteContent = await fs.readFile(remote.fsPath, "utf8");
            editorContent = (await workspace.openTextDocument(local)).getText();
            // Exercise cleanup without leaving a temporary diff document open.
            throw new Error("Test diff closed");
        }) as typeof commands.executeCommand;
        const showErrorMessage = window.showErrorMessage;
        window.showErrorMessage = (() =>
            Promise.resolve(undefined)) as typeof window.showErrorMessage;
        try {
            await runDiffWithLiveServerCommand({
                script: 29,
                document,
                instance: "prime",
                fetchScriptDiff: async () => ({
                    localContent: document.getText(),
                    remoteContent: "remote",
                    isNewOnRemote: false,
                }),
            });
            assert.ok(remoteUri);
            assert.deepStrictEqual(diffArguments, [
                "vscode.diff",
                document.uri,
                "s29 (Prime ↔ Local file)",
            ]);
            assert.strictEqual(remoteContent, "remote");
            assert.strictEqual(
                editorContent,
                "unsaved changes\nsaved contents",
            );
            assert.deepStrictEqual(warnings, [
                ["Warning: This file has unsaved changes."],
            ]);
            assert.ok(document.isDirty);
            assert.strictEqual(
                await fs.readFile(localFile, "utf8"),
                "saved contents",
            );
            await assert.rejects(fs.access(remoteUri.fsPath));
        } finally {
            commands.executeCommand = executeCommand;
            window.showErrorMessage = showErrorMessage;
            window.showWarningMessage = showWarningMessage;
            await document.save();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
