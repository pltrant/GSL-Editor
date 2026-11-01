import * as assert from "assert";
import { spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";

import {
    AuditLog,
    agentEnvMarkers,
    devLogin,
    loadScriptFiles,
    scriptNumber,
    uploadSession,
} from "../../gsl/devUpload/devUpload";
import {
    guardReason,
    processAncestors,
    runInteractive,
} from "../../gsl/devUpload/devUploadInteractive";
import { EAccessClient } from "../../gsl/eaccessClient";
import { withOneShotEditorClient } from "../../gsl/editorClient";

const SCRIPT = 12345;
const SCRIPT2 = 12346;
const VERB_SCRIPT = 777;
const DEV_TEXT = "old first\nold second\n";
const NEW_TEXT = "new first\n\tnew second\nnew third\n";
const TEXT2 = "second script\n";
const EPOCH = 1_700_000_000;
const BUNDLE = path.resolve(
    __dirname,
    "../../gsl/devUpload/devUpload.bundle.js",
);

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** The suite runs under an agent, which `upload` refuses; the tool must not see that. */
const plainEnv = () => {
    const env = { ...process.env };
    for (const name of agentEnvMarkers(env)) delete env[name];
    return env;
};
/** What `upload` must be told for each file: the fake's starting epoch */
const expectArgs = (files: string[]) =>
    files.flatMap((file) => ["--expect", `${scriptNumber(file)}=${EPOCH}`]);

interface FakeScript {
    text: string;
    /**
     * `missing` has no record; `new` has a record but no source; `stale_new`
     * shows metadata to `/ss` but no source to `/ms`; `verb` redirects to `/mv`
     */
    state: "exists" | "missing" | "new" | "stale_new" | "verb";
    modifier: string;
    /** null prints blank metadata */
    epoch: number | null;
}

/**
 * A game server with the script editor's rules: `G` writes the buffer, and so
 * does any `Edt:` command starting with Q, which includes `quit`.
 */
class FakeGame {
    readonly server = net.createServer((socket) => this.accept(socket));
    /** Commands each connection sent, after its login lines */
    readonly connections: string[][] = [];
    scripts: Record<number, FakeScript> = {
        [SCRIPT]: {
            text: DEV_TEXT,
            state: "exists",
            modifier: "W_test",
            epoch: EPOCH,
        },
        [SCRIPT2]: {
            text: "x\n",
            state: "exists",
            modifier: "W_test",
            epoch: EPOCH,
        },
        [VERB_SCRIPT]: {
            text: "verb\n",
            state: "verb",
            modifier: "W_test",
            epoch: EPOCH,
        },
    };
    /** The script number the compile reports, when not the edited one */
    compileNumber: number | undefined;
    compileFails = false;
    /** Replaces what `G` writes, as if the server altered the text */
    writtenText: string | undefined;
    /** The first connection's socket dies after this many script lines */
    failAfterLines: { lines: number; how: "drop" | "reset" } | undefined;
    /** The first connection stops answering after the end of the text */
    hangBeforeGo = false;
    /** The first connection stops answering once `G` arrives */
    hangAfterGo = false;
    /** `Q` after a compile OK reports the abort of a lost token file */
    tokenFileLost = false;
    /** `/ss` for these scripts never answers */
    ssSilent = new Set<number>();
    /** `/ms` answers the verb redirect for another script number */
    verbRedirectWrongScript = false;
    /** `/ss` shows the modifier but no `Last modified:` line */
    ssNoEpochLine = false;
    frozenCsv = "type,id,status,gm,access\n";
    /** `/freeze list csv` never answers */
    freezeSilent = false;
    /** This script joins the frozen list once any script has compiled */
    freezeAfterUpload: number | undefined;
    /** Accepts connections but never shows a prompt */
    silent = false;

    get port(): number {
        return (this.server.address() as net.AddressInfo).port;
    }

    listen(): Promise<void> {
        return new Promise((resolve) =>
            this.server.listen(0, "127.0.0.1", resolve),
        );
    }

    private write(socket: net.Socket, text: string): void {
        if (!socket.destroyed) socket.write(text);
    }

    private accept(socket: net.Socket): void {
        const commands: string[] = [];
        const connection = this.connections.push(commands);
        const write = (text: string) => this.write(socket, text);
        let mode: "login" | "game" | "editor" | "input" = "login";
        let loginLines = 0;
        let buffer: string[] = [];
        let compiled = false;
        let editing: FakeScript | undefined;
        write('<mode id="GAME"/>\n');
        if (!this.silent) setTimeout(() => write("Welcome.\r\n>"), 20);

        const editorWrite = () => {
            // The real editor won't write an empty buffer.
            if (buffer.length === 0 || !editing) return;
            editing.text =
                this.writtenText ?? buffer.map((l) => `${l}\n`).join("");
            editing.state = "exists";
        };
        const openEditor = (script: FakeScript, number: number) => {
            editing = script;
            compiled = false;
            if (script.state === "new" || script.state === "stale_new") {
                buffer = [];
                mode = "input";
                write(`New File: S${number}.\r\n001] `);
            } else {
                buffer = script.text.split("\n").slice(0, -1);
                mode = "editor";
                write(`File: S${number}, ${buffer.length} lines.\r\nEdt:`);
            }
        };
        const showScript = (number: number, script: FakeScript | undefined) => {
            if (this.ssSilent.has(number)) return;
            if (
                !script ||
                script.state === "missing" ||
                script.state === "new"
            ) {
                write(
                    `Error: Script #${number} has not been created yet.\r\n>`,
                );
            } else if (script.state === "verb") {
                write(
                    `Error: Script #${number} is a verb. Please use /mv age instead.\r\n>`,
                );
            } else if (script.epoch === null) {
                write(
                    `Script: ${number}\r\nName: test\r\nOwned by: W_test\r\nLast modified by:\r\nLast modified: 0\r\n>`,
                );
            } else {
                write(
                    `Script: ${number}\r\nName: test\r\nOwned by: W_test\r\nLast modified by: ${script.modifier}\r\n` +
                        (this.ssNoEpochLine
                            ? ""
                            : `Last modified: ${script.epoch}\r\n`) +
                        "On Tue Nov 14 22:13:20 2023\r\n>",
                );
            }
        };
        const handle = (command: string) => {
            if (mode === "login") {
                // The key, then the /FE: line.
                if (++loginLines === 2) mode = "game";
                return;
            }
            commands.push(command);
            if (mode === "input") {
                if (command === "") {
                    mode = "editor";
                    if (!this.hangBeforeGo || connection !== 1) write("Edt:");
                    return;
                }
                buffer.push(command);
                const failure = this.failAfterLines;
                if (
                    connection === 1 &&
                    failure &&
                    buffer.length >= failure.lines
                ) {
                    if (failure.how === "reset") socket.resetAndDestroy();
                    else socket.destroy();
                }
                return;
            }
            if (mode === "editor") {
                if (!command) {
                    write("Edt:");
                    return;
                }
                const letter = command[0].toLowerCase();
                if (letter === "z" || letter === "c") {
                    if (letter === "z") buffer = [];
                    mode = "input";
                    write(
                        letter === "z"
                            ? "READY FOR ASCII UPLOAD\r\n"
                            : "Continuing:\r\n",
                    );
                } else if (letter === "p") {
                    write(buffer.map((l) => `${l}\r\n`).join("") + "Edt:");
                } else if (letter === "g") {
                    editorWrite();
                    if (this.freezeAfterUpload !== undefined) {
                        this.frozenCsv += `script,${this.freezeAfterUpload},FROZEN,"W_GS4-B",4\n`;
                    }
                    if (this.hangAfterGo && connection === 1) return;
                    const number =
                        this.compileNumber ??
                        Number(
                            Object.keys(this.scripts).find(
                                (k) => this.scripts[Number(k)] === editing,
                            ),
                        );
                    const compiling = `Compiling GSL script: ${number} [0][/dev/S${number}]\r\n`;
                    compiled = !this.compileFails;
                    write(
                        compiling +
                            (this.compileFails
                                ? "   12 : bad token\r\nCompile Failed w/1 errors and 0 warnings.\r\nEdt:"
                                : "Compile OK.  0 Warnings.  Size: 1 bytes (of 2 available)\r\nEdt:"),
                    );
                } else if (letter === "q") {
                    editorWrite();
                    mode = "game";
                    write(
                        compiled && !this.tokenFileLost
                            ? "Compile ok.\r\n>"
                            : "Script edit aborted.\r\n>",
                    );
                }
                return;
            }
            let match: RegExpMatchArray | null;
            if (command === "quit") {
                socket.end();
            } else if ((match = command.match(/^\/ss (\d+) GS4D raw$/))) {
                const number = Number(match[1]);
                showScript(number, this.scripts[number]);
            } else if ((match = command.match(/^\/ms (\d+)$/))) {
                const number = Number(match[1]);
                const script = this.scripts[number];
                if (!script || script.state === "missing") {
                    write(
                        `Error: Script #${number} has not been created yet.\r\n>`,
                    );
                } else if (script.state === "verb") {
                    const shown = this.verbRedirectWrongScript
                        ? number + 1
                        : number;
                    write(
                        `Error: Script #${shown} is a verb. Please use /mv age instead.\r\n`,
                    );
                } else {
                    openEditor(script, number);
                }
            } else if (command === "/mv age") {
                openEditor(this.scripts[VERB_SCRIPT], VERB_SCRIPT);
            } else if (command === "/freeze list csv") {
                if (this.freezeSilent) return;
                write(
                    "CSV dump of frozen resources\r\n" +
                        this.frozenCsv.replace(/\n/g, "\r\n") +
                        "2 frozen resource(s).\r\n>",
                );
            }
        };

        let received = "";
        socket.on("error", () => {});
        socket.on("data", (data) => {
            received += data.toString();
            let nl: number;
            while ((nl = received.indexOf("\n")) > -1) {
                const command = received.slice(0, nl);
                received = received.slice(nl + 1);
                handle(command);
            }
        });
    }
}

const okUploadCommands = (script: number, text: string) => [
    "/freeze list csv",
    `/ss ${script} GS4D raw`,
    `/ms ${script}`,
    "Z",
    ...text.split("\n").slice(0, -1),
    "",
    "G",
    "Q",
    `/ms ${script}`,
    "P",
    "Q",
];

suite("Dev upload tool", function () {
    // Several tests wait out a 15s server timer.
    this.timeout(60_000);

    let home: string;
    let configPath: string;
    let filePath: string;
    let filePath2: string;
    let auditPath: string;
    let game: FakeGame;

    const writeConfig = (config: object) =>
        fs.writeFileSync(configPath, JSON.stringify(config));
    const auditEvents = () =>
        fs.existsSync(auditPath)
            ? fs
                  .readFileSync(auditPath, "utf8")
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line))
            : [];

    setup(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-dev-upload-"));
        configPath = path.join(home, "login.json");
        auditPath = path.join(home, "dev-upload-audit.log");
        filePath = path.join(home, `S${SCRIPT}.gsl`);
        filePath2 = path.join(home, `S${SCRIPT2}.gsl`);
        fs.writeFileSync(filePath, NEW_TEXT);
        fs.writeFileSync(filePath2, TEXT2);
        writeConfig({
            account: "test",
            devInstance: "GS4D",
            devCharacter: "TestChar",
        });
        game = new FakeGame();
        await game.listen();
    });

    teardown(async () => {
        game.server.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    // The preload answers the play.net login and points the game connection
    // here, so nothing can reach a live server.
    const run = (
        args: string[],
        env: NodeJS.ProcessEnv = {},
        {
            bundle = BUNDLE,
            cwd = undefined as string | undefined,
            inheritEnv = true,
        } = {},
    ) =>
        new Promise<{ result: any; code: number | null; stderr: string }>(
            (resolve, reject) => {
                const child = spawn(
                    process.execPath,
                    [
                        "--require",
                        path.resolve(__dirname, "fakePlayNetPreload.js"),
                        bundle,
                        ...args,
                    ],
                    {
                        cwd,
                        env: {
                            ...(inheritEnv ? plainEnv() : {}),
                            HOME: home,
                            USERPROFILE: home,
                            ELECTRON_RUN_AS_NODE: "1",
                            GSL_MCP_DEBUG: "",
                            GSL_LOGIN_CONFIG_FILE: "",
                            GSL_PASSWORD: "test-secret",
                            FAKE_GAME_PORT: String(game.port),
                            ...env,
                        },
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );
                let stdout = "";
                let stderr = "";
                child.stdout.on("data", (data) => (stdout += data));
                child.stderr.on("data", (data) => (stderr += data));
                child.on("error", reject);
                child.on("close", (code) => {
                    const lines = stdout.split("\n").filter(Boolean);
                    assert.strictEqual(lines.length, 1, stdout + stderr);
                    resolve({ result: JSON.parse(lines[0]), code, stderr });
                });
            },
        );
    const upload = (
        files = [filePath],
        env?: NodeJS.ProcessEnv,
        extra: string[] = expectArgs(files),
    ) => run(["upload", "--config", configPath, ...extra, ...files], env);
    const metadata = (
        scripts: string[],
        env?: NodeJS.ProcessEnv,
        extra: string[] = [],
    ) => run(["metadata", "--config", configPath, ...extra, ...scripts], env);
    const frozen = (env?: NodeJS.ProcessEnv) =>
        run(["frozen", "--config", configPath], env);

    const assertRefusedBeforeLogin = (
        { result, code, stderr }: Awaited<ReturnType<typeof run>>,
        detail: RegExp,
    ) => {
        assert.strictEqual(result.outcome, "refused", JSON.stringify(result));
        assert.match(result.detail, detail);
        assert.strictEqual(code, 1);
        assert.strictEqual(game.connections.length, 0);
        assert.ok(!stderr.includes("fake play.net connect"), stderr);
        for (const script of result.scripts) {
            assert.strictEqual(script.outcome, "not_attempted");
        }
    };
    /** In-process logins pass the Dev gate and land on the fake game. */
    const withFakeLogin = async <T>(task: () => Promise<T>): Promise<T> => {
        const originalQuickLogin = EAccessClient.quickLogin;
        EAccessClient.quickLogin = (async () => ({
            sal: { gamehost: "127.0.0.1", gameport: game.port, key: "key" },
            loginDetails: { development: true },
        })) as any;
        try {
            return await task();
        } finally {
            EAccessClient.quickLogin = originalQuickLogin;
        }
    };
    /** play.net answered, but the game server was never contacted */
    const assertRefusedAtLaunch = (
        { result, code, stderr }: Awaited<ReturnType<typeof run>>,
        detail: RegExp,
    ) => {
        assert.strictEqual(result.outcome, "refused", JSON.stringify(result));
        assert.match(result.detail, detail);
        assert.strictEqual(code, 1);
        assert.strictEqual(game.connections.length, 0);
        assert.ok(stderr.includes("fake play.net connect"), stderr);
    };

    suite("upload", () => {
        test("two scripts upload on one login, each read back", async () => {
            const { result, code } = await upload([filePath, filePath2]);

            assert.deepStrictEqual(result, {
                outcome: "ok",
                detail: "",
                scripts: [
                    {
                        outcome: "ok",
                        script: SCRIPT,
                        sha256: hash(NEW_TEXT),
                        readback_sha256: hash(NEW_TEXT),
                        detail: "Compile OK and the read-back matched.",
                    },
                    {
                        outcome: "ok",
                        script: SCRIPT2,
                        sha256: hash(TEXT2),
                        readback_sha256: hash(TEXT2),
                        detail: "Compile OK and the read-back matched.",
                    },
                ],
            });
            assert.strictEqual(code, 0);
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
            assert.strictEqual(game.scripts[SCRIPT2].text, TEXT2);
            assert.deepStrictEqual(game.connections, [
                [
                    ...okUploadCommands(SCRIPT, NEW_TEXT),
                    ...okUploadCommands(SCRIPT2, TEXT2),
                    "quit",
                ],
            ]);
            assert.deepStrictEqual(
                auditEvents().map(({ event, script }) => [event, script]),
                [
                    ["start", undefined],
                    ["sending", SCRIPT],
                    ["result", SCRIPT],
                    ["sending", SCRIPT2],
                    ["result", SCRIPT2],
                    ["end", undefined],
                ],
            );
            assert.ok(
                !fs.readFileSync(auditPath, "utf8").includes("test-secret"),
            );
        });

        test("a CRLF file uploads with the line endings folded", async () => {
            fs.writeFileSync(filePath, NEW_TEXT.replace(/\n/g, "\r\n"));

            const { result } = await upload();

            assert.strictEqual(result.outcome, "ok", JSON.stringify(result));
            assert.strictEqual(result.scripts[0].sha256, hash(NEW_TEXT));
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
        });

        test("a file without a final newline hashes as a download would", async () => {
            fs.writeFileSync(filePath, NEW_TEXT.trimEnd());

            const { result } = await upload();

            assert.strictEqual(result.outcome, "ok");
            assert.strictEqual(result.scripts[0].sha256, hash(NEW_TEXT));
        });

        test("a failed compile stops the run with the rest not attempted", async () => {
            game.compileFails = true;

            const { result, code } = await upload([filePath, filePath2]);

            assert.strictEqual(result.outcome, "compile_failed");
            const [first, second] = result.scripts;
            assert.strictEqual(first.outcome, "compile_failed");
            assert.strictEqual(first.readback_sha256, hash(NEW_TEXT));
            assert.match(first.detail, /line 12: bad token/);
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
            assert.strictEqual(second.outcome, "not_attempted");
            assert.strictEqual(code, 1);
            assert.strictEqual(game.connections.length, 1);
            assert.ok(!game.connections[0].includes(`/ss ${SCRIPT2} GS4D raw`));
            assert.strictEqual(game.scripts[SCRIPT2].text, "x\n");
        });

        test("a failed compile that left other text on Dev is unknown", async () => {
            game.compileFails = true;
            game.writtenText = DEV_TEXT;

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.match(
                result.scripts[0].detail,
                /Dev does not hold the sent text/,
            );
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(DEV_TEXT),
            );
        });

        test("a zero-padded file name uploads as that script", async () => {
            const padded = path.join(home, `S0${SCRIPT2}.gsl`);
            fs.writeFileSync(padded, TEXT2);

            const { result } = await upload([padded]);

            assert.strictEqual(result.outcome, "ok", JSON.stringify(result));
            assert.strictEqual(result.scripts[0].script, SCRIPT2);
        });

        test("a closed stdin pipe drops the upload unwritten", async () => {
            game.hangBeforeGo = true;
            const child = spawn(
                process.execPath,
                [
                    "--require",
                    path.resolve(__dirname, "fakePlayNetPreload.js"),
                    BUNDLE,
                    "upload",
                    "--config",
                    configPath,
                    ...expectArgs([filePath]),
                    filePath,
                ],
                {
                    env: {
                        ...plainEnv(),
                        ELECTRON_RUN_AS_NODE: "1",
                        GSL_PASSWORD: "test-secret",
                        FAKE_GAME_PORT: String(game.port),
                    },
                    stdio: ["pipe", "pipe", "pipe"],
                },
            );
            let stdout = "";
            child.stdout.on("data", (data) => (stdout += data));
            // Wait until the text is in the editor, then let the parent "die".
            await new Promise<void>((resolve) => {
                const poll = setInterval(() => {
                    if (game.connections[0]?.includes("")) {
                        clearInterval(poll);
                        resolve();
                    }
                }, 20);
            });
            const started = performance.now();
            child.stdin.end();
            const code = await new Promise((resolve) =>
                child.on("close", resolve),
            );

            assert.ok(
                performance.now() - started < 10_000,
                "aborted before the 15s timer",
            );
            const result = JSON.parse(stdout.trim());
            assert.strictEqual(code, 1);
            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.match(result.scripts[0].detail, /stdin closed/);
            // A dead parent gets no read-back login either.
            assert.strictEqual(result.scripts[0].readback_sha256, null);
            assert.strictEqual(game.connections.length, 1);
            assert.ok(!game.connections[0].includes("G"));
            assert.ok(!game.connections[0].includes("Q"));
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
        });

        test("a compile OK for another script is unknown", async () => {
            game.compileNumber = SCRIPT + 1;

            const { result } = await upload();

            assert.strictEqual(result.outcome, "unknown");
            assert.match(
                result.scripts[0].detail,
                /did not compile and go live/,
            );
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(NEW_TEXT),
            );
        });

        test("a compile OK that never goes live is unknown", async () => {
            game.tokenFileLost = true;

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.match(
                result.scripts[0].detail,
                /did not compile and go live/,
            );
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(NEW_TEXT),
            );
        });

        test("a read-back that differs from the sent text is unknown", async () => {
            game.writtenText = "the server changed this\n";

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(game.writtenText),
            );
            assert.strictEqual(game.connections.length, 1);
        });

        test("a dropped connection reads back on a new login and stops", async () => {
            game.failAfterLines = { lines: 1, how: "drop" };

            const { result } = await upload([filePath, filePath2]);

            assert.strictEqual(result.outcome, "unknown");
            const [first, second] = result.scripts;
            assert.strictEqual(first.outcome, "unknown");
            assert.strictEqual(first.readback_sha256, hash(DEV_TEXT));
            assert.match(first.detail, /Dev does not hold the sent text/);
            assert.strictEqual(second.outcome, "not_attempted");
            assert.deepStrictEqual(game.connections[1], [
                `/ms ${SCRIPT}`,
                "P",
                "Q",
                "quit",
            ]);
            assert.strictEqual(game.connections.length, 2);
            const results = auditEvents().filter(
                ({ event }) => event === "result",
            );
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].outcome, "unknown");
        });

        test("a silent server before G gets no G, Q or quit", async () => {
            game.hangBeforeGo = true;

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(DEV_TEXT),
            );
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.deepStrictEqual(game.connections[0], [
                "/freeze list csv",
                `/ss ${SCRIPT} GS4D raw`,
                `/ms ${SCRIPT}`,
                "Z",
                ...NEW_TEXT.split("\n").slice(0, -1),
                "",
            ]);
        });

        test("a reset connection never resends", async () => {
            game.failAfterLines = { lines: 1, how: "reset" };

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(DEV_TEXT),
            );
            assert.strictEqual(game.connections.length, 2);
            assert.deepStrictEqual(game.connections[1], [
                `/ms ${SCRIPT}`,
                "P",
                "Q",
                "quit",
            ]);
        });

        test("a silent server after G is dropped after 30s without typing Q or quit", async () => {
            game.hangAfterGo = true;
            const started = performance.now();

            const { result } = await upload();

            assert.ok(
                performance.now() - started >= 30_000,
                "the upload timer is 30s",
            );
            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.strictEqual(
                result.scripts[0].readback_sha256,
                hash(NEW_TEXT),
            );
            assert.match(result.scripts[0].detail, /Dev holds the sent text/);
            assert.deepStrictEqual(game.connections[0], [
                "/freeze list csv",
                `/ss ${SCRIPT} GS4D raw`,
                `/ms ${SCRIPT}`,
                "Z",
                ...NEW_TEXT.split("\n").slice(0, -1),
                "",
                "G",
            ]);
        });

        test("the outcome is unknown when the read-back login fails too", async () => {
            game.failAfterLines = { lines: 1, how: "drop" };
            const connected = new Promise<void>((resolve) =>
                game.server.once("connection", () => resolve()),
            );
            const uploading = upload();
            await connected;
            // The first connection is already accepted; refuse the read-back.
            game.server.close();

            const { result } = await uploading;

            assert.strictEqual(result.scripts[0].outcome, "unknown");
            assert.strictEqual(result.scripts[0].readback_sha256, null);
            assert.match(result.scripts[0].detail, /Read-back failed/);
        });

        for (const [name, text, detail] of [
            ["an empty file", "", /line 1: blank line/],
            ["a blank line", "first\n\nthird\n", /line 2: blank line/],
            ["a whitespace-only line", "first\n \t\n", /line 2: blank line/],
            ["a trailing blank line", "first\n\n", /line 2: blank line/],
            ["a leading ~", "first\n~second\n", /line 2: starts with ~/],
            [
                "trailing whitespace on the last line",
                "first\nsecond  \n",
                /line 2: trailing whitespace on last line/,
            ],
            [
                "a script too long for the editor",
                "x\n".repeat(39_999),
                /39999 lines, limit 39998/,
            ],
            [
                "a line over 118 characters",
                `${"x".repeat(119)}\n`,
                /line 1: 119 characters, limit 118/,
            ],
            [
                "a lone CR",
                "first\rsecond\n",
                /line 1: character U\+000D at column 6/,
            ],
            [
                "a non-ASCII character",
                "first\nsec\u00a0ond\n",
                /line 2: character U\+00A0 at column 4/,
            ],
        ] as const) {
            test(`${name} is refused before login`, async () => {
                fs.writeFileSync(filePath, text);

                const refused = await upload([filePath, filePath2]);

                assertRefusedBeforeLogin(refused, detail);
                assert.deepStrictEqual(
                    refused.result.scripts.map(({ script }: any) => script),
                    [SCRIPT, SCRIPT2],
                );
            });
        }

        test("a line of exactly 118 characters is allowed", async () => {
            fs.writeFileSync(filePath, `${"x".repeat(118)}\n`);

            const { result } = await upload();

            assert.strictEqual(result.outcome, "ok");
        });

        test("every refused line is listed, up to a limit", async () => {
            fs.writeFileSync(filePath, "~a\n".repeat(25));

            const { result } = await upload();

            assert.match(result.detail, /line 20: starts with ~; 5 more$/);
        });

        test("a symlinked file is refused before login", async () => {
            const target = path.join(home, "target.gsl");
            fs.writeFileSync(target, NEW_TEXT);
            fs.rmSync(filePath);
            fs.symlinkSync(target, filePath);

            assertRefusedBeforeLogin(await upload(), /symlink/);
        });

        test("a file not named S<number>.gsl is refused before login", async () => {
            const other = path.join(home, "notes.gsl");
            fs.writeFileSync(other, NEW_TEXT);

            assertRefusedBeforeLogin(await upload([other]), /S<number>\.gsl/);
            assertRefusedBeforeLogin(
                await upload([filePath, filePath]),
                /listed twice/,
            );
            assertRefusedBeforeLogin(await upload([]), /at least one/);
        });

        test("a frozen script is refused with nothing sent", async () => {
            game.frozenCsv += `script,${SCRIPT},FROZEN,"W_GS4-A",4\n`;

            const { result, code } = await upload([filePath, filePath2]);

            assert.strictEqual(result.outcome, "refused");
            assert.strictEqual(result.scripts[0].outcome, "refused");
            assert.strictEqual(
                result.scripts[0].detail,
                "Nothing was uploaded: Dev reports the script as FROZEN.",
            );
            assert.strictEqual(result.scripts[1].outcome, "not_attempted");
            assert.strictEqual(code, 1);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.deepStrictEqual(game.connections, [
                ["/freeze list csv", "quit"],
            ]);
            assert.deepStrictEqual(
                auditEvents().map(({ event }) => event),
                ["start", "end"],
            );
        });

        test("a locked script, and one frozen through its verb, are refused", async () => {
            game.frozenCsv +=
                `script,${SCRIPT},LOCKED,"W_GS4-C",5\n` +
                'verb,age,FROZEN,"W_GS4-B",4\n' +
                `verb_script,${SCRIPT2},FROZEN,"W_GS4-B",4\n`;

            const { result } = await upload([filePath, filePath2]);
            const { result: viaVerb } = await upload([filePath2]);

            assert.strictEqual(result.scripts[0].outcome, "refused");
            assert.match(result.scripts[0].detail, /as LOCKED\./);
            assert.strictEqual(result.scripts[1].outcome, "not_attempted");
            assert.strictEqual(viaVerb.scripts[0].outcome, "refused");
            assert.match(viaVerb.scripts[0].detail, /as FROZEN\./);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.strictEqual(game.scripts[SCRIPT2].text, "x\n");
        });

        test("a script frozen after an earlier upload is refused when its turn comes", async () => {
            game.freezeAfterUpload = SCRIPT2;

            const { result, code } = await upload([filePath, filePath2]);

            assert.strictEqual(result.outcome, "refused");
            assert.strictEqual(result.scripts[0].outcome, "ok");
            assert.strictEqual(result.scripts[1].outcome, "refused");
            assert.match(result.scripts[1].detail, /as FROZEN\./);
            assert.strictEqual(code, 1);
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
            assert.strictEqual(game.scripts[SCRIPT2].text, "x\n");
            assert.deepStrictEqual(game.connections, [
                [
                    ...okUploadCommands(SCRIPT, NEW_TEXT),
                    "/freeze list csv",
                    "quit",
                ],
            ]);
        });

        test("a /freeze read that fails refuses the script unwritten", async () => {
            game.freezeSilent = true;

            const { result, code } = await upload([filePath, filePath2]);

            assert.strictEqual(result.outcome, "refused");
            assert.strictEqual(result.scripts[0].outcome, "refused");
            assert.match(result.scripts[0].detail, /^Nothing was uploaded: /);
            assert.match(result.scripts[0].detail, /timed out/);
            assert.strictEqual(result.scripts[1].outcome, "not_attempted");
            assert.strictEqual(code, 1);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.deepStrictEqual(game.connections, [["/freeze list csv"]]);
        });

        test("a script missing on Dev is refused with nothing sent", async () => {
            game.scripts[SCRIPT].state = "missing";

            const { result } = await upload([filePath, filePath2]);

            assert.strictEqual(result.scripts[0].outcome, "refused");
            assert.match(result.scripts[0].detail, /reports it as missing/);
            assert.strictEqual(result.scripts[1].outcome, "not_attempted");
            assert.deepStrictEqual(game.connections, [
                ["/freeze list csv", `/ss ${SCRIPT} GS4D raw`, "quit"],
            ]);
        });

        test("a script with a record but no source is never created here", async () => {
            game.scripts[SCRIPT].state = "new";

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "refused");
            assert.deepStrictEqual(game.connections, [
                ["/freeze list csv", `/ss ${SCRIPT} GS4D raw`, "quit"],
            ]);
            assert.strictEqual(game.scripts[SCRIPT].state, "new");
        });

        test("a script that /ss and /ms disagree about is dropped with no text or Q", async () => {
            game.scripts[SCRIPT].state = "stale_new";

            const { result } = await upload();

            assert.strictEqual(result.scripts[0].outcome, "refused");
            assert.match(result.scripts[0].detail, /disagrees/);
            assert.deepStrictEqual(game.connections, [
                [
                    "/freeze list csv",
                    `/ss ${SCRIPT} GS4D raw`,
                    `/ms ${SCRIPT}`,
                    "",
                ],
            ]);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
        });

        test("--expect is required, one epoch per script, digits only", async () => {
            for (const [extra, detail] of [
                [[], /--expect 12345=<epoch> is required/],
                [expectArgs([filePath]), /--expect 12346=<epoch> is required/],
                [
                    [
                        ...expectArgs([filePath]),
                        "--expect",
                        `${SCRIPT2}=W_test`,
                    ],
                    /<number>=<epoch>/,
                ],
                [
                    [
                        ...expectArgs([filePath]),
                        "--expect",
                        `${SCRIPT2}=missing`,
                    ],
                    /<number>=<epoch>/,
                ],
                [
                    [...expectArgs([filePath]), "--expect", `${SCRIPT2}=0x1`],
                    /<number>=<epoch>/,
                ],
            ] as const) {
                const refused = await upload([filePath, filePath2], undefined, [
                    ...extra,
                ]);
                assertRefusedBeforeLogin(refused, detail);
                assert.deepStrictEqual(
                    refused.result.scripts.map(({ script }: any) => script),
                    [SCRIPT, SCRIPT2],
                );
            }
        });

        test("--expect with the listed epochs uploads", async () => {
            const { result } = await upload([filePath, filePath2], undefined, [
                "--expect",
                `${SCRIPT}=${EPOCH}`,
                "--expect",
                `${SCRIPT2}=${EPOCH}`,
            ]);

            assert.strictEqual(result.outcome, "ok", JSON.stringify(result));
        });

        for (const [name, expect, change] of [
            ["a stale epoch", `${SCRIPT}=${EPOCH}`, { epoch: EPOCH + 1 }],
            [
                "an epoch for blank metadata",
                `${SCRIPT}=${EPOCH}`,
                { epoch: null },
            ],
            ["an epoch for a verb", `${VERB_SCRIPT}=${EPOCH}`, {}],
            [
                "an epoch for a missing script",
                `${SCRIPT}=${EPOCH}`,
                { state: "missing" },
            ],
        ] as const) {
            test(`--expect with ${name} is refused with nothing sent`, async () => {
                const script = Number(expect.split("=")[0]);
                const file = path.join(home, `S${script}.gsl`);
                fs.writeFileSync(file, NEW_TEXT);
                Object.assign(game.scripts[script], change);

                const { result } = await upload([file], undefined, [
                    "--expect",
                    expect,
                ]);

                assert.strictEqual(
                    result.scripts[0].outcome,
                    "refused",
                    JSON.stringify(result),
                );
                assert.deepStrictEqual(game.connections, [
                    ["/freeze list csv", `/ss ${script} GS4D raw`, "quit"],
                ]);
            });
        }

        test("--expect 0 matches blank metadata", async () => {
            game.scripts[SCRIPT].epoch = null;

            const { result } = await upload([filePath], undefined, [
                "--expect",
                `${SCRIPT}=0`,
            ]);

            assert.strictEqual(result.outcome, "ok", JSON.stringify(result));
        });

        test("a modifier with no date is refused as uncheckable, whatever --expect says", async () => {
            for (const [noDate, expected] of [
                ["no line", 0],
                ["empty line", 0],
                ["no line", EPOCH],
            ] as const) {
                game.connections.length = 0;
                game.ssNoEpochLine = noDate === "no line";
                game.scripts[SCRIPT].epoch = 0;

                const { result } = await upload([filePath], undefined, [
                    "--expect",
                    `${SCRIPT}=${expected}`,
                ]);

                assert.strictEqual(
                    result.scripts[0].outcome,
                    "refused",
                    `${noDate}, expected ${expected}`,
                );
                assert.strictEqual(
                    result.scripts[0].detail,
                    "Nothing was uploaded: Dev shows a modifier but no date, which --expect cannot check.",
                );
                assert.doesNotMatch(result.scripts[0].detail, /changed/);
                assert.deepStrictEqual(game.connections, [
                    ["/freeze list csv", `/ss ${SCRIPT} GS4D raw`, "quit"],
                ]);
            }
        });

        test("an agent session is refused before login", async () => {
            assertRefusedBeforeLogin(
                await upload([filePath], { CLAUDECODE: "1" }),
                /agent session: environment variables CLAUDECODE are set/,
            );
        });

        test("--expect for a script not in the run is refused before login", async () => {
            assertRefusedBeforeLogin(
                await upload([filePath], undefined, [
                    "--expect",
                    `${SCRIPT}=1`,
                    "--expect",
                    `${SCRIPT}=2`,
                ]),
                /names script 12345 twice/,
            );
            assertRefusedBeforeLogin(
                await upload([filePath], undefined, [
                    "--expect",
                    `${SCRIPT2}=1`,
                ]),
                /--expect/,
            );
            assertRefusedBeforeLogin(
                await upload([filePath], undefined, ["--expect", "nonsense"]),
                /--expect/,
            );
        });

        test("an unwritable audit log refuses before login", async () => {
            fs.mkdirSync(auditPath);

            assertRefusedBeforeLogin(
                await upload(),
                /EISDIR|illegal operation/,
            );

            // Opens, then every write fails, as a full disk would.
            if (fs.existsSync("/dev/full")) {
                assertRefusedBeforeLogin(
                    await upload([filePath], undefined, [
                        ...expectArgs([filePath]),
                        "--audit-log",
                        "/dev/full",
                    ]),
                    /Audit log write failed/,
                );
            }
        });

        test("a failed sending audit record stops before /ms", async () => {
            const audit = new AuditLog(auditPath, (text) => text);
            const record = audit.record.bind(audit);
            audit.record = (fields) => {
                // The disk fills after the start record.
                if (fields.event === "sending") fs.closeSync((audit as any).fd);
                record(fields);
            };
            const login = devLogin(configPath, { GSL_PASSWORD: "test-secret" });

            const { detail, scripts } = await withFakeLogin(() =>
                uploadSession({
                    login,
                    files: loadScriptFiles([filePath, filePath2]),
                    expected: [{ epoch: EPOCH }, { epoch: EPOCH }],
                    audit,
                }),
            );

            assert.strictEqual(scripts[0].outcome, "refused");
            assert.match(scripts[0].detail, /audit log write failed/);
            assert.strictEqual(scripts[1].outcome, "not_attempted");
            assert.match(detail, /Audit log write failed/);
            assert.deepStrictEqual(game.connections, [
                ["/freeze list csv", `/ss ${SCRIPT} GS4D raw`, "quit"],
            ]);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
        });

        test("debug logging stays off and no credential is printed", async () => {
            const { result, stderr } = await upload([filePath], {
                GSL_MCP_DEBUG: "1",
            });

            assert.strictEqual(result.outcome, "ok");
            assert.ok(!stderr.includes("Connection#"), stderr);
            assert.ok(!stderr.includes("test-secret"), stderr);
            assert.ok(!JSON.stringify(result).includes("test-secret"));
        });

        test("an audit log that fails mid-run keeps the real results", async () => {
            const audit = new AuditLog(auditPath, (text) => text);
            const record = audit.record.bind(audit);
            audit.record = (fields) => {
                record(fields);
                // The next write fails, as a full disk would make it.
                if (fields.event === "sending") fs.closeSync((audit as any).fd);
            };
            const login = devLogin(configPath, { GSL_PASSWORD: "test-secret" });

            const { detail, scripts } = await withFakeLogin(() =>
                uploadSession({
                    login,
                    files: loadScriptFiles([filePath]),
                    expected: [{ epoch: EPOCH }],
                    audit,
                }),
            );

            assert.strictEqual(scripts[0].outcome, "ok");
            assert.strictEqual(scripts[0].readback_sha256, hash(NEW_TEXT));
            assert.match(detail, /Audit log write failed/);
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
            audit.close();
        });
    });

    suite("Dev gate", () => {
        for (const [name, config] of [
            ["GS4 Prime", { devInstance: "GS4", devCharacter: "TestChar" }],
            ["DR Dev", { devInstance: "DRD", devCharacter: "TestChar" }],
            [
                "a lower-case game code",
                { devInstance: "gs4d", devCharacter: "TestChar" },
            ],
        ] as const) {
            test(`${name} is refused before login`, async () => {
                writeConfig({ account: "test", ...config });

                assertRefusedBeforeLogin(await upload(), /only runs on GS4D/);
                assertRefusedBeforeLogin(
                    await metadata([String(SCRIPT)]),
                    /only runs on GS4D/,
                );
                assertRefusedBeforeLogin(await frozen(), /only runs on GS4D/);
            });
        }

        test("a game EAccess does not report as DEVELOPMENT is refused", async () => {
            assertRefusedAtLaunch(
                await upload([filePath], { FAKE_GAME_TYPE: "PRODUCTION" }),
                /not report GS4D as DEVELOPMENT/,
            );
        });

        test("a config without exactly one dev character is refused", async () => {
            writeConfig({
                account: "test",
                primeInstance: "GS4",
                primeCharacter: "A",
            });
            assertRefusedBeforeLogin(
                await upload(),
                /exactly one dev character/,
            );

            writeConfig({
                account: "test",
                devInstance: "GS4D",
                devCharacters: ["TestChar", "Other"],
            });
            assertRefusedBeforeLogin(
                await upload(),
                /exactly one dev character/,
            );
        });

        test("a malformed config never quotes its account", async () => {
            fs.writeFileSync(configPath, '{"account":bob-acct,}');

            const refused = await upload();

            assertRefusedBeforeLogin(
                refused,
                new RegExp(
                    `^Login config file at .*login\\.json is not valid JSON\\.$`,
                ),
            );
            assert.ok(!refused.result.detail.includes("bob-acct"));
        });

        test("a non-string account is refused instead of crashing", async () => {
            writeConfig({
                account: 123,
                devInstance: "GS4D",
                devCharacter: "TestChar",
            });

            assertRefusedBeforeLogin(
                await upload(),
                /account must be a string/,
            );
        });

        test("a missing password or config is refused before login, in words for any caller", async () => {
            assertRefusedBeforeLogin(
                await upload([filePath], { GSL_PASSWORD: "" }),
                /^GSL_PASSWORD environment variable is not set\. It holds the play\.net password\.$/,
            );
            const missing = path.join(home, "missing.json");
            assertRefusedBeforeLogin(
                await run(["frozen", "--config", missing]),
                new RegExp(
                    `^Login config file not found at .*missing\\.json\\. Run 'GSL: User Setup'`,
                ),
            );
            assertRefusedBeforeLogin(
                await run(["upload", ...expectArgs([filePath]), filePath]),
                /Pass --config <loginConfig.json> or set GSL_LOGIN_CONFIG_FILE/,
            );
        });

        test("GSL_LOGIN_CONFIG_FILE stands in for --config", async () => {
            const { result } = await run(["frozen"], {
                GSL_LOGIN_CONFIG_FILE: configPath,
            });

            assert.deepStrictEqual(result, {
                outcome: "ok",
                detail: "",
                scripts: [],
            });
        });

        test("version needs no config, login or connection", async () => {
            const { result, code } = await run(
                ["version"],
                { GSL_PASSWORD: "", PATH: process.env.PATH },
                { inheritEnv: false },
            );

            assert.deepStrictEqual(result, {
                outcome: "ok",
                detail: "",
                tool: "gsl-dev-upload",
                interface: 1,
            });
            assert.strictEqual(code, 0);
            assert.strictEqual(game.connections.length, 0);
            assertRefusedBeforeLogin(await run(["version", "x"]), /Usage/);
        });

        test("bad commands and arguments are refused before login", async () => {
            assertRefusedBeforeLogin(await run([]), /Usage/);
            assertRefusedBeforeLogin(await run(["compile", filePath]), /Usage/);
            assertRefusedBeforeLogin(
                await run(["frozen", "--config", configPath, "x"]),
                /Usage/,
            );
            assertRefusedBeforeLogin(await run(["--bogus"]), /bogus/);
            assertRefusedBeforeLogin(
                await metadata(["abc"]),
                /not a script number/,
            );
            assertRefusedBeforeLogin(
                await metadata(["0"]),
                /0 is not a script number/,
            );
            assertRefusedBeforeLogin(
                await metadata(["1234567"]),
                /not a script number/,
            );
            assertRefusedBeforeLogin(await metadata([]), /at least one/);
            assertRefusedBeforeLogin(
                await metadata([String(SCRIPT)], undefined, [
                    "--expect",
                    "1=2",
                ]),
                /--expect is only for upload/,
            );
        });
    });

    suite("metadata", () => {
        test("a zero-padded number is that script, as a file name is", async () => {
            const { result, code } = await metadata([`0${SCRIPT}`]);

            assert.strictEqual(code, 0, JSON.stringify(result));
            assert.strictEqual(result.scripts[0].script, SCRIPT);
            assert.strictEqual(result.scripts[0].status, "ok");
            assert.deepStrictEqual(game.connections, [
                [`/ss ${SCRIPT} GS4D raw`, "quit"],
            ]);
        });

        test("reports each script's status on one login", async () => {
            game.scripts[SCRIPT2].epoch = null;
            game.scripts[1] = {
                text: "",
                state: "missing",
                modifier: "",
                epoch: null,
            };

            const { result, code } = await metadata([
                String(SCRIPT),
                String(SCRIPT2),
                "1",
                String(VERB_SCRIPT),
            ]);

            assert.deepStrictEqual(result, {
                outcome: "ok",
                detail: "",
                scripts: [
                    {
                        outcome: "ok",
                        script: SCRIPT,
                        status: "ok",
                        modifier: "W_test",
                        epoch: EPOCH,
                        detail: "",
                    },
                    {
                        outcome: "ok",
                        script: SCRIPT2,
                        status: "blank",
                        modifier: null,
                        epoch: 0,
                        detail: "",
                    },
                    {
                        outcome: "ok",
                        script: 1,
                        status: "missing",
                        modifier: null,
                        epoch: null,
                        detail: "",
                    },
                    {
                        outcome: "ok",
                        script: VERB_SCRIPT,
                        status: "verb",
                        modifier: null,
                        epoch: null,
                        detail: "",
                    },
                ],
            });
            assert.strictEqual(code, 0);
            assert.deepStrictEqual(game.connections, [
                [
                    `/ss ${SCRIPT} GS4D raw`,
                    `/ss ${SCRIPT2} GS4D raw`,
                    "/ss 1 GS4D raw",
                    `/ss ${VERB_SCRIPT} GS4D raw`,
                    "quit",
                ],
            ]);
        });

        test("a /ss timeout is unavailable and skips the rest", async () => {
            game.ssSilent.add(SCRIPT);

            const { result, code } = await metadata([
                String(SCRIPT),
                String(SCRIPT2),
            ]);

            assert.strictEqual(result.outcome, "unknown");
            const [first, second] = result.scripts;
            assert.strictEqual(first.outcome, "unknown");
            assert.strictEqual(first.status, "unavailable");
            assert.match(first.detail, /timed out/);
            assert.strictEqual(second.outcome, "not_attempted");
            assert.strictEqual(second.status, "unavailable");
            assert.match(
                second.detail,
                /Skipped after an earlier \/ss timeout/,
            );
            assert.strictEqual(code, 1);
            assert.ok(!game.connections[0].includes(`/ss ${SCRIPT2} GS4D raw`));
        });

        test("a login failure lists every script as not attempted", async () => {
            game.silent = true;

            const { result, code } = await metadata([
                String(SCRIPT),
                String(SCRIPT2),
            ]);

            assert.strictEqual(result.outcome, "unknown");
            assert.match(result.detail, /timed out/);
            assert.deepStrictEqual(
                result.scripts.map(({ script, outcome }: any) => [
                    script,
                    outcome,
                ]),
                [
                    [SCRIPT, "not_attempted"],
                    [SCRIPT2, "not_attempted"],
                ],
            );
            assert.strictEqual(code, 1);
        });
    });

    suite("frozen", () => {
        test("lists frozen, locked and verb scripts", async () => {
            game.frozenCsv =
                "type,id,status,gm,access\n" +
                'script,17323,FROZEN,"W_GS4-A",4\n' +
                'verb,age,FROZEN,"W_GS4-B",4\n' +
                'verb_script,13693,FROZEN,"W_GS4-B",4\n' +
                'verb,curtsey,FROZEN,"W_GS4-B",4\n' +
                'verb_script,0,FROZEN,"W_GS4-B",4\n' +
                'script,18000,LOCKED,"W_GS4-C",5\n' +
                'segment,501,FROZEN,"W_GS4-C",4\n';

            const { result, code } = await frozen();

            assert.deepStrictEqual(
                {
                    ...result,
                    scripts: result.scripts.sort(
                        (a: any, b: any) => a.script - b.script,
                    ),
                },
                {
                    outcome: "ok",
                    detail: "",
                    scripts: [
                        { script: 13693, status: "FROZEN" },
                        { script: 17323, status: "FROZEN" },
                        { script: 18000, status: "LOCKED" },
                    ],
                },
            );
            assert.strictEqual(code, 0);
            assert.deepStrictEqual(game.connections, [
                ["/freeze list csv", "quit"],
            ]);
        });

        test("a verb row without its verb_script row is skipped", async () => {
            game.frozenCsv =
                "type,id,status,gm,access\n" +
                'script,17323,FROZEN,"W_GS4-A",4\n' +
                'verb,age,FROZEN,"W_GS4-A",4\n' +
                'verb,bow,FROZEN,"W_GS4-B",4\n' +
                'verb_script,13693,FROZEN,"W_GS4-B",4\n' +
                'verb,curtsey,FROZEN,"W_GS4-C",4\n';

            const { result, code } = await frozen();

            assert.deepStrictEqual(
                {
                    ...result,
                    scripts: result.scripts.sort(
                        (a: any, b: any) => a.script - b.script,
                    ),
                },
                {
                    outcome: "ok",
                    detail: "",
                    scripts: [
                        { script: 13693, status: "FROZEN" },
                        { script: 17323, status: "FROZEN" },
                    ],
                },
            );
            assert.strictEqual(code, 0);
        });

        test("a failed list is unknown with no scripts", async () => {
            game.silent = true;

            const { result, code } = await frozen();

            assert.deepStrictEqual(
                { ...result, detail: "" },
                { outcome: "unknown", detail: "", scripts: [] },
            );
            assert.match(result.detail, /timed out/);
            assert.strictEqual(code, 1);
        });

        test("the MCP bundle carries none of this tool", () => {
            const mcpBundle = fs.readFileSync(
                path.resolve(__dirname, "../../gsl/mcp/mcpServer.bundle.js"),
                "utf8",
            );
            for (const marker of [
                "dev-upload-audit",
                "not_attempted",
                " to dev'",
            ]) {
                assert.ok(!mcpBundle.includes(marker), marker);
            }
            assert.ok(
                fs.readFileSync(BUNDLE, "utf8").includes("dev-upload-audit"),
            );
        });

        test("the bundle runs alone, without node_modules or vscode", async () => {
            const alone = fs.mkdtempSync(
                path.join(os.tmpdir(), "gsl-bundle-alone-"),
            );
            try {
                const bundle = path.join(alone, "devUpload.bundle.js");
                fs.copyFileSync(BUNDLE, bundle);
                assert.ok(!fs.existsSync(path.join(alone, "node_modules")));
                assert.ok(
                    fs.readFileSync(bundle, "utf8").includes("--audit-log"),
                );
                const minimalEnv = {
                    PATH: process.env.PATH,
                    HOME: home,
                    GSL_PASSWORD: "test-secret",
                    ELECTRON_RUN_AS_NODE: "1",
                    FAKE_GAME_PORT: String(game.port),
                };

                const { result, stderr } = await run(
                    [
                        "upload",
                        "--config",
                        configPath,
                        "--audit-log",
                        auditPath,
                        ...expectArgs([filePath]),
                        filePath,
                    ],
                    minimalEnv,
                    { bundle, cwd: alone, inheritEnv: false },
                );

                assert.strictEqual(
                    result.outcome,
                    "ok",
                    JSON.stringify(result),
                );
                assert.ok(stderr.length < 1024 * 1024);
            } finally {
                fs.rmSync(alone, { recursive: true, force: true });
            }
        });
    });

    suite("one-shot client", () => {
        const login = () => ({
            ...devLogin(configPath, { GSL_PASSWORD: "test-secret" }),
            requireDevelopment: true as const,
        });

        test("a task that leaves the editor open is dropped, not quit", async () => {
            const result = await withFakeLogin(() =>
                withOneShotEditorClient(login(), async (client) => {
                    await client.modifyScript(SCRIPT, true);
                    return "left open";
                }),
            );

            assert.strictEqual(result, "left open");
            assert.deepStrictEqual(game.connections, [[`/ms ${SCRIPT}`]]);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
        });

        test("nested reconnect suspension keeps reconnect off", async () => {
            const suspended = await withFakeLogin(() =>
                withOneShotEditorClient(login(), async (client) => {
                    const inner = client as any;
                    await inner.withAutoReconnectSuspended(async () => {});
                    return inner.autoReconnectSuspended;
                }),
            );

            assert.strictEqual(suspended, true);
        });

        test("sendScript keeps the 15s default the extension uses", async () => {
            game.hangBeforeGo = true;
            const started = performance.now();

            await withFakeLogin(() =>
                withOneShotEditorClient(login(), async (client) => {
                    await client.modifyScript(SCRIPT, true);
                    await assert.rejects(
                        client.sendScript(["x", ""], false),
                        /Script upload timed out/,
                    );
                }),
            );

            // Under the upload tool's 30s, so this is the 15s default.
            const elapsed = performance.now() - started;
            assert.ok(elapsed >= 15_000 && elapsed < 30_000, `${elapsed}ms`);
        });
    });

    suite("interactive", () => {
        const tty = () => Object.assign(new PassThrough(), { isTTY: true });
        const io = (
            overrides: Partial<Parameters<typeof guardReason>[0]> = {},
        ) => ({
            env: { GSL_PASSWORD: "test-secret" } as NodeJS.ProcessEnv,
            stdin: tty() as unknown as NodeJS.ReadStream,
            stdout: tty(),
            stderr: new PassThrough(),
            ancestors: [] as string[],
            ...overrides,
        });

        /** The bundle without a terminal; the fake game is never reached. */
        const spawned = (args: string[]) =>
            new Promise<{
                code: number | null;
                stdout: string;
                stderr: string;
            }>((resolve) => {
                const child = spawn(
                    process.execPath,
                    [BUNDLE, "interactive", ...args],
                    {
                        env: { ...plainEnv(), GSL_PASSWORD: "test-secret" },
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );
                let stdout = "";
                let stderr = "";
                child.stdout.on("data", (data) => (stdout += data));
                child.stderr.on("data", (data) => (stderr += data));
                child.on("close", (code) => resolve({ code, stdout, stderr }));
            });

        test("an argument error is REFUSED on stderr, not a JSON line", async () => {
            for (const args of [
                ["--expect", "1=2", filePath],
                ["--conifg", configPath, filePath],
            ]) {
                const { code, stdout, stderr } = await spawned(args);

                assert.strictEqual(code, 1, args.join(" "));
                assert.strictEqual(stdout, "", stdout);
                assert.match(
                    stderr,
                    args[0] === "--expect"
                        ? /^REFUSED: --expect is only for upload\.\n$/
                        : /^REFUSED: Unknown option '--conifg'/,
                );
            }
            assert.strictEqual(game.connections.length, 0);
        });

        test("refuses without a terminal, from the spawned bundle", async () => {
            const { code, stdout, stderr } = await spawned([
                "--config",
                configPath,
                filePath,
            ]);

            assert.strictEqual(code, 1);
            assert.strictEqual(stdout, "", stdout);
            assert.match(
                stderr,
                /REFUSED: stdin and stdout must both be an interactive terminal/,
            );
            assert.strictEqual(game.connections.length, 0);
        });

        test("refuses an agent session by environment or parent process", () => {
            const ancestors = processAncestors();
            assert.ok(Array.isArray(ancestors));
            if (process.platform === "linux") assert.ok(ancestors.length > 0);
            assert.strictEqual(guardReason(io()), undefined);
            assert.match(
                guardReason(io({ stdout: new PassThrough() }))!,
                /interactive terminal/,
            );
            assert.match(
                guardReason(
                    io({ env: { CLAUDECODE: "1", GSL_PASSWORD: "x" } }),
                )!,
                /environment variables are present \(CLAUDECODE\)/,
            );
            assert.match(
                guardReason(io({ env: { CLAUDE_CODE_FOO: "1" } }))!,
                /CLAUDE_CODE_FOO/,
            );
            assert.match(
                guardReason(io({ env: { CODEX_THREAD_ID: "1" } }))!,
                /CODEX_THREAD_ID/,
            );
            assert.match(
                guardReason(io({ ancestors: ["bash", "/usr/bin/claude"] }))!,
                /under an agent process/,
            );
            assert.match(
                guardReason(
                    io({
                        ancestors: [
                            "node",
                            "/x/@anthropic-ai/claude-code/cli.js",
                        ],
                    }),
                )!,
                /agent process/,
            );
            assert.match(
                guardReason(io({ ancestors: ["codex"] }))!,
                /agent process/,
            );
            assert.strictEqual(
                guardReason(io({ ancestors: ["bash", "tmux", "sshd"] })),
                undefined,
            );
        });

        /** Runs the interactive command in-process against the fake game. */
        const interactive = async (
            files: string[],
            answer: (prompt: string) => string | undefined,
            overrides: Parameters<typeof io>[0] = {},
        ) => {
            const streams = io(overrides);
            let stdout = "";
            let stderr = "";
            streams.stdout.on("data", (data) => {
                stdout += data;
                const prompt = stdout.split("\n").pop()!;
                const reply = answer(prompt);
                if (reply !== undefined) {
                    stdout += "\n";
                    (streams.stdin as unknown as PassThrough).write(
                        `${reply}\n`,
                    );
                }
            });
            streams.stderr.on("data", (data) => (stderr += data));
            const code = await withFakeLogin(() =>
                runInteractive(
                    files,
                    { config: configPath, "audit-log": auditPath },
                    streams,
                ),
            );
            return { code, stdout, stderr };
        };
        const phrasePrompt = /^Type 'upload (\d) to dev'/;

        test("lists Dev's metadata with warnings, then uploads on the same login", async () => {
            game.scripts[SCRIPT].modifier = "W_OTHER";
            game.scripts[SCRIPT2].epoch = Math.floor(Date.now() / 1000) + 3600;

            const { code, stdout } = await interactive(
                [filePath, filePath2],
                (prompt) =>
                    phrasePrompt.test(prompt) ? "upload 2 to dev" : undefined,
            );

            assert.strictEqual(code, 0, stdout);
            assert.match(stdout, /last modified by W_OTHER/);
            assert.match(
                stdout,
                new RegExp(
                    `WARNING: script ${SCRIPT} was last modified on Dev by someone else: W_OTHER`,
                ),
            );
            assert.match(
                stdout,
                new RegExp(
                    `WARNING: Dev's copy of script ${SCRIPT2} changed .* after the local file was saved`,
                ),
            );
            assert.match(stdout, /WARNINGS: 2 warning\(s\)/);
            assert.match(stdout, new RegExp(`  ${SCRIPT}  ok  Compile OK`));
            const preflight = auditEvents().find(
                ({ event }) => event === "preflight",
            );
            assert.strictEqual(preflight.confirmed, true);
            assert.strictEqual(preflight.scripts[0].dev.modifier, "W_OTHER");
            assert.match(
                preflight.scripts[0].warnings[0],
                /last modified on Dev by someone else/,
            );
            assert.match(preflight.scripts[1].warnings[0], /may be stale/);
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
            assert.strictEqual(game.scripts[SCRIPT2].text, TEXT2);
            assert.deepStrictEqual(game.connections, [
                [
                    `/ss ${SCRIPT} GS4D raw`,
                    `/ss ${SCRIPT2} GS4D raw`,
                    ...okUploadCommands(SCRIPT, NEW_TEXT),
                    ...okUploadCommands(SCRIPT2, TEXT2),
                    "quit",
                ],
            ]);
        });

        test("a frozen script is refused after the phrase, with no warning list override", async () => {
            game.frozenCsv += `script,${SCRIPT},FROZEN,"W_GS4-A",4\n`;

            const { code, stdout } = await interactive([filePath], (prompt) =>
                phrasePrompt.test(prompt) ? "upload 1 to dev" : undefined,
            );

            assert.strictEqual(code, 1);
            assert.match(
                stdout,
                new RegExp(
                    `${SCRIPT}  refused  Nothing was uploaded: Dev reports the script as FROZEN\\.`,
                ),
            );
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.deepStrictEqual(game.connections, [
                [`/ss ${SCRIPT} GS4D raw`, "/freeze list csv", "quit"],
            ]);
        });

        test("a wrong phrase uploads nothing", async () => {
            const { code, stderr } = await interactive([filePath], (prompt) =>
                phrasePrompt.test(prompt) ? "upload 1 to prime" : undefined,
            );

            assert.strictEqual(code, 1);
            assert.match(stderr, /REFUSED: confirmation phrase did not match/);
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.deepStrictEqual(game.connections, [
                [`/ss ${SCRIPT} GS4D raw`, "quit"],
            ]);
            const events = auditEvents();
            assert.strictEqual(
                events.find(({ event }) => event === "preflight").confirmed,
                false,
            );
            const end = events.find(({ event }) => event === "end");
            assert.strictEqual(end.scripts[0].outcome, "refused");
        });

        test("a verb script is warned about, then follows the redirect for its own number only", async () => {
            const verbFile = path.join(home, `S${VERB_SCRIPT}.gsl`);
            fs.writeFileSync(verbFile, NEW_TEXT);

            const { code, stdout } = await interactive([verbFile], (prompt) =>
                phrasePrompt.test(prompt) ? "upload 1 to dev" : undefined,
            );

            assert.strictEqual(code, 0, stdout);
            assert.match(
                stdout,
                /WARNING: Dev metadata for script 777 is a verb/,
            );
            assert.strictEqual(game.scripts[VERB_SCRIPT].text, NEW_TEXT);
            assert.deepStrictEqual(game.connections[0].slice(0, 6), [
                `/ss ${VERB_SCRIPT} GS4D raw`,
                "/freeze list csv",
                `/ss ${VERB_SCRIPT} GS4D raw`,
                `/ms ${VERB_SCRIPT}`,
                "/mv age",
                "Z",
            ]);
        });

        test("a verb redirect for another script number is not followed", async () => {
            const verbFile = path.join(home, `S${VERB_SCRIPT}.gsl`);
            fs.writeFileSync(verbFile, NEW_TEXT);
            game.verbRedirectWrongScript = true;

            const { code, stdout } = await interactive([verbFile], (prompt) =>
                phrasePrompt.test(prompt) ? "upload 1 to dev" : undefined,
            );

            assert.strictEqual(code, 1);
            assert.match(
                stdout,
                new RegExp(`  ${VERB_SCRIPT}  refused  .*timed out`),
            );
            assert.ok(!game.connections[0].includes("/mv age"));
            assert.strictEqual(game.scripts[VERB_SCRIPT].text, "verb\n");
        });

        test("a script with a modifier and no date uploads unchecked after its warning", async () => {
            game.scripts[SCRIPT].epoch = 0;

            const { code, stdout } = await interactive([filePath], (prompt) =>
                phrasePrompt.test(prompt) ? "upload 1 to dev" : undefined,
            );

            assert.strictEqual(code, 0, stdout);
            assert.match(stdout, /last modified by W_test, date unknown/);
            assert.match(
                stdout,
                new RegExp(
                    `WARNING: couldn't read when script ${SCRIPT} was last modified on Dev`,
                ),
            );
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
        });

        test("creates a missing script only after its warning", async () => {
            game.scripts[SCRIPT].state = "new";

            const { code, stdout } = await interactive([filePath], (prompt) =>
                phrasePrompt.test(prompt) ? "upload 1 to dev" : undefined,
            );

            assert.strictEqual(code, 0, stdout);
            assert.match(
                stdout,
                new RegExp(
                    `WARNING: script ${SCRIPT} is not on Dev yet: uploading would create it`,
                ),
            );
            assert.strictEqual(game.scripts[SCRIPT].text, NEW_TEXT);
            assert.deepStrictEqual(game.connections[0].slice(0, 7), [
                `/ss ${SCRIPT} GS4D raw`,
                "/freeze list csv",
                `/ss ${SCRIPT} GS4D raw`,
                `/ms ${SCRIPT}`,
                "",
                "",
                "C",
            ]);
        });

        test("stops when Dev changed after the list", async () => {
            let listed = false;
            const { code, stdout } = await interactive(
                [filePath, filePath2],
                (prompt) => {
                    if (!phrasePrompt.test(prompt)) return undefined;
                    if (!listed) {
                        listed = true;
                        game.scripts[SCRIPT].epoch = EPOCH + 1;
                        return "upload 2 to dev";
                    }
                    return undefined;
                },
            );

            assert.strictEqual(code, 1);
            assert.match(
                stdout,
                new RegExp(
                    `  ${SCRIPT}  refused  Nothing was uploaded: Dev's copy changed`,
                ),
            );
            assert.match(stdout, new RegExp(`  ${SCRIPT2}  not_attempted`));
            assert.strictEqual(game.scripts[SCRIPT].text, DEV_TEXT);
            assert.ok(!game.connections[0].includes(`/ms ${SCRIPT}`));
        });

        test("asks for the password when GSL_PASSWORD is unset", async () => {
            const { code, stdout } = await interactive(
                [filePath],
                (prompt) =>
                    prompt.startsWith("Play.net password")
                        ? "test-secret"
                        : phrasePrompt.test(prompt)
                          ? "upload 1 to dev"
                          : undefined,
                { env: {} },
            );

            assert.strictEqual(code, 0, stdout);
            assert.ok(!stdout.includes("test-secret"));
        });
    });
});
