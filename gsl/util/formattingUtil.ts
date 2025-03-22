import { MAX_LINE_LENGTH } from "../diagnostics";

export const QUOTE_CONTINUATION = `" +\\\n`

const REGEX = /^(\s*)(msgp|msg\s+NP\d+|msgr|msgrxp|msgrx2|set.*?to)\s*\(?"(.*)"\s*(!.*)?/i;

/**
 * Decompose input across multiple lines, respecting MAX_LINE_LENGTH.
 */
export const fixLineTooLong = (input: string): string => {
    if (input.length <= MAX_LINE_LENGTH) return input;

    // Supported commands: msg, msgp, msg NP0/NP1/NP5, msgrxp, set T0 to, etc.
    const match = input.match(REGEX);
    if (!match) return input;

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

    return result;
}

const ensureParantheses = (text: string): string => {
    const match = text.match(REGEX);
    if (!match) return text;
    const [_, indentation, command, content] = match;
    return `${indentation}${command} ("${content}")`;
}

const nextWrap = (result: string, bufferIn: string): [string, string] => {
    if (bufferIn.length <= MAX_LINE_LENGTH) {
        // Remaining text fits in one line. Append it and return empty buffer.
        return [result + bufferIn, ''];
    }
    const maxLength = MAX_LINE_LENGTH - 3 // Leave 3 for quote continuation
    // Find the last space before max length
    let cutIndex = -1
    let inSpaceSequence = false
    for (let i = 0; i < bufferIn.length; i++) {
        if (i >= maxLength) break
        if (bufferIn[i] === " " && !inSpaceSequence) {
            cutIndex = i
        }
        inSpaceSequence = Boolean(bufferIn[i] === " ")
    }
    if (cutIndex === -1) {
        // If no space found, force cut at max possible length
        cutIndex = maxLength
    }

    // Split the buffer
    const currentLine = bufferIn.substring(0, cutIndex);
    const remainingBuffer = bufferIn.substring(cutIndex);

    // Add line continuation marker if there's more text
    const suffix = remainingBuffer ? QUOTE_CONTINUATION : '';

    return [result + currentLine + suffix, remainingBuffer];
};