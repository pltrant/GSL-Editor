import * as fs from "fs";
import * as path from "path";

import { commands, ExtensionContext, window, workspace } from "vscode";

import {
    GSLX_CURRENT_AUTHOR,
    GSLX_DEV_ACCOUNT,
    GSLX_DEV_PASSWORD,
    GSLX_PRIME_CHARACTER,
    GSLX_PRIME_INSTANCE,
} from "../const";
import {
    GSL_AGENT_COMMANDS_MANAGED_DIR,
    GSL_AGENT_PROMPTS_MANAGED_DIR,
    GSL_AGENT_PROMPTS_VERSION_FILE,
} from "./syncAgentPrompts";

const COPILOT_CODE_REVIEW_COMMAND_FILE = "copilotCodeReview.command.txt";

function hasManagedPromptFiles(rootPath: string): boolean {
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
        return false;
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            if (hasManagedPromptFiles(fullPath)) {
                return true;
            }
            continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".prompt.md")) {
            return true;
        }
    }
    return false;
}

async function verifyPrimeUserSetupPrecondition(
    context: ExtensionContext,
): Promise<boolean> {
    const account = context.globalState.get<string>(GSLX_DEV_ACCOUNT);
    const password = await context.secrets.get(GSLX_DEV_PASSWORD);
    const primeInstance = context.globalState.get<string>(GSLX_PRIME_INSTANCE);
    const primeCharacter =
        context.globalState.get<string>(GSLX_PRIME_CHARACTER);
    const author = context.globalState.get<string>(GSLX_CURRENT_AUTHOR)?.trim();
    if (account && password && primeInstance && primeCharacter && author) {
        return true;
    }

    const runSetupAction = "Run User Setup";
    const choice = await window.showErrorMessage(
        "Copilot Code Review requires User Setup first. Run 'GSL: User Setup' and try again.",
        { modal: true },
        runSetupAction,
    );
    if (choice === runSetupAction) {
        void commands.executeCommand("gsl.userSetup");
    }
    return false;
}

function readManagedCommandPrompt(rootFolderPath: string): string | undefined {
    const commandPromptFilePath = path.join(
        rootFolderPath,
        GSL_AGENT_COMMANDS_MANAGED_DIR,
        COPILOT_CODE_REVIEW_COMMAND_FILE,
    );
    if (!fs.existsSync(commandPromptFilePath)) {
        return undefined;
    }

    const prompt = fs.readFileSync(commandPromptFilePath, "utf8").trim();
    return prompt.length > 0 ? prompt : undefined;
}

async function verifyManagedPromptSyncPrecondition(): Promise<
    string | undefined
> {
    const workspaceFolder = window.activeTextEditor
        ? workspace.getWorkspaceFolder(window.activeTextEditor.document.uri)
        : undefined;
    const rootFolderPath = (workspaceFolder ?? workspace.workspaceFolders?.[0])
        ?.uri.fsPath;
    if (!rootFolderPath) {
        await window.showErrorMessage(
            "Copilot Code Review requires an open workspace folder.",
            { modal: true },
        );
        return undefined;
    }

    const managedPromptDirPath = path.join(
        rootFolderPath,
        GSL_AGENT_PROMPTS_MANAGED_DIR,
    );
    const versionFilePath = path.join(
        rootFolderPath,
        GSL_AGENT_PROMPTS_VERSION_FILE,
    );
    const commandPromptFilePath = path.join(
        rootFolderPath,
        GSL_AGENT_COMMANDS_MANAGED_DIR,
        COPILOT_CODE_REVIEW_COMMAND_FILE,
    );
    const promptsAreSynced =
        hasManagedPromptFiles(managedPromptDirPath) &&
        fs.existsSync(versionFilePath) &&
        fs.existsSync(commandPromptFilePath);

    if (promptsAreSynced) {
        return rootFolderPath;
    }

    const syncPromptsAction = "Run Sync Agent Prompts";
    const choice = await window.showErrorMessage(
        "Copilot Code Review requires synced GSL-managed prompts. Run 'GSL: Sync Agent Prompts' and try again.",
        { modal: true },
        syncPromptsAction,
    );
    if (choice === syncPromptsAction) {
        void commands.executeCommand("gsl.syncAgentPrompts");
    }
    return undefined;
}

async function openCopilotChatWithPrompt(prompt: string): Promise<boolean> {
    const availableCommands = new Set(await commands.getCommands(true));
    if (!availableCommands.has("workbench.action.chat.open")) {
        return false;
    }

    const candidateArguments = [
        {
            query: prompt,
            mode: "agent",
            autoSend: true,
            isPartialQuery: false,
        },
        {
            query: prompt,
            mode: "agent",
            isPartialQuery: true,
        },
        prompt,
    ];

    for (const args of candidateArguments) {
        try {
            await commands.executeCommand("workbench.action.chat.open", args);
            return true;
        } catch {
            // Try the next invocation shape for compatibility.
        }
    }

    return false;
}

export async function runCopilotCodeReviewCommand({
    context,
}: {
    context: ExtensionContext;
}): Promise<void> {
    if (!(await verifyPrimeUserSetupPrecondition(context))) {
        return;
    }

    const rootFolderPath = await verifyManagedPromptSyncPrecondition();
    if (!rootFolderPath) {
        return;
    }

    const copilotCodeReviewPrompt = readManagedCommandPrompt(rootFolderPath);
    if (!copilotCodeReviewPrompt) {
        await window.showErrorMessage(
            "Could not load Copilot Code Review command prompt. Run 'GSL: Sync Agent Prompts' and try again.",
            { modal: true },
        );
        return;
    }

    const opened = await openCopilotChatWithPrompt(copilotCodeReviewPrompt);
    if (opened) {
        return;
    }

    await window.showErrorMessage(
        "Could not open Copilot Chat. Confirm GitHub Copilot Chat is installed and enabled.",
        { modal: true },
    );
}
