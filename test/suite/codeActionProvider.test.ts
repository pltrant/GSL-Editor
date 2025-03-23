import * as assert from 'assert'
import * as vscode from 'vscode'
import { GSLCodeActionProvider, ACTION_WRAP_TO_MULTIPLE, ACTION_COLLAPSE_MULTILINE, ACTION_REDISTRIBUTE_MULTILINE } from '../../gsl/codeActionProvider'
import { LINE_TOO_LONG } from '../../gsl/diagnostics'
import { QUOTE_CONTINUATION } from '../../gsl/util/formattingUtil'

const buildDiagnostic = (range: vscode.Range): vscode.Diagnostic => ({
    code: LINE_TOO_LONG,
    range,
    message: 'Line is too long',
    severity: vscode.DiagnosticSeverity.Warning
})

suite('GSLCodeActionProvider Test Suite', () => {
    let document: vscode.TextDocument
    let provider: GSLCodeActionProvider

    // Helper to run provider and return the replacement text from the WorkspaceEdit.
    async function getReplacementText(content: string, actionTitle: string): Promise<string> {
        // Open a new document with provided content.
        document = await vscode.workspace.openTextDocument({
            language: 'gsl',
            content
        })
        provider = new GSLCodeActionProvider()
        // Create a range that covers the entire line
        const range = new vscode.Range(0, 0, 0, content.length)
        const context: vscode.CodeActionContext = {
            diagnostics: [buildDiagnostic(range)],
            triggerKind: vscode.CodeActionTriggerKind.Invoke,
            only: undefined
        }
        const actions = await Promise.resolve(provider.provideCodeActions(document, range, context))
        const action = actions?.find(a => a.title === actionTitle)
        assert.ok(action, `Expected to find action with title "${actionTitle}"`)
        const edit = action.edit
        assert.ok(edit, 'Expected WorkspaceEdit to be defined')
        const edits = edit.get(document.uri)
        assert.ok(edits && edits.length > 0, 'Expected at least one TextEdit in WorkspaceEdit')
        return edits[0].newText
    }

    test('should offer wrap action for long set command', async () => {
        const longText = 'set T9 to ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus fidddsibudds elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `set T9 to ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus fidddsibudds${QUOTE_CONTINUATION}` +
            `" elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis${QUOTE_CONTINUATION}` +
            `" sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit${QUOTE_CONTINUATION}` +
            `" scelerisque.")`
        )
    })

    test('should offer wrap action for long set command (with table)', async () => {
        const longText = 'set table:12345[3,2,4] to ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus fidddsibudds elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `set table:12345[3,2,4] to ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus${QUOTE_CONTINUATION}` +
            `" fidddsibudds elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna,${QUOTE_CONTINUATION}` +
            `" eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu${QUOTE_CONTINUATION}` +
            `" blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msg command', async () => {
        const longText = 'msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msg command, adding parantheses', async () => {
        const longText = 'msg NP1 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgp command, adding parantheses', async () => {
        const longText = 'msgp "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgp ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac${QUOTE_CONTINUATION}` +
            `" nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla${QUOTE_CONTINUATION}` +
            `" ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgr command, adding parantheses', async () => {
        const longText = 'msgr "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgr ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac${QUOTE_CONTINUATION}` +
            `" nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla${QUOTE_CONTINUATION}` +
            `" ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgrxp command, adding parantheses', async () => {
        const longText = 'msgrxp "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgrxp ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgrx2 command, adding parantheses', async () => {
        const longText = 'msgrx2 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgrx2 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should handle indentation', async () => {
        const longText = '    msg NP1 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `    msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus${QUOTE_CONTINUATION}` +
            `    " elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu${QUOTE_CONTINUATION}` +
            `    " facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu${QUOTE_CONTINUATION}` +
            `    " blandit scelerisque.")`
        )
    })

    test('should handle comments', async () => {
        const longText = '    msg NP1 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque." ! foobar biz baz'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `    msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus${QUOTE_CONTINUATION}` +
            `    " elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu${QUOTE_CONTINUATION}` +
            `    " facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu${QUOTE_CONTINUATION}` +
            `    " blandit scelerisque.")\n    ! foobar biz baz`
        )
    })

    test('should handle a long unbroken string', async () => {
        const longText = '  msgp ("testingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestintestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestinFoobarfoo")'
        const replacement = await getReplacementText(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `  msgp ("testingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestintestingt${QUOTE_CONTINUATION}` +
            `  "estingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestingtestinFoobarfoo")`
        )
    })

    test('should collapse multiline string', async () => {
        const multiLineString = 
            `msgp ("This is a test" +\\
            " that spans multiple" +\\
            " lines")`
        assert.equal(
            await getReplacementText(multiLineString, ACTION_COLLAPSE_MULTILINE),
            'msgp "This is a test that spans multiple lines"'
        )
    })

    test('should collapse multiline string with indentation', async () => {
        const multiLineString = 
            `    msgp ("This is a test" +\\
            " that spans multiple" +\\
            " lines")`
        assert.equal(
            await getReplacementText(multiLineString, ACTION_COLLAPSE_MULTILINE),
            '    msgp "This is a test that spans multiple lines"'
        )
    })

    test('should redistribute multiline string to one line if possible, removing parantheses', async () => {
        const multiLineString = 
            `    msgp ("This is a test" +\\
            " that spans multiple" +\\
            " lines")`
        assert.equal(
            await getReplacementText(multiLineString, ACTION_REDISTRIBUTE_MULTILINE),
            '    msgp "This is a test that spans multiple lines"'
        )
    })

    test('should redistribute multiline string to shortest number of lines if one line is not possible', async () => {
        const multiLineString = 
        `    msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus${QUOTE_CONTINUATION}` +
        `    " elementum , eu${QUOTE_CONTINUATION}` +
        `    " facilisis Praesent dapibus est eu${QUOTE_CONTINUATION}` +
        `    " blandit scelerisque.")`
        assert.equal(
            await getReplacementText(multiLineString, ACTION_REDISTRIBUTE_MULTILINE),
            `    msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus${QUOTE_CONTINUATION}` +
            `    " elementum , eu facilisis Praesent dapibus est eu blandit scelerisque.")`
        )
    })
})
