import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    detectLineEnding,
    resolveDefaultLineEnding,
    writeScriptFile,
} from "../../../gsl/util/lineEndingUtil";

suite("Line Ending Utility Test Suite", () => {
    let dir: string;
    let savedEnv: NodeJS.ProcessEnv;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-eol-test-"));
        // Keep the developer's global/system git config out of these tests
        savedEnv = { ...process.env };
        process.env.GIT_CONFIG_GLOBAL = path.join(dir, "empty.gitconfig");
        process.env.GIT_CONFIG_NOSYSTEM = "1";
    });

    teardown(() => {
        process.env = savedEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function initRepo(config: Record<string, string>): void {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        for (const [key, value] of Object.entries(config)) {
            execFileSync("git", ["config", key, value], { cwd: dir });
        }
    }

    const serverContent = "line one\r\nline two\r\n";

    test("download over an LF file stays LF", () => {
        const filePath = path.join(dir, "S00001.gsl");
        fs.writeFileSync(filePath, "old\nscript\n");
        writeScriptFile({
            filePath,
            content: serverContent,
            fallbackEol: "\r\n",
        });
        assert.strictEqual(
            fs.readFileSync(filePath, "utf8"),
            "line one\nline two\n",
        );
    });

    test("download over a CRLF file stays CRLF", () => {
        const filePath = path.join(dir, "S00001.gsl");
        fs.writeFileSync(filePath, "old\r\nscript\r\n");
        writeScriptFile({
            filePath,
            content: "line one\nline two\n",
            fallbackEol: "\n",
        });
        assert.strictEqual(
            fs.readFileSync(filePath, "utf8"),
            "line one\r\nline two\r\n",
        );
    });

    test("existing file wins over git settings", () => {
        initRepo({ "core.eol": "crlf" });
        const filePath = path.join(dir, "S00001.gsl");
        fs.writeFileSync(filePath, "old\nscript\n");
        assert.strictEqual(
            detectLineEnding({ filePath, fallback: "\r\n" }),
            "\n",
        );
    });

    test("new file outside a git repository uses the fallback", () => {
        const filePath = path.join(dir, "S00001.gsl");
        writeScriptFile({
            filePath,
            content: serverContent,
            fallbackEol: "\n",
        });
        assert.strictEqual(
            fs.readFileSync(filePath, "utf8"),
            "line one\nline two\n",
        );
        assert.strictEqual(
            detectLineEnding({
                filePath: path.join(dir, "S00002.gsl"),
                fallback: "\r\n",
            }),
            "\r\n",
        );
    });

    test("existing file without line breaks uses the fallback", () => {
        const filePath = path.join(dir, "S00001.gsl");
        fs.writeFileSync(filePath, "");
        assert.strictEqual(
            detectLineEnding({ filePath, fallback: "\r\n" }),
            "\r\n",
        );
    });

    test("new file in a git repository uses core.eol", () => {
        initRepo({ "core.autocrlf": "false", "core.eol": "lf" });
        assert.strictEqual(
            detectLineEnding({
                filePath: path.join(dir, "S00001.gsl"),
                fallback: "\r\n",
            }),
            "\n",
        );
    });

    test("new file in a git repository uses core.autocrlf", () => {
        initRepo({ "core.autocrlf": "true" });
        assert.strictEqual(
            detectLineEnding({
                filePath: path.join(dir, "S00001.gsl"),
                fallback: "\n",
            }),
            "\r\n",
        );
    });

    test("new file in a git repository uses .gitattributes eol", () => {
        initRepo({ "core.autocrlf": "true" });
        fs.writeFileSync(path.join(dir, ".gitattributes"), "*.gsl eol=lf\n");
        assert.strictEqual(
            detectLineEnding({
                filePath: path.join(dir, "S00001.gsl"),
                fallback: "\r\n",
            }),
            "\n",
        );
    });

    test("new file in a git repository without eol settings uses the fallback", () => {
        initRepo({});
        assert.strictEqual(
            detectLineEnding({
                filePath: path.join(dir, "S00001.gsl"),
                fallback: "\r\n",
            }),
            "\r\n",
        );
    });

    test("resolveDefaultLineEnding honors files.eol and falls back to the OS", () => {
        const osEol = os.EOL === "\r\n" ? "\r\n" : "\n";
        assert.strictEqual(resolveDefaultLineEnding("\n"), "\n");
        assert.strictEqual(resolveDefaultLineEnding("\r\n"), "\r\n");
        assert.strictEqual(resolveDefaultLineEnding("auto"), osEol);
        assert.strictEqual(resolveDefaultLineEnding(undefined), osEol);
    });
});
