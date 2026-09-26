import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { commands, TextDocument, Uri, window, workspace } from "vscode";

import { GameInstance } from "../agentToolOrchestrator";

export async function runDiffWithLiveServerCommand({
    script,
    document,
    instance,
    fetchScriptDiff,
}: {
    script: number;
    document: TextDocument;
    instance: GameInstance;
    fetchScriptDiff: (
        script: number,
        document: TextDocument,
    ) => Promise<{
        localContent: string;
        remoteContent: string;
        isNewOnRemote: boolean;
    }>;
}): Promise<void> {
    const label = instance.charAt(0).toUpperCase() + instance.slice(1);

    try {
        const { localContent, remoteContent, isNewOnRemote } =
            await fetchScriptDiff(script, document);

        if (isNewOnRemote) {
            window.showWarningMessage(
                `Script ${script}: Not found on ${label} server (appears to be new in Dev).`,
                { modal: true },
            );
            return;
        }

        if (remoteContent === localContent) {
            window.showWarningMessage(
                `Script ${script}: No differences found between ${label} and Dev.`,
                { modal: true },
            );
            return;
        }

        const tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), `gsl-${instance}-diff-`),
        );
        const tmpFile = path.join(tmpDir, path.basename(document.fileName));
        await fs.writeFile(tmpFile, remoteContent);

        const remoteUri = Uri.file(tmpFile);
        const localUri = document.uri;
        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            closeSubscription.dispose();
            await fs.rm(tmpDir, { recursive: true, force: true });
        };
        const closeSubscription = workspace.onDidCloseTextDocument(
            (closedDoc) => {
                if (closedDoc.uri.fsPath === remoteUri.fsPath) {
                    void cleanup();
                }
            },
        );

        let diffOpened = false;
        try {
            await commands.executeCommand(
                "vscode.diff",
                remoteUri,
                localUri,
                `s${script} (${label} \u2194 Dev)`,
            );
            diffOpened = true;
        } finally {
            if (!diffOpened) {
                await cleanup();
            }
        }
    } catch (e) {
        console.error(e);
        const error = `Failed to diff script ${script} with ${label}`;
        window.showErrorMessage(
            e instanceof Error ? `${error} (${e.message})` : error,
        );
    }
}
