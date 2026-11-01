/**
 * Standalone Dev upload tool, bundled to gsl/devUpload/devUpload.bundle.js
 * by `npm run compile`. Not part of the MCP server or the extension. See the
 * README section "Dev Upload Tool" for the interface.
 *
 *   version
 *   metadata [--config <loginConfig.json>] <script number>...
 *   upload [--config <loginConfig.json>] [--audit-log <path>]
 *          --expect <number>=<epoch>... <S<number>.gsl>...
 *   frozen [--config <loginConfig.json>]
 *
 * Each command but `version` logs in once. Every command prints one JSON line
 * and exits 0 only when the outcome is `ok`. GSL_PASSWORD comes from the
 * environment. Debug logging never turns on here, since it would record the
 * login.
 */

import * as fs from "fs";
import { parseArgs } from "util";
import {
    AuditLog,
    DevLogin,
    agentEnvMarkers,
    defaultAuditPath,
    devLogin,
    errorMessage,
    frozenSession,
    loadScriptFiles,
    loginConfigPath,
    makeScrub,
    metadataSession,
    notAttempted,
    notAttemptedMetadata,
    parseExpected,
    parseScriptNumbers,
    runOutcome,
    scriptNumber,
    scrubDeep,
    uploadSession,
} from "./devUpload";

const USAGE =
    "Usage: version | metadata [--config <file>] <script number>... | " +
    "upload [--config <file>] [--audit-log <path>] --expect <number>=<epoch>... <S<number>.gsl>... | " +
    "frozen [--config <file>]; see the README.";

/** Bumped when the JSON shape or a command changes incompatibly */
const INTERFACE_VERSION = 1;

type Options = { config?: string; "audit-log"?: string; expect?: string[] };

type Report = { outcome: string; detail: string } & (
    | { scripts: unknown[] }
    | { tool: string; interface: number }
);

/**
 * Aborts when a parent that holds our stdin pipe closes it or dies, so a
 * killed caller leaves no upload running. A terminal, a file or /dev/null on
 * stdin is left alone.
 */
function abortOnStdinClose(): AbortSignal {
    const controller = new AbortController();
    const stdin = fs.fstatSync(0);
    if (stdin.isFIFO() || stdin.isSocket()) {
        process.stdin.on("end", () =>
            controller.abort(new Error("stdin closed.")),
        );
        process.stdin.on("error", () =>
            controller.abort(new Error("stdin closed.")),
        );
        process.stdin.resume();
    }
    return controller.signal;
}

async function upload(paths: string[], options: Options): Promise<Report> {
    const requested = paths.map(scriptNumber).filter(Boolean);
    try {
        // Agents never upload; an automation around this tool clears its env.
        const markers = agentEnvMarkers(process.env);
        if (markers.length > 0) {
            throw new Error(
                `Refusing to upload from an agent session: environment variables ${markers.join(", ")} are set.`,
            );
        }
        const files = loadScriptFiles(paths);
        const scripts = files.map(({ script }) => script);
        const expected = parseExpected(options.expect ?? [], scripts);
        const login = devLogin(options.config, process.env);
        const audit = new AuditLog(
            options["audit-log"] ??
                defaultAuditPath(loginConfigPath(options.config, process.env)!),
            makeScrub(login.password),
        );
        try {
            const { detail, scripts } = await uploadSession({
                login,
                files,
                expected,
                audit,
                signal: abortOnStdinClose(),
            });
            return { outcome: runOutcome(detail, scripts), detail, scripts };
        } finally {
            audit.close();
        }
    } catch (e) {
        return {
            outcome: "refused",
            detail: errorMessage(e),
            scripts: requested.map((script) => notAttempted(script)),
        };
    }
}

async function metadata(values: string[], options: Options): Promise<Report> {
    let scripts: number[] = [];
    let login: DevLogin;
    try {
        scripts = parseScriptNumbers(values);
        login = devLogin(options.config, process.env);
    } catch (e) {
        return {
            outcome: "refused",
            detail: errorMessage(e),
            scripts: scripts.map((script) => notAttemptedMetadata(script)),
        };
    }
    try {
        const results = await metadataSession(
            login,
            scripts,
            abortOnStdinClose(),
        );
        return {
            outcome: runOutcome("", results),
            detail: "",
            scripts: results,
        };
    } catch (e) {
        return {
            outcome: "unknown",
            detail: errorMessage(e),
            scripts: scripts.map((script) => notAttemptedMetadata(script)),
        };
    }
}

/** Frozen and locked scripts, verbs included; a failed list has none */
async function frozen(options: Options): Promise<Report> {
    let login: DevLogin;
    try {
        login = devLogin(options.config, process.env);
    } catch (e) {
        return { outcome: "refused", detail: errorMessage(e), scripts: [] };
    }
    try {
        const scripts = await frozenSession(login, abortOnStdinClose());
        return { outcome: "ok", detail: "", scripts };
    } catch (e) {
        return { outcome: "unknown", detail: errorMessage(e), scripts: [] };
    }
}

async function main(): Promise<void> {
    let report: Report;
    try {
        const { values, positionals } = parseArgs({
            allowPositionals: true,
            options: {
                config: { type: "string" },
                "audit-log": { type: "string" },
                expect: { type: "string", multiple: true },
            },
        });
        const [command, ...rest] = positionals;
        if (values.expect && command !== "upload") {
            throw new Error("--expect is only for upload.");
        }
        if (command === "version" && rest.length === 0) {
            report = {
                outcome: "ok",
                detail: "",
                tool: "gsl-dev-upload",
                interface: INTERFACE_VERSION,
            };
        } else if (command === "upload") report = await upload(rest, values);
        else if (command === "metadata") report = await metadata(rest, values);
        else if (command === "frozen" && rest.length === 0)
            report = await frozen(values);
        else throw new Error(USAGE);
    } catch (e) {
        report = { outcome: "refused", detail: errorMessage(e), scripts: [] };
    }
    const scrubbed = scrubDeep(report, makeScrub(process.env.GSL_PASSWORD));
    process.stdout.write(`${JSON.stringify(scrubbed)}\n`, () =>
        process.exit(report.outcome === "ok" ? 0 : 1),
    );
}

main();
