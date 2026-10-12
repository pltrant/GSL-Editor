import * as assert from "assert";
import {
    CommandScriptErrorDetector,
    agentScriptErrorPatterns,
    commandScriptError,
} from "../../gsl/commandScriptError";
import {
    OutputProcessor,
    shouldResetClient,
    stripGamePrompt,
} from "../../gsl/editorClient";

const AGENT_ERROR = agentScriptErrorPatterns("/agent /staff");

function traceback(command: string): string {
    return [
        "GM-[SCR*ERR](Current Script: 16425. Called by: -1) at line 117.",
        "---->  0.) 16425. P_Stack in=0, P-Stack out=?, called from line 117 in script #-1. (MATCH=NOMATCHSET)",
        "End of traceback.",
        "Push/pop stack trace:",
        "       0.) Pushed S   -1:Ln 117; Popped S   -1:Ln 117.",
        "End of push/pop trace.",
        "Key variables:",
        ` ${command
            .split(" ")
            .map((word, i) => `S${i}[${word}]`)
            .join(" ")}`,
        "$ERROR=256, $BREAK=0",
        "Last matched $MATCH marker: [NOMATCHSET]",
        "This call sequence was triggered by a(n) player command.",
        ">",
    ].join("\r\n");
}

suite("Command script errors", () => {
    function collect(text: string): string[] | undefined {
        const detector = new CommandScriptErrorDetector(AGENT_ERROR);
        let report: string[] | undefined;
        new OutputProcessor((line) => {
            report ??= detector.record(stripGamePrompt(line));
        }).accumulate(text);
        return report;
    }

    test("reports this command's traceback once it completes", () => {
        const report = collect(
            ">\r\n<<<beginning of output>>>\r\npartial row\r\n" +
                traceback("/agent /staff"),
        );
        assert.ok(report);
        assert.ok(report.includes("partial row"));
        assert.ok(
            report.some((line) => line.includes("Current Script: 16425")),
        );
        assert.ok(report.some((line) => line.includes("(MATCH=NOMATCHSET)")));
        assert.ok(report.includes("$ERROR=256, $BREAK=0"));
        assert.strictEqual(
            report.at(-1),
            "This call sequence was triggered by a(n) player command.",
        );
    });

    test("waits for the end of the traceback", () => {
        const detector = new CommandScriptErrorDetector(AGENT_ERROR);
        for (const line of traceback("/agent /staff").split("\r\n")) {
            const report = detector.record(line);
            if (line.startsWith("This call sequence")) assert.ok(report);
            else assert.strictEqual(report, undefined);
        }
    });

    test("ignores and discards other commands' tracebacks", () => {
        const detector = new CommandScriptErrorDetector(AGENT_ERROR);
        const record = (text: string) =>
            text.split("\r\n").map((line) => detector.record(line));
        assert.ok(record(traceback("look")).every((r) => r === undefined));
        assert.ok(
            record(traceback("/agent /other")).every((r) => r === undefined),
        );
        // Text that only mentions the end marker mid-line is not an error.
        assert.strictEqual(
            detector.record("see This call sequence was triggered by"),
            undefined,
        );
        const report = record(traceback("/agent /staff")).find(Boolean);
        assert.ok(report);
        assert.ok(!report.some((line) => line.includes("S0[look]")));
    });

    test("retains the most recent 60 lines", () => {
        const detector = new CommandScriptErrorDetector(AGENT_ERROR);
        for (let i = 0; i < 100; i++) detector.record(`line ${i}`);
        const report = traceback("/agent /staff")
            .split("\r\n")
            .map((line) => detector.record(line))
            .find(Boolean);
        assert.ok(report);
        assert.strictEqual(report.length, 60);
        assert.strictEqual(report[0], "line 51");
    });

    test("keeps the connection for errors after the start marker", () => {
        const error = commandScriptError(
            "/agent /staff",
            ["End of traceback.", "$ERROR=256, $BREAK=0"],
            { seenStart: true },
        );
        assert.strictEqual(error.name, "CommandScriptError");
        assert.strictEqual(shouldResetClient(error), false);
        assert.strictEqual(
            error.message,
            'Command "/agent /staff" failed with a script error:\n' +
                "End of traceback.\n$ERROR=256, $BREAK=0",
        );
    });

    test("resets the connection for errors before the start marker", () => {
        const error = commandScriptError("/agent /staff", [], {
            seenStart: false,
        });
        assert.strictEqual(error.name, "UnconfirmedScriptError");
        assert.strictEqual(shouldResetClient(error), true);
    });

    test("agent patterns match only this command's key variables", () => {
        const { end, owner } = agentScriptErrorPatterns(
            " /agent  /staff list ",
        );
        assert.ok(
            end.test(
                "This call sequence was triggered by a(n) player command.",
            ),
        );
        assert.ok(!end.test("see This call sequence was triggered by"));
        assert.ok(owner.test(" S0[/agent] S1[/staff] S2[list]"));
        assert.ok(owner.test(" S0[/AGENT] S1[/staff] S2[list]"));
        assert.ok(!owner.test(" S0[/agent] S1[/staff]"));
        assert.ok(!owner.test(" S0[/agent] S1[/staff] S2[list] S3[x]"));
        assert.ok(!owner.test(" S0[look] S1[/agent]"));
        assert.ok(
            agentScriptErrorPatterns("/agent $x=1 a.b [1]").owner.test(
                " S0[/agent] S1[$x=1] S2[a.b] S3[[1]]",
            ),
        );
    });
});
