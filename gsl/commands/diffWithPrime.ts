import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { commands, TextDocument, Uri, window, workspace } from "vscode";

export async function runDiffWithPrimeCommand({
    script,
    document,
    fetchPrimeScriptDiff,
}: {
    script: number;
    document: TextDocument;
    fetchPrimeScriptDiff: (
        script: number,
        document: TextDocument,
    ) => Promise<{
        localContent: string;
        primeContent: string;
        isNewOnPrime: boolean;
    }>;
}): Promise<void> {
    try {
        const { localContent, primeContent, isNewOnPrime } =
            await fetchPrimeScriptDiff(script, document);

        if (isNewOnPrime) {
            window.showWarningMessage(
                `Script ${script}: Not found on Prime server (appears to be new in Dev).`,
                { modal: true },
            );
            return;
        }

        if (primeContent === localContent) {
            window.showWarningMessage(
                `Script ${script}: No differences found between Prime and Dev.`,
                { modal: true },
            );
            return;
        }

        const tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "gsl-prime-diff-"),
        );
        const tmpFile = path.join(tmpDir, path.basename(document.fileName));
        await fs.writeFile(tmpFile, primeContent);

        const primeUri = Uri.file(tmpFile);
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
                if (closedDoc.uri.fsPath === primeUri.fsPath) {
                    void cleanup();
                }
            },
        );

        let diffOpened = false;
        try {
            await commands.executeCommand(
                "vscode.diff",
                primeUri,
                localUri,
                `s${script} (Prime \u2194 Dev)`,
            );
            diffOpened = true;
        } finally {
            if (!diffOpened) {
                await cleanup();
            }
        }
    } catch (e) {
        console.error(e);
        const error = `Failed to diff script ${script} with prime`;
        window.showErrorMessage(
            e instanceof Error ? `${error} (${e.message})` : error,
        );
    }
}
