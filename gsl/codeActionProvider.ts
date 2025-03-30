import * as vscode from 'vscode'

import { CodeActionProvider, CodeAction, CodeActionKind, Range, TextDocument, TextLine, WorkspaceEdit } from 'vscode'
import { LINE_TOO_LONG, MAX_LINE_LENGTH } from './diagnostics'
import { fixLineTooLong, collapseMultiline, isWrappedString, getMessageCommand, MessageCommand } from './util/formattingUtil'

export const COMBINE_MULTIPLE_MESSAGES = 'Combine Messages'
export const ACTION_REDISTRIBUTE_MULTILINE = 'Redistribute Multiline String'
export const ACTION_COLLAPSE_MULTILINE = 'Collapse Multiline String'
export const ACTION_WRAP_TO_MULTIPLE = 'Wrap to Multiple Lines'
export const ACTION_ALIGN_COMMENTS = 'Align Comments'

export class GSLCodeActionProvider implements CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ]

    provideCodeActions(
        document: TextDocument,
        range: Range,
        context: vscode.CodeActionContext
    ): CodeAction[] {
        const actions: CodeAction[] = []
        const line = document.lineAt(range.start.line)

        // Add Align Comments action if multiple comments exist and can be aligned
        const alignCommentsAction = getAlignCommentsAction(document, range)
        if (alignCommentsAction) {
            actions.push(alignCommentsAction)
        }

        // Add Combine Multiple Messages action if multiple messages exist in sequence
        const combineMessagesAction = getCombineMessagesAction(document, line)
        if (combineMessagesAction) {
            actions.push(combineMessagesAction)
        }

        // Add Collapse Multiline String action if the line can be collapsed
        if (isWrappedString(line.text)) {
            let startLine = line
            // Seek to start of wrapped string
            while (startLine.range.start.line > 1) {
                const prevLine = document.lineAt(startLine.range.start.line - 1)
                if (!isWrappedString(prevLine.text)) break
                startLine = prevLine
            }
            let endLine = startLine.range.start.line
            let fullText = startLine.text

            // Keep reading lines until we find one that doesn't end with \
            while (endLine < document.lineCount - 1) {
                const nextLine = document.lineAt(endLine + 1)
                if (!nextLine.text.trimEnd().endsWith('\\')) {
                    fullText += '\n' + nextLine.text
                    endLine++
                    break
                }
                fullText += '\n' + nextLine.text
                endLine++
            }

            // Identify range
            const multiLineRange = new Range(
                startLine.range.start.line,
                0,
                endLine,
                document.lineAt(endLine).text.length
            )

            // Add Redistribute Multiline String
            const redistributed = fixLineTooLong(collapseMultiline(fullText))
            if (redistributed !== fullText) {
                const redistributeEdit = new WorkspaceEdit()
                redistributeEdit.replace(
                    document.uri,
                    multiLineRange,
                    redistributed
                )
                const redistributeAction = new CodeAction(
                    ACTION_REDISTRIBUTE_MULTILINE,
                    CodeActionKind.RefactorInline
                )
                redistributeAction.edit = redistributeEdit
                actions.push(redistributeAction)
            }

            // Add Collapse Multiline String
            const collapseEdit = new WorkspaceEdit()
            collapseEdit.replace(
                document.uri,
                multiLineRange,
                collapseMultiline(fullText)
            )
            const collapseAction = new CodeAction(
                ACTION_COLLAPSE_MULTILINE,
                CodeActionKind.RefactorInline
            )
            collapseAction.edit = collapseEdit
            actions.push(collapseAction)
        }

        // Add Wrap action if line is too long
        if (context.diagnostics.some(diag => String(diag.code) === LINE_TOO_LONG)) {
            const fixed = fixLineTooLong(line.text)
            if (line.text !== fixed) {
                const wrapAction = new CodeAction(
                    ACTION_WRAP_TO_MULTIPLE,
                    CodeActionKind.QuickFix
                )
                const wrapEdit = new WorkspaceEdit()
                wrapEdit.replace(document.uri, line.range, fixed)
                wrapAction.edit = wrapEdit
                actions.push(wrapAction)
            }
        }
        return actions
    }
}

const getNextLine = (document: TextDocument, line: TextLine): TextLine | null => {
    return line.range.end.line === document.lineCount
        ? null
        : document.lineAt(line.range.start.line + 1)
}

const isSequenceOfMessageCmd = (
    document: TextDocument,
    line: TextLine,
    lineCmd: MessageCommand
): boolean => {
    if (!lineCmd.skipNewline) return false
    const nextLine = getNextLine(document, line)
    if (!nextLine) return false
    const nextLineCmd = getMessageCommand(nextLine.text)
    if (!nextLineCmd) return false
    return lineCmd.command.toLowerCase() === nextLineCmd.command.toLowerCase()
}

const getCombineMessagesAction = (
    document: TextDocument,
    line: TextLine
): CodeAction | undefined => {
    const messageCmd = getMessageCommand(line.text)
    if (!messageCmd || !isSequenceOfMessageCmd(document, line, messageCmd)) {
        return
    }
    let content = messageCmd.content
    let comments = [messageCmd.comment].filter(Boolean)
    let endLine = line.range.start.line

    // Keep reading lines until we find one that isn't in the sequence
    while (endLine < document.lineCount - 1) {
        const nextCmd = getMessageCommand(document.lineAt(endLine + 1).text)
        if (
            !nextCmd
            || messageCmd.command.toLowerCase() !== nextCmd.command.toLowerCase()
        ) {
            break
        }
        content += nextCmd.content
        if (nextCmd.comment) comments.push(nextCmd.comment)
        endLine++
    }

    // Determine whether the whole sequence ends in a newline
    if (getMessageCommand(document.lineAt(endLine).text)?.skipNewline) {
        content += '$\\'
    }

    // Identify range
    const multiLineRange = new Range(
        line.range.start.line,
        0,
        endLine,
        document.lineAt(endLine).text.length
    )

    // Create result text
    let result = fixLineTooLong(
        collapseMultiline(
            `${messageCmd.indentation}${messageCmd.command} "${content}"`
        )
    )
    comments.forEach(comment => {
        result += `\n${messageCmd.indentation}! ${comment}`
    })

    // Create action
    const combineEdit = new WorkspaceEdit();
    combineEdit.replace(
        document.uri,
        multiLineRange,
        result
    );
    const combineAction = new CodeAction(
        COMBINE_MULTIPLE_MESSAGES,
        CodeActionKind.RefactorInline
    )
    combineAction.edit = combineEdit
    return combineAction
}      

const getAlignCommentsAction = (
    document: TextDocument,
    range: Range
): CodeAction | null => {
    if (range.isSingleLine) return null

    // Check if there are comments to align
    let hasComments = false
    for (let i = range.start.line; i <= range.end.line; i++) {
        const line = document.lineAt(i)
        if (line.text.includes('!') && !line.text.trimStart().startsWith('!')) {
            hasComments = true
            break
        }
    }
    
    if (!hasComments) return null

    // Align comments
    const TARGET_POSITION = 60
    const alignEdit = new WorkspaceEdit()

    for (let i = range.start.line; i <= range.end.line; i++) {
        const line = document.lineAt(i)
        const commentInfo = getLineCommentInfo(line.text)
        if (!commentInfo || commentInfo.isWholeLineComment) continue

        const { commentIndex } = commentInfo
        const code = line.text.substring(0, commentIndex).trimEnd()
        const comment = line.text.substring(commentIndex)
        
        // Calculate maximum possible padding without exceeding MAX_LINE_LENGTH
        const maxPadding = Math.max(0, MAX_LINE_LENGTH - code.length - comment.length - 2);
        const targetPadding = TARGET_POSITION - code.length;
        
        // Use target position if possible, otherwise use maximum allowed padding
        const padding = ' '.repeat(Math.min(maxPadding, targetPadding));
        
        alignEdit.replace(
            document.uri,
            line.range,
            code + padding + comment
        )
    }

    // Create action
    const alignAction = new CodeAction(
        ACTION_ALIGN_COMMENTS,
        CodeActionKind.RefactorInline
    )
    alignAction.edit = alignEdit
    return alignAction
}

const getLineCommentInfo = (text: string): {
    isWholeLineComment: boolean;
    commentIndex: number;
} | undefined => {
    if (text.trimStart().startsWith('!')) {
        return {
            isWholeLineComment: true,
            commentIndex: text.indexOf('!')
        }
    }
    let inString = false
    let inParans = false
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (inString) {
            if (char === '"') inString = false
            continue
        }
        if (inParans) {
            if (char === ')') inParans = false
            continue
        }
        if (char === '!') {
            return {
                isWholeLineComment: false,
                commentIndex: i
            }
        }
        if (char === '"') {
            inString = true
        }
        else if (char === '(') {
            inParans = true
        }
    }
}