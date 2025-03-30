import {
    DocumentHighlightProvider,
    DocumentHighlight,
    DocumentHighlightKind,
    Range,
    TextDocument,
    Position,
    TextLine
} from "vscode"
import { isNonVoid } from "./util/typeUtil"

const MAX_SCAN_ITERATIONS = 10000; // Prevent excessive scanning

// Token regexes. First capture group must capture the appropriate token. See `readToken`.
const MM_START = /^\s*(:\s*".*?")/i
const BLOCK_START = /^\s*(ifnot|if|loop|when|is|default|:\s*".*?")/i
const DOT = /^\s*(\.)/i
const PUSH = /^\s*(fastpush|push)/i
const POP = /^\s*(fastpop|pop)/i
const IF = /^\s*(ifnot|if)/i
const ELSE = /^\s*(else_ifnot|else_if|else)/i
const CASE_STATEMENT = /^\s*(is|default)/i
const STOP = /^\s*(stop)/i

/** Given a line, return the matched token type, or undefined if not found. */
const readToken = <T extends string>(
    lineText: string,
    regex: RegExp,
): T | undefined => {
    const match = lineText.match(regex)
    return match ? match[1]?.toLowerCase() as T : undefined
}

const isFirstSymbolOnLine = (line: TextLine, position: Position, wordRange?: Range): boolean => {
    // Handle dot case
    if (
        readToken(line.text, DOT) && (
            line.text.indexOf('.') === position.character
            || line.text.indexOf('.') === position.character - 1
        )
    ) return true
    // Handle normal word case
    if (!wordRange) return false
    return line.firstNonWhitespaceCharacterIndex === wordRange.start.character
}

const isThenSymbol = (line: TextLine, word?: string): boolean => {
    return word?.toLowerCase() === 'then' && (
        Boolean(readToken(line.text, BLOCK_START) || readToken(line.text, ELSE))
    )
}

const isMatchmarkerStart = (line: TextLine, position: Position): boolean => {
    const mmStartMatch = line.text.match(MM_START)
    if (!mmStartMatch) return false
    return mmStartMatch[0].length >= position.character
}

export class GSLDocumentHighlightProvider implements DocumentHighlightProvider {
    provideDocumentHighlights(document: TextDocument, position: Position): DocumentHighlight[] {
        const line = document.lineAt(position.line)
        const wordRange = document.getWordRangeAtPosition(position, /\b\w+\b/)
        const word = wordRange ? document.getText(wordRange) : undefined

        if (
            isFirstSymbolOnLine(line, position, wordRange)
            || isThenSymbol(line, word)
            || isMatchmarkerStart(line, position)
        ) {
            // Handle DOT, ELSE, and case statements, rerunnning this function with the opener.
            let blockEnd = readToken(line.text, DOT)
                || readToken(line.text, ELSE)
                || readToken(line.text, CASE_STATEMENT)
            if (blockEnd) {
                const startOfBlock = this.findStartOfBlock(document, position)
                if (startOfBlock) {
                    // Rerun with start of block for consistent logic
                    return this.provideDocumentHighlights(document, startOfBlock)
                }
                return [highlightMatch(document, position.line, blockEnd)]
            }

            // Try processing line as block start.
            const blockStart = readToken(line.text, BLOCK_START)
            if (blockStart) {
                return [
                    // Highlight all of blockStart so that the MM line is fully highlighted:
                    highlightMatch(document, position.line, blockStart),
                    ...this.scanForwardsHighlightBlockTokens(document, position, blockStart)
                ]
            }

            // Handle case of "push|fastpush" by searching for corresponding pops.
            const push = readToken<'push' | 'fastpush'>(line.text, PUSH)
            if (push) {
                return [
                    highlightMatch(document, position.line, push),
                    ...this.scanForwardHighlightPops(document, position, push)
                ]
            }

            // Handle case of "pop|fastpop" by searching for corresponding push.
            const pop = readToken<'pop' | 'fastpop'>(line.text, POP)
            if (pop) {
                return [
                    highlightMatch(document, position.line, pop),
                    this.scanBackwardHighlightPushes(document, position, pop)
                ].filter(isNonVoid)
            }
        }

        // Nothing matched. Just highlight the word range of the original position (if any).
        if (!word) return []
        const highlights: DocumentHighlight[] = []
        
        for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
            const lineText = document.lineAt(lineNum).text
            let match: RegExpExecArray | null
            const regex = new RegExp(`\\b${word}\\b`, 'gi')
            
            while ((match = regex.exec(lineText)) !== null) {
                const range = new Range(
                    new Position(lineNum, match.index),
                    new Position(lineNum, match.index + word.length)
                )
                highlights.push(new DocumentHighlight(range, DocumentHighlightKind.Text))
            }
        }
        
        return highlights
    }

    /**
     * Given a block opener token at `position`, i.e.
     * "ifnot/if/loop/when/is/default" or a MM label line, scan forwards
     * and highlight the corresponding block closing token (a dot).
     * 
     * In the case of "if/ifnot", the "else/else_if/else_ifnot" tokens
     * will also be highlighted.
     * 
     * In the case of "when", the IS/DEFAULT tokens are highlighted.
     */
    private scanForwardsHighlightBlockTokens(
        document: TextDocument,
        position: Position,
        originalMatch: string
    ): DocumentHighlight[] {
        const highlights = new Array<DocumentHighlight>()
        const blockStack = [originalMatch]
        let iterations = 0

        // If statements should have THEN highlighted
        if (originalMatch === 'if' || originalMatch === 'ifnot') {
            const thenHighlight = highlightThenSymbol(document, position.line)
            if (thenHighlight) highlights.push(thenHighlight)
        }

        // Scan forward to find the corresponding pair at the same level of the stack
        for (
            let i = position.line + 1;
            i < document.lineCount && iterations < MAX_SCAN_ITERATIONS;
            i++, iterations++
        ) {
            const topOfStack = peekStack(blockStack)
            if (!topOfStack) return highlights

            // Handle IS/DEFAULT, a special kind of block start
            const line = document.lineAt(i)
            if (originalMatch === 'when' && blockStack.length === 1) {
                const caseStatement = readToken(line.text, CASE_STATEMENT)
                if (caseStatement) {
                    highlights.push(highlightMatch(document, i, caseStatement))
                }
            }
            if (originalMatch === 'when' && blockStack.length === 2) {
                const endCaseStatement = readToken(line.text, DOT)
                if (endCaseStatement) {
                    highlights.push(highlightMatch(document, i, endCaseStatement))
                }
            }

            // Handle block start
            const blockStartMatch = readToken(line.text, BLOCK_START)
            if (blockStartMatch) {
                blockStack.push(blockStartMatch)
                continue
            }

            // Handle ELSE
            if (originalMatch.startsWith('if') && blockStack.length === 1) {
                const elseMatch = readToken(line.text, ELSE)
                if (elseMatch) {
                    highlights.push(highlightMatch(document, i, elseMatch))
                    const thenHighlight = highlightThenSymbol(document, i)
                    if (thenHighlight) highlights.push(thenHighlight)
                    continue
                }
            }

            // Handle DOT
            const dot = readToken(line.text, DOT)
            if (dot && isPair(topOfStack, dot)) {
                blockStack.pop()
                // Uncomment this if we want to highlights dots in WHEN:
                // if (originalMatch === 'when' && blockStack.length === 1) {
                //     highlights.push(highlightMatch(document, i, dot))
                //     continue
                // }
                if (!blockStack.length) {
                    highlights.push(highlightMatch(document, i, dot))
                }
                continue
            }
        }

        return highlights
    }

    /**
     * Given a "." statement at `position`, scans backwards to find
     * the position of the start of the block.
     */
    private findStartOfBlock(
        document: TextDocument,
        position: Position
    ): Position | undefined {
        const blockStack = new Array<string>('.')
        let iterations = 0

        // Scan backward to find the corresponding pair at the same level of the stack
        for (
            let i = position.line - 1;
            i >= 0 && iterations < MAX_SCAN_ITERATIONS;
            i--, iterations++
        ) {
            const topOfStack = peekStack(blockStack)
            if (!topOfStack) return
            const line = document.lineAt(i)

            // Handle block start
            const blockStart = readToken(line.text, BLOCK_START)
            if (blockStart) {
                if (!blockStack.length) return // In case text is malformed

                // Pop stack and return if start of pair is found
                blockStack.pop()
                if (!blockStack.length) {
                    return new Position(i, line.text.toLowerCase().indexOf(blockStart))
                }
            }

            // Handle DOT
            const dot = readToken(line.text, DOT)
            if (dot) {
                blockStack.push(dot)
                continue
            }
        }
    }

    /**
     * Given a "pop/fastpop" statement at `position`, scans backward to find
     * and highlight the corresponding "push/fastpush" statement.
     */
    private scanBackwardHighlightPushes(
        document: TextDocument,
        position: Position,
        originalMatch: 'pop' | 'fastpop'
    ): DocumentHighlight | undefined {
        /**
         * A reverse block stack. When a block ending is seen it is pushed on,
         * and when a block beginning is seen the last block ending is
         * popped off. Unlike in other places, we treat fastpush/push/
         * fastpop/pop as block symbols.
         */
        const blockStack = new Array<string>(originalMatch)
        let earlyStop = false
        let iterations = 0

        // Scan backwards to find the corresponding push
        for (
            let i = position.line - 1;
            i >= 0 && iterations < MAX_SCAN_ITERATIONS;
            i--, iterations++
        ) {
            const line = document.lineAt(i)
            const pushMatch = readToken(line.text, PUSH)

            if (readToken(line.text, STOP)) {
                earlyStop = true
                continue
            }

            if (blockStack.length <= 1) {
                // Try processing as the corresponding push
                if (pushMatch && isPair(pushMatch, originalMatch)) {
                    return highlightMatch(document, i, pushMatch)
                }
            }

            // Try processing as block start, including pushes
            const blockStart = pushMatch ?? readToken(line.text, BLOCK_START)
            if (blockStart) {
                earlyStop = false
                if (blockStack.length > 0) blockStack.pop()
                continue
            }

            // Try processing as block start, including pops
            const blockEnd = readToken(line.text, POP)
                ?? readToken(line.text, DOT)
            if (blockEnd) {
                if ((blockEnd === 'pop' || blockEnd === 'fastpop') && earlyStop) {
                    continue // Ignore early pop stops
                }
                blockStack.push(blockEnd)
                continue
            }
        }
    }

    /**
     * Given a "push/fastpush" statement at `position`, scans forward to find
     * and highlight the corresponding "pop/fastpop" statements. Because of
     * early stops, multiple highlights may be returned.
     */
    private scanForwardHighlightPops(
        document: TextDocument,
        position: Position,
        originalMatch: 'push' | 'fastpush'
    ): DocumentHighlight[] {
        const highlights = new Array<DocumentHighlight>()
        /**
         * A block stack. When a block beginning is seen it is pushed on,
         * and when a block ending is seen then the last beginning is popped.
         */
        const blockStack = new Array<string>(originalMatch)
        let pushDepth = 1
        let iterations = 0

        // Scan forward to find all pops associated with the given push match
        for (
            let i = position.line + 1;
            i < document.lineCount && iterations < MAX_SCAN_ITERATIONS;
            i++, iterations++
        ) {
            const topOfStack = peekStack(blockStack)
            if (!topOfStack) return highlights
            const line = document.lineAt(i)

            // Try processing as block start
            const blockStart = readToken(line.text, BLOCK_START)
            if (blockStart) {
                blockStack.push(blockStart)
                continue
            }

            // Try processing as block end
            const blockEnd = readToken(line.text, DOT)
            if (blockEnd) {
                if (isPair(topOfStack, blockEnd)) blockStack.pop()
                continue
            }

            // Try processing as push
            const pushMatch = readToken(line.text, PUSH)
            if (pushMatch) {
                blockStack.push(pushMatch)
                pushDepth++
                continue
            }

            // Try processing as pop
            const popMatch = readToken(line.text, POP)
            if (popMatch) {
                if (isPair(originalMatch, popMatch) && pushDepth === 1) {
                    // Highlight push
                    highlights.push(highlightMatch(document, i, popMatch))
                }
                if (isPair(topOfStack, popMatch)) {
                    // Remove last pop from stack
                    blockStack.pop()
                    pushDepth--
                }
            }
        }
        return highlights
    }
}

const peekStack = <T>(stack: T[]): T | null => stack.length
    ? stack[stack.length - 1]
    : null

const highlightThenSymbol = (
    document: TextDocument,
    lineNum: number
): DocumentHighlight | undefined => {
    const thenMatch = document.lineAt(lineNum).text.toLowerCase().indexOf('then')
    if (thenMatch === -1) return
    return highlightMatch(document, lineNum, 'then')
}

const highlightMatch = (
    document: TextDocument,
    lineNum: number,
    match: string
): DocumentHighlight => {
    const lineText = document.lineAt(lineNum).text.toLowerCase()
    const startIndex = lineText.indexOf(match)
    const startPos = new Position(lineNum, startIndex)
    const endPos = new Position(lineNum, startIndex + match.length)
    const range = new Range(startPos, endPos)
    return new DocumentHighlight(range, DocumentHighlightKind.Text)
}

const isPair = (
    blockStartMatch: string,
    blockEndMatch: string,
): boolean => {
    const start = blockStartMatch
    const end = blockEndMatch
    if (start === 'fastpush') return end === 'fastpop'
    if (start === 'push') return end === 'pop'
    return end === '.'
}