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
