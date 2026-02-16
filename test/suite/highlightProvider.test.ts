import * as assert from "assert";
import * as vscode from "vscode";
import { GSLDocumentHighlightProvider } from "../../gsl/highlightProvider";

suite("Highlight Provider Test Suite", () => {
    const provider = new GSLDocumentHighlightProvider();

    /**
     * Compares input with expected output. Expects a `|` character to be in the input,
     * indicating the user's cursor location. Output will contain `----` characters to
     * indicate the ranges highlighted by vscode.
     */
    async function testHighlights(
        input: string,
        expectedOutput: string,
    ): Promise<void> {
        // Find cursor position marked with | and remove it
        const lines = input.split("\n");
        let cursorLine = 0;
        let cursorChar = 0;
        let cleanedInput = "";

        for (let i = 0; i < lines.length; i++) {
            const pipeIndex = lines[i].indexOf("|");
            if (pipeIndex >= 0) {
                cursorLine = i;
                cursorChar = pipeIndex;
                lines[i] =
                    lines[i].substring(0, pipeIndex) +
                    lines[i].substring(pipeIndex + 1);
            }

            if (i > 0) cleanedInput += "\n";
            cleanedInput += lines[i];
        }

        const document = await vscode.workspace.openTextDocument({
            language: "gsl",
            content: cleanedInput,
        });

        const position = new vscode.Position(cursorLine, cursorChar);
        const highlights = await provider.provideDocumentHighlights(
            document,
            position,
        );

        assert.ok(highlights, "Highlights should not be undefined");

        // Create a marked string from the input based on the actual highlights
        const resultLines = cleanedInput.split("\n");
        const markedLines: string[] = [];

        // Process each line
        for (let i = 0; i < resultLines.length; i++) {
            let line = resultLines[i];

            // Get all highlights for this line and sort them from right to left
            // to avoid messing up character positions when adding markers
            const lineHighlights = highlights
                .filter((h) => h.range.start.line === i)
                .sort(
                    (a, b) => b.range.start.character - a.range.start.character,
                );

            // Track already processed character positions to avoid duplicate highlighting
            const processedRanges: [number, number][] = [];

            // Process each highlight for this line
            for (const highlight of lineHighlights) {
                const start = highlight.range.start.character;
                const end = highlight.range.end.character;

                // Skip if this range overlaps with an already processed range
                if (
                    processedRanges.some(
                        ([s, e]) =>
                            (start >= s && start < e) ||
                            (end > s && end <= e) ||
                            (start <= s && end >= e),
                    )
                ) {
                    continue;
                }

                // Add this range to processed ranges
                processedRanges.push([start, end]);

                // Add highlight markers
                const text = document.getText(highlight.range);
                line =
                    line.substring(0, start) +
                    "----" +
                    text +
                    "----" +
                    line.substring(end);
            }

            markedLines.push(line);
        }

        const actual = markedLines.join("\n");

        // Compare with expected
        assert.strictEqual(actual, expectedOutput);
    }

    test("Should highlight standalone word", async () => {
        await testHighlights(
            `ms|gp "hello world"\n`,
            // Expects:
            `----msgp---- "hello world"\n`,
        );
    });

    test("Should highlight matching push/pop", async () => {
        await testHighlights(
            `p|ush\n` + `  msgp "inside push"\n` + `pop\n`,
            // Expects:
            `----push----\n` + `  msgp "inside push"\n` + `----pop----\n`,
        );
    });

    test("Should highlight matching push/pop (reverse)", async () => {
        await testHighlights(
            `push\n` + `  msgp "inside push"\n` + `p|op\n`,
            // Expects:
            `----push----\n` + `  msgp "inside push"\n` + `----pop----\n`,
        );
    });

    test("Should highlight matching fastpush/fastpop", async () => {
        await testHighlights(
            `|fastpush\n` + `  msgp "inside fastpush"\n` + `fastpop\n`,
            // Expects:
            `----fastpush----\n` +
                `  msgp "inside fastpush"\n` +
                `----fastpop----\n`,
        );
    });

    test("Should highlight matching fastpush/fastpop (reverse)", async () => {
        await testHighlights(
            `fastpush\n` + `  msgp "inside fastpush"\n` + `|fastpop\n`,
            // Expects:
            `----fastpush----\n` +
                `  msgp "inside fastpush"\n` +
                `----fastpop----\n`,
        );
    });

    test("Should highlight matching fastpush/fastpop (reverse)", async () => {
        await testHighlights(
            `fastpush\n` + `  msgp "inside fastpush"\n` + `|fastpop\n`,
            // Expects:
            `----fastpush----\n` +
                `  msgp "inside fastpush"\n` +
                `----fastpop----\n`,
        );
    });

    test("Should highlight matching block start/end", async () => {
        await testHighlights(
            `|if A8 then\n` + `  msgp "then branch"\n` + `.\n`,
            // Expects:
            `----if---- A8 ----then----\n` +
                `  msgp "then branch"\n` +
                `----.----\n`,
        );
    });

    test("Should highlight matching block start/end (reverse)", async () => {
        await testHighlights(
            `if A8 then\n` + `  msgp "then branch"\n` + `.|\n`,
            // Expects:
            `----if---- A8 ----then----\n` +
                `  msgp "then branch"\n` +
                `----.----\n`,
        );
    });

    test("Should highlight nested blocks correctly", async () => {
        await testHighlights(
            `if A8 then\n` +
                `  |if B9 then\n` +
                `    msgp "nested"\n` +
                `  .\n` +
                `.\n`,
            // Expects:
            `if A8 then\n` +
                `  ----if---- B9 ----then----\n` +
                `    msgp "nested"\n` +
                `  ----.----\n` +
                `.\n`,
        );
    });

    test("Should highlight nested blocks correctly (reverse)", async () => {
        await testHighlights(
            `if A8 then\n` +
                `  if B9 then\n` +
                `    msgp "nested"\n` +
                `  .|\n` +
                `.\n`,
            // Expects:
            `if A8 then\n` +
                `  ----if---- B9 ----then----\n` +
                `    msgp "nested"\n` +
                `  ----.----\n` +
                `.\n`,
        );
    });

    test("Should handle early fastpop stop", async () => {
        await testHighlights(
            `|fastpush\n` +
                `  if B9 then\n` +
                `    fastpop\n` +
                `    stop\n` +
                `  .\n` +
                `fastpop\n`,
            // Expects:
            `----fastpush----\n` +
                `  if B9 then\n` +
                `    ----fastpop----\n` +
                `    stop\n` +
                `  .\n` +
                `----fastpop----\n`,
        );
    });

    test("Should handle early fastpop stop (middle)", async () => {
        await testHighlights(
            `fastpush\n` +
                `  if B9 then\n` +
                `    |fastpop\n` +
                `    stop\n` +
                `  .\n` +
                `fastpop\n`,
            // Expects:
            `----fastpush----\n` +
                `  if B9 then\n` +
                `    ----fastpop----\n` +
                `    stop\n` +
                `  .\n` +
                `fastpop\n`,
        );
    });

    test("Should handle early fastpop stop (reverse)", async () => {
        await testHighlights(
            `fastpush\n` +
                `  if B9 then\n` +
                `    fastpop\n` +
                `    stop\n` +
                `  .\n` +
                `|fastpop\n`,
            // Expects:
            `----fastpush----\n` +
                `  if B9 then\n` +
                `    fastpop\n` +
                `    stop\n` +
                `  .\n` +
                `----fastpop----\n`,
        );
    });

    test("Should handle nested early fastpop stop", async () => {
        await testHighlights(
            `fastpush\n` +
                `  |fastpush\n` +
                `    if B9 then\n` +
                `      fastpop\n` +
                `      stop\n` +
                `    .\n` +
                `  fastpop\n` +
                `fastpop\n`,
            // Expects:
            `fastpush\n` +
                `  ----fastpush----\n` +
                `    if B9 then\n` +
                `      ----fastpop----\n` +
                `      stop\n` +
                `    .\n` +
                `  ----fastpop----\n` +
                `fastpop\n`,
        );
    });

    test("Should handle nested early fastpop stop (reverse)", async () => {
        await testHighlights(
            `fastpush\n` +
                `  fastpush\n` +
                `    if B9 then\n` +
                `      fastpop\n` +
                `      stop\n` +
                `    .\n` +
                `  |fastpop\n` +
                `fastpop\n`,
            // Expects:
            `fastpush\n` +
                `  ----fastpush----\n` +
                `    if B9 then\n` +
                `      fastpop\n` +
                `      stop\n` +
                `    .\n` +
                `  ----fastpop----\n` +
                `fastpop\n`,
        );
    });

    test("Should ignore comments containing code", async () => {
        await testHighlights(
            `p|ush\n` + `  ! pop\n` + `pop\n`,
            // Expects:
            `----push----\n` + `  ! pop\n` + `----pop----\n`,
        );
    });

    test("Should ignore comments containing code (reverse)", async () => {
        await testHighlights(
            `push\n` + `  ! push\n` + `p|op\n`,
            // Expects:
            `----push----\n` + `  ! push\n` + `----pop----\n`,
        );
    });

    test("Should ignore strings containing code", async () => {
        await testHighlights(
            `p|ush\n` + `  msgp "pop goes the weasel."\n` + `pop\n`,
            // Expects:
            `----push----\n` +
                `  msgp "pop goes the weasel."\n` +
                `----pop----\n`,
        );
    });

    test("Should ignore strings containing code (reverse)", async () => {
        await testHighlights(
            `push\n` + `  msgp "push goes the weasel."\n` + `p|op\n`,
            // Expects:
            `----push----\n` +
                `  msgp "push goes the weasel."\n` +
                `----pop----\n`,
        );
    });

    test("Should gracefully fail with broken pairs", async () => {
        await testHighlights(
            `p|ush\n` + `  msgp "inside broken code"\n` + `fastpop\n`,
            // Expects:
            `----push----\n` + `  msgp "inside broken code"\n` + `fastpop\n`,
        );
    });

    test("Should gracefully fail with broken pairs (reverse)", async () => {
        await testHighlights(
            `push\n` + `  msgp "inside broken code"\n` + `|fastpop\n`,
            // Expects:
            `push\n` + `  msgp "inside broken code"\n` + `----fastpop----\n`,
        );
    });

    test("Should highlight related else statements", async () => {
        await testHighlights(
            `|if A1 then\n` +
                `  fastpop\n` +
                `  stop\n` +
                `else_ifnot A8 then\n` +
                `  msgp "foo"\n` +
                `else_if A8 then\n` +
                `  msgp "hm"\n` +
                `else\n` +
                `  msgp "hmmm"\n` +
                `.\n`,
            // Expects:
            `----if---- A1 ----then----\n` +
                `  fastpop\n` +
                `  stop\n` +
                `----else_ifnot---- A8 ----then----\n` +
                `  msgp "foo"\n` +
                `----else_if---- A8 ----then----\n` +
                `  msgp "hm"\n` +
                `----else----\n` +
                `  msgp "hmmm"\n` +
                `----.----\n`,
        );
    });

    test("Should highlight related else statements (reverse)", async () => {
        await testHighlights(
            `if A1 then\n` +
                `  fastpop\n` +
                `  stop\n` +
                `else_ifnot A8 then\n` +
                `  msgp "foo"\n` +
                `else_if A8 then\n` +
                `  msgp "hm"\n` +
                `else\n` +
                `  msgp "hmmm"\n` +
                `.|\n`,
            // Expects:
            `----if---- A1 ----then----\n` +
                `  fastpop\n` +
                `  stop\n` +
                `----else_ifnot---- A8 ----then----\n` +
                `  msgp "foo"\n` +
                `----else_if---- A8 ----then----\n` +
                `  msgp "hm"\n` +
                `----else----\n` +
                `  msgp "hmmm"\n` +
                `----.----\n`,
        );
    });

    test("Should highlight matching MM start/end", async () => {
        await testHighlights(
            `: "$FOO_BAR|"\n` + `  msgp "inside"\n` + `.\n`,
            // Expects:
            `----\: "$FOO_BAR"----\n` + `  msgp "inside"\n` + `----\.----\n`,
        );
    });

    test("Should highlight matching MM start/end (reverse)", async () => {
        await testHighlights(
            `: "$FOO_BAR"\n` + `  msgp "inside"\n` + `|.\n`,
            // Expects:
            `----\: "$FOO_BAR"----\n` + `  msgp "inside"\n` + `----\.----\n`,
        );
    });

    test("Should handle nested push/pop (outer cursor)", async () => {
        await testHighlights(
            `|push\n` + `  push\n` + `  pop\n` + `pop\n`,
            // Expects:
            `----push----\n` + `  push\n` + `  pop\n` + `----pop----\n`,
        );
    });

    test("Should handle nested push/pop (outer cursor; reverse)", async () => {
        await testHighlights(
            `push\n` + `  push\n` + `  pop\n` + `|pop\n`,
            // Expects:
            `----push----\n` + `  push\n` + `  pop\n` + `----pop----\n`,
        );
    });

    test("Should handle nested push/pop (inner cursor)", async () => {
        await testHighlights(
            `push\n` + `  |push\n` + `  pop\n` + `pop\n`,
            // Expects:
            `push\n` + `  ----push----\n` + `  ----pop----\n` + `pop\n`,
        );
    });

    test("Should handle nested push/pop (inner cursor; reverse)", async () => {
        await testHighlights(
            `push\n` + `  push\n` + `  |pop\n` + `pop\n`,
            // Expects:
            `push\n` + `  ----push----\n` + `  ----pop----\n` + `pop\n`,
        );
    });

    test("Should handle nested push/pop in if block", async () => {
        await testHighlights(
            `p|ush\n` +
                `  if A8 then\n` +
                `    push\n` +
                `    pop\n` +
                `  .\n` +
                `pop\n`,
            // Expects:
            `----push----\n` +
                `  if A8 then\n` +
                `    push\n` +
                `    pop\n` +
                `  .\n` +
                `----pop----\n`,
        );
    });

    test("Should handle nested push/pop in if block (reverse)", async () => {
        await testHighlights(
            `push\n` +
                `  if A8 then\n` +
                `    push\n` +
                `    pop\n` +
                `  .\n` +
                `p|op\n`,
            // Expects:
            `----push----\n` +
                `  if A8 then\n` +
                `    push\n` +
                `    pop\n` +
                `  .\n` +
                `----pop----\n`,
        );
    });

    test("Should handle nested if/else case", async () => {
        await testHighlights(
            `|if A8 then\n` +
                `else\n` +
                `  if A9 then\n` +
                `  else\n` +
                `  .\n` +
                `.\n`,
            // Expects:
            `----if---- A8 ----then----\n` +
                `----else----\n` +
                `  if A9 then\n` +
                `  else\n` +
                `  .\n` +
                `----.----\n`,
        );
    });

    test("Should highlight corresponding IS/DEFAULT on WHEN", async () => {
        await testHighlights(
            `|when A8\n` +
                `  is 8\n` +
                `  .\n` +
                `  default\n` +
                `  .\n` +
                `.\n`,
            // Expects:
            `----when---- A8\n` +
                `  ----is---- 8\n` +
                `  ----.----\n` +
                `  ----default----\n` +
                `  ----.----\n` +
                `----.----\n`,
        );
    });

    test("Should highlight corresponding IS/DEFAULT on WHEN (cursor at end of default)", async () => {
        await testHighlights(
            `when A8\n` +
                `  is 8\n` +
                `  .\n` +
                `  default\n` +
                `  .|\n` +
                `.\n`,
            // Expects:
            `----when---- A8\n` +
                `  ----is---- 8\n` +
                `  ----.----\n` +
                `  ----default----\n` +
                `  ----.----\n` +
                `----.----\n`,
        );
    });

    test("Should handle IS as if cursor was next to corresponding WHEN", async () => {
        await testHighlights(
            `when A8\n` + `  |is 8\n` + `  .\n` + `.\n`,
            // Expects:
            `----when---- A8\n` +
                `  ----is---- 8\n` +
                `  ----.----\n` +
                `----.----\n`,
        );
    });

    test("Should handle nested WHEN", async () => {
        await testHighlights(
            `|when A8\n` +
                `  is 8\n` +
                `    when A9\n` +
                `      is 9\n` +
                `      .\n` +
                `      default\n` +
                `      .\n` +
                `    .\n` +
                `  .\n` +
                `  default\n` +
                `  .\n` +
                `.\n`,
            // Expects:
            `----when---- A8\n` +
                `  ----is---- 8\n` +
                `    when A9\n` +
                `      is 9\n` +
                `      .\n` +
                `      default\n` +
                `      .\n` +
                `    .\n` +
                `  ----.----\n` +
                `  ----default----\n` +
                `  ----.----\n` +
                `----.----\n`,
        );
    });

    test("Should handle nested WHEN (reverse)", async () => {
        await testHighlights(
            `when A8\n` +
                `  is 8\n` +
                `    when A9\n` +
                `      is 9\n` +
                `      .\n` +
                `      default\n` +
                `      .\n` +
                `    .\n` +
                `  .\n` +
                `  default\n` +
                `  .\n` +
                `|.\n`,
            // Expects:
            `----when---- A8\n` +
                `  ----is---- 8\n` +
                `    when A9\n` +
                `      is 9\n` +
                `      .\n` +
                `      default\n` +
                `      .\n` +
                `    .\n` +
                `  ----.----\n` +
                `  ----default----\n` +
                `  ----.----\n` +
                `----.----\n`,
        );
    });

    test("Should highlight object tokens", async () => {
        await testHighlights(
            `set |NO1 to NO2\n` + `msgp "$O1N"`,
            // Expects:
            `set ----NO1---- to NO2\n` + `msgp "----$O1N----"`,
        );
    });

    test("Should highlight object tokens (reverse)", async () => {
        await testHighlights(
            `set NO1 to NO2\n` + `msgp "$|O1N"`,
            // Expects:
            `set ----NO1---- to NO2\n` + `msgp "----$O1N----"`,
        );
    });

    test("Should highlight player tokens", async () => {
        await testHighlights(
            `set |NP1 to NP2\n` + `msgp "$P1N"`,
            // Expects:
            `set ----NP1---- to NP2\n` + `msgp "----$P1N----"`,
        );
    });

    test("Should highlight player tokens (reverse)", async () => {
        await testHighlights(
            `set NP1 to NP2\n` + `msgp "$|P1N"`,
            // Expects:
            `set ----NP1---- to NP2\n` + `msgp "----$P1N----"`,
        );
    });

    test("Should highlight creature tokens", async () => {
        await testHighlights(
            `set |NC1 to NC2\n` + `msgp "$C1N"`,
            // Expects:
            `set ----NC1---- to NC2\n` + `msgp "----$C1N----"`,
        );
    });

    test("Should highlight creature tokens (reverse)", async () => {
        await testHighlights(
            `set NC1 to NC2\n` + `msgp "$|C1N"`,
            // Expects:
            `set ----NC1---- to NC2\n` + `msgp "----$C1N----"`,
        );
    });

    test("Should highlight event tokens", async () => {
        await testHighlights(
            `set |NE1 to NE2\n` + `msgp "$E1N"`,
            // Expects:
            `set ----NE1---- to NE2\n` + `msgp "----$E1N----"`,
        );
    });

    test("Should highlight event tokens (reverse)", async () => {
        await testHighlights(
            `set NE1 to NE2\n` + `msgp "$|E1N"`,
            // Expects:
            `set ----NE1---- to NE2\n` + `msgp "----$E1N----"`,
        );
    });

    test("Should highlight room tokens", async () => {
        await testHighlights(
            `set |NR1 to NR2\n` + `msgp "$r1"`,
            // Expects:
            `set ----NR1---- to NR2\n` + `msgp "----$r1----"`,
        );
    });

    test("Should highlight room tokens (reverse)", async () => {
        await testHighlights(
            `set NR1 to NR2\n` + `msgp "|$r1"`,
            // Expects:
            `set ----NR1---- to NR2\n` + `msgp "----$r1----"`,
        );
    });

    test("Should highlight x tokens for player", async () => {
        await testHighlights(
            `set NC1 to NC2\n` + `set |NP1 to NP2\n` + `msgp "$X1"`,
            // Expects:
            `set NC1 to NC2\n` +
                `set ----NP1---- to NP2\n` +
                `msgp "----$X1----"`,
        );
    });

    test("Should highlight x tokens for creature", async () => {
        await testHighlights(
            `set |NC1 to NC2\n` + `set NP1 to NP2\n` + `msgp "$X1"`,
            // Expects:
            `set ----NC1---- to NC2\n` +
                `set NP1 to NP2\n` +
                `msgp "----$X1----"`,
        );
    });

    test("Should highlight player/creature tokens for x token", async () => {
        await testHighlights(
            `set NC1 to NC2\n` + `set NP1 to NP2\n` + `msgp "$|X1"`,
            // Expects:
            `set ----NC1---- to NC2\n` +
                `set ----NP1---- to NP2\n` +
                `msgp "----$X1----"`,
        );
    });

    test("Should highlight A register in string", async () => {
        await testHighlights(
            `set |A1 to 3\n` + `msgp "$A1"`,
            // Expects:
            `set ----A1---- to 3\n` + `msgp "$----A1----"`,
        );
    });

    test("Should highlight A register in string (reverse)", async () => {
        await testHighlights(
            `set A1 to 3\n` + `msgp "$|A1"`,
            // Expects:
            `set ----A1---- to 3\n` + `msgp "$----A1----"`,
        );
    });
});
