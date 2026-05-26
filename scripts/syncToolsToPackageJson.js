/**
 * Codegen: synchronizes TOOL_DEFINITIONS → package.json languageModelTools.
 *
 * Run after tsc: node scripts/syncToolsToPackageJson.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

let TOOL_DEFINITIONS;
try {
    ({ TOOL_DEFINITIONS } = require("../gsl/mcp/toolDefinitions"));
} catch (e) {
    console.error(
        "Failed to load toolDefinitions. Ensure tsc has run first.",
        e.message,
    );
    process.exit(1);
}

const PACKAGE_JSON_PATH = path.resolve(__dirname, "../package.json");

function generateLanguageModelTools() {
    return TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        displayName: tool.vscode.displayName,
        toolReferenceName: tool.vscode.toolReferenceName,
        canBeReferencedInPrompt: true,
        icon: tool.vscode.icon || "$(tools)",
        userDescription: tool.vscode.userDescription,
        modelDescription: tool.description,
        inputSchema: tool.inputSchema,
    }));
}

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
pkg.contributes.languageModelTools = generateLanguageModelTools();
fs.writeFileSync(
    PACKAGE_JSON_PATH,
    JSON.stringify(pkg, null, 4) + "\n",
    "utf8",
);
console.log(
    `Synced ${TOOL_DEFINITIONS.length} tools to package.json languageModelTools.`,
);
