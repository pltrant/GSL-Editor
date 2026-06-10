import * as assert from "assert";
import { OutputProcessor } from "../../gsl/editorClient";

suite("OutputProcessor", () => {
    function collect(): { lines: string[]; output: OutputProcessor } {
        const lines: string[] = [];
        const output = new OutputProcessor((line) => lines.push(line));
        return { lines, output };
    }

    test("splits buffered text into lines", () => {
        const { lines, output } = collect();
        output.accumulate("one\r\ntwo\r\npartial");
        assert.deepStrictEqual(lines, ["one", "two"]);
        output.accumulate(" line\r\n");
        assert.deepStrictEqual(lines, ["one", "two", "partial line"]);
    });

    test("strips ANSI escape sequences from emitted lines", () => {
        const { lines, output } = collect();
        output.accumulate(
            "\x1b[0m<<<beginning of output>>>\r\n" +
                "\x1b[1;32mgreen\x1b[0m text\r\n" +
                "plain\r\n",
        );
        assert.deepStrictEqual(lines, [
            "<<<beginning of output>>>",
            "green text",
            "plain",
        ]);
    });

    test("strips OSC and single-character escape sequences", () => {
        const { lines, output } = collect();
        output.accumulate(
            "\x1b]0;window title\x07<<<beginning of output>>>\r\n" +
                "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ text\r\n" +
                "\x1b=keypad mode\r\n",
        );
        assert.deepStrictEqual(lines, [
            "<<<beginning of output>>>",
            "link text",
            "keypad mode",
        ]);
    });

    test("strips ANSI escape sequences split across chunks", () => {
        const { lines, output } = collect();
        output.accumulate("\x1b[");
        output.accumulate("0mShowing room #100\r\n");
        assert.deepStrictEqual(lines, ["Showing room #100"]);
    });
});
