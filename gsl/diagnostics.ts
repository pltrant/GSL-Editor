import * as vscode from "vscode";
import { GSL_LANGUAGE_ID } from "./const";

export const LINE_TOO_LONG = "line-too-long";
export const MAX_LINE_LENGTH = 118;

export function subscribeToDocumentChanges(
    context: vscode.ExtensionContext,
    lineLengthDiagnostics: vscode.DiagnosticCollection,
): void {
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) =>
            refreshDiagnostics(e.document, lineLengthDiagnostics),
        ),
        vscode.workspace.onDidOpenTextDocument((doc) =>
            refreshDiagnostics(doc, lineLengthDiagnostics),
        ),
    );
    // Refresh diagnostics for already open documents
    vscode.workspace.textDocuments.forEach((doc) =>
        refreshDiagnostics(doc, lineLengthDiagnostics),
    );
}

function refreshDiagnostics(
    document: vscode.TextDocument,
    lineLengthDiagnostics: vscode.DiagnosticCollection,
): void {
    // Only run diagnostics for GSL language documents
    if (document.languageId !== GSL_LANGUAGE_ID) {
        return;
    }

    const diagnostics: vscode.Diagnostic[] = [];

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const lineOfText = document.lineAt(lineIndex);
        if (lineOfText.text.length > MAX_LINE_LENGTH) {
            const diagnostic = createLineLengthDiagnostic(
                lineOfText,
                MAX_LINE_LENGTH,
            );
            diagnostics.push(diagnostic);
        }
    }

    lineLengthDiagnostics.set(document.uri, diagnostics);
}

function createLineLengthDiagnostic(
    lineOfText: vscode.TextLine,
    maxLineLength: number,
): vscode.Diagnostic {
    const message = `Line is too long (${lineOfText.text.length} > ${maxLineLength} characters)`;
    const range = lineOfText.range; // highlight the entire line
    const diagnostic = new vscode.Diagnostic(
        range,
        message,
        vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.code = LINE_TOO_LONG;
    return diagnostic;
}
