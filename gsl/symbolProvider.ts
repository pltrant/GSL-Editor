import { DocumentSymbolProvider, Range, SymbolKind, Location } from "vscode";

export class GSLDocumentSymbolProvider implements DocumentSymbolProvider {
    provideDocumentSymbols(document: any, token: any): Promise<any> {
        return new Promise((resolve, reject) => {
            let header = true;
            let symbols = [];
            for (let i = 0; i < document.lineCount; i++) {
                let line = document.lineAt(i);
                if (line.text.startsWith(": ")) {
                    header = false;
                    let matchMarker = /^:\s+"(.*?)"/.exec(line.text);
                    if (matchMarker) {
                        let endLine = null;
                        let endChar = null;
                        for (
                            let i = line.lineNumber;
                            i < document.lineCount;
                            i++
                        ) {
                            let lineTxt = document.lineAt(i);
                            if (lineTxt.text.startsWith(".")) {
                                // Attribute any comments after the closing period to the current matchmarker
                                for (
                                    let j = i + 1;
                                    j < document.lineCount;
                                    j++
                                ) {
                                    let lineTxt2 = document.lineAt(j);
                                    if (!lineTxt2.text.startsWith("!")) {
                                        break;
                                    } else {
                                        i++;
                                    }
                                }
                                endLine = i;
                                endChar =
                                    document.lineAt(i).range.end.character;
                                break;
                            }
                        }
                        let symbolRange = null;
                        if (endLine == null || endChar == null) {
                            symbolRange = line.range;
                        } else {
                            symbolRange = new Range(
                                line.lineNumber,
                                line.range.start.character,
                                endLine,
                                endChar,
                            );
                        }
                        symbols.push({
                            name: matchMarker[1],
                            kind: SymbolKind.Method,
                            location: new Location(document.uri, symbolRange),
                        });
                    }
                } else if (header && !line.text.startsWith("!")) {
                    header = false;
                    let endLine = null;
                    let endChar = null;
                    for (let i = line.lineNumber; i < document.lineCount; i++) {
                        let lineTxt = document.lineAt(i);
                        if (lineTxt.text.startsWith(":")) {
                            i--;
                            endLine = i;
                            endChar = document.lineAt(i).range.end.character;
                            break;
                        }
                    }
                    if (endLine == null || endChar == null) {
                        // the whole script is in the empty matchmarker
                        endLine = document.lineCount - 1;
                        endChar = document.lineAt(document.lineCount - 1).range
                            .end.character;
                    }
                    let symbolRange = new Range(
                        line.lineNumber,
                        line.range.start.character,
                        endLine,
                        endChar,
                    );
                    symbols.push({
                        name: '""',
                        kind: SymbolKind.Method,
                        location: new Location(document.uri, symbolRange),
                    });
                }
            }
            resolve(symbols);
        });
    }
}
