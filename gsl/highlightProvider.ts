
import { DocumentHighlightProvider, DocumentHighlight, DocumentHighlightKind, TextDocument, Position, ProviderResult } from "vscode"
import { CancellationToken } from "vscode-languageclient"

export class GSLDocumentHighlightProvider implements DocumentHighlightProvider {
    private startKeywords: RegExp
    private middleKeywords: RegExp
    private endKeywords: RegExp
    private gslWords: RegExp

    constructor() {
        this.startKeywords = /^:|^\s*(if|ifnot|loop|when|is|default|fastpush|push)\b.*$/i
        this.middleKeywords = /^\s*(else|else_if|else_ifnot)\b.*$/i
        this.endKeywords = /^\s*\.|(fastpop|pop)\b.*$/i
        this.gslWords = /:|\.|if|ifnot|loop|when|is|default|else_ifnot|else_if|else|fastpush|fastpop|push|pop/i
    }

    provideDocumentHighlights(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<DocumentHighlight[]> {
        let highlights = []
        let textRange = document.getWordRangeAtPosition(position, /[\S]+/)
        if (textRange) {
            let lineNum = textRange.start.line
            let starts = 0
            let ends = 0

            if (this.startKeywords.test(document.getText(textRange))) {
                highlights.push(new DocumentHighlight(textRange, DocumentHighlightKind.Text))
                this.searchLinesAfter(document, lineNum, highlights, starts, ends)
            } else if (this.middleKeywords.test(document.getText(textRange))) {
                highlights.push(new DocumentHighlight(textRange, DocumentHighlightKind.Text))
                // Check for the starting keyword
                ends = 1
                this.searchLinesBefore(document, lineNum, highlights, starts, ends)
                // Check for the ending keyword
                lineNum = textRange.start.line
                starts = 1
                ends = 0
                this.searchLinesAfter(document, lineNum, highlights, starts, ends)
            } else if (this.endKeywords.test(document.getText(textRange))) {
                highlights.push(new DocumentHighlight(textRange, DocumentHighlightKind.Text))
                this.searchLinesBefore(document, lineNum, highlights, starts, ends)
            }
        }
        return highlights
    }

    searchLinesAfter(document: TextDocument, lineNum: number, highlights: DocumentHighlight[], starts: number, ends: number) {
        let foundEnd = false
        let textLine = ''
        while (foundEnd === false) {
            textLine = document.lineAt(lineNum).text
            if (this.startKeywords.test(textLine)) {
                starts++
            } else if ((starts === ends + 1) && (this.middleKeywords.test(textLine))) {
                this.addHighlight(highlights, document, lineNum, textLine)
            } else if (this.endKeywords.test(textLine)) {
                ends++
            }
            if (starts === ends) {
                this.addHighlight(highlights, document, lineNum, textLine)
                foundEnd = true
            }
            lineNum++
        }
    }

    searchLinesBefore(document: TextDocument, lineNum: number, highlights: DocumentHighlight[], starts: number, ends: number) {
        let foundEnd = false
        let textLine = ''
        while (foundEnd === false) {
            textLine = document.lineAt(lineNum).text
            if (this.startKeywords.test(textLine)) {
                starts++
            } else if ((starts + 1 === ends) && (this.middleKeywords.test(textLine))) {
                this.addHighlight(highlights, document, lineNum, textLine)
            } else if (this.endKeywords.test(textLine)) {
                ends++
            }
            if (starts === ends) {
                this.addHighlight(highlights, document, lineNum, textLine)
                foundEnd = true
            }
            lineNum--
        }
    }

    addHighlight(highlights: DocumentHighlight[], document: TextDocument, lineNum: number, textLine: string) {
        let startIdx = textLine.search(/\S|$/)
        if (startIdx > -1) {
            let endPos = new Position(lineNum, startIdx)
            if (endPos) {
                let endRange = document.getWordRangeAtPosition(endPos, this.gslWords)
                if (endRange) {
                    highlights.push(new DocumentHighlight(endRange))
                }
            }
        }
    }
}
