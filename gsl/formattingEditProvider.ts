import { DocumentFormattingEditProvider, TextDocument, Range, TextEdit } from "vscode"

export class GSLDocumentFormattingEditProvider implements DocumentFormattingEditProvider {
    provideDocumentFormattingEdits (document: TextDocument) {
      let textEdits = []
      let firstLine = document.lineAt(0)
      let lastLine = document.lineAt(document.lineCount - 1)
      let textRange = new Range(
        0,
        firstLine.range.start.character,
        document.lineCount - 1,
        lastLine.range.end.character
      )
      // Remove non-printable characters
      // eslint-disable-next-line no-control-regex
      textEdits.push(TextEdit.replace(textRange, document.getText().replace(/[^\x00-\x7f]/g, '')))
      // Remove blank lines
      textEdits.push(TextEdit.replace(textRange, document.getText().replace(/(\r\n){2,}/g, '\r\n')))
      return textEdits
    }
  }

  