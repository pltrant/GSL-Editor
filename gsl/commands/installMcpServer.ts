import { promises as fs } from "fs";
import * as path from "path";

import { ExtensionContext, window } from "vscode";

const MCP_SERVER_PATH_KEY = "gsl.installMcpServer.destinationPath";

export async function runInstallMcpServerCommand({
    context,
    loginConfigPath,
}: {
    context: ExtensionContext;
    loginConfigPath: string | undefined;
}): Promise<void> {
    if (!loginConfigPath) {
        window.showErrorMessage(
            "Login config file path is not configured. Run 'GSL: User Setup' first.",
        );
        return;
    }

    const sourcePath = context.asAbsolutePath("gsl/mcp/mcpServer.bundle.js");
    const defaultDestinationPath = path.join(
        path.dirname(loginConfigPath),
        "mcpServer.bundle.js",
    );
    const enteredPath = await window.showInputBox({
        prompt: "Where should the MCP server be installed?",
        value:
            context.globalState.get<string>(MCP_SERVER_PATH_KEY) ??
            defaultDestinationPath,
        ignoreFocusOut: true,
    });
    if (!enteredPath) {
        return;
    }

    const trimmedPath = enteredPath.trim();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const destinationPath = path.resolve(
        trimmedPath.startsWith("~")
            ? path.join(home, trimmedPath.slice(1))
            : trimmedPath,
    );
    const destinationDirectory = path.dirname(destinationPath);

    try {
        const directoryStats = await fs.stat(destinationDirectory);
        if (!directoryStats.isDirectory()) {
            window.showErrorMessage(
                `MCP server parent path is not a folder: ${destinationDirectory}.`,
            );
            return;
        }

        await fs.copyFile(sourcePath, destinationPath);
        await context.globalState.update(MCP_SERVER_PATH_KEY, trimmedPath);
        window.showInformationMessage(
            `MCP server installed at ${destinationPath}.`,
        );
    } catch (error) {
        console.error("Failed to install MCP server:", error);
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            window.showErrorMessage(
                `MCP server parent folder does not exist: ${destinationDirectory}.`,
            );
            return;
        }
        window.showErrorMessage(
            error instanceof Error
                ? `Failed to install MCP server (${error.message})`
                : "Failed to install MCP server.",
        );
    }
}
