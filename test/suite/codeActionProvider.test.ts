import * as assert from 'assert'
import * as vscode from 'vscode'
import { GSLCodeActionProvider, ACTION_WRAP_TO_MULTIPLE, ACTION_COLLAPSE_MULTILINE, ACTION_REDISTRIBUTE_MULTILINE, COMBINE_MULTIPLE_MESSAGES, ACTION_ALIGN_COMMENTS } from '../../gsl/codeActionProvider'
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

    /**
     * Finds the first Code Action applicable to the given `content` in the given
     * `range`, applies it to `content`, and returns the result. Asserts that at
     * least one Code Action of `actionTitle` is found. 
     */
    async function applyCodeAction(
        content: string,
        actionTitle: string,
        range: vscode.Range = new vscode.Range(0, 0, 0, content.length)
    ): Promise<string> {
        // Open a new document with provided content.
        document = await vscode.workspace.openTextDocument({
            language: 'gsl',
            content
        })
        provider = new GSLCodeActionProvider()
        // Create a range that covers the entire line
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

        // Sort edits in reverse order to apply from bottom to top
        edits.sort((a, b) => b.range.start.compareTo(a.range.start))

        // Apply all edits to the content
        let result = content
        for (const edit of edits) {
            const startOffset = document.offsetAt(edit.range.start)
            const endOffset = document.offsetAt(edit.range.end)
            result = result.substring(0, startOffset) + edit.newText + result.substring(endOffset)
        }
        return result
    }

    /**
     * Same as `applyCodeAction`, but presumes that the user has all of `content` selected.
     */
    async function applyCodeActionToSelection(
        content: string,
        actionTitle: string
    ): Promise<string> {
        const lineCount = content.split("\n").length
        return applyCodeAction(
            content,
            actionTitle,
            new vscode.Range(0, 0, lineCount - 1, content.length)
        )
    }

    test('should offer wrap action for long set command', async () => {
        const longText = 'set T9 to ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus fidddsibudds elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
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
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
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
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msg command, adding parantheses', async () => {
        const longText = 'msg NP1 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgp command, adding parantheses', async () => {
        const longText = 'msgp "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgp ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac${QUOTE_CONTINUATION}` +
            `" nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla${QUOTE_CONTINUATION}` +
            `" ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgr command, adding parantheses', async () => {
        const longText = 'msgr "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgr ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac${QUOTE_CONTINUATION}` +
            `" nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla${QUOTE_CONTINUATION}` +
            `" ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgrxp command, adding parantheses', async () => {
        const longText = 'msgrxp "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgrxp ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should offer wrap action for msgrx2 command, adding parantheses', async () => {
        const longText = 'msgrx2 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
        assert.equal(
            replacement,
            `msgrx2 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum${QUOTE_CONTINUATION}` +
            `" ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien${QUOTE_CONTINUATION}` +
            `" nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should handle indentation', async () => {
        const longText = '    msg NP1 "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus elementum ac nec ligula. Proin hendrerit, lorem in sagittis consequat, metus massa aliquet magna, eu facilisis sapien nulla ut eros. Etiam facilisis eros ut ligula consequat malesuada. Praesent dapibus est eu blandit scelerisque."'
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
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
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
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
        const replacement = await applyCodeAction(longText, ACTION_WRAP_TO_MULTIPLE)
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
            await applyCodeAction(multiLineString, ACTION_COLLAPSE_MULTILINE),
            'msgp "This is a test that spans multiple lines"'
        )
    })

    test('should collapse multiline string with indentation', async () => {
        const multiLineString =
            `    msgp ("This is a test" +\\
            " that spans multiple" +\\
            " lines")`
        assert.equal(
            await applyCodeAction(multiLineString, ACTION_COLLAPSE_MULTILINE),
            '    msgp "This is a test that spans multiple lines"'
        )
    })

    test('should redistribute multiline string to one line if possible, removing parantheses', async () => {
        const multiLineString =
            `    msgp ("This is a test" +\\
            " that spans multiple" +\\
            " lines")`
        assert.equal(
            await applyCodeAction(multiLineString, ACTION_REDISTRIBUTE_MULTILINE),
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
            await applyCodeAction(multiLineString, ACTION_REDISTRIBUTE_MULTILINE),
            `    msg NP1 ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus${QUOTE_CONTINUATION}` +
            `    " elementum , eu facilisis Praesent dapibus est eu blandit scelerisque.")`
        )
    })

    test('should combine messages if the line skips newline and the command is identical', async () => {
        const multiLineString =
            `    msgp "Foo$\\"\n` +
            `    msgp "Bar"`
        assert.equal(
            await applyCodeAction(multiLineString, COMBINE_MULTIPLE_MESSAGES),
            `    msgp "FooBar"`
        )
    })

    test('should not combine messages if the line skips newline and the command isnt identical', async () => {
        const multiLineString =
            `    msgp "Foo$\\"\n` +
            `    msgp "Bar$\\"\n` +
            `    msgr "Baz"`
        assert.equal(
            await applyCodeAction(multiLineString, COMBINE_MULTIPLE_MESSAGES),
            `    msgp "FooBar$\\"\n` +
            `    msgr "Baz"`
        )
    })

    test('should combine messages with msg NPX sequence', async () => {
        const multiLineString =
            `    msg NP0 "Foo$\\"\n` +
            `    msg NP0 "Bar$\\"\n` +
            `    msg NP1 "Baz$\\"\n`
        assert.equal(
            await applyCodeAction(multiLineString, COMBINE_MULTIPLE_MESSAGES),
            `    msg NP0 "FooBar$\\"\n` +
            `    msg NP1 "Baz$\\"\n`
        )
    })

    test('should not destroy trailing comments', async () => {
        const multiLineString =
            `    msg NP0 "Foo$\\" ! Comment1\n` +
            `    msg NP0 "Bar" ! Comment2\n`
        assert.equal(
            await applyCodeAction(multiLineString, COMBINE_MULTIPLE_MESSAGES),
            `    msg NP0 "FooBar"\n` +
            `    ! Comment1\n` +
            `    ! Comment2\n`
        )
    })

    test('should align comments', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `msgr "a" ! A\n` +
                `msgp "Foo" ! Foo\n` +
                `msgr "Bar biz baz rawr" ! Bar\n`,
                ACTION_ALIGN_COMMENTS
            ),
            'msgr "a"                                                       ! A\n' +
            'msgp "Foo"                                                     ! Foo\n' +
            'msgr "Bar biz baz rawr"                                        ! Bar\n'
        )
    })

    test('should not align whole-line comments', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `  msgp "a" ! A\n` +
                `  ! This is a whole line comment\n` +
                `  msgr "FooBar" ! FooBar\n`,
                ACTION_ALIGN_COMMENTS
            ),
            '  msgp "a"                                                     ! A\n' +
            '  ! This is a whole line comment\n' +
            '  msgr "FooBar"                                                ! FooBar\n'
        )
    })

    test('should align comments leftwards if comments are unnecessarily deeply indented', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `msgr "a"                                     ! A\n` +
                `msgp "Foo"                                           ! Foo\n` +
                `msgr "Bar biz baz rawr"                                    ! Bar\n`,
                ACTION_ALIGN_COMMENTS
            ),
            'msgr "a"                                                       ! A\n' +
            'msgp "Foo"                                                     ! Foo\n' +
            'msgr "Bar biz baz rawr"                                        ! Bar\n'
        )
    })

    test('should respect the 120 character limit', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                '  msgp "a"      ! Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus\n' +
                '  msgr "b"                                                                               ! B\n',
                ACTION_ALIGN_COMMENTS
            ),
            '  msgp "a" ! Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam eget turpis nec lacus finibus\n' +
            '  msgr "b"                                                     ! B\n'
        )
    })

    test('should ignore exclamation points in strings', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `msgr "a" ! A\n` +
                `msgp "Foo!" ! Foo\n` +
                `msgr "Bar biz baz rawr" ! Bar\n`,
                ACTION_ALIGN_COMMENTS
            ),
            'msgr "a"                                                       ! A\n' +
            'msgp "Foo!"                                                    ! Foo\n' +
            'msgr "Bar biz baz rawr"                                        ! Bar\n'
        )
    })

    test('should ignore exclamation points in parantheses', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `if (A1 != A2) then\n` +
                `  msgr "a" ! A\n` +
                `  msgp "Foo!" ! Foo\n` +
                `  msgr "Bar biz baz rawr" ! Bar\n` +
                `.\n`,
                ACTION_ALIGN_COMMENTS
            ),
            `if (A1 != A2) then\n` +
            '  msgr "a"                                                     ! A\n' +
            '  msgp "Foo!"                                                  ! Foo\n' +
            '  msgr "Bar biz baz rawr"                                      ! Bar\n' +
            '.\n'
        )
    })

    test('should ignore exclamation points in parantheses - 2nd case', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `  if ((NR0 / 1000) != 3031) then\n` +
                `      stop                                                    ! Failure, not in Nelemar\n` +
                `  .\n`,
                ACTION_ALIGN_COMMENTS
            ),
            `  if ((NR0 / 1000) != 3031) then\n` +
            `      stop                                                     ! Failure, not in Nelemar\n` +
            `  .\n`
        )
    })

    test('should skip multiline segments', async () => {
        assert.equal(
            await applyCodeActionToSelection(
                `msgp "foo" ! a\n` +
                `if ( \\ ! b\n` +
                `  (NR0 / 1000) != 3031 \\ ! c\n` +
                `) then ! d\n` +
                `    stop ! e\n` +
                `.! f\n`,
                ACTION_ALIGN_COMMENTS
            ),
            `msgp "foo"                                                     ! a\n` +
            `if ( \\ ! b\n` +
            `  (NR0 / 1000) != 3031 \\ ! c\n` +
            `) then                                                         ! d\n` +
            `    stop                                                       ! e\n` +
            `.                                                              ! f\n`,
        )
    })
})