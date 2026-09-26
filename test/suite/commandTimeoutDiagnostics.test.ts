import * as assert from "assert";
import { CommandTimeoutDiagnostics } from "../../gsl/commandTimeoutDiagnostics";
import { OutputProcessor } from "../../gsl/editorClient";

suite("Command timeout diagnostics", () => {
    function finish(
        diagnostics: CommandTimeoutDiagnostics,
        pending = "",
        seenStart = false,
    ) {
        const error = diagnostics.timeoutError({
            command: "/ss 24049 GS4D raw",
            worker: "GS4D/TestWorker",
            seenStart,
            pending,
        });
        return JSON.parse(error.message.split("\nDiagnostics: ")[1]);
    }

    test("reports missing start marker and unfinished output", () => {
        const diagnostics = new CommandTimeoutDiagnostics([]);
        diagnostics.record("Unexpected server response");
        const details = finish(diagnostics, "unfinished");
        assert.strictEqual(details.worker, "GS4D/TestWorker");
        assert.strictEqual(details.seenStart, false);
        assert.strictEqual(details.pendingLine, true);
        assert.strictEqual(
            details.responseTail,
            "Unexpected server response\nunfinished",
        );
    });

    test("reports no response separately from a missing end marker", () => {
        const diagnostics = new CommandTimeoutDiagnostics([]);
        assert.strictEqual(finish(diagnostics).responseTail, "");
        diagnostics.record("Game: GS4D");
        assert.strictEqual(finish(diagnostics, "", true).seenStart, true);
    });

    test("retains at most 20 lines and 4096 characters including pending text", () => {
        const diagnostics = new CommandTimeoutDiagnostics([]);
        for (let i = 0; i < 100; i++) diagnostics.record(`line ${i}`);
        let details = finish(diagnostics);
        assert.strictEqual(details.responseTail.split("\n").length, 20);
        assert.ok(details.responseTail.startsWith("line 80\n"));
        assert.strictEqual(details.truncated, true);
        details = finish(diagnostics, "x".repeat(100000));
        assert.strictEqual(details.responseTail, "x".repeat(4096));
    });

    test("redacts secrets split across chunks and interrupted by timeout", () => {
        const diagnostics = new CommandTimeoutDiagnostics([
            "test-account",
            "secret-password",
        ]);
        const output = new OutputProcessor((line) => diagnostics.record(line));
        output.accumulate("test-account secret-pass");
        output.accumulate("word\r\nsecret-pass");
        const details = finish(diagnostics, output.peek());
        assert.strictEqual(
            details.responseTail,
            "[REDACTED] [REDACTED]\n[REDACTED]",
        );
    });

    test("redacts before truncation and escapes control characters", () => {
        const diagnostics = new CommandTimeoutDiagnostics([
            "private-account",
            "private-password",
        ]);
        diagnostics.record("private-password" + "x".repeat(4090));
        const error = diagnostics.timeoutError({
            command: "private-password\ncommand",
            worker: "private-account\x1b[31m",
            seenStart: false,
            pending: "",
        });
        assert.ok(!error.message.includes("private-password"));
        assert.ok(!error.message.includes("private-account"));
        assert.ok(!error.message.includes("\x1b"));
        assert.ok(!error.message.includes("password"));
    });
});
