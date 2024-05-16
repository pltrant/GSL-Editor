import { HoverProvider, Hover, TextDocument, Position } from "vscode"
import { snippets } from '../snippets/GslSnippets'
import { ScriptProperties } from "./editorClient"

const skippedSnippets = new Set(['if', 'ifnot', 'else', 'loop', 'when'])

const snippetDescriptionMap = Object.values(snippets).reduce(
    (memo, snippet) => {
        const firstWord = snippet.prefix.split(/\s+/)[0].toLowerCase()
        if (!firstWord || skippedSnippets.has(firstWord)) return memo
        const tokens = snippet.description.split(/\n+/)
        memo[firstWord] ||= []
        tokens[0] = '`' + tokens[0] + '`'
        memo[firstWord].push(tokens.join('\n\n'))
        return memo
    },
    {} as Record<string, string[]>
)

type GetScriptProperties = (script: number) => Promise<ScriptProperties | undefined>;

export class GSLHoverProvider implements HoverProvider {
    private nodeInfo: any;
    private varInfo: any;
    private tokenInfo: any;
    private baseHoverRegex: RegExp;
    private stringTokenRegex: RegExp;
    private fieldRegex: RegExp;
    private varRegex: RegExp;
    private tokenRegex: RegExp;
    private systemRegex: RegExp;
    private tableRegex: RegExp;
    private callmatchLineRegex: RegExp;
    private callmatchScriptNumberRegex: RegExp;
    private getScriptProperties: GetScriptProperties;

    constructor(getScriptProperties: GetScriptProperties) {
        this.getScriptProperties = getScriptProperties
        this.nodeInfo = {
            'O': {
                'A': 'article',
                'J': 'adjective',
                'N': 'noun',
                'D': 'article adjective noun',
                'S': 'adjective noun',
                'C': 'opened/closed',
                'O': 'an opened/a closed',
                'T': "'the' followed by noun",
                'M': "'pronoun' field if set, otherwise noun"
            },
            'C': {
                'A': 'article',
                'J': 'adjective',
                'N': 'noun',
                'D': 'article adjective noun',
                'S': 'adjective noun',
                'T': "'crtr_name' field if set, otherwise 'the' followed by noun",
                'U': "'the' followed by adjective and noun",
                'M': "'pronoun' field if set, otherwise noun"
            },
            'P': {
                '': 'First name',
                'A': 'Master/Mistress',
                'B': 'First and last name',
                'F': 'himself/herself',
                'G': 'he/she',
                'H': 'his/her',
                'I': 'him/her',
                'L': 'Last name',
                'M': 'man/woman',
                'P': 'profession',
                'R': 'race',
                'S': 'sir/madam'
            },
            'X': {
                '': 'article adjective noun of creature OR first name of player.',
                'F': 'himself/herself of creature or player.',
                'G': 'he/she of creature or player.',
                'H': 'his/her of creature or player.',
                'I': 'him/her of creature or player.',
                'T': "Creatures: 'crtr_name' field if set, otherwise 'the' followed by noun. Characters: first name.",
                'U': "Creatures: 'the' followed by adjective and noun. Characters: first name."
            },
            'E': {
                'A': 'article',
                'J': 'adjective',
                'N': 'noun',
                'D': 'article adjective noun',
                'S': 'adjective noun',
                'T': "'the' followed by noun",
                'M': "'pronoun' field if set, otherwise noun"
            },
            'r': {
                '': 'Room number.'
            }
        }
        this.varInfo = {
            'A': 'value',
            'B': 'value',
            'D': 'value / 100 with remainder as decimal',
            'V': 'value',
            'L': 'value right aligned to 7 characters',
            'S': 'value',
            'K': 'value right aligned to 16 characters',
            'T': 'value'
        }
        this.tokenInfo = {
            '$': '$ symbol',
            '\\': 'Suppresses automatic linefeed',
            '^': 'Uppercase first letter of string',
            'Q': '" symbol',
            'R': 'Linefeed',
            '*': 'ESC code (ASCII 27)',
            '+': 'Capitalizes first letter of next string token',
            "'": "Adds 's to next string token, properly XML wrapped",
            'ZE': 'Outputs timestamp for token that follows'
        }
        this.baseHoverRegex = /^\s*[a-zA-Z]+( |$)|\$(:\$[A-Z]+|:\d+\[\d+,\d+,\d+\]|[\w\d:_-]+|[ABDVLSKT]\d|[$\\^QR*+'])/
        this.stringTokenRegex = /\$([POCEXr])(\d)([A-Z]?)$/
        this.fieldRegex = /\$([POCEXr]\d):([\w\d_]+)$/
        this.varRegex = /\$([ABDVLSKT])(\d)/
        this.tokenRegex = /\$([$\\^QR*+']|ZE)/
        this.systemRegex = /\$:(\$[A-Z]+)/
        this.tableRegex = /\$:(\d+)(\[\d+,\d+,\d+\])/
        this.callmatchLineRegex = /^\s*callmatch .*? in (\d+)/i
        this.callmatchScriptNumberRegex = /\d+\s*(!.*)?$/
    }

    provideHover(document: TextDocument, position: Position, token: any): Hover | Promise<Hover | undefined> | undefined {
        // Check for hover over callmatch script number
        if (document.getWordRangeAtPosition(position, this.callmatchScriptNumberRegex)) {
            const line = document.lineAt(position.line).text
            const callmatchMatch = this.callmatchLineRegex.exec(line)
            if (callmatchMatch !== null) {
                return this.callmatchHover(Number(callmatchMatch[1]))
            }
        }

        // Check for hover over words
        let wordRange = document.getWordRangeAtPosition(position, this.baseHoverRegex)
        if (!wordRange) return
        const word = document.getText(wordRange)?.trim()
        const snippets = snippetDescriptionMap[word.toLowerCase()]

        if (snippets?.length) {
            return this.snippetHover(snippets)
        } else if (this.stringTokenRegex.test(word)) {
            return this.stringTokenHover(word)
        } else if (this.fieldRegex.test(word)) {
            return this.fieldHover(word)
        } else if (this.varRegex.test(word)) {
            return this.varHover(word)
        } else if (this.tokenRegex.test(word)) {
            return this.tokenHover(word)
        } else if (this.systemRegex.test(word)) {
            return this.systemHover(word)
        } else if (this.tableRegex.test(word)) {
            return this.tableHover(word)
        }
    }

    snippetHover(snippets: string[]): Hover | undefined {
        return new Hover(snippets.join('\n\n---\n\n'))
    }

    stringTokenHover(token: any): any {
        let tokenTypes = this.stringTokenRegex.exec(token);
        if (tokenTypes && tokenTypes[1] in this.nodeInfo && tokenTypes[3] in this.nodeInfo[tokenTypes[1]]) {
            return new Hover('N' + tokenTypes[1].toUpperCase() + tokenTypes[2] + ': ' + this.nodeInfo[tokenTypes[1]][tokenTypes[3]])
        }
    }

    fieldHover(token: any): any {
        let tokenTypes = this.fieldRegex.exec(token);
        if (tokenTypes == null) { return; }
        return new Hover('N' + tokenTypes[1].toUpperCase() + ": '" + tokenTypes[2] + "' field");
    }

    varHover(token: any): any {
        let tokenTypes = this.varRegex.exec(token)
        if (tokenTypes == null) { return; }
        let varName = tokenTypes[1]
        if (varName === 'D' || varName === 'L') varName = 'V'
        if (varName === 'K') varName = 'S'
        return new Hover(varName + tokenTypes[2] + ': ' + this.varInfo[tokenTypes[1]])
    }

    tokenHover(word: any): any {
        var match = this.tokenRegex.exec(word);
        if (match == null) { return; }
        let token = match[1]
        return new Hover(this.tokenInfo[token])
    }

    systemHover(word: any): any {
        let match = this.systemRegex.exec(word)
        if (match == null) { return; }
        let token = match[1]
        return new Hover('System variable ' + token)
    }

    tableHover(word: any): any {
        let tokenTypes = this.tableRegex.exec(word)
        if (tokenTypes == null) { return; }
        return new Hover('table #' + tokenTypes[1] + ': value in ' + tokenTypes[2])
    }

    async callmatchHover(script: number): Promise<Hover | undefined> {
        const scriptProperties = await this.getScriptProperties(script)
        if (!scriptProperties) return
        const {desc, name, owner, modifier, lastModifiedDate} = scriptProperties
        const dateStr = lastModifiedDate.toLocaleDateString()
        const timeStr = lastModifiedDate.toLocaleTimeString()
        const firstLine = desc || scriptProperties.verb || ''
        return new Hover(
            (firstLine ? `${firstLine}\n` : '')
            + (name ? `- Name: ${name}\n` : '')
            + `- Owner: ${owner}\n`
            + `- Last modified by: ${modifier}\n`
            + `- Last modified on: ${dateStr} at ${timeStr}\n`
        )
    }
}
