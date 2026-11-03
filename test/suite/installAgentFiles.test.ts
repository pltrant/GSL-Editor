import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { removeTempDirectory } from "../../gsl/commands/installAgentFiles";

suite("Install agent files temp cleanup", () => {
    let directory: string;
    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-agents-test-"));
    });
    teardown(() => {
        if (fs.existsSync(directory)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("removes a directory containing read-only files without throwing", () => {
        const packDir = path.join(directory, "repo", ".git", "objects", "pack");
        fs.mkdirSync(packDir, { recursive: true });
        const packFile = path.join(packDir, "pack-test.idx");
        fs.writeFileSync(packFile, "index");
        fs.chmodSync(packFile, 0o444);

        assert.doesNotThrow(() => removeTempDirectory(directory));
        assert.strictEqual(fs.existsSync(directory), false);
    });

    test("ignores a directory that does not exist", () => {
        const missing = path.join(directory, "missing");
        assert.doesNotThrow(() => removeTempDirectory(missing));
    });
});
