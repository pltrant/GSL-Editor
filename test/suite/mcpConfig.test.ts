import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadLoginConfig } from "../../gsl/mcp/mcpConfig";

suite("MCP worker configuration", () => {
    let directory: string;
    let filename: string;
    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-workers-"));
        filename = path.join(directory, "login.json");
    });
    teardown(() => fs.rmSync(directory, { recursive: true, force: true }));

    function load(properties: object) {
        fs.writeFileSync(
            filename,
            JSON.stringify({
                account: "test",
                author: "Test/Author",
                ...properties,
            }),
        );
        return loadLoginConfig({
            GSL_LOGIN_CONFIG_FILE: filename,
            GSL_PASSWORD: "test",
        });
    }

    test("legacy single-character configuration produces one worker", () => {
        const config = load({ devInstance: "GS4D", devCharacter: "First" });
        assert.strictEqual(config.configError, undefined);
        assert.deepStrictEqual(
            config.credentials.get("dev")?.map((c) => c.character),
            ["First"],
        );
    });

    test("unused legacy template fields do not disable configured workers", () => {
        const config = load({
            devInstance: "GS4D",
            primeInstance: "GS3",
            testInstance: "GST",
            shatteredInstance: "GSF",
            platinumInstance: "GSX",
            devCharacter: "First",
            primeCharacter: "",
            testCharacter: "",
            shatteredCharacter: "",
            platinumCharacter: "",
        });
        assert.strictEqual(config.configError, undefined);
        assert.strictEqual(config.credentials.size, 1);
        assert.strictEqual(
            config.credentials.get("dev")?.[0].character,
            "First",
        );
    });

    test("legacy characters without an instance remain unconfigured", () => {
        const config = load({ devCharacter: "First" });
        assert.strictEqual(config.configError, undefined);
        assert.strictEqual(config.credentials.size, 0);
    });

    test("plural lists override legacy characters and deduplicate case-insensitively", () => {
        const config = load({
            devInstance: "GS4D",
            devCharacter: "Legacy",
            devCharacters: [" First ", "first", "Second"],
            primeInstance: "GS4",
            primeCharacters: ["Third", "Fourth"],
        });
        assert.strictEqual(config.configError, undefined);
        assert.deepStrictEqual(
            config.credentials.get("dev")?.map((c) => c.character),
            ["first", "Second"],
        );
        assert.deepStrictEqual(
            config.credentials.get("prime")?.map((c) => c.character),
            ["Third", "Fourth"],
        );
    });

    test("malformed or empty worker lists report configuration errors", () => {
        for (const characters of [[], [""], ["A", 3], [null]]) {
            const config = load({
                devInstance: "GS4D",
                devCharacter: "",
                devCharacters: characters,
            });
            assert.match(
                config.configError ?? "",
                /Invalid dev worker configuration/,
            );
            assert.strictEqual(config.credentials.size, 0);
        }
    });
});
