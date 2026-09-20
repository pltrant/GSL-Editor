import * as assert from "assert";
import { BaseGameClient } from "../../gsl/gameClients";
import {
    executeRolloutCommand,
    parseRolloutInput,
    rolloutCommand,
} from "../../gsl/rollout";

class FakeClient extends BaseGameClient {
    sent: string[] = [];
    constructor() {
        super({});
    }
    send(command: string) {
        this.sent.push(command);
    }
    output(text: string) {
        this.emit("text", text);
    }
}

suite("Rollout", () => {
    test("parses download-style expressions in order and deduplicates", () => {
        assert.deepStrictEqual(
            parseRolloutInput(
                "29, incant; s07890.gsl 9800-9802 29 INCANT /mongen",
            ),
            [
                { kind: "script", id: "29" },
                { kind: "verb", id: "incant" },
                { kind: "script", id: "7890" },
                { kind: "script", id: "9800" },
                { kind: "script", id: "9801" },
                { kind: "script", id: "9802" },
                { kind: "verb", id: "/mongen" },
            ],
        );
        for (const value of [
            "",
            "0",
            "12-9",
            "1-999999",
            "12.5",
            "29\x00",
            "incant!",
            "abcdefgh",
            "/abcdefg",
            "1e3",
            "12-13-14",
        ]) {
            assert.throws(() => parseRolloutInput(value), value);
        }
        assert.strictEqual(
            rolloutCommand("deploy", { kind: "verb", id: "incant" }),
            "/deploy verb incant confirm",
        );
    });

    test("deploy waits for success, including fragmented output", async () => {
        const client = new FakeClient();
        let done = false;
        const result = executeRolloutCommand(
            client,
            "deploy",
            { kind: "script", id: "29" },
            undefined,
            new AbortController().signal,
        ).then((id) => {
            done = true;
            return id;
        });
        assert.deepStrictEqual(client.sent, ["/deploy script 29 confirm"]);
        client.output("GN>Got the command /deploy script 29.\r\n>");
        await Promise.resolve();
        assert.strictEqual(done, false);
        client.output("Deploy results: 0[All ");
        client.output("done]\r\n");
        assert.strictEqual(await result, 29);
        assert.strictEqual(client.listenerCount("text"), 0);
    });

    test("verb deployment captures script ID for matching rollin completion", async () => {
        const client = new FakeClient();
        const item = { kind: "verb" as const, id: "incant" };
        const deploy = executeRolloutCommand(
            client,
            "deploy",
            item,
            undefined,
            new AbortController().signal,
        );
        client.output(
            "Got the command /deploy verb 12345.\r\nDeploy results: 0[]\r\n",
        );
        const id = await deploy;
        let done = false;
        const rollin = executeRolloutCommand(
            client,
            "rollin",
            item,
            id,
            new AbortController().signal,
        ).then(() => {
            done = true;
        });
        client.output("Roll in of script #12345 is completed.\r\n");
        client.output(
            "Got the command /rollin verb incant.\r\nRoll in of script #999 is completed.\r\n",
        );
        await Promise.resolve();
        assert.strictEqual(done, false);
        client.output("Roll in of script #12345 is completed.\r\n");
        await rollin;
    });

    test("stops on deploy failure and script callback blocks", async () => {
        for (const response of [
            "Deploy results: 5[failed]",
            "Deploy results: -1[Failed to compile script\n]",
            "Deploying script 29 was blocked by the script 1 callback ($BREAK=1).",
            "Missing confirm.",
        ]) {
            const client = new FakeClient();
            const result = executeRolloutCommand(
                client,
                "deploy",
                { kind: "script", id: "29" },
                undefined,
                new AbortController().signal,
            );
            client.output(response + "\r\n");
            await assert.rejects(result, { name: "RolloutCommandError" });
            assert.strictEqual(client.listenerCount("text"), 0);
        }
    });

    test("stops on missing deployed verb or blocked rollin", async () => {
        for (const response of [
            "Got the command /rollin verb incant but I could not find a deployed version of it.",
            "Rollin failed: missing file",
            "Verb incant(29) roll in was blocked at the last minute ($BREAK=1, $T0=blocked).",
            "Could not roll in the verb incant.",
        ]) {
            const client = new FakeClient();
            const result = executeRolloutCommand(
                client,
                "rollin",
                { kind: "verb", id: "incant" },
                29,
                new AbortController().signal,
            );
            client.output(response + "\r\n");
            await assert.rejects(result);
        }
    });

    test("cancellation before send dispatches nothing", async () => {
        const client = new FakeClient();
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(
            executeRolloutCommand(
                client,
                "deploy",
                { kind: "script", id: "29" },
                undefined,
                abort.signal,
            ),
        );
        assert.deepStrictEqual(client.sent, []);
    });

    test("cancellation, disconnect, and timeout never retry commands", async () => {
        for (const reason of ["cancel", "quit", "error", "timeout"]) {
            const client = new FakeClient();
            const abort = new AbortController();
            const result = executeRolloutCommand(
                client,
                "deploy",
                { kind: "script", id: "29" },
                undefined,
                abort.signal,
                10,
            );
            if (reason === "cancel") abort.abort();
            if (reason === "quit") client.emit("quit");
            if (reason === "error")
                client.emit("error", new Error("lost socket"));
            await assert.rejects(result, {
                name: "RolloutOutcomeUnknownError",
            });
            // Reusing this client must not send another mutation or consume
            // the previous deployment's delayed result as a new success.
            const next = executeRolloutCommand(
                client,
                "deploy",
                { kind: "script", id: "30" },
                undefined,
                new AbortController().signal,
            );
            client.output(
                "Got the command /deploy script 30.\r\nDeploy results: 0[]\r\n",
            );
            await assert.rejects(next, { name: "RolloutOutcomeUnknownError" });
            assert.strictEqual(client.sent.length, 1);
            assert.strictEqual(client.listenerCount("text"), 0);
            assert.strictEqual(client.listenerCount("error"), 0);
        }
    });
});
