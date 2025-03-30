import * as assert from 'assert'
import * as vscode from 'vscode'
import { formatIndentation } from '../../../gsl/util/formattingUtil'

suite('Formatting Utility Test Suite', () => {
    async function testFormatIndentation(input: string, expected: string): Promise<void> {
        // Create a document with the input text
        const document = await vscode.workspace.openTextDocument({
            language: 'gsl',
            content: input
        })

        // Call formatIndentation with the document
        const formatted = formatIndentation(document)

        // Assert the result matches expected output
        assert.strictEqual(formatted, expected)
    }

    test('Should indent an MM', async () => {
        await testFormatIndentation(
            `: "$FOOBAR"\n` +
            `msgp "foobar"\n` +
            `.\n`,
            // Expects:
            `: "$FOOBAR"\n` +
            `  msgp "foobar"\n` +
            `.\n`
        )
    })

    test('Should preserve comments ', async () => {
        await testFormatIndentation(
            `: "$FOOBAR" ! a\n` +
            `  ! a whole line comment here\n` +
            `msgp "foobar" ! b\n` +
            `. ! c`,
            // Expects:
            `: "$FOOBAR" ! a\n` +
            `  ! a whole line comment here\n` +
            `  msgp "foobar" ! b\n` +
            `. ! c`
        )
    })

    test('Should handle nested blocks with if-then', async () => {
        await testFormatIndentation(
            `: "$FOOBAR"\n` +
            `if A8 then\n` +
            `msgp "foobar"\n` +
            `.\n` +
            `.\n`,
            // Expects:
            `: "$FOOBAR"\n` +
            `  if A8 then\n` +
            `    msgp "foobar"\n` +
            `  .\n` +
            `.\n`
        )
    })

    test('Should handle multiple levels of nesting', async () => {
        await testFormatIndentation(
            `: "$OUTER"\n` +
            `if A8 then\n` +
            `if B9 then\n` +
            `msgp "nested"\n` +
            `.\n` +
            `msgp "less nested"\n` +
            `.\n` +
            `.\n`,
            // Expects:
            `: "$OUTER"\n` +
            `  if A8 then\n` +
            `    if B9 then\n` +
            `      msgp "nested"\n` +
            `    .\n` +
            `    msgp "less nested"\n` +
            `  .\n` +
            `.\n`
        )
    })

    test('Should handle push and pop operations', async () => {
        await testFormatIndentation(
            `push\n` +
            `msgp "inside push"\n` +
            `pop\n`,
            // Expects:
            `push\n` +
            `  msgp "inside push"\n` +
            `pop\n`
        )
    })

    test('Should handle fastpush and fastpop operations', async () => {
        await testFormatIndentation(
            `fastpush\n` +
            `msgp "inside fastpush"\n` +
            `fastpop\n`,
            // Expects:
            `fastpush\n` +
            `  msgp "inside fastpush"\n` +
            `fastpop\n`
        )
    })

    test('Should handle else blocks', async () => {
        await testFormatIndentation(
            `if A8 then\n` +
            `msgp "then branch"\n` +
            `else\n` +
            `msgp "else branch"\n` +
            `.\n`,
            // Expects:
            `if A8 then\n` +
            `  msgp "then branch"\n` +
            `else\n` +
            `  msgp "else branch"\n` +
            `.\n`
        )
    })

    test('Should handle case structures with is/default', async () => {
        await testFormatIndentation(
            `when A8\n` +
            `is 1\n` +
            `msgp "case 1"\n` +
            `.\n` +
            `is 2\n` +
            `msgp "case 2"\n` +
            `.\n` +
            `default\n` +
            `msgp "default case"\n` +
            `.\n` +
            `.\n`,
            // Expects:
            `when A8\n` +
            `  is 1\n` +
            `    msgp "case 1"\n` +
            `  .\n` +
            `  is 2\n` +
            `    msgp "case 2"\n` +
            `  .\n` +
            `  default\n` +
            `    msgp "default case"\n` +
            `  .\n` +
            `.\n`
        )
    })

    test('Should handle empty lines', async () => {
        await testFormatIndentation(
            `if A8 then\n` +
            `msgp "line 1"\n` +
            `\n` +
            `msgp "line 2"\n` +
            `.\n`,
            // Expects:
            `if A8 then\n` +
            `  msgp "line 1"\n` +
            `\n` +
            `  msgp "line 2"\n` +
            `.\n`
        )
    })

    test('Should handle else_if blocks', async () => {
        await testFormatIndentation(
            `if A8 then\n` +
            `msgp "then branch"\n` +
            `else_if B9 then\n` +
            `msgp "else if branch"\n` +
            `else\n` +
            `msgp "else branch"\n` +
            `.\n`,
            // Expects:
            `if A8 then\n` +
            `  msgp "then branch"\n` +
            `else_if B9 then\n` +
            `  msgp "else if branch"\n` +
            `else\n` +
            `  msgp "else branch"\n` +
            `.\n`
        )
    })

    test('Should handle loops', async () => {
        await testFormatIndentation(
            `loop\n` +
            `msgp "inside loop"\n` +
            `.\n`,
            // Expects:
            `loop\n` +
            `  msgp "inside loop"\n` +
            `.\n`
        )
    })

    test('Should handle early pop stop', async () => {
        await testFormatIndentation(
            `push\n` +
            `if A8 then\n` +
            `pop\n` +
            `stop\n` +
            `.\n` +
            `pop\n`,
            // Expects:
            `push\n` +
            `  if A8 then\n` +
            `    pop\n` +
            `    stop\n` +
            `  .\n` +
            `pop\n`,
        )
    })

    test('Should handle early fastpop stop', async () => {
        await testFormatIndentation(
            `fastpush\n` +
            `if A8 then\n` +
            `fastpop\n` +
            `stop\n` +
            `.\n` +
            `fastpop\n`,
            // Expects:
            `fastpush\n` +
            `  if A8 then\n` +
            `    fastpop\n` +
            `    stop\n` +
            `  .\n` +
            `fastpop\n`,
        )
    })

    test('Should leave unindented comments alone', async () => {
        await testFormatIndentation(
            `: "$do_stuff"\n` +
            `! Expects: NP0\n` +
            `! Returns: None\n` +
            `msgp "stuff"\n` +
            `.\n`,
            // Expects:
            `: "$do_stuff"\n` +
            `! Expects: NP0\n` +
            `! Returns: None\n` +
            `  msgp "stuff"\n` +
            `.\n`,
        )
    })
})
