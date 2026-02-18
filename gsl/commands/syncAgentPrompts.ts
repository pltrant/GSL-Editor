import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

import {
    commands,
    ConfigurationTarget,
    ExtensionContext,
    Uri,
    window,
    workspace,
} from "vscode";

const GSL_AGENT_PROMPTS_DEPLOY_KEY_SECRET = "gsl.agentPromptsDeployPrivateKey";
const GSL_AGENT_PROMPTS_REPO_SSH =
    "git@github.com:pltrant/GSL-Editor-Agents.git";
const GSL_AGENT_PROMPTS_BRANCH = "main";
const GSL_AGENT_PROMPTS_SOURCE_SUBDIR = path.join(
    "src",
    "prompts",
    "gsl-managed",
);
export const GSL_AGENT_PROMPTS_MANAGED_DIR = path.join(
    ".github",
    "prompts",
    "gsl-managed",
);
export const GSL_AGENT_PROMPTS_VERSION_FILE = path.join(
    ".github",
    "version.txt",
);
const GSL_AGENT_PROMPTS_STATE_FILE = path.join(
    ".github",
    "gsl-agent-prompts-state.json",
);
const OVERWRITE_PROMPTS_LABEL = "Overwrite changed prompt files";
const KEEP_PROMPTS_LABEL = "Keep existing prompt files";
const OVERWRITE_INSTRUCTIONS_LABEL =
    "Overwrite workspace .github/copilot-instructions.md";
const KEEP_INSTRUCTIONS_LABEL = "Keep existing .github/copilot-instructions.md";

interface AgentPromptSyncStateFile {
    sourceRepositorySha: string;
    syncedAtUtc: string;
    sourcePromptHashes: Record<string, string>;
}

function runCommand(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(
            command,
            args,
            {
                cwd: options?.cwd,
                env: options?.env,
            },
            (error, stdout, stderr) => {
                if (error) {
                    const message = [
                        `Command failed: ${command} ${args.join(" ")}`,
                        stderr?.toString().trim() ||
                            stdout?.toString().trim() ||
                            error.message,
                    ]
                        .filter(Boolean)
                        .join("\n");
                    reject(new Error(message));
                    return;
                }
                resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                });
            },
        );
    });
}

async function fetchGitHubSshHostPublicKeys(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const request = https.get(
            "https://api.github.com/meta",
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "User-Agent": "GSL-Editor",
                },
            },
            (response) => {
                const chunks = new Array<string>();
                response.setEncoding("utf8");
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    if (response.statusCode !== 200) {
                        reject(
                            new Error(
                                `Failed to fetch GitHub metadata (status ${response.statusCode ?? "unknown"}).`,
                            ),
                        );
                        return;
                    }

                    let parsedBody: unknown;
                    try {
                        parsedBody = JSON.parse(chunks.join(""));
                    } catch {
                        reject(new Error("Failed to parse GitHub metadata."));
                        return;
                    }

                    if (!parsedBody || typeof parsedBody !== "object") {
                        reject(
                            new Error("GitHub metadata has an invalid shape."),
                        );
                        return;
                    }

                    const sshKeys = (parsedBody as { ssh_keys?: unknown })
                        .ssh_keys;
                    if (!Array.isArray(sshKeys)) {
                        reject(
                            new Error(
                                "GitHub metadata is missing SSH host keys.",
                            ),
                        );
                        return;
                    }

                    const normalizedHostKeys = sshKeys.filter(
                        (value): value is string =>
                            typeof value === "string" &&
                            /^\S+\s+\S+/.test(value),
                    );
                    if (normalizedHostKeys.length === 0) {
                        reject(
                            new Error(
                                "GitHub metadata did not include usable SSH host keys.",
                            ),
                        );
                        return;
                    }

                    resolve(normalizedHostKeys);
                });
            },
        );

        request.on("error", (error) => reject(error));
        request.setTimeout(10000, () => {
            request.destroy(
                new Error("Timed out while fetching GitHub host keys."),
            );
        });
    });
}

async function createGitHubKnownHostsFile(
    tempRootPath: string,
): Promise<{ knownHostsPath?: string; warningMessage?: string }> {
    try {
        const sshHostPublicKeys = await fetchGitHubSshHostPublicKeys();
        const knownHostsEntries = sshHostPublicKeys.map(
            (publicKey) => `github.com ${publicKey}`,
        );
        const knownHostsPath = path.join(tempRootPath, "known_hosts");
        fs.writeFileSync(knownHostsPath, `${knownHostsEntries.join("\n")}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        return { knownHostsPath };
    } catch (error) {
        const failureReason =
            error instanceof Error ? error.message : String(error);
        const fallbackInstruction =
            process.platform === "win32"
                ? "If clone fails with host verification errors, run one of the following:\n" +
                  "- PowerShell: New-Item -ItemType Directory -Force $HOME/.ssh | Out-Null; ssh-keyscan github.com >> $HOME/.ssh/known_hosts\n" +
                  "- Command Prompt: if not exist %USERPROFILE%\\.ssh mkdir %USERPROFILE%\\.ssh && ssh-keyscan github.com >> %USERPROFILE%\\.ssh\\known_hosts"
                : "If clone fails with host verification errors, run: mkdir -p ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts";
        const warningMessage =
            "Unable to auto-configure GitHub SSH host verification. " +
            `Reason: ${failureReason}. ` +
            fallbackInstruction;
        return { warningMessage };
    }
}

function expandHomePath(value: string): string {
    if (!value.startsWith("~")) return value;
    const suffix = value.slice(1);
    return path.join(os.homedir(), suffix);
}

function listPromptFilesRecursive(rootDir: string): string[] {
    const promptFiles = new Array<string>();
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            promptFiles.push(...listPromptFilesRecursive(fullPath));
            continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".prompt.md")) {
            promptFiles.push(fullPath);
        }
    }
    return promptFiles;
}

function resolveSourceCopilotInstructionsFilePath(
    clonePath: string,
): string | undefined {
    const sourceInstructionsPath = path.join(
        clonePath,
        "src",
        "copilot-instructions.md",
    );
    return fs.existsSync(sourceInstructionsPath)
        ? sourceInstructionsPath
        : undefined;
}

async function resolveRepositoryHeadSha(repoPath: string): Promise<string> {
    const { stdout } = await runCommand("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
    });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error("Unable to resolve cloned repository SHA.");
    }
    return sha;
}

function writeSyncVersionFile({
    workspaceFolderPath,
    sourceRepositoryUrl,
    sourceRepositoryBranch,
    sourceRepositorySha,
    syncedAtUtc,
}: {
    workspaceFolderPath: string;
    sourceRepositoryUrl: string;
    sourceRepositoryBranch: string;
    sourceRepositorySha: string;
    syncedAtUtc: string;
}): string {
    const workspaceGithubDir = path.join(workspaceFolderPath, ".github");
    fs.mkdirSync(workspaceGithubDir, { recursive: true });
    const versionFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_VERSION_FILE,
    );
    const versionFileContents = [
        `source_repository_url=${sourceRepositoryUrl}`,
        `source_repository_branch=${sourceRepositoryBranch}`,
        `source_repository_sha=${sourceRepositorySha}`,
        `synced_at_utc=${syncedAtUtc}`,
        "",
    ].join("\n");
    fs.writeFileSync(versionFilePath, versionFileContents, "utf8");
    return versionFilePath;
}

function normalizeTextForComparison(text: string): string {
    const normalizedNewlines = text.replace(/\r\n?/g, "\n");
    return normalizedNewlines.endsWith("\n")
        ? normalizedNewlines.slice(0, -1)
        : normalizedNewlines;
}

function hashNormalizedText(text: string): string {
    return crypto
        .createHash("sha256")
        .update(normalizeTextForComparison(text), "utf8")
        .digest("hex");
}

function readNormalizedFile(filePath: string): string {
    return normalizeTextForComparison(fs.readFileSync(filePath, "utf8"));
}

function hashNormalizedFile(filePath: string): string {
    return crypto
        .createHash("sha256")
        .update(readNormalizedFile(filePath), "utf8")
        .digest("hex");
}

function filesMatchWithNormalization(
    fileAPath: string,
    fileBPath: string,
): boolean {
    return readNormalizedFile(fileAPath) === readNormalizedFile(fileBPath);
}

function normalizeRelativePath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
}

function buildSourcePromptHashes(
    sourcePromptDir: string,
    promptFiles: string[],
): Record<string, string> {
    return promptFiles.reduce<Record<string, string>>((acc, promptFile) => {
        acc[normalizeRelativePath(path.relative(sourcePromptDir, promptFile))] =
            hashNormalizedFile(promptFile);
        return acc;
    }, {});
}

function readSourceRepositoryShaFromVersionFile(
    workspaceFolderPath: string,
): string | undefined {
    const versionFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_VERSION_FILE,
    );
    if (!fs.existsSync(versionFilePath)) {
        return undefined;
    }
    const lines = fs.readFileSync(versionFilePath, "utf8").split(/\r?\n/);
    const shaLine = lines.find((line) =>
        line.startsWith("source_repository_sha="),
    );
    if (!shaLine) {
        return undefined;
    }
    const sha = shaLine.split("=", 2)[1]?.trim();
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

function readAgentPromptSyncStateFile(
    workspaceFolderPath: string,
): AgentPromptSyncStateFile | undefined {
    const stateFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_STATE_FILE,
    );
    if (!fs.existsSync(stateFilePath)) {
        return undefined;
    }
    try {
        const parsedState = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
        if (!parsedState || typeof parsedState !== "object") {
            return undefined;
        }
        const { sourceRepositorySha, syncedAtUtc, sourcePromptHashes } =
            parsedState as {
                sourceRepositorySha?: unknown;
                syncedAtUtc?: unknown;
                sourcePromptHashes?: unknown;
            };
        if (
            typeof sourceRepositorySha !== "string" ||
            !/^[0-9a-f]{40}$/i.test(sourceRepositorySha) ||
            typeof syncedAtUtc !== "string" ||
            !sourcePromptHashes ||
            typeof sourcePromptHashes !== "object"
        ) {
            return undefined;
        }
        const normalizedHashes = Object.entries(sourcePromptHashes).reduce<
            Record<string, string>
        >((acc, [relativePath, hash]) => {
            if (typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash)) {
                acc[relativePath] = hash;
            }
            return acc;
        }, {});
        return {
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes: normalizedHashes,
        };
    } catch {
        return undefined;
    }
}

function writeAgentPromptSyncStateFile({
    workspaceFolderPath,
    sourceRepositorySha,
    syncedAtUtc,
    sourcePromptHashes,
}: {
    workspaceFolderPath: string;
    sourceRepositorySha: string;
    syncedAtUtc: string;
    sourcePromptHashes: Record<string, string>;
}): string {
    const stateFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_STATE_FILE,
    );
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    const statePayload: AgentPromptSyncStateFile = {
        sourceRepositorySha,
        syncedAtUtc,
        sourcePromptHashes,
    };
    fs.writeFileSync(
        stateFilePath,
        `${JSON.stringify(statePayload, null, 2)}\n`,
        "utf8",
    );
    return stateFilePath;
}

function findMostRecentBackupPath(filePath: string): string | undefined {
    const directoryPath = path.dirname(filePath);
    const baseName = path.basename(filePath);
    if (!fs.existsSync(directoryPath)) {
        return undefined;
    }

    let mostRecentIndex = -1;
    for (const entry of fs.readdirSync(directoryPath)) {
        const match = new RegExp(
            `^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.backup\\.(\\d+)$`,
        ).exec(entry);
        if (!match) {
            continue;
        }
        const index = Number.parseInt(match[1], 10);
        if (Number.isFinite(index) && index > mostRecentIndex) {
            mostRecentIndex = index;
        }
    }

    if (mostRecentIndex < 0) {
        return undefined;
    }
    return `${filePath}.backup.${mostRecentIndex}`;
}

function nextBackupPath(filePath: string): string {
    for (let index = 1; ; index++) {
        const backupPath = `${filePath}.backup.${index}`;
        if (!fs.existsSync(backupPath)) {
            return backupPath;
        }
    }
}

function shouldCreateBackup(filePath: string): boolean {
    const currentFileContent = readNormalizedFile(filePath);
    const mostRecentBackupPath = findMostRecentBackupPath(filePath);
    if (!mostRecentBackupPath || !fs.existsSync(mostRecentBackupPath)) {
        return true;
    }
    return readNormalizedFile(mostRecentBackupPath) !== currentFileContent;
}

function formatMarkdownBulletList(items: string[]): string {
    if (items.length === 0) {
        return "  - none";
    }
    return items.map((item) => `  - ${item}`).join("\n");
}

function formatCountedSection(title: string, items: string[]): string[] {
    if (items.length === 0) {
        return [];
    }
    return [
        `- **${title} (${items.length})**`,
        formatMarkdownBulletList(items),
    ];
}

async function syncManagedPromptFiles({
    sourcePromptDir,
    promptFiles,
    targetPromptDir,
}: {
    sourcePromptDir: string;
    promptFiles: string[];
    targetPromptDir: string;
}): Promise<
    | {
          backupPathsCreated: string[];
          overwrittenManagedPromptPaths: string[];
          createdManagedPromptPaths: string[];
          alreadyUpToDateManagedPromptPaths: string[];
          keptManagedPromptPaths: string[];
          deletedManagedPromptPaths: string[];
      }
    | undefined
> {
    fs.mkdirSync(targetPromptDir, { recursive: true });

    const backupPathsCreated = new Array<string>();
    const overwrittenManagedPromptPaths = new Array<string>();
    const createdManagedPromptPaths = new Array<string>();
    const alreadyUpToDateManagedPromptPaths = new Array<string>();
    const keptManagedPromptPaths = new Array<string>();
    const deletedManagedPromptPaths = new Array<string>();

    const sourcePromptPathsByRelativePath = new Map<string, string>();
    for (const promptFile of promptFiles) {
        sourcePromptPathsByRelativePath.set(
            path.relative(sourcePromptDir, promptFile),
            promptFile,
        );
    }

    const existingPromptFiles = listPromptFilesRecursive(targetPromptDir);
    const backupRequiredPromptTargets = new Array<string>();
    let shouldOverwriteManagedPromptFiles = true;
    for (const targetPromptFile of existingPromptFiles) {
        const relativePath = path.relative(targetPromptDir, targetPromptFile);
        const sourcePromptFile =
            sourcePromptPathsByRelativePath.get(relativePath);
        if (!sourcePromptFile) {
            if (shouldCreateBackup(targetPromptFile)) {
                backupRequiredPromptTargets.push(targetPromptFile);
            }
            continue;
        }
        if (
            !filesMatchWithNormalization(sourcePromptFile, targetPromptFile) &&
            shouldCreateBackup(targetPromptFile)
        ) {
            backupRequiredPromptTargets.push(targetPromptFile);
        }
    }

    if (backupRequiredPromptTargets.length > 0) {
        const overwritePromptChoice = await window.showQuickPick(
            [{ label: OVERWRITE_PROMPTS_LABEL }, { label: KEEP_PROMPTS_LABEL }],
            {
                placeHolder:
                    "Overwrite changed managed prompt files and create backups first?",
                ignoreFocusOut: true,
            },
        );
        if (!overwritePromptChoice) {
            return;
        }
        if (overwritePromptChoice.label !== OVERWRITE_PROMPTS_LABEL) {
            shouldOverwriteManagedPromptFiles = false;
        } else {
            for (const targetPromptFile of backupRequiredPromptTargets) {
                const backupPath = nextBackupPath(targetPromptFile);
                fs.copyFileSync(targetPromptFile, backupPath);
                backupPathsCreated.push(backupPath);
            }
        }
    }

    for (const promptFile of promptFiles) {
        const relativePath = path.relative(sourcePromptDir, promptFile);
        const targetPath = path.join(targetPromptDir, relativePath);
        const targetAlreadyExists = fs.existsSync(targetPath);
        if (
            targetAlreadyExists &&
            filesMatchWithNormalization(promptFile, targetPath)
        ) {
            alreadyUpToDateManagedPromptPaths.push(
                relativePath.replace(/\\/g, "/"),
            );
            continue;
        }
        if (targetAlreadyExists && !shouldOverwriteManagedPromptFiles) {
            keptManagedPromptPaths.push(relativePath.replace(/\\/g, "/"));
            continue;
        }
        if (
            targetAlreadyExists &&
            shouldCreateBackup(targetPath) &&
            backupRequiredPromptTargets.length > 0
        ) {
            const alreadyBackedUp = backupPathsCreated.some((backupPath) =>
                backupPath.startsWith(`${targetPath}.backup.`),
            );
            if (!alreadyBackedUp) {
                keptManagedPromptPaths.push(relativePath.replace(/\\/g, "/"));
                continue;
            }
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(promptFile, targetPath);
        if (targetAlreadyExists) {
            overwrittenManagedPromptPaths.push(
                relativePath.replace(/\\/g, "/"),
            );
        } else {
            createdManagedPromptPaths.push(relativePath.replace(/\\/g, "/"));
        }
    }

    for (const existingPromptFile of existingPromptFiles) {
        const relativePath = path.relative(targetPromptDir, existingPromptFile);
        if (sourcePromptPathsByRelativePath.has(relativePath)) {
            continue;
        }
        if (!shouldOverwriteManagedPromptFiles) {
            keptManagedPromptPaths.push(relativePath.replace(/\\/g, "/"));
            continue;
        }
        if (shouldCreateBackup(existingPromptFile)) {
            const hasBackup = backupPathsCreated.some((backupPath) =>
                backupPath.startsWith(`${existingPromptFile}.backup.`),
            );
            if (!hasBackup) {
                keptManagedPromptPaths.push(relativePath.replace(/\\/g, "/"));
                continue;
            }
        }
        fs.rmSync(existingPromptFile, { force: true });
        deletedManagedPromptPaths.push(relativePath.replace(/\\/g, "/"));
    }

    return {
        backupPathsCreated,
        overwrittenManagedPromptPaths,
        createdManagedPromptPaths,
        alreadyUpToDateManagedPromptPaths,
        keptManagedPromptPaths,
        deletedManagedPromptPaths,
    };
}

async function fetchRepositoryCommitBySha({
    repoPath,
    sourceRepositorySha,
}: {
    repoPath: string;
    sourceRepositorySha: string;
}): Promise<boolean> {
    try {
        await runCommand(
            "git",
            ["fetch", "--depth", "1", "origin", sourceRepositorySha],
            { cwd: repoPath },
        );
        return true;
    } catch {
        return false;
    }
}

async function resolveSourcePromptHashesAtSha({
    repoPath,
    sourceRepositorySha,
    relativePromptPaths,
}: {
    repoPath: string;
    sourceRepositorySha: string;
    relativePromptPaths: string[];
}): Promise<Record<string, string>> {
    const promptHashes: Record<string, string> = {};
    const sourceDirPath = normalizeRelativePath(
        GSL_AGENT_PROMPTS_SOURCE_SUBDIR,
    );
    for (const relativePromptPath of relativePromptPaths) {
        const promptPathAtSha = path.posix.join(
            sourceDirPath,
            normalizeRelativePath(relativePromptPath),
        );
        try {
            const { stdout } = await runCommand(
                "git",
                ["show", `${sourceRepositorySha}:${promptPathAtSha}`],
                { cwd: repoPath },
            );
            promptHashes[normalizeRelativePath(relativePromptPath)] =
                hashNormalizedText(stdout);
        } catch {
            continue;
        }
    }
    return promptHashes;
}

function autoUpdateManagedPromptFiles({
    sourcePromptDir,
    promptFiles,
    targetPromptDir,
    previousSourcePromptHashes,
}: {
    sourcePromptDir: string;
    promptFiles: string[];
    targetPromptDir: string;
    previousSourcePromptHashes: Record<string, string>;
}): { updatedPromptCount: number; skippedPromptCount: number } {
    fs.mkdirSync(targetPromptDir, { recursive: true });

    let updatedPromptCount = 0;
    let skippedPromptCount = 0;

    for (const promptFile of promptFiles) {
        const relativePath = normalizeRelativePath(
            path.relative(sourcePromptDir, promptFile),
        );
        const targetPath = path.join(targetPromptDir, relativePath);
        const targetExists = fs.existsSync(targetPath);
        if (!targetExists) {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(promptFile, targetPath);
            updatedPromptCount++;
            continue;
        }

        if (filesMatchWithNormalization(promptFile, targetPath)) {
            continue;
        }

        const previousPromptHash = previousSourcePromptHashes[relativePath];
        if (!previousPromptHash) {
            skippedPromptCount++;
            continue;
        }

        if (hashNormalizedFile(targetPath) !== previousPromptHash) {
            skippedPromptCount++;
            continue;
        }

        fs.copyFileSync(promptFile, targetPath);
        updatedPromptCount++;
    }

    return { updatedPromptCount, skippedPromptCount };
}

async function syncCopilotInstructionsFile({
    sourceInstructionsFilePath,
    workspaceFolderPath,
    backupPathsCreated,
}: {
    sourceInstructionsFilePath: string | undefined;
    workspaceFolderPath: string;
    backupPathsCreated: string[];
}): Promise<string> {
    if (!sourceInstructionsFilePath) {
        return "No source copilot-instructions.md found in synced agent repo.";
    }

    const workspaceGithubDir = path.join(workspaceFolderPath, ".github");
    const workspaceInstructionsPath = path.join(
        workspaceGithubDir,
        "copilot-instructions.md",
    );
    if (!fs.existsSync(workspaceInstructionsPath)) {
        fs.mkdirSync(workspaceGithubDir, { recursive: true });
        fs.copyFileSync(sourceInstructionsFilePath, workspaceInstructionsPath);
        return "Created .github/copilot-instructions.md from synced source.";
    }

    if (
        !filesMatchWithNormalization(
            sourceInstructionsFilePath,
            workspaceInstructionsPath,
        )
    ) {
        if (!shouldCreateBackup(workspaceInstructionsPath)) {
            fs.copyFileSync(
                sourceInstructionsFilePath,
                workspaceInstructionsPath,
            );
            return "Overwrote .github/copilot-instructions.md with synced source.";
        }
        const overwriteChoice = await window.showQuickPick(
            [
                {
                    label: OVERWRITE_INSTRUCTIONS_LABEL,
                },
                {
                    label: KEEP_INSTRUCTIONS_LABEL,
                },
            ],
            {
                placeHolder:
                    "Do you want to overwrite workspace .github/copilot-instructions.md with the synced version?",
                ignoreFocusOut: true,
            },
        );
        if (!overwriteChoice) {
            return "Kept existing .github/copilot-instructions.md.";
        }
        if (overwriteChoice.label === OVERWRITE_INSTRUCTIONS_LABEL) {
            const backupPath = nextBackupPath(workspaceInstructionsPath);
            fs.copyFileSync(workspaceInstructionsPath, backupPath);
            backupPathsCreated.push(backupPath);
            fs.copyFileSync(
                sourceInstructionsFilePath,
                workspaceInstructionsPath,
            );
            return "Overwrote .github/copilot-instructions.md with synced source.";
        }
        if (overwriteChoice.label === KEEP_INSTRUCTIONS_LABEL) {
            return "Kept existing .github/copilot-instructions.md.";
        }
    }

    return "Kept existing .github/copilot-instructions.md (already up to date).";
}

async function resolveAgentPromptsDeployKey(
    context: ExtensionContext,
): Promise<string | undefined> {
    const existingKey = await context.secrets.get(
        GSL_AGENT_PROMPTS_DEPLOY_KEY_SECRET,
    );
    if (existingKey) {
        const choice = await window.showQuickPick(
            [
                { label: "Use saved deploy key" },
                { label: "Use a different deploy key file" },
                { label: "Cancel" },
            ],
            {
                placeHolder: "Choose deploy key source for prompt sync.",
                ignoreFocusOut: true,
            },
        );
        if (!choice || choice.label === "Cancel") {
            return;
        }
        if (choice.label === "Use saved deploy key") {
            return existingKey;
        }
    }

    const defaultKeyPath = path.join(
        os.homedir(),
        "gsl-editor-agents-deploy-key.txt",
    );
    const input = await window.showInputBox({
        prompt: "Path to the deploy private key file for prompt sync",
        value: defaultKeyPath,
        ignoreFocusOut: true,
    });
    if (!input?.trim()) {
        return;
    }

    const deployKeyPath = expandHomePath(input.trim());
    if (!fs.existsSync(deployKeyPath)) {
        throw new Error(`Deploy key file not found: ${deployKeyPath}`);
    }

    const deployKey = fs.readFileSync(deployKeyPath, "utf8").trim();
    if (!deployKey.startsWith("-----BEGIN")) {
        throw new Error(
            "Deploy key file does not look like a private SSH key.",
        );
    }

    await context.secrets.store(GSL_AGENT_PROMPTS_DEPLOY_KEY_SECRET, deployKey);
    return deployKey;
}

export interface SyncAgentPromptsCommandDependencies {
    context: ExtensionContext;
}

export async function runStartupAgentPromptAutoUpdate({
    context,
}: SyncAgentPromptsCommandDependencies): Promise<void> {
    const workspaceFolder = workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const workspaceFolderPath = workspaceFolder.uri.fsPath;
    const targetPromptDir = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_MANAGED_DIR,
    );
    if (!fs.existsSync(targetPromptDir)) {
        return;
    }

    const existingPromptFiles = listPromptFilesRecursive(targetPromptDir);
    if (existingPromptFiles.length === 0) {
        return;
    }

    const hasSyncMarker =
        fs.existsSync(
            path.join(workspaceFolderPath, GSL_AGENT_PROMPTS_VERSION_FILE),
        ) ||
        fs.existsSync(
            path.join(workspaceFolderPath, GSL_AGENT_PROMPTS_STATE_FILE),
        );
    if (!hasSyncMarker) {
        return;
    }

    const deployKey = await context.secrets.get(
        GSL_AGENT_PROMPTS_DEPLOY_KEY_SECRET,
    );
    if (!deployKey) {
        return;
    }

    const message = window.setStatusBarMessage(
        "Checking GSL managed prompts for updates...",
        30000,
    );
    let tempRootPath: string | undefined;
    try {
        tempRootPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "gsl-agent-prompts-"),
        );
        const keyPath = path.join(tempRootPath, "deploy_key");
        const clonePath = path.join(tempRootPath, "repo");
        fs.writeFileSync(keyPath, `${deployKey}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });

        const sshKeyPath = keyPath.replace(/\\/g, "/");
        const quotedSshKeyPath = `"${sshKeyPath.replace(/"/g, '\\"')}"`;
        const { knownHostsPath } =
            await createGitHubKnownHostsFile(tempRootPath);
        const sshCommandParts = [
            `ssh -i ${quotedSshKeyPath}`,
            "-o IdentitiesOnly=yes",
            "-o StrictHostKeyChecking=yes",
        ];
        if (knownHostsPath) {
            const normalizedKnownHostsPath = knownHostsPath.replace(/\\/g, "/");
            const quotedKnownHostsPath = `"${normalizedKnownHostsPath.replace(/"/g, '\\"')}"`;
            sshCommandParts.push(
                `-o UserKnownHostsFile=${quotedKnownHostsPath}`,
            );
        }
        const env = {
            ...process.env,
            GIT_SSH_COMMAND: sshCommandParts.join(" "),
        };

        await runCommand(
            "git",
            [
                "clone",
                "--depth",
                "1",
                "--branch",
                GSL_AGENT_PROMPTS_BRANCH,
                GSL_AGENT_PROMPTS_REPO_SSH,
                clonePath,
            ],
            { env },
        );
        const sourceRepositorySha = await resolveRepositoryHeadSha(clonePath);
        const sourcePromptDir = path.join(
            clonePath,
            GSL_AGENT_PROMPTS_SOURCE_SUBDIR,
        );
        if (!fs.existsSync(sourcePromptDir)) {
            return;
        }

        const promptFiles = listPromptFilesRecursive(sourcePromptDir);
        const sourcePromptHashes = buildSourcePromptHashes(
            sourcePromptDir,
            promptFiles,
        );
        const relativePromptPaths = Object.keys(sourcePromptHashes);

        const storedSyncState =
            readAgentPromptSyncStateFile(workspaceFolderPath);
        let previousSourcePromptHashes =
            storedSyncState?.sourcePromptHashes ?? {};
        if (Object.keys(previousSourcePromptHashes).length === 0) {
            const previousSourceRepositorySha =
                readSourceRepositoryShaFromVersionFile(workspaceFolderPath);
            if (
                previousSourceRepositorySha &&
                previousSourceRepositorySha !== sourceRepositorySha &&
                (await fetchRepositoryCommitBySha({
                    repoPath: clonePath,
                    sourceRepositorySha: previousSourceRepositorySha,
                }))
            ) {
                previousSourcePromptHashes =
                    await resolveSourcePromptHashesAtSha({
                        repoPath: clonePath,
                        sourceRepositorySha: previousSourceRepositorySha,
                        relativePromptPaths,
                    });
            } else if (previousSourceRepositorySha === sourceRepositorySha) {
                previousSourcePromptHashes = sourcePromptHashes;
            }
        }

        const { updatedPromptCount, skippedPromptCount } =
            autoUpdateManagedPromptFiles({
                sourcePromptDir,
                promptFiles,
                targetPromptDir,
                previousSourcePromptHashes,
            });

        const syncedAtUtc = new Date().toISOString();
        writeSyncVersionFile({
            workspaceFolderPath,
            sourceRepositoryUrl: GSL_AGENT_PROMPTS_REPO_SSH,
            sourceRepositoryBranch: GSL_AGENT_PROMPTS_BRANCH,
            sourceRepositorySha,
            syncedAtUtc,
        });
        writeAgentPromptSyncStateFile({
            workspaceFolderPath,
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes,
        });

        if (updatedPromptCount > 0 || skippedPromptCount > 0) {
            const skippedSummary =
                skippedPromptCount > 0
                    ? `, ${skippedPromptCount} not updated (local changes)`
                    : "";
            void window.showInformationMessage(
                `GSL prompt auto-update: ${updatedPromptCount} updated${skippedSummary}.`,
            );
        }
    } catch {
        return;
    } finally {
        message.dispose();
        if (tempRootPath) {
            fs.rmSync(tempRootPath, { recursive: true, force: true });
        }
    }
}

export async function runSyncAgentPromptsCommand({
    context,
}: SyncAgentPromptsCommandDependencies): Promise<void> {
    const activeWorkspaceFolder = window.activeTextEditor
        ? workspace.getWorkspaceFolder(window.activeTextEditor.document.uri)
        : undefined;
    const workspaceFolder =
        activeWorkspaceFolder ?? workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return void window.showErrorMessage(
            "Open a workspace folder before syncing agent prompts.",
        );
    }

    const message = window.setStatusBarMessage(
        "Syncing GSL agent prompts...",
        60000,
    );
    let tempRootPath: string | undefined;
    try {
        const deployKey = await resolveAgentPromptsDeployKey(context);
        if (!deployKey) {
            return;
        }

        tempRootPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "gsl-agent-prompts-"),
        );
        const keyPath = path.join(tempRootPath, "deploy_key");
        const clonePath = path.join(tempRootPath, "repo");
        fs.writeFileSync(keyPath, `${deployKey}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });

        const sshKeyPath = keyPath.replace(/\\/g, "/");
        const quotedSshKeyPath = `"${sshKeyPath.replace(/"/g, '\\"')}"`;
        const { knownHostsPath, warningMessage } =
            await createGitHubKnownHostsFile(tempRootPath);
        if (warningMessage) {
            void window.showWarningMessage(warningMessage);
        }
        const sshCommandParts = [
            `ssh -i ${quotedSshKeyPath}`,
            "-o IdentitiesOnly=yes",
            "-o StrictHostKeyChecking=yes",
        ];
        if (knownHostsPath) {
            const normalizedKnownHostsPath = knownHostsPath.replace(/\\/g, "/");
            const quotedKnownHostsPath = `"${normalizedKnownHostsPath.replace(/"/g, '\\"')}"`;
            sshCommandParts.push(
                `-o UserKnownHostsFile=${quotedKnownHostsPath}`,
            );
        }
        const env = {
            ...process.env,
            GIT_SSH_COMMAND: sshCommandParts.join(" "),
        };

        await runCommand(
            "git",
            [
                "clone",
                "--depth",
                "1",
                "--branch",
                GSL_AGENT_PROMPTS_BRANCH,
                GSL_AGENT_PROMPTS_REPO_SSH,
                clonePath,
            ],
            { env },
        );
        const sourceRepositorySha = await resolveRepositoryHeadSha(clonePath);

        const sourcePromptDir = path.join(
            clonePath,
            GSL_AGENT_PROMPTS_SOURCE_SUBDIR,
        );
        const sourceInstructionsFilePath =
            resolveSourceCopilotInstructionsFilePath(clonePath);
        if (!fs.existsSync(sourcePromptDir)) {
            throw new Error(
                `Prompt source directory not found: ${GSL_AGENT_PROMPTS_SOURCE_SUBDIR}`,
            );
        }

        const promptFiles = listPromptFilesRecursive(sourcePromptDir);
        const targetPromptDir = path.join(
            workspaceFolder.uri.fsPath,
            GSL_AGENT_PROMPTS_MANAGED_DIR,
        );
        const managedPromptSyncResult = await syncManagedPromptFiles({
            sourcePromptDir,
            promptFiles,
            targetPromptDir,
        });
        if (!managedPromptSyncResult) {
            return;
        }
        const {
            backupPathsCreated,
            overwrittenManagedPromptPaths,
            createdManagedPromptPaths,
            alreadyUpToDateManagedPromptPaths,
            keptManagedPromptPaths,
            deletedManagedPromptPaths,
        } = managedPromptSyncResult;

        const promptLocationsConfig = workspace
            .getConfiguration("chat")
            .get<Record<string, boolean> | string[]>("promptFilesLocations");
        const promptLocations: Record<string, boolean> = Array.isArray(
            promptLocationsConfig,
        )
            ? promptLocationsConfig.reduce<Record<string, boolean>>(
                  (acc, location) => {
                      acc[location] = true;
                      return acc;
                  },
                  {},
              )
            : { ...(promptLocationsConfig ?? {}) };
        if (!promptLocations[GSL_AGENT_PROMPTS_MANAGED_DIR]) {
            promptLocations[GSL_AGENT_PROMPTS_MANAGED_DIR] = true;
            await workspace
                .getConfiguration("chat")
                .update(
                    "promptFilesLocations",
                    promptLocations,
                    ConfigurationTarget.Workspace,
                );
        }

        const instructionsOutcome = await syncCopilotInstructionsFile({
            sourceInstructionsFilePath,
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            backupPathsCreated,
        });
        const syncedAtUtc = new Date().toISOString();
        const sourcePromptHashes = buildSourcePromptHashes(
            sourcePromptDir,
            promptFiles,
        );
        const versionFilePath = writeSyncVersionFile({
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            sourceRepositoryUrl: GSL_AGENT_PROMPTS_REPO_SSH,
            sourceRepositoryBranch: GSL_AGENT_PROMPTS_BRANCH,
            sourceRepositorySha,
            syncedAtUtc,
        });
        writeAgentPromptSyncStateFile({
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes,
        });
        const versionFilePathForDisplay = path
            .relative(workspaceFolder.uri.fsPath, versionFilePath)
            .replace(/\\/g, "/");

        const backupPathsForDisplay = backupPathsCreated.map((backupPath) =>
            path
                .relative(workspaceFolder.uri.fsPath, backupPath)
                .replace(/\\/g, "/"),
        );
        const managedPromptSections = [
            ...formatCountedSection(
                "Overwritten",
                overwrittenManagedPromptPaths,
            ),
            ...formatCountedSection("Created", createdManagedPromptPaths),
            ...formatCountedSection(
                "Already up to date",
                alreadyUpToDateManagedPromptPaths,
            ),
            ...formatCountedSection("Kept existing", keptManagedPromptPaths),
            ...formatCountedSection("Removed", deletedManagedPromptPaths),
        ];
        if (managedPromptSections.length === 0) {
            managedPromptSections.push(
                "- No managed prompt changes were detected.",
            );
        }
        const backupSections =
            backupPathsForDisplay.length > 0
                ? [
                      "### Backup Files Created",
                      "",
                      `- **Total backups (${backupPathsForDisplay.length})**`,
                      formatMarkdownBulletList(backupPathsForDisplay),
                      "",
                  ]
                : [];
        const summaryMarkdown = [
            "# TLDR",
            "",
            "Prompts have been updated — open Copilot Chat, type `/`, and start using them by prompt name.",
            "",
            "# The Nitty Gritty Details",
            "",
            "### Overview",
            "",
            `- Synced **${promptFiles.length}** agent prompt file(s) to \`${GSL_AGENT_PROMPTS_MANAGED_DIR}\`.`,
            "",
            "### Managed Prompt Results",
            "",
            ...managedPromptSections,
            "",
            ...backupSections,
            "### Instructions File",
            "",
            `- ${instructionsOutcome}`,
            "",
            "### Sync Metadata",
            "",
            `- Wrote sync metadata to \`${versionFilePathForDisplay}\`.`,
            `- Source repository URL: \`${GSL_AGENT_PROMPTS_REPO_SSH}\``,
            `- Source repository branch: \`${GSL_AGENT_PROMPTS_BRANCH}\``,
            `- Source repository SHA: \`${sourceRepositorySha}\``,
            `- Synced at (UTC): \`${syncedAtUtc}\``,
            "",
        ].join("\n");

        const summaryFilePath = path.join(targetPromptDir, "sync-summary.md");
        fs.writeFileSync(summaryFilePath, summaryMarkdown, "utf8");
        await commands.executeCommand(
            "markdown.showPreview",
            Uri.file(summaryFilePath),
        );
    } catch (error) {
        window.showErrorMessage(
            error instanceof Error
                ? `Agent prompt sync failed: ${error.message}`
                : "Agent prompt sync failed.",
        );
    } finally {
        message.dispose();
        if (tempRootPath) {
            fs.rmSync(tempRootPath, { recursive: true, force: true });
        }
    }
}
