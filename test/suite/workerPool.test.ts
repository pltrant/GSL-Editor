import * as assert from "assert";
import {
    AgentToolOrchestrator,
    LoginCredentials,
} from "../../gsl/agentToolOrchestrator";
import {
    ClientTask,
    EditorClientInterface,
    InitOptions,
    ScriptCompileResults,
} from "../../gsl/editorClient";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const first: LoginCredentials = {
    account: "test",
    instance: "GS4D",
    character: "First",
    password: "test",
};
const second = { ...first, character: "Second" };

function orchestrator(
    credentials: LoginCredentials | LoginCredentials[],
    run: <T>(
        key: string,
        options: InitOptions,
        task: ClientTask<T>,
    ) => Promise<T>,
) {
    return new AgentToolOrchestrator(
        {
            getCredentials: async () => credentials,
            getCurrentAuthor: () => "Test/Author",
            downloadLocation: "/tmp",
            console: { log: () => {} },
        },
        run,
    );
}

suite("MCP character worker pool", () => {
    test("two workers run concurrently; a waiting request takes the first free worker", async () => {
        const gates = [
            deferred<string[]>(),
            deferred<string[]>(),
            deferred<string[]>(),
        ];
        const assignments: string[] = [];
        const keys: string[] = [];
        const orch = orchestrator(
            [first, second],
            async <T>(
                key: string,
                options: InitOptions,
                task: ClientTask<T>,
            ) => {
                const index = assignments.length;
                assignments.push(options.login.character);
                keys.push(key);
                return task({
                    executeCommand: () => gates[index].promise,
                } as unknown as EditorClientInterface);
            },
        );
        const requests = [
            orch.getVerbData("one"),
            orch.getVerbData("two"),
            orch.getVerbData("three"),
        ];
        await tick();
        assert.deepStrictEqual(assignments, ["First", "Second"]);
        assert.notStrictEqual(keys[0], keys[1]);
        gates[1].resolve(["two"]);
        assert.strictEqual(await requests[1], "two");
        await tick();
        assert.deepStrictEqual(assignments, ["First", "Second", "Second"]);
        assert.strictEqual(keys[1], keys[2]);
        gates[2].resolve(["three"]);
        gates[0].resolve(["one"]);
        assert.deepStrictEqual(await Promise.all(requests), [
            "one",
            "two",
            "three",
        ]);
    });

    test("a failed worker task releases its character to the next request", async () => {
        const gate = deferred<string[]>();
        let calls = 0;
        const orch = orchestrator(
            [first, { ...first, character: "FIRST" }],
            async <T>(
                _key: string,
                _options: InitOptions,
                task: ClientTask<T>,
            ) => {
                const index = calls++;
                return task({
                    executeCommand: () =>
                        index === 0
                            ? gate.promise
                            : Promise.resolve(["recovered"]),
                } as unknown as EditorClientInterface);
            },
        );
        const failed = assert.rejects(
            orch.getVerbData("one"),
            /connection lost/,
        );
        const waiting = orch.getVerbData("two");
        await tick();
        assert.strictEqual(
            calls,
            1,
            "duplicate characters must not become independent workers",
        );
        gate.reject(new Error("connection lost"));
        await failed;
        assert.strictEqual(await waiting, "recovered");
    });

    test("compilations run concurrently on separate workers and clean up failures", async () => {
        const gate = deferred<ScriptCompileResults>();
        let compilations = 0;
        let exits = 0;
        const scriptIds: number[] = [];
        const orch = orchestrator(
            [first, second],
            async <T>(
                _key: string,
                _options: InitOptions,
                task: ClientTask<T>,
            ) =>
                task({
                    modifyScript: async (script: number) => {
                        scriptIds.push(script);
                        return { new: false };
                    },
                    sendScript: async () =>
                        ++compilations === 1
                            ? gate.promise
                            : ({} as ScriptCompileResults),
                    exitModifyScript: async () => {
                        exits++;
                    },
                    executeCommand: async () => ["read finished"],
                } as unknown as EditorClientInterface),
        );
        const failed = assert.rejects(
            orch.uploadAndCompileScript("first"),
            /compile failed/,
        );
        const concurrent = orch.uploadAndCompileScript("second");
        await tick();
        assert.strictEqual(compilations, 2);
        await concurrent;
        assert.strictEqual(await orch.getVerbData("look"), "read finished");
        gate.reject(new Error("compile failed"));
        await failed;
        assert.deepStrictEqual(scriptIds, [24661, 24661]);
        assert.strictEqual(exits, 1);
    });

    test("legacy extension calls retain their shared instance queue", async () => {
        const orch = orchestrator(
            first,
            async <T>(
                key: string,
                options: InitOptions,
                task: ClientTask<T>,
            ) => {
                assert.strictEqual(key, "dev");
                assert.strictEqual(options.login.character, "First");
                return task({
                    executeCommand: async () => ["ok"],
                } as unknown as EditorClientInterface);
            },
        );
        assert.strictEqual(await orch.getVerbData("look"), "ok");
    });
});
