import * as vscode from 'vscode';

import { CodeActionProvider, CodeAction, CodeActionKind, Range, TextDocument, WorkspaceEdit } from 'vscode'
import { LINE_TOO_LONG } from './diagnostics';
import { fixLineTooLong } from './util/formattingUtil';

export class GSLCodeActionProvider implements CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: TextDocument, range: Range, context: vscode.CodeActionContext): CodeAction[] {
        // Only trigger for diagnostics with code "line-too-long"
        if (!context.diagnostics.some(diag => String(diag.code) === LINE_TOO_LONG)) {
            return [];
        }
        const line = document.lineAt(range.start.line);
        const fixed = fixLineTooLong(line.text)
        if (line.text === fixed) return [];

        const action = new CodeAction('Wrap to multiple lines', CodeActionKind.QuickFix);
        const edit = new WorkspaceEdit();
        edit.replace(document.uri, line.range, fixed);
        action.edit = edit;
        return [action]
    }
}
