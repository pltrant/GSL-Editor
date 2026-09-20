import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TOOL_DEFINITIONS, createMcpToolHandler } from "../../gsl/mcp/mcpTools";
import {
    AgentToolOrchestrator,
    AgentToolOrchestratorDeps,
    LoginCredentials,
    GameInstance,
} from "../../gsl/agentToolOrchestrator";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const DEV_CREDS: LoginCredentials = {
    account: "test",
    instance: "GS4D",
    character: "TestChar",
    password: "testpass",
};

const PRIME_CREDS: LoginCredentials = {
    account: "test",
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
        downloadLocation: "/tmp/gsl",
        console: { log: () => {} },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("MCP Tool Definitions", () => {
    test("all expected tools are defined", () => {
        const names = TOOL_DEFINITIONS.map((t) => t.name);
        assert.ok(names.includes("gsl_get_room_data"));
        assert.ok(names.includes("gsl_get_existence_data"));
        assert.ok(names.includes("gsl_get_player_varfields"));
        assert.ok(names.includes("gsl_get_script_ss_metadata"));
        assert.ok(names.includes("gsl_get_verb_data"));
        assert.ok(names.includes("gsl_get_table_metadata"));
        assert.ok(names.includes("gsl_slash_agent_command"));
        assert.ok(names.includes("gsl_download_script"));
        assert.ok(names.includes("gsl_diff_script_across_instances"));
        assert.ok(names.includes("gsl_compile_check"));
        assert.ok(names.includes("gsl_get_current_author"));
    });

    test("tool count is 11", () => {
        assert.strictEqual(TOOL_DEFINITIONS.length, 11);
    });

    test("every tool has a name, description, and inputSchema", () => {
        for (const tool of TOOL_DEFINITIONS) {
            assert.ok(tool.name, `Tool missing name`);
            assert.ok(tool.description, `${tool.name} missing description`);
            assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
        }
    });
});

suite("MCP Tool Handlers", () => {
    test("gsl_get_current_author returns author string", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_current_author", orch);
        const result = await handler({});
        assert.ok(!result.isError);
        assert.ok(
            result.content.some(
                (c: any) => c.type === "text" && c.text.includes("AlexB/Nyxus"),
            ),
        );
    });

    test("gsl_get_current_author returns error when not configured", async () => {
        const orch = new AgentToolOrchestrator(
            makeDeps({ getCurrentAuthor: () => undefined }),
        );
        const handler = createMcpToolHandler("gsl_get_current_author", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("handler for unknown tool throws", () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        assert.throws(() => createMcpToolHandler("nonexistent_tool", orch));
    });

    test("gsl_get_room_data handler validates missing roomId", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_room_data", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_get_existence_data handler validates missing existenceId", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_existence_data", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_get_player_varfields handler validates missing playerName", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_player_varfields", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_get_verb_data handler validates missing verb", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_verb_data", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_get_script_ss_metadata handler validates missing scriptId", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler(
            "gsl_get_script_ss_metadata",
            orch,
        );
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_get_table_metadata handler validates missing tableId", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_table_metadata", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_diff_script_across_instances handler validates missing scriptNumber", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler(
            "gsl_diff_script_across_instances",
            orch,
        );
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_compile_check handler validates missing filename", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_compile_check", orch);
        const result = await handler({});
        assert.ok(result.isError);
    });

    test("gsl_get_room_data returns formatted output", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const stub = "Showing room #123\nName: Test Room\nFlags: none";
        orch.getRoomData = async () => stub;
        const handler = createMcpToolHandler("gsl_get_room_data", orch);
        const result = await handler({ roomId: 123, instance: "dev" });
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes("Showing room #123"));
    });

    test("gsl_slash_agent_command coerces non-string to string", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        orch.executeAgentCommand = async (cmd) => `ran: ${cmd}`;
        const handler = createMcpToolHandler("gsl_slash_agent_command", orch);
        const result = await handler({ command: 42 as any });
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes("ran: 42"));
    });

    test("gsl_get_table_metadata error mentions tableId not scriptNumber", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_table_metadata", orch);
        const result = await handler({});
        assert.ok(result.isError);
        assert.ok(result.content[0].text.includes("tableId"));
    });
});

suite("MCP Script Downloads", () => {
    let dir: string;
    let orch: AgentToolOrchestrator;
    let calls: Array<[number, GameInstance | undefined]>;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-download-test-"));
        orch = new AgentToolOrchestrator(makeDeps({ downloadLocation: dir }));
        calls = [];
        orch.fetchScript = async (script, instance) => {
            calls.push([script, instance]);
            return { content: `script ${script}`, isNew: false };
        };
    });

    teardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("single script retains its file name, default instance, and response", async () => {
        const result = await createMcpToolHandler(
            "gsl_download_script",
            orch,
        )({ scriptNumber: 123 });
        const filePath = path.join(dir, "S00123.dev.mcp.gsl");
        assert.deepStrictEqual(calls, [[123, "dev"]]);
        assert.strictEqual(fs.readFileSync(filePath, "utf8"), "script 123");
        assert.deepStrictEqual(result, {
            content: [
                {
                    type: "text",
                    text: `Script 123 downloaded from dev to: ${filePath}`,
                },
            ],
        });
    });

    test("batch downloads each script from the requested instance", async () => {
        const result = await createMcpToolHandler(
            "gsl_download_script",
            orch,
        )({ scriptNumber: [123, 456], instance: "prime" });
        assert.ok(!result.isError);
        assert.deepStrictEqual(calls, [
            [123, "prime"],
            [456, "prime"],
        ]);
        assert.strictEqual(result.content.length, 2);
        for (const script of [123, 456]) {
            const filePath = path.join(
                dir,
                `S${String(script).padStart(5, "0")}.prime.mcp.gsl`,
            );
            assert.strictEqual(
                fs.readFileSync(filePath, "utf8"),
                `script ${script}`,
            );
            assert.ok(
                result.content.some((item) => item.text.includes(filePath)),
            );
        }
    });

    test("invalid batches are rejected before any downloads", async () => {
        const handler = createMcpToolHandler("gsl_download_script", orch);
        for (const scriptNumber of [
            undefined,
            [],
            [123, 0],
            [123, 1000000],
            [123, 1.5],
            [123, "456"],
            [[123]],
        ]) {
            const result = await handler({ scriptNumber });
            assert.ok(result.isError);
        }
        assert.deepStrictEqual(calls, []);
        assert.deepStrictEqual(fs.readdirSync(dir), []);
    });

    test("batch continues after missing scripts and download errors", async () => {
        orch.fetchScript = async (script) => {
            if (script === 123) return { content: "", isNew: true };
            if (script === 456) throw new Error("Download failed");
            return { content: "last script", isNew: false };
        };
        const result = await createMcpToolHandler(
            "gsl_download_script",
            orch,
        )({ scriptNumber: [123, 456, 789] });
        assert.ok(result.isError);
        assert.strictEqual(result.content.length, 3);
        assert.ok(result.content[0].text.includes("Script 123: Not found"));
        assert.ok(
            result.content[1].text.includes(
                "Failed to download script 456: Download failed",
            ),
        );
        assert.ok(result.content[2].text.includes("Script 789 downloaded"));
        assert.deepStrictEqual(fs.readdirSync(dir), ["S00789.dev.mcp.gsl"]);
        assert.strictEqual(
            fs.readFileSync(path.join(dir, "S00789.dev.mcp.gsl"), "utf8"),
            "last script",
        );
    });
});

suite("MCP Script Diffs", () => {
    let orch: AgentToolOrchestrator;
    let calls: Array<[number, GameInstance | undefined]>;

    setup(() => {
        orch = new AgentToolOrchestrator(makeDeps());
        calls = [];
        orch.fetchScript = async (script, instance) => {
            calls.push([script, instance]);
            return { content: `${instance}\n`, isNew: false };
        };
    });

    function diff(args: Record<string, unknown>) {
        return createMcpToolHandler(
            "gsl_diff_script_across_instances",
            orch,
        )(args);
    }

    test("scalar and singleton batch preserve default diff output", async () => {
        const scalar = await diff({ scriptNumber: 123 });
        assert.deepStrictEqual(await diff({ scriptNumber: [123] }), scalar);
        assert.ok(!scalar.isError);
        assert.strictEqual(scalar.content.length, 1);
        assert.ok(scalar.content[0].text.includes("--- S123.gsl (prime)"));
        assert.ok(scalar.content[0].text.includes("+++ S123.gsl (dev)"));
        assert.ok(scalar.content[0].text.includes("-prime\n+dev"));
    });

    test("batch preserves order and shares instances and context", async () => {
        const result = await diff({
            scriptNumber: [456, 123],
            baseInstance: "dev",
            compareInstance: "prime",
            context: 0,
        });
        assert.ok(!result.isError);
        assert.deepStrictEqual(calls, [
            [456, "dev"],
            [456, "prime"],
            [123, "dev"],
            [123, "prime"],
        ]);
        assert.strictEqual(result.content.length, 2);
        assert.ok(result.content[0].text.includes("Script 456:"));
        assert.ok(result.content[1].text.includes("Script 123:"));
        assert.ok(
            result.content.every((item) => item.text.includes("-dev\n+prime")),
        );
    });

    test("invalid batches fail before fetching", async () => {
        for (const scriptNumber of [
            [],
            [123, 0],
            [123, 1000000],
            [123, 1.5],
            [123, "456"],
            [[123]],
        ]) {
            assert.ok((await diff({ scriptNumber })).isError);
        }
        assert.deepStrictEqual(calls, []);
    });

    test("batch continues through missing scripts and fetch failures", async () => {
        orch.fetchScript = async (script, instance) => {
            if (script === 4) throw new Error("Fetch failed");
            const isNew =
                script === 1 ||
                (script === 2 && instance === "prime") ||
                (script === 3 && instance === "dev");
            return { content: "same\n", isNew };
        };
        const result = await diff({ scriptNumber: [1, 2, 3, 4, 5] });
        assert.ok(result.isError);
        assert.deepStrictEqual(
            result.content.map((item) => item.text),
            [
                "Script 1: Not found on either prime or dev.",
                "Script 2: Not found on prime (exists only on dev).",
                "Script 3: Not found on dev (exists only on prime).",
                "Failed to diff script 4: Fetch failed",
                "Script 5: No differences between prime and dev.",
            ],
        );
    });

    test("context and whitespace options apply to every diff", async () => {
        orch.fetchScript = async (_script, instance) => ({
            content:
                instance === "prime"
                    ? "before\nold\nafter\n"
                    : "before\nnew\nafter\n",
            isNew: false,
        });
        const result = await diff({ scriptNumber: [1, 2], context: 0 });
        assert.ok(
            result.content.every(
                (item) =>
                    item.text.includes("@@ -2,1 +2,1 @@\n-old\n+new") &&
                    !item.text.includes(" before"),
            ),
        );
        orch.fetchScript = async (_script, instance) => ({
            content: instance === "prime" ? "same\n" : "  same  \n",
            isNew: false,
        });
        const whitespace = await diff({
            scriptNumber: [1, 2],
            ignoreWhitespace: true,
        });
        assert.ok(
            whitespace.content.every(
                (item) =>
                    item.text.includes("No differences") &&
                    item.text.includes("ignoring whitespace"),
            ),
        );
    });
});
