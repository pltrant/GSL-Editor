import * as assert from "assert";
import { promises as fs } from "fs";
import { commands, TextDocument, Uri, window, workspace } from "vscode";
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
                }
            }
        } finally {
            window.showWarningMessage = showWarningMessage;
        }
    });

    test("diff title labels the active local document on the right", async () => {
        const executeCommand = commands.executeCommand;
        const document = await workspace.openTextDocument({
            content: "local unsaved changes",
        });
        let remoteUri: Uri | undefined;
        let diffArguments: unknown[] = [];
        let remoteContent: string | undefined;
        commands.executeCommand = (async (
            command: string,
            remote: Uri,
            local: Uri,
            title: string,
        ) => {
            remoteUri = remote;
            diffArguments = [command, local, title];
            remoteContent = await fs.readFile(remote.fsPath, "utf8");
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
            await assert.rejects(fs.access(remoteUri.fsPath));
        } finally {
            commands.executeCommand = executeCommand;
            window.showErrorMessage = showErrorMessage;
        }
    });
});
