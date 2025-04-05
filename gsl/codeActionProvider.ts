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
    const combineEdit = new WorkspaceEdit()
    combineEdit.replace(
        document.uri,
        multiLineRange,
        result
    )
    const combineAction = new CodeAction(
        COMBINE_MULTIPLE_MESSAGES,
        CodeActionKind.RefactorInline
    )
    combineAction.edit = combineEdit
    return combineAction
}

export const getAlignCommentsAction = (
    document: TextDocument,
    range: Range
): CodeAction | null => {
    const alignEdit = new WorkspaceEdit()

    // Loop through lines in range
    for (let i = range.start.line; i <= range.end.line; i++) {
        const line = document.lineAt(i)
        const commentInfo = getLineCommentInfo(line.text)
        if (
            !commentInfo
            || commentInfo.isWholeLineComment
            || commentInfo.isMultiLineSegment
        ) {
            continue
        }

        // Attempt column alignment at 64 (the auchand standard) and 90 (some number I just made up)
        const preferredIndexes = [64, 90]
        const { code, comment } = commentInfo
        let result = line.text

        for (let j = 0; j < preferredIndexes.length; j++) {
            const colIndex = preferredIndexes[j] - 2
            const padding = colIndex - code.length
            if (padding <= 0) continue
            const contentLength = code.length + padding + comment.length
            if (contentLength + 3 <= MAX_LINE_LENGTH) {
                result = `${code}${' '.repeat(padding)} ! ${comment}` // Ideal
                break
            }
            else if (contentLength + 2 <= MAX_LINE_LENGTH) {
                result = `${code}${' '.repeat(padding)} !${comment}` // Close to ideal
                break
            }
            else if (contentLength + 1 <= MAX_LINE_LENGTH) {
                result = `${code}${' '.repeat(padding)}!${comment}` // Close enough
                break
            }
            else if (j === preferredIndexes.length - 1) {
                result = `${code} ! ${comment}` // At least space it out pretty
            }
        }
        if (line.text !== result && result.length <= MAX_LINE_LENGTH) {
            alignEdit.replace(document.uri, line.range, result)
        }
    }
    if (alignEdit.entries().length === 0) return null

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
    isMultiLineSegment: boolean;
    code: string;
    comment: string;
} | undefined => {
    // Handle whole line comments
    if (text.trimStart().startsWith('!')) {
        const match = text.match(/!\s*(.*)/)
        return {
            isWholeLineComment: true,
            isMultiLineSegment: false,
            code: text.substring(0, text.indexOf('!')).trimEnd(),
            comment: match ? match[1].trim() : ''
        }
    }
    // Handle multiline case
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        // Process string state
        if (inString) {
            // Continue until end of string
            if (char === '"') inString = false
            continue
        }
        if (char === '"') {
            // Begin string state
            inString = true
            continue
        }
        if (char === '\\') {
            // Return comment info with multiline segment as true
            const match = text.substring(i + 1).match(/!\s*(.*)/)
            return {
                isWholeLineComment: false,
                isMultiLineSegment: true,
                code: text.substring(0, i + 1).trimEnd(),
                comment: match ? match[1].trim() : ''
            }
        }
    }

    // Handle all other cases
    inString = false
    let paransCount = 0
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        // Process string state
        if (inString) {
            // Continue until end of string
            if (char === '"') inString = false
            continue
        }
        if (char === '"') {
            // Begin string state
            inString = true
            continue
        }
        if (char === '(') {
            // Track parans count
            paransCount++
            continue
        }
        if (char === '\\') {
            // Return comment info with multiline segment as true
            const match = text.substring(i + 1).match(/!\s*(.*)/)
            return {
                isWholeLineComment: false,
                isMultiLineSegment: true,
                code: text.substring(0, i + 1).trimEnd(),
                comment: match ? match[1].trim() : ''
            }
        }
        if (paransCount) {
            // Update parans count and continue
            if (char === ')') paransCount--
            continue
        }
        if (char === '!') {
            // Return comment info
            const match = text.substring(i).match(/!\s*(.*)/)
            return {
                isWholeLineComment: false,
                isMultiLineSegment: false,
                code: text.substring(0, i).trimEnd(),
                comment: match ? match[1].trim() : ''
            }
        }
    }
}