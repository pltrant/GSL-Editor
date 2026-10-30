import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    ClientTask,
    EditorClientInterface,
    InitOptions,
} from "../../gsl/editorClient";
import {
    McpToolResult,
    TOOL_DEFINITIONS,
    coerceInteger,
    createMcpToolHandler,
} from "../../gsl/mcp/mcpTools";
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

suite("MCP Id Coercion", () => {
    test("coerceInteger accepts integers and numeric strings", () => {
        for (const [value, expected] of [
            [24262, 24262],
            [-516105, -516105],
            ["24262", 24262],
            ["  24262\t", 24262],
            ["-516105", -516105],
            ["00123", 123],
        ] as const) {
            assert.strictEqual(coerceInteger(value), expected, String(value));
        }
    });

    test("coerceInteger rejects non-integer input", () => {
        for (const value of [
            undefined,
            null,
            1.5,
            NaN,
            "",
            "  ",
            "1.5",
            "1e3",
            "0x10",
            "+5",
            "12 34",
            "abc",
            "S24262",
            "99999999999999999999",
            true,
            [123],
            { value: 123 },
        ]) {
            assert.strictEqual(coerceInteger(value), undefined, String(value));
        }
    });

    test("coerceInteger accepts an S prefix only for script numbers", () => {
        const options = { allowScriptPrefix: true };
        assert.strictEqual(coerceInteger("S24262", options), 24262);
        assert.strictEqual(coerceInteger(" s24262 ", options), 24262);
        assert.strictEqual(coerceInteger("24262", options), 24262);
        for (const value of ["S", "S-5", "SS24262", "S 24262", "T24262"]) {
            assert.strictEqual(coerceInteger(value, options), undefined, value);
        }
    });
});

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

suite("MCP Script Metadata", () => {
    for (const [loginInstance, response] of [
        ["DRD", ["Game: DRD", "Script 999999 does not exist."]],
        ["GS4D", ["Invalid script number: 999999"]],
    ] as const) {
        test(`${loginInstance} missing script returns a tool error without waiting for a date`, async () => {
            const client = {
                executeCommand: async (_command: string, options: any) => {
                    const error = response[response.length - 1];
                    if (response.length > 1) {
                        assert.ok(options.captureStart.test(response[0]));
                        assert.ok(
                            options.captureEnd.test(error),
                            "Missing-script response must end capture after Game:",
                        );
                        assert.strictEqual(options.includeEndLine, true);
                    } else {
                        assert.ok(options.abortPattern.test(error));
                    }
                    assert.ok(
                        !options.captureEnd.test(
                            "Name: Script 999999 does not exist.",
                        ),
                    );
                    return [...response];
                },
            } as unknown as EditorClientInterface;
            const orch = new AgentToolOrchestrator(
                makeDeps({
                    getCredentials: async () => ({
                        ...DEV_CREDS,
                        instance: loginInstance,
                    }),
                }),
                async <T>(
                    _key: string,
                    _options: InitOptions,
                    task: ClientTask<T>,
                ): Promise<T> => task(client),
            );
            const result = await createMcpToolHandler(
                "gsl_get_script_ss_metadata",
                orch,
            )({ scriptId: 999999 });
            assert.strictEqual(result.isError, true);
            assert.strictEqual(
                result.content[0].text,
                response[response.length - 1],
            );
        });
    }

    for (const [loginInstance, codes] of [
        ["GS4D", ["GS4D", "GS4", "GS4X", "GST", "GSF"]],
        ["DRD", ["DRD", "DR", "DRX", "DRT", "DRF"]],
    ] as const) {
        for (const pooled of [false, true]) {
            test(`${loginInstance} metadata uses the correct game codes (${pooled ? "pool" : "single worker"})`, async () => {
                const instances: GameInstance[] = [
                    "dev",
                    "prime",
                    "platinum",
                    "test",
                    "shattered",
                ];
                const commands: string[] = [];
                const response = [
                    "Game: " + loginInstance,
                    "Name: Example",
                    "Last modified by: Tester",
                    "On Mon Oct 05 12:00:00 2026",
                ];
                const client = {
                    executeCommand: async (command: string, options: any) => {
                        commands.push(command);
                        assert.ok(options.captureStart.test(response[0]));
                        assert.ok(
                            !options.captureStart.test("prefix " + response[0]),
                        );
                        assert.ok(options.captureEnd.test(response[3]));
                        assert.ok(
                            options.captureEnd.test(
                                "Unspecified Date (Dec 1969)",
                            ),
                        );
                        return response;
                    },
                } as unknown as EditorClientInterface;
                const creds = { ...DEV_CREDS, instance: loginInstance };
                const orch = new AgentToolOrchestrator(
                    makeDeps({
                        getCredentials: async (instance) => {
                            assert.strictEqual(instance, "dev");
                            return pooled ? [creds] : creds;
                        },
                    }),
                    async <T>(
                        _key: string,
                        options: InitOptions,
                        task: ClientTask<T>,
                    ): Promise<T> => {
                        assert.strictEqual(
                            options.login.instance,
                            loginInstance,
                        );
                        return task(client);
                    },
                );
                const handler = createMcpToolHandler(
                    "gsl_get_script_ss_metadata",
                    orch,
                );
                for (const instance of [undefined, ...instances]) {
                    const result = await handler({ scriptId: 123, instance });
                    assert.ok(!result.isError);
                    assert.strictEqual(
                        result.content[0].text,
                        response.join("\n"),
                    );
                }
                assert.deepStrictEqual(
                    commands,
                    [codes[0], ...codes].map((code) => `/ss 123 ${code} raw`),
                );
            });
        }
    }
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

    test("gsl_get_table_metadata accepts a numeric string tableId", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const calls: Array<[number, GameInstance | undefined]> = [];
        orch.getGlobalTableData = async (tableId, instance) => {
            calls.push([tableId, instance]);
            return `Table ${tableId}`;
        };
        const result = await createMcpToolHandler(
            "gsl_get_table_metadata",
            orch,
        )({ tableId: "11424" });
        assert.ok(!result.isError);
        assert.deepStrictEqual(calls, [[11424, "dev"]]);
    });

    test("gsl_get_table_metadata error lists received keys when tableId is absent", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        orch.getGlobalTableData = async () => {
            throw new Error("must not be called");
        };
        const handler = createMcpToolHandler("gsl_get_table_metadata", orch);
        assert.deepStrictEqual(await handler({ tableNumber: "11424" }), {
            content: [
                {
                    type: "text",
                    text: "Missing or invalid tableId (received keys: tableNumber). Expected an integer between 1 and 999999.",
                },
            ],
            isError: true,
        });
        assert.strictEqual(
            (await handler({})).content[0].text,
            "Missing or invalid tableId (received keys: none). Expected an integer between 1 and 999999.",
        );
    });

    test("gsl_get_table_metadata rejects invalid tableId values without listing keys", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const handler = createMcpToolHandler("gsl_get_table_metadata", orch);
        for (const tableId of ["abc", "1000000"]) {
            const result = await handler({ tableId });
            assert.ok(result.isError, String(tableId));
            assert.strictEqual(
                result.content[0].text,
                "Missing or invalid tableId. Expected an integer between 1 and 999999.",
            );
        }
    });

    test("room, existence, and script metadata ids accept numeric strings", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const calls: Array<[string, number]> = [];
        orch.getRoomData = async (id) => {
            calls.push(["room", id]);
            return "room";
        };
        orch.getExistenceData = async (id) => {
            calls.push(["existence", id]);
            return "existence";
        };
        orch.getScriptData = async (id) => {
            calls.push(["script", id]);
            return "ss";
        };
        for (const [tool, args] of [
            ["gsl_get_room_data", { roomId: "123" }],
            ["gsl_get_existence_data", { existenceId: "-516105" }],
            ["gsl_get_script_ss_metadata", { scriptId: "S24262" }],
        ] as const) {
            const result = await createMcpToolHandler(tool, orch)(args);
            assert.ok(!result.isError, tool);
        }
        assert.deepStrictEqual(calls, [
            ["room", 123],
            ["existence", -516105],
            ["script", 24262],
        ]);
    });

    test("room error lists received keys when roomId is absent", async () => {
        const orch = new AgentToolOrchestrator(makeDeps());
        const room = await createMcpToolHandler(
            "gsl_get_room_data",
            orch,
        )({ room: 123, instance: "dev" });
        assert.strictEqual(
            room.content[0].text,
            "Missing or invalid roomId (received keys: room, instance). Provide a positive integer.",
        );
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

    test("download keeps the existing file's line endings", async () => {
        orch.fetchScript = async () => ({
            content: "line one\nline two\n",
            isNew: false,
        });
        const filePath = path.join(dir, "S00123.dev.mcp.gsl");
        fs.writeFileSync(filePath, "old\r\nscript\r\n");
        const result = await createMcpToolHandler(
            "gsl_download_script",
            orch,
        )({ scriptNumber: 123 });
        assert.ok(!result.isError);
        assert.strictEqual(
            fs.readFileSync(filePath, "utf8"),
            "line one\r\nline two\r\n",
        );
    });

    test("numeric string script numbers are coerced", async () => {
        const result = await createMcpToolHandler(
            "gsl_download_script",
            orch,
        )({ scriptNumber: ["123", " S456 "] });
        assert.ok(!result.isError);
        assert.deepStrictEqual(calls, [
            [123, "dev"],
            [456, "dev"],
        ]);
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), [
            "S00123.dev.mcp.gsl",
            "S00456.dev.mcp.gsl",
        ]);
    });

    test("invalid batches are rejected before any downloads", async () => {
        const handler = createMcpToolHandler("gsl_download_script", orch);
        for (const scriptNumber of [
            undefined,
            [],
            [123, 0],
            [123, 1000000],
            [123, 1.5],
            [123, "abc"],
            [123, "4 56"],
            [123, "T456"],
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

suite("MCP File Symlink Refusal", () => {
    const SECRET = "API_TOKEN=do-not-leak";
    let dir: string;
    let orch: AgentToolOrchestrator;
    let compiled: string[];

    const compileCheck = (filename: string) =>
        createMcpToolHandler("gsl_compile_check", orch)({ filename });
    const download = (downloadLocation: string) => {
        orch = new AgentToolOrchestrator(makeDeps({ downloadLocation }));
        orch.fetchScript = async () => ({
            content: "fetched\n",
            isNew: false,
        });
        return createMcpToolHandler(
            "gsl_download_script",
            orch,
        )({
            scriptNumber: 123,
        });
    };
    const scriptName = "S00123.dev.mcp.gsl";

    function compilingOrchestrator(downloadLocation: string) {
        const compiling = new AgentToolOrchestrator(
            makeDeps({ downloadLocation }),
        );
        compiling.uploadAndCompileScript = async (content) => {
            compiled.push(content);
            return {
                status: 0,
                script: 24661,
                path: "",
                bytes: content.length,
                maxBytes: 100,
                errors: 0,
                warnings: 0,
                errorList: [],
            };
        };
        return compiling;
    }

    function skipWithoutPosixFiles(context: Mocha.Context) {
        if (process.platform === "win32") context.skip();
    }

    function assertRefused(result: McpToolResult) {
        assert.ok(result.isError, result.content[0].text);
        assert.deepStrictEqual(compiled, []);
        assert.ok(!result.content[0].text.includes(SECRET));
    }

    /** Runs `action` with the pre-open symlink checks blind, as in a swap. */
    async function withSwappedPath<T>(action: () => Promise<T>): Promise<T> {
        const mutableFs = require("fs") as { lstatSync: unknown };
        const { lstatSync } = mutableFs;
        mutableFs.lstatSync = () => undefined;
        try {
            return await action();
        } finally {
            mutableFs.lstatSync = lstatSync;
        }
    }

    /** `getuid` undefined is how Windows looks to the path check. */
    async function compileThroughRootOwnedLink(uid: number | undefined) {
        fs.mkdirSync(path.join(dir, "real"), { recursive: true });
        fs.rmSync(path.join(dir, "system"), { force: true });
        fs.symlinkSync(path.join(dir, "real"), path.join(dir, "system"));
        fs.writeFileSync(path.join(dir, "real", "a.gsl"), SECRET);
        const mutableFs = require("fs") as { lstatSync: typeof fs.lstatSync };
        const { lstatSync } = mutableFs;
        const { getuid } = process;
        mutableFs.lstatSync = ((
            target: string,
            options: fs.StatSyncOptions,
        ) => {
            const stats = lstatSync(target, options) as fs.Stats | undefined;
            if (stats?.isSymbolicLink()) stats.uid = 0;
            return stats;
        }) as typeof fs.lstatSync;
        process.getuid = uid === undefined ? undefined : () => uid;
        try {
            return await compileCheck(path.join("system", "a.gsl"));
        } finally {
            mutableFs.lstatSync = lstatSync;
            process.getuid = getuid;
        }
    }

    /** Fails the first `failures` renames with EPERM, on `platform`. */
    async function downloadWithRenameFailures({
        failures,
        platform,
    }: {
        failures: number;
        platform: NodeJS.Platform;
    }) {
        const mutableFs = require("fs") as { renameSync: typeof fs.renameSync };
        const { renameSync } = mutableFs;
        const realPlatform = process.platform;
        let attempts = 0;
        mutableFs.renameSync = (from, to) => {
            if (++attempts <= failures) {
                throw Object.assign(new Error("EPERM"), { code: "EPERM" });
            }
            renameSync(from, to);
        };
        Object.defineProperty(process, "platform", { value: platform });
        try {
            return { result: await download(dir), attempts };
        } finally {
            mutableFs.renameSync = renameSync;
            Object.defineProperty(process, "platform", { value: realPlatform });
        }
    }

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-symlink-test-"));
        compiled = [];
        orch = compilingOrchestrator(dir);
    });

    teardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("compiles a .gsl file by absolute and relative path", async () => {
        const scriptPath = path.join(dir, "S02017.gsl");
        fs.writeFileSync(scriptPath, "script body");

        assert.ok(!(await compileCheck(scriptPath)).isError);
        assert.ok(!(await compileCheck("S02017.gsl")).isError);
        assert.deepStrictEqual(compiled, ["script body", "script body"]);
    });

    test("compiles a regular file in an arbitrary directory", async () => {
        const scratch = path.join(dir, "tmp", "threads", "t1", "scratch");
        fs.mkdirSync(scratch, { recursive: true });
        fs.writeFileSync(path.join(scratch, "probe.gsl"), "script body");
        orch = compilingOrchestrator("/nonexistent");

        const result = await compileCheck(path.join(scratch, "probe.gsl"));

        assert.ok(!result.isError, result.content[0].text);
        assert.deepStrictEqual(compiled, ["script body"]);
    });

    test("compiles through a root-owned symlink in the path", async function () {
        skipWithoutPosixFiles(this);
        const result = await compileThroughRootOwnedLink(1000);

        assert.ok(!result.isError, result.content[0].text);
    });

    test("trusts no symlink as root or on Windows", async function () {
        skipWithoutPosixFiles(this);
        assertRefused(await compileThroughRootOwnedLink(0));
        assertRefused(await compileThroughRootOwnedLink(undefined));
    });

    test("compile refuses a .gsl symlink to a non-.gsl file", async function () {
        skipWithoutPosixFiles(this);
        fs.writeFileSync(path.join(dir, ".env"), SECRET);
        fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "evil.gsl"));

        const result = await compileCheck("evil.gsl");

        assertRefused(result);
        assert.strictEqual(
            result.content[0].text,
            `${path.join(dir, "evil.gsl")} has a symlink in its path; use the real path.`,
        );
    });

    test("compile refuses a .gsl symlink to a .gsl file", async function () {
        skipWithoutPosixFiles(this);
        fs.writeFileSync(path.join(dir, "real.gsl"), SECRET);
        fs.symlinkSync(path.join(dir, "real.gsl"), path.join(dir, "link.gsl"));

        assertRefused(await compileCheck("link.gsl"));
    });

    test("compile refuses a file behind a symlinked parent", async function () {
        skipWithoutPosixFiles(this);
        fs.mkdirSync(path.join(dir, "real"));
        fs.writeFileSync(path.join(dir, "real", "a.gsl"), SECRET);
        fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));

        assertRefused(await compileCheck(path.join("link", "a.gsl")));
    });

    test("compile refuses a path swapped for a symlink", async function () {
        skipWithoutPosixFiles(this);
        fs.writeFileSync(path.join(dir, ".env"), SECRET);
        fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "swap.gsl"));

        assertRefused(await withSwappedPath(() => compileCheck("swap.gsl")));
    });

    test("compile refuses a non-.gsl path", async () => {
        fs.writeFileSync(path.join(dir, "notes.txt"), SECRET);

        assertRefused(await compileCheck("notes.txt"));
    });

    test("compile refuses a directory named like a .gsl file", async () => {
        fs.mkdirSync(path.join(dir, "folder.gsl"));

        assertRefused(await compileCheck("folder.gsl"));
    });

    test("compile refuses a FIFO without hanging", async function () {
        skipWithoutPosixFiles(this);
        execFileSync("mkfifo", [path.join(dir, "pipe.gsl")]);

        const result = await compileCheck("pipe.gsl");

        assertRefused(result);
        assert.strictEqual(
            result.content[0].text,
            `${path.join(dir, "pipe.gsl")} is not a regular file.`,
        );
    });

    test("download writes a new file and replaces a regular one", async () => {
        const scriptPath = path.join(dir, scriptName);

        assert.ok(!(await download(dir)).isError);
        assert.strictEqual(
            fs.readFileSync(scriptPath, "utf8"),
            `fetched${os.EOL}`,
        );

        fs.writeFileSync(scriptPath, "much longer old\r\ncontent\r\n");
        assert.ok(!(await download(dir)).isError);
        assert.strictEqual(fs.readFileSync(scriptPath, "utf8"), "fetched\r\n");
    });

    test("download refuses a planted symlink and keeps its target", async function () {
        skipWithoutPosixFiles(this);
        const target = path.join(dir, "authorized_keys");
        fs.writeFileSync(target, SECRET);
        fs.symlinkSync(target, path.join(dir, scriptName));

        const result = await download(dir);

        assertRefused(result);
        assert.strictEqual(fs.readFileSync(target, "utf8"), SECRET);
    });

    test("download refuses a dangling planted symlink", async function () {
        skipWithoutPosixFiles(this);
        const target = path.join(dir, "created-through-link");
        fs.symlinkSync(target, path.join(dir, scriptName));

        assertRefused(await download(dir));
        assert.ok(!fs.existsSync(target));
    });

    test("download refuses a symlinked download directory", async function () {
        skipWithoutPosixFiles(this);
        fs.mkdirSync(path.join(dir, "real"));
        fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));

        assertRefused(await download(path.join(dir, "link")));
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, "real")), []);
    });

    test("download creates no directory through a symlink", async function () {
        skipWithoutPosixFiles(this);
        fs.mkdirSync(path.join(dir, "real"));
        fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));

        assertRefused(await download(path.join(dir, "link", "sub")));
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, "real")), []);
    });

    test("download runs no git hook planted in its directory", async function () {
        skipWithoutPosixFiles(this);
        const hook = path.join(dir, "hook.sh");
        const marker = path.join(dir, "hook-ran");
        fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
        execFileSync("git", ["init", "-q", dir]);
        fs.writeFileSync(path.join(dir, "tracked"), "x");
        execFileSync("git", ["-C", dir, "add", "tracked"]);
        execFileSync("git", ["-C", dir, "config", "core.fsmonitor", hook]);

        assert.ok(!(await download(dir)).isError);
        assert.ok(!fs.existsSync(marker));
    });

    test("download refuses a path swapped for a symlink", async function () {
        skipWithoutPosixFiles(this);
        const target = path.join(dir, "authorized_keys");
        fs.writeFileSync(target, SECRET);
        fs.symlinkSync(target, path.join(dir, scriptName));

        assertRefused(await withSwappedPath(() => download(dir)));
        assert.strictEqual(fs.readFileSync(target, "utf8"), SECRET);
    });

    test("download refuses a FIFO without hanging", async function () {
        skipWithoutPosixFiles(this);
        execFileSync("mkfifo", [path.join(dir, scriptName)]);

        assertRefused(await download(dir));
    });

    test("download leaves a hard-linked outside file intact", async () => {
        const outside = path.join(dir, "authorized_keys");
        const scriptPath = path.join(dir, scriptName);
        fs.writeFileSync(outside, SECRET);
        fs.linkSync(outside, scriptPath);

        assert.ok(!(await download(dir)).isError);

        assert.strictEqual(fs.readFileSync(outside, "utf8"), SECRET);
        assert.strictEqual(fs.readFileSync(scriptPath, "utf8"), "fetched\n");
        assert.strictEqual(fs.statSync(scriptPath).nlink, 1);
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), [
            scriptName,
            "authorized_keys",
        ]);
    });

    test("download retries a rename blocked on Windows", async () => {
        const scriptPath = path.join(dir, scriptName);
        fs.writeFileSync(scriptPath, "old\n");

        const { result, attempts } = await downloadWithRenameFailures({
            failures: 2,
            platform: "win32",
        });

        assert.ok(!result.isError, result.content[0].text);
        assert.strictEqual(attempts, 3);
        assert.strictEqual(fs.readFileSync(scriptPath, "utf8"), "fetched\n");
        assert.deepStrictEqual(fs.readdirSync(dir), [scriptName]);
    });

    test("download reports a file held open on Windows", async () => {
        const scriptPath = path.join(dir, scriptName);
        fs.writeFileSync(scriptPath, "old\n");

        const { result, attempts } = await downloadWithRenameFailures({
            failures: Infinity,
            platform: "win32",
        });

        assert.ok(result.isError);
        assert.ok(
            result.content[0].text.includes(
                `${scriptPath} could not be replaced (EPERM). It is probably read-only or open in another program`,
            ),
            result.content[0].text,
        );
        assert.strictEqual(attempts, 20);
        assert.strictEqual(fs.readFileSync(scriptPath, "utf8"), "old\n");
        assert.deepStrictEqual(fs.readdirSync(dir), [scriptName]);
    });

    test("download doesn't retry a failed rename off Windows", async () => {
        const scriptPath = path.join(dir, scriptName);
        fs.writeFileSync(scriptPath, "old\n");

        const { result, attempts } = await downloadWithRenameFailures({
            failures: Infinity,
            platform: "linux",
        });

        assert.ok(result.isError);
        assert.ok(!result.content[0].text.includes("another program"));
        assert.strictEqual(attempts, 1);
        assert.strictEqual(fs.readFileSync(scriptPath, "utf8"), "old\n");
        assert.deepStrictEqual(fs.readdirSync(dir), [scriptName]);
    });

    test("download removes the temp file after a failed write", async () => {
        const scriptPath = path.join(dir, scriptName);
        fs.writeFileSync(scriptPath, "old\n");
        const mutableFs = require("fs") as {
            writeFileSync: typeof fs.writeFileSync;
        };
        const { writeFileSync } = mutableFs;
        mutableFs.writeFileSync = (file, _data, options) => {
            writeFileSync(file, "partial", options);
            throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        };
        try {
            const result = await download(dir);

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes("ENOSPC"));
        } finally {
            mutableFs.writeFileSync = writeFileSync;
        }
        assert.strictEqual(fs.readFileSync(scriptPath, "utf8"), "old\n");
        assert.deepStrictEqual(fs.readdirSync(dir), [scriptName]);
    });

    test("a failed temp cleanup doesn't hide the write error", async () => {
        fs.writeFileSync(path.join(dir, scriptName), "old\n");
        const mutableFs = require("fs") as { rmSync: typeof fs.rmSync };
        const { rmSync } = mutableFs;
        mutableFs.rmSync = () => {
            throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        };
        try {
            const { result } = await downloadWithRenameFailures({
                failures: Infinity,
                platform: "linux",
            });

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes("EPERM"));
        } finally {
            mutableFs.rmSync = rmSync;
        }
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

    test("numeric string script numbers match integer output", async () => {
        const expected = await diff({
            scriptNumber: 24262,
            baseInstance: "prime",
            compareInstance: "dev",
        });
        assert.ok(!expected.isError);
        assert.deepStrictEqual(
            await diff({
                scriptNumber: "S24262",
                baseInstance: "prime",
                compareInstance: "dev",
            }),
            expected,
        );
    });

    test("missing scriptNumber lists received keys", async () => {
        const result = await diff({ scriptId: 123 });
        assert.ok(result.isError);
        assert.ok(result.content[0].text.includes("(received keys: scriptId)"));
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
            [123, "abc"],
            [123, "4 56"],
            [123, "T456"],
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
