import * as vscode from 'vscode';

import { CodeActionProvider, CodeAction, CodeActionKind, Range, TextDocument, WorkspaceEdit } from 'vscode'
import { LINE_TOO_LONG } from './diagnostics';
import { fixLineTooLong, collapseMultiline, isWrappedString } from './util/formattingUtil';

export const ACTION_REDISTRIBUTE_MULTILINE = 'Redistribute Multiline String';
export const ACTION_COLLAPSE_MULTILINE = 'Collapse Multiline String';
export const ACTION_WRAP_TO_MULTIPLE = 'Wrap to Multiple Lines';

export class GSLCodeActionProvider implements CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: TextDocument, range: Range, context: vscode.CodeActionContext): CodeAction[] {
        const actions: CodeAction[] = [];
        const line = document.lineAt(range.start.line);

        // Add Collapse Multiline String action if the line can be collapsed
        if (isWrappedString(line.text)) {
            let startLine = line
            // Seek to start of wrapped string
            while (startLine.range.start.line > 1) {
                const prevLine = document.lineAt(startLine.range.start.line - 1)
                if (!isWrappedString(prevLine.text)) break
                startLine = prevLine
            }
            let endLine = startLine.range.start.line;
            let fullText = startLine.text;

            // Keep reading lines until we find one that doesn't end with \
            while (endLine < document.lineCount - 1) {
                const nextLine = document.lineAt(endLine + 1);
                if (!nextLine.text.trimEnd().endsWith('\\')) {
                    fullText += '\n' + nextLine.text;
                    endLine++;
                    break;
                }
                fullText += '\n' + nextLine.text;
                endLine++;
            }

            // Identify range
            const multiLineRange = new Range(
                startLine.range.start.line,
                0,
                endLine,
                document.lineAt(endLine).text.length
            );

            // Add Redistribute Multiline String
            const redistributed = fixLineTooLong(collapseMultiline(fullText));
            if (redistributed !== fullText) {
                const redistributeEdit = new WorkspaceEdit();
                redistributeEdit.replace(
                    document.uri,
                    multiLineRange,
                    redistributed
                );
                const redistributeAction = new CodeAction(
                    ACTION_REDISTRIBUTE_MULTILINE,
                    CodeActionKind.RefactorInline
                );
                redistributeAction.edit = redistributeEdit;
                actions.push(redistributeAction);
            }

            // Add Collapse Multiline String
            const collapseEdit = new WorkspaceEdit();
            collapseEdit.replace(
                document.uri,
                multiLineRange,
                collapseMultiline(fullText)
            );
            const collapseAction = new CodeAction(
                ACTION_COLLAPSE_MULTILINE,
                CodeActionKind.RefactorInline
            );
            collapseAction.edit = collapseEdit;
            actions.push(collapseAction);
        }

        // Add Wrap action if line is too long
        if (context.diagnostics.some(diag => String(diag.code) === LINE_TOO_LONG)) {
            const fixed = fixLineTooLong(line.text);
            if (line.text !== fixed) {
                const wrapAction = new CodeAction(
                    ACTION_WRAP_TO_MULTIPLE,
                    CodeActionKind.QuickFix
                );
                const wrapEdit = new WorkspaceEdit();
                wrapEdit.replace(document.uri, line.range, fixed);
                wrapAction.edit = wrapEdit;
                actions.push(wrapAction);
            }
        }
        return actions;
    }
}
