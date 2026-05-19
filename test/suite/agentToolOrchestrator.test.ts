import * as assert from "assert";
import {
    AgentToolOrchestrator,
    AgentToolOrchestratorDeps,
    LoginCredentials,
    GameInstance,
} from "../../gsl/agentToolOrchestrator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_CREDS: LoginCredentials = {
    account: "testaccount",
    instance: "GS4D",
    character: "TestChar",
    password: "testpass",
};

const PRIME_CREDS: LoginCredentials = {
    account: "testaccount",
    instance: "GS3",
    character: "TestChar",
    password: "testpass",
};

const ALL_CREDS: Record<string, LoginCredentials> = {
    dev: DEV_CREDS,
    prime: PRIME_CREDS,
};

function makeDeps(
    overrides: Partial<AgentToolOrchestratorDeps> = {},
): AgentToolOrchestratorDeps {
    return {
        getCredentials: async (instance: GameInstance) =>
            ALL_CREDS[instance] as LoginCredentials | undefined,
        getCurrentAuthor: () => "AlexB/Nyxus",
        downloadLocation: "/tmp/gsl-test",
        console: { log: () => {} },
        ...overrides,
    };
}

function depsWithout(
    ...instances: GameInstance[]
): Partial<AgentToolOrchestratorDeps> {
    const excluded = new Set(instances);
    return {
        getCredentials: async (instance: GameInstance) =>
            excluded.has(instance) ? undefined : ALL_CREDS[instance],
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("ToolOrchestrator", () => {
    // -- getCurrentAuthor --------------------------------------------------

    test("getCurrentAuthor returns configured author", () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        assert.strictEqual(orch.getCurrentAuthor(), "AlexB/Nyxus");
    });

    test("getCurrentAuthor returns undefined when not configured", () => {
        const orch = new AgentToolOrchestrator(
            makeDeps({ getCurrentAuthor: () => undefined }),
        );
        assert.strictEqual(orch.getCurrentAuthor(), undefined);
    });

    // -- credential error handling -----------------------------------------

    test("getRoomData throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.getRoomData(100, "dev"), {
            message: /dev server not configured/,
        });
    });

    test("getRoomData on prime throws when prime credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("prime")));
        await assert.rejects(() => orch.getRoomData(100, "prime"), {
            message: /prime server not configured/,
        });
    });

    test("getExistenceData throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.getExistenceData(200, "dev"), {
            message: /dev server not configured/,
        });
    });

    test("getPlayerVarfields throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(
            () => orch.getPlayerVarfields("TestPlayer", "Full", "dev"),
            { message: /dev server not configured/ },
        );
    });

    test("getVerbData throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.getVerbData("sit"), {
            message: /dev server not configured/,
        });
    });

    test("getScriptData throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.getScriptData(123, "GS4D"), {
            message: /dev server not configured/,
        });
    });

    test("getGlobalTableData throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.getGlobalTableData(5), {
            message: /dev server not configured/,
        });
    });

    test("executeAgentCommand throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.executeAgentCommand("testcmd", "dev"), {
            message: /dev server not configured/,
        });
    });

    test("fetchPrimeScript throws when prime credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("prime")));
        await assert.rejects(() => orch.fetchPrimeScript(100), {
            message: /prime server not configured/,
        });
    });

    test("fetchDevScript throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(() => orch.fetchDevScript(100), {
            message: /dev server not configured/,
        });
    });

    test("uploadAndCompileScript throws when dev credentials missing", async () => {
        const orch = new AgentToolOrchestrator(makeDeps(depsWithout("dev")));
        await assert.rejects(
            () => orch.uploadAndCompileScript("some content"),
            { message: /dev server not configured/ },
        );
    });

    // -- input validation --------------------------------------------------

    test("getPlayerVarfields rejects control characters in playerName", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        await assert.rejects(
            () => orch.getPlayerVarfields("bad\x00name", "Full", "dev"),
            { message: /control characters/ },
        );
    });

    test("executeAgentCommand rejects control characters in command", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        await assert.rejects(
            () => orch.executeAgentCommand("bad\x01cmd", "dev"),
            { message: /control characters/ },
        );
    });

    test("getVerbData rejects control characters in verb", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        await assert.rejects(() => orch.getVerbData("bad\x02verb"), {
            message: /control characters/,
        });
    });

    test("uploadAndCompileScript rejects empty content", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        await assert.rejects(() => orch.uploadAndCompileScript(""), {
            message: /empty script/,
        });
    });

    test("uploadAndCompileScript rejects whitespace-only content", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        await assert.rejects(() => orch.uploadAndCompileScript("   \n  "), {
            message: /empty script/,
        });
    });
});
