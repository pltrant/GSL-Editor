import { TextDocument } from "vscode"
import { MAX_LINE_LENGTH } from "../diagnostics"

export const QUOTE_CONTINUATION = `" +\\\n`
export const WRAPPED_TEXT_LINE_REGEX = /"\s*\+\s*\\$/
export const MESSAGE_LINE_REGEX = /^(\s*)(msgp|msg\s+NP\d|msgr|msgrxp|msgrx2)\s+"(.*?)(\$\\)?"\s*(!\s*.*)?/i
const WRAPPABLE_LINE_REGEX = /^(\s*)(msgp|msg\s+NP\d|msgr|msgrxp|msgrx2|set.*?to)\s*\(?"(.*)"\s*(!.*)?/i

export interface MessageCommand {
    /** A series of space characters. */
    indentation: string
    /** @example 'msgp' | 'msg NP0' | 'msgr' */
    command: string
    /** @example 'Hello World' */
    content: string
    /** True if the line ended with a $\ symbol. */
    skipNewline: boolean
    /** Contains the trailing comment, if one exists. */
    comment: string | null
}

/**
 * Collapse multiline string to a single line.
*/
export const collapseMultiline = (input: string): string => {
	// Regex removes " +\n" (with optional surrounding whitespace) between adjacent string literals.
	return stripUnnecessaryParans(
        input.replace(/"\s*\+\s*\\\s*\r?\n\s*"/g, "")
    )
}

export const isWrappedString = (text: string): boolean => Boolean(
    text.trimStart()[0] !== '!'
    && text.trimEnd().endsWith('\\')
    && text.match(WRAPPED_TEXT_LINE_REGEX)
)

export const getMessageCommand = (text: string): MessageCommand | null => {
    const match = text.match(MESSAGE_LINE_REGEX)
    if (match) {
        const [_, indentation, command, content, skipNewlineSymbol, comment] = match
        return {
            indentation,
            command,
            content,
            skipNewline: Boolean(skipNewlineSymbol),
            comment: comment ? comment.slice(1).trimStart() : null
        }
    }
    return null
}

const stripUnnecessaryParans = (text: string): string => {
    if (text.indexOf("\n") !== -1) {
        return text; // Multiline. Parans is necessary.
    }
    const match = text.match(WRAPPABLE_LINE_REGEX)
    if (!match) return text
    const [_, indentation, command, content, comment] = match
    const withoutParans = `${indentation}${command} "${content}"${comment || ''}`
    return (withoutParans.length <= MAX_LINE_LENGTH) ? withoutParans : text
}

/**
 * Decompose input across multiple lines, respecting MAX_LINE_LENGTH.
 */
export const fixLineTooLong = (input: string): string => {
    // Return single line if possible
    const withoutParans = stripUnnecessaryParans(input)
    if (withoutParans.length <= MAX_LINE_LENGTH) return withoutParans

    // Supported commands: msg, msgp, msg NP0/NP1/NP5, msgrxp, set T0 to, etc.
    const match = input.match(WRAPPABLE_LINE_REGEX)
    if (!match) return input

    // Consume buffer
    const [_, indentation, __, ___, comment] = match
    let result = ""
    let bufferIn = ensureParantheses(input.trimEnd())

    while (bufferIn.length) {
        if (result) {
            // Indent line if it isn't the first
            bufferIn = indentation + '"' + bufferIn
        }
        [result, bufferIn] = nextWrap(result, bufferIn)
    }

    if (comment?.trim()) {
        // Move comment to next line and let user handle it
        result += `\n${indentation}${comment.trim()}`
    }

    const resultWithoutParans = stripUnnecessaryParans(input)
    return (resultWithoutParans.length <= MAX_LINE_LENGTH)
        ? resultWithoutParans
        : result
}

const ensureParantheses = (text: string): string => {
    const match = text.match(WRAPPABLE_LINE_REGEX)
    if (!match) return text
    const [_, indentation, command, content] = match
    return `${indentation}${command} ("${content}")`
}

const nextWrap = (result: string, bufferIn: string): [string, string] => {
    if (bufferIn.length <= MAX_LINE_LENGTH) {
        // Remaining text fits in one line. Append it and return empty buffer.
        return [result + bufferIn, '']
    }
    const maxLength = MAX_LINE_LENGTH - 3 // Leave 3 for quote continuation
    // Find the last space before max length
    let cutIndex = -1
    let inSpaceSequence = false
    for (let i = bufferIn.indexOf('"'); i < bufferIn.length; i++) {
        if (i >= maxLength) break
        if (bufferIn[i] === " " && !inSpaceSequence) {
            cutIndex = i
        }
        inSpaceSequence = Boolean(bufferIn[i] === " ")
    }
    if (cutIndex === -1) {
        // If no space found, force cut at max possible length
        cutIndex = maxLength - 1
    }

    // Split the buffer
    const currentLine = bufferIn.substring(0, cutIndex)
    const remainingBuffer = bufferIn.substring(cutIndex)

    // Add line continuation marker if there's more text
    const suffix = remainingBuffer ? QUOTE_CONTINUATION : ''

    return [result + currentLine + suffix, remainingBuffer]
}

// String constants for block types
const PUSH = 'push'
const FASTPUSH = 'fastpush'
const BLOCK = 'block'

// Core regex patterns for indentation processing
const BLOCK_START_REGEX = /^(if|ifnot|else_if|else_ifnot|else|loop|when|push|fastpush|push|is|default|:)/i
const BLOCK_END_REGEX = /^(\.|else_if|else_ifnot|else|fastpop|pop)/i
const PUSH_REGEX = /^push/i
const FASTPUSH_REGEX = /^fastpush/i
const POP_REGEX = /^pop/i
const FASTPOP_REGEX = /^fastpop/i
const INDENT_SIZE = 2 // Spaces per indentation level

const indentText = (text: string, indentationCount: number): string =>
    ' '.repeat(Math.max(0, indentationCount) * INDENT_SIZE) + text

/**
 * Formats document indentation based on GSL language structure rules.
 * Handles blocks, control statements, and special push/pop operations.
 */
export const formatIndentation = (document: TextDocument): string => {
    const formattedLines = new Array<string>()
    const blockStack = new Array<string>()

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i)
        const text = line.text.trim()
        const currentBlock = blockStack.length > 0 ? blockStack[blockStack.length - 1] : null

        // Preserve empty lines
        if (text === '') {
            formattedLines.push('')
            continue
        }

        // Process unindent
        if (BLOCK_END_REGEX.test(text) && blockStack.length > 0) {
            if (POP_REGEX.test(text)) {
                if (currentBlock === PUSH) {
                    blockStack.pop()
                }
            } else if (FASTPOP_REGEX.test(text)) {
                if (currentBlock === FASTPUSH) {
                    blockStack.pop()
                }
            } else {
                blockStack.pop()
            }
        }

        // Format line (unless it's a whole-line comment at column 0)
        if (line.text.startsWith('!')) {
            formattedLines.push(line.text.trimEnd())
        } else {
            formattedLines.push(indentText(text, blockStack.length))
        }

        // Process indentation increases
        if (BLOCK_START_REGEX.test(text)) {
            if (PUSH_REGEX.test(text)) {
                blockStack.push(PUSH)
            } else if (FASTPUSH_REGEX.test(text)) {
                blockStack.push(FASTPUSH)
            } else {
                blockStack.push(BLOCK)
            }
        }
    }

    return formattedLines.join('\n')
}