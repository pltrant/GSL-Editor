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
const GSL_AGENTS_FILE = "AGENTS.md";
const GSL_AGENT_PROMPTS_SOURCE_SUBDIR = path.join(
    "src",
    "prompts",
    "gsl-managed",
);
const GSL_AGENT_COMMANDS_SOURCE_SUBDIR = path.join("src", "commands");
const GSL_COPILOT_CODE_REVIEW_COMMAND_FILE = "copilotCodeReview.command.txt";
export const GSL_AGENT_PROMPTS_MANAGED_DIR = path.join(
    ".github",
    "prompts",
    "gsl-managed",
);
export const GSL_AGENT_COMMANDS_MANAGED_DIR = path.join(".github", "commands");
export const GSL_AGENT_PROMPTS_VERSION_FILE = path.join(
    ".github",
    "version.txt",
);
const GSL_AGENT_PROMPTS_STATE_FILE = path.join(
    ".github",
    "gsl-agent-prompts-state.json",
);
const OVERWRITE_PROMPTS_LABEL =
    "Overwrite changed prompt files (create backups first)";
const KEEP_PROMPTS_LABEL = "Keep existing prompt files";
const OVERWRITE_COMMAND_FILES_LABEL =
    "Overwrite changed command files (create backups first)";
const KEEP_COMMAND_FILES_LABEL = "Keep existing command files";
const OVERWRITE_AGENTS_FILE_LABEL =
    "Overwrite workspace AGENTS.md (create backup first)";
const KEEP_AGENTS_FILE_LABEL = "Keep existing AGENTS.md";

interface AgentSyncStateFile {
    sourceRepositorySha: string;
    syncedAtUtc: string;
    sourcePromptHashes: Record<string, string>;
    sourceAgentsFileHash?: string;
    sourceCommandFileHashes?: Record<string, string>;
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
    return listFilesRecursive(rootDir, { suffix: ".prompt.md" });
}

function listCommandFilesRecursive(rootDir: string): string[] {
    return listFilesRecursive(rootDir, { suffix: ".command.txt" });
}

function listFilesRecursive(
    rootDir: string,
    { suffix }: { suffix: ".prompt.md" | ".command.txt" },
): string[] {
    const files = new Array<string>();
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursive(fullPath, { suffix }));
            continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
            files.push(fullPath);
        }
    }
    return files;
}

function resolveSourceAgentsFilePath(clonePath: string): string | undefined {
    const sourceAgentsFilePath = path.join(clonePath, "src", GSL_AGENTS_FILE);
    return fs.existsSync(sourceAgentsFilePath)
        ? sourceAgentsFilePath
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
    return buildSourceFileHashes(sourcePromptDir, promptFiles);
}

function buildSourceCommandFileHashes(
    sourceCommandDir: string,
    commandFiles: string[],
): Record<string, string> {
    return buildSourceFileHashes(sourceCommandDir, commandFiles);
}

function buildSourceFileHashes(
    sourceDir: string,
    files: string[],
): Record<string, string> {
    return files.reduce<Record<string, string>>((acc, sourceFile) => {
        acc[normalizeRelativePath(path.relative(sourceDir, sourceFile))] =
            hashNormalizedFile(sourceFile);
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

function readAgentSyncStateFile(
    workspaceFolderPath: string,
): AgentSyncStateFile | undefined {
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
        const {
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes,
            sourceAgentsFileHash,
            sourceCommandFileHashes,
        } = parsedState as {
            sourceRepositorySha?: unknown;
            syncedAtUtc?: unknown;
            sourcePromptHashes?: unknown;
            sourceAgentsFileHash?: unknown;
            sourceCommandFileHashes?: unknown;
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
        const normalizedAgentsFileHash =
            typeof sourceAgentsFileHash === "string" &&
            /^[0-9a-f]{64}$/i.test(sourceAgentsFileHash)
                ? sourceAgentsFileHash
                : undefined;
        const normalizedCommandFileHashes =
            sourceCommandFileHashes &&
            typeof sourceCommandFileHashes === "object"
                ? Object.entries(sourceCommandFileHashes).reduce<
                      Record<string, string>
                  >((acc, [relativePath, hash]) => {
                      if (
                          typeof hash === "string" &&
                          /^[0-9a-f]{64}$/i.test(hash)
                      ) {
                          acc[relativePath] = hash;
                      }
                      return acc;
                  }, {})
                : {};
        return {
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes: normalizedHashes,
            sourceAgentsFileHash: normalizedAgentsFileHash,
            sourceCommandFileHashes: normalizedCommandFileHashes,
        };
    } catch {
        return undefined;
    }
}

function writeAgentSyncStateFile({
    workspaceFolderPath,
    sourceRepositorySha,
    syncedAtUtc,
    sourcePromptHashes,
    sourceAgentsFileHash,
    sourceCommandFileHashes,
}: {
    workspaceFolderPath: string;
    sourceRepositorySha: string;
    syncedAtUtc: string;
    sourcePromptHashes: Record<string, string>;
    sourceAgentsFileHash?: string;
    sourceCommandFileHashes?: Record<string, string>;
}): string {
    const stateFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_STATE_FILE,
    );
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    const statePayload: AgentSyncStateFile = {
        sourceRepositorySha,
        syncedAtUtc,
        sourcePromptHashes,
    };
    if (sourceAgentsFileHash) {
        statePayload.sourceAgentsFileHash = sourceAgentsFileHash;
    }
    if (
        sourceCommandFileHashes &&
        Object.keys(sourceCommandFileHashes).length > 0
    ) {
        statePayload.sourceCommandFileHashes = sourceCommandFileHashes;
    }
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

interface ManagedFileSyncResult {
    backupPathsCreated: string[];
    overwrittenPaths: string[];
    createdPaths: string[];
    alreadyUpToDatePaths: string[];
    keptPaths: string[];
    deletedPaths: string[];
}

interface ManagedFileAutoUpdateResult {
    updatedCount: number;
    skippedCount: number;
}

function buildManagedFileSections({
    overwrittenPaths,
    createdPaths,
    alreadyUpToDatePaths,
    keptPaths,
    deletedPaths,
    emptyMessage,
}: {
    overwrittenPaths: string[];
    createdPaths: string[];
    alreadyUpToDatePaths: string[];
    keptPaths: string[];
    deletedPaths: string[];
    emptyMessage: string;
}): string[] {
    const sections = [
        ...formatCountedSection("Overwritten", overwrittenPaths),
        ...formatCountedSection("Created", createdPaths),
        ...formatCountedSection("Already up to date", alreadyUpToDatePaths),
        ...formatCountedSection("Kept existing", keptPaths),
        ...formatCountedSection("Removed", deletedPaths),
    ];
    if (sections.length === 0) {
        sections.push(emptyMessage);
    }
    return sections;
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
    const result = await syncManagedFiles({
        sourceDir: sourcePromptDir,
        sourceFiles: promptFiles,
        targetDir: targetPromptDir,
        fileSuffix: ".prompt.md",
        overwriteLabel: OVERWRITE_PROMPTS_LABEL,
        keepLabel: KEEP_PROMPTS_LABEL,
        overwritePromptPlaceholder:
            "Overwrite changed managed prompt files? Changed files will be backed up first.",
    });
    if (!result) {
        return undefined;
    }

    return {
        backupPathsCreated: result.backupPathsCreated,
        overwrittenManagedPromptPaths: result.overwrittenPaths,
        createdManagedPromptPaths: result.createdPaths,
        alreadyUpToDateManagedPromptPaths: result.alreadyUpToDatePaths,
        keptManagedPromptPaths: result.keptPaths,
        deletedManagedPromptPaths: result.deletedPaths,
    };
}

async function syncManagedCommandFiles({
    sourceCommandDir,
    commandFiles,
    targetCommandDir,
}: {
    sourceCommandDir: string;
    commandFiles: string[];
    targetCommandDir: string;
}): Promise<
    | {
          backupPathsCreated: string[];
          overwrittenManagedCommandPaths: string[];
          createdManagedCommandPaths: string[];
          alreadyUpToDateManagedCommandPaths: string[];
          keptManagedCommandPaths: string[];
          deletedManagedCommandPaths: string[];
      }
    | undefined
> {
    const result = await syncManagedFiles({
        sourceDir: sourceCommandDir,
        sourceFiles: commandFiles,
        targetDir: targetCommandDir,
        fileSuffix: ".command.txt",
        overwriteLabel: OVERWRITE_COMMAND_FILES_LABEL,
        keepLabel: KEEP_COMMAND_FILES_LABEL,
        overwritePromptPlaceholder:
            "Overwrite changed managed command files? Changed files will be backed up first.",
    });
    if (!result) {
        return undefined;
    }

    return {
        backupPathsCreated: result.backupPathsCreated,
        overwrittenManagedCommandPaths: result.overwrittenPaths,
        createdManagedCommandPaths: result.createdPaths,
        alreadyUpToDateManagedCommandPaths: result.alreadyUpToDatePaths,
        keptManagedCommandPaths: result.keptPaths,
        deletedManagedCommandPaths: result.deletedPaths,
    };
}

async function syncManagedFiles({
    sourceDir,
    sourceFiles,
    targetDir,
    fileSuffix,
    overwriteLabel,
    keepLabel,
    overwritePromptPlaceholder,
}: {
    sourceDir: string;
    sourceFiles: string[];
    targetDir: string;
    fileSuffix: ".prompt.md" | ".command.txt";
    overwriteLabel: string;
    keepLabel: string;
    overwritePromptPlaceholder: string;
}): Promise<ManagedFileSyncResult | undefined> {
    fs.mkdirSync(targetDir, { recursive: true });

    const backupPathsCreated = new Array<string>();
    const overwrittenPaths = new Array<string>();
    const createdPaths = new Array<string>();
    const alreadyUpToDatePaths = new Array<string>();
    const keptPaths = new Array<string>();
    const deletedPaths = new Array<string>();

    const sourcePathsByRelativePath = new Map<string, string>();
    for (const sourceFile of sourceFiles) {
        sourcePathsByRelativePath.set(
            path.relative(sourceDir, sourceFile),
            sourceFile,
        );
    }

    const existingFiles = listFilesRecursive(targetDir, { suffix: fileSuffix });
    const backupRequiredTargets = new Array<string>();
    let shouldOverwriteManagedFiles = true;
    for (const targetFile of existingFiles) {
        const relativePath = path.relative(targetDir, targetFile);
        const sourceFile = sourcePathsByRelativePath.get(relativePath);
        if (!sourceFile) {
            if (shouldCreateBackup(targetFile)) {
                backupRequiredTargets.push(targetFile);
            }
            continue;
        }
        if (
            !filesMatchWithNormalization(sourceFile, targetFile) &&
            shouldCreateBackup(targetFile)
        ) {
            backupRequiredTargets.push(targetFile);
        }
    }

    if (backupRequiredTargets.length > 0) {
        const overwriteChoice = await window.showQuickPick(
            [{ label: overwriteLabel }, { label: keepLabel }],
            {
                placeHolder: overwritePromptPlaceholder,
                ignoreFocusOut: true,
            },
        );
        if (!overwriteChoice) {
            return undefined;
        }
        if (overwriteChoice.label !== overwriteLabel) {
            shouldOverwriteManagedFiles = false;
        } else {
            for (const targetFile of backupRequiredTargets) {
                const backupPath = nextBackupPath(targetFile);
                fs.copyFileSync(targetFile, backupPath);
                backupPathsCreated.push(backupPath);
            }
        }
    }

    for (const sourceFile of sourceFiles) {
        const relativePath = path.relative(sourceDir, sourceFile);
        const targetPath = path.join(targetDir, relativePath);
        const targetAlreadyExists = fs.existsSync(targetPath);
        if (
            targetAlreadyExists &&
            filesMatchWithNormalization(sourceFile, targetPath)
        ) {
            alreadyUpToDatePaths.push(relativePath.replace(/\\/g, "/"));
            continue;
        }
        if (targetAlreadyExists && !shouldOverwriteManagedFiles) {
            keptPaths.push(relativePath.replace(/\\/g, "/"));
            continue;
        }
        if (
            targetAlreadyExists &&
            shouldCreateBackup(targetPath) &&
            backupRequiredTargets.length > 0
        ) {
            const alreadyBackedUp = backupPathsCreated.some((backupPath) =>
                backupPath.startsWith(`${targetPath}.backup.`),
            );
            if (!alreadyBackedUp) {
                keptPaths.push(relativePath.replace(/\\/g, "/"));
                continue;
            }
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourceFile, targetPath);
        if (targetAlreadyExists) {
            overwrittenPaths.push(relativePath.replace(/\\/g, "/"));
        } else {
            createdPaths.push(relativePath.replace(/\\/g, "/"));
        }
    }

    for (const existingFile of existingFiles) {
        const relativePath = path.relative(targetDir, existingFile);
        if (sourcePathsByRelativePath.has(relativePath)) {
            continue;
        }
        if (!shouldOverwriteManagedFiles) {
            keptPaths.push(relativePath.replace(/\\/g, "/"));
            continue;
        }
        if (shouldCreateBackup(existingFile)) {
            const hasBackup = backupPathsCreated.some((backupPath) =>
                backupPath.startsWith(`${existingFile}.backup.`),
            );
            if (!hasBackup) {
                keptPaths.push(relativePath.replace(/\\/g, "/"));
                continue;
            }
        }
        fs.rmSync(existingFile, { force: true });
        deletedPaths.push(relativePath.replace(/\\/g, "/"));
    }

    return {
        backupPathsCreated,
        overwrittenPaths,
        createdPaths,
        alreadyUpToDatePaths,
        keptPaths,
        deletedPaths,
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
    const result = autoUpdateManagedFiles({
        sourceDir: sourcePromptDir,
        sourceFiles: promptFiles,
        targetDir: targetPromptDir,
        previousSourceFileHashes: previousSourcePromptHashes,
    });
    return {
        updatedPromptCount: result.updatedCount,
        skippedPromptCount: result.skippedCount,
    };
}

function autoUpdateManagedCommandFiles({
    sourceCommandDir,
    commandFiles,
    targetCommandDir,
    previousSourceCommandFileHashes,
}: {
    sourceCommandDir: string;
    commandFiles: string[];
    targetCommandDir: string;
    previousSourceCommandFileHashes: Record<string, string>;
}): { updatedCommandCount: number; skippedCommandCount: number } {
    const result = autoUpdateManagedFiles({
        sourceDir: sourceCommandDir,
        sourceFiles: commandFiles,
        targetDir: targetCommandDir,
        previousSourceFileHashes: previousSourceCommandFileHashes,
    });
    return {
        updatedCommandCount: result.updatedCount,
        skippedCommandCount: result.skippedCount,
    };
}

function autoUpdateManagedFiles({
    sourceDir,
    sourceFiles,
    targetDir,
    previousSourceFileHashes,
}: {
    sourceDir: string;
    sourceFiles: string[];
    targetDir: string;
    previousSourceFileHashes: Record<string, string>;
}): ManagedFileAutoUpdateResult {
    fs.mkdirSync(targetDir, { recursive: true });

    let updatedCount = 0;
    let skippedCount = 0;

    for (const sourceFile of sourceFiles) {
        const relativePath = normalizeRelativePath(
            path.relative(sourceDir, sourceFile),
        );
        const targetPath = path.join(targetDir, relativePath);
        const targetExists = fs.existsSync(targetPath);
        if (!targetExists) {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(sourceFile, targetPath);
            updatedCount++;
            continue;
        }

        if (filesMatchWithNormalization(sourceFile, targetPath)) {
            continue;
        }

        const previousSourceHash = previousSourceFileHashes[relativePath];
        if (!previousSourceHash) {
            skippedCount++;
            continue;
        }

        if (hashNormalizedFile(targetPath) !== previousSourceHash) {
            skippedCount++;
            continue;
        }

        fs.copyFileSync(sourceFile, targetPath);
        updatedCount++;
    }

    return { updatedCount, skippedCount };
}

async function syncAgentsFile({
    sourceAgentsFilePath,
    workspaceFolderPath,
    backupPathsCreated,
}: {
    sourceAgentsFilePath: string | undefined;
    workspaceFolderPath: string;
    backupPathsCreated: string[];
}): Promise<string> {
    if (!sourceAgentsFilePath) {
        return "No source AGENTS.md found in synced agent repo.";
    }

    const workspaceAgentsFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENTS_FILE,
    );
    if (!fs.existsSync(workspaceAgentsFilePath)) {
        fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
        return "Created AGENTS.md from synced source.";
    }

    if (
        !filesMatchWithNormalization(
            sourceAgentsFilePath,
            workspaceAgentsFilePath,
        )
    ) {
        if (!shouldCreateBackup(workspaceAgentsFilePath)) {
            fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
            return "Overwrote AGENTS.md with synced source.";
        }
        const overwriteChoice = await window.showQuickPick(
            [
                {
                    label: OVERWRITE_AGENTS_FILE_LABEL,
                },
                {
                    label: KEEP_AGENTS_FILE_LABEL,
                },
            ],
            {
                placeHolder:
                    "Do you want to overwrite workspace AGENTS.md with the synced version? Existing AGENTS.md will be backed up first.",
                ignoreFocusOut: true,
            },
        );
        if (!overwriteChoice) {
            return "Kept existing AGENTS.md.";
        }
        if (overwriteChoice.label === OVERWRITE_AGENTS_FILE_LABEL) {
            const backupPath = nextBackupPath(workspaceAgentsFilePath);
            fs.copyFileSync(workspaceAgentsFilePath, backupPath);
            backupPathsCreated.push(backupPath);
            fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
            return "Overwrote AGENTS.md with synced source.";
        }
        if (overwriteChoice.label === KEEP_AGENTS_FILE_LABEL) {
            return "Kept existing AGENTS.md.";
        }
    }

    return "Kept existing AGENTS.md (already up to date).";
}

function autoUpdateAgentsFile({
    sourceAgentsFilePath,
    workspaceFolderPath,
    previousSourceAgentsFileHash,
}: {
    sourceAgentsFilePath: string | undefined;
    workspaceFolderPath: string;
    previousSourceAgentsFileHash: string | undefined;
}): { updatedAgentsFile: boolean; skippedAgentsFile: boolean } {
    if (!sourceAgentsFilePath) {
        return { updatedAgentsFile: false, skippedAgentsFile: false };
    }

    const workspaceAgentsFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENTS_FILE,
    );
    if (!fs.existsSync(workspaceAgentsFilePath)) {
        fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
        return { updatedAgentsFile: true, skippedAgentsFile: false };
    }

    if (
        filesMatchWithNormalization(
            sourceAgentsFilePath,
            workspaceAgentsFilePath,
        )
    ) {
        return { updatedAgentsFile: false, skippedAgentsFile: false };
    }

    if (!previousSourceAgentsFileHash) {
        return { updatedAgentsFile: false, skippedAgentsFile: true };
    }

    if (
        hashNormalizedFile(workspaceAgentsFilePath) !==
        previousSourceAgentsFileHash
    ) {
        return { updatedAgentsFile: false, skippedAgentsFile: true };
    }

    fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
    return { updatedAgentsFile: true, skippedAgentsFile: false };
}

async function resolveAgentPromptsDeployKey(
    context: ExtensionContext,
): Promise<string | undefined> {
    const existingKey = await context.secrets.get(
        GSL_AGENT_PROMPTS_DEPLOY_KEY_SECRET,
    );
    if (existingKey) {
        return existingKey;
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
    const targetCommandDir = path.join(
        workspaceFolderPath,
        GSL_AGENT_COMMANDS_MANAGED_DIR,
    );
    const existingPromptFiles = fs.existsSync(targetPromptDir)
        ? listPromptFilesRecursive(targetPromptDir)
        : [];
    const existingCommandFiles = fs.existsSync(targetCommandDir)
        ? listCommandFilesRecursive(targetCommandDir)
        : [];
    if (existingPromptFiles.length === 0 && existingCommandFiles.length === 0) {
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
        const sourceCommandDir = path.join(
            clonePath,
            GSL_AGENT_COMMANDS_SOURCE_SUBDIR,
        );
        const sourceAgentsFilePath = resolveSourceAgentsFilePath(clonePath);
        if (!fs.existsSync(sourcePromptDir)) {
            return;
        }

        const promptFiles = listPromptFilesRecursive(sourcePromptDir);
        const commandFiles = fs.existsSync(sourceCommandDir)
            ? listCommandFilesRecursive(sourceCommandDir)
            : [];
        const sourcePromptHashes = buildSourcePromptHashes(
            sourcePromptDir,
            promptFiles,
        );
        const sourceCommandFileHashes = buildSourceCommandFileHashes(
            sourceCommandDir,
            commandFiles,
        );
        const relativePromptPaths = Object.keys(sourcePromptHashes);

        const storedSyncState = readAgentSyncStateFile(workspaceFolderPath);
        let previousSourcePromptHashes =
            storedSyncState?.sourcePromptHashes ?? {};
        const previousSourceCommandFileHashes =
            storedSyncState?.sourceCommandFileHashes ?? {};
        const previousSourceAgentsFileHash =
            storedSyncState?.sourceAgentsFileHash;
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
        const { updatedCommandCount, skippedCommandCount } =
            autoUpdateManagedCommandFiles({
                sourceCommandDir,
                commandFiles,
                targetCommandDir,
                previousSourceCommandFileHashes,
            });
        const { updatedAgentsFile, skippedAgentsFile } = autoUpdateAgentsFile({
            sourceAgentsFilePath,
            workspaceFolderPath,
            previousSourceAgentsFileHash,
        });

        const syncedAtUtc = new Date().toISOString();
        const sourceAgentsFileHash = sourceAgentsFilePath
            ? hashNormalizedFile(sourceAgentsFilePath)
            : undefined;
        writeSyncVersionFile({
            workspaceFolderPath,
            sourceRepositoryUrl: GSL_AGENT_PROMPTS_REPO_SSH,
            sourceRepositoryBranch: GSL_AGENT_PROMPTS_BRANCH,
            sourceRepositorySha,
            syncedAtUtc,
        });
        writeAgentSyncStateFile({
            workspaceFolderPath,
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes,
            sourceAgentsFileHash,
            sourceCommandFileHashes,
        });

        if (
            updatedPromptCount > 0 ||
            skippedPromptCount > 0 ||
            updatedCommandCount > 0 ||
            skippedCommandCount > 0 ||
            updatedAgentsFile ||
            skippedAgentsFile
        ) {
            const promptSummary = `${updatedPromptCount} prompt file(s) updated${
                skippedPromptCount > 0
                    ? `, ${skippedPromptCount} prompt file(s) not updated (local changes)`
                    : ""
            }`;
            const commandSummary = `${updatedCommandCount} command file(s) updated${
                skippedCommandCount > 0
                    ? `, ${skippedCommandCount} command file(s) not updated (local changes)`
                    : ""
            }`;
            const agentsFileSummary = sourceAgentsFilePath
                ? updatedAgentsFile
                    ? ", AGENTS.md updated"
                    : skippedAgentsFile
                      ? ", AGENTS.md not updated (local changes)"
                      : ""
                : "";
            void window.showInformationMessage(
                `GSL prompt auto-update: ${promptSummary}, ${commandSummary}${agentsFileSummary}.`,
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
        const sourceCommandDir = path.join(
            clonePath,
            GSL_AGENT_COMMANDS_SOURCE_SUBDIR,
        );
        const sourceAgentsFilePath = resolveSourceAgentsFilePath(clonePath);
        if (!fs.existsSync(sourcePromptDir)) {
            throw new Error(
                `Prompt source directory not found: ${GSL_AGENT_PROMPTS_SOURCE_SUBDIR}`,
            );
        }
        if (!fs.existsSync(sourceCommandDir)) {
            throw new Error(
                `Command source directory not found: ${GSL_AGENT_COMMANDS_SOURCE_SUBDIR}`,
            );
        }
        const requiredCommandFilePath = path.join(
            sourceCommandDir,
            GSL_COPILOT_CODE_REVIEW_COMMAND_FILE,
        );
        if (!fs.existsSync(requiredCommandFilePath)) {
            throw new Error(
                `Required command file not found: ${normalizeRelativePath(path.join(GSL_AGENT_COMMANDS_SOURCE_SUBDIR, GSL_COPILOT_CODE_REVIEW_COMMAND_FILE))}`,
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

        const commandFiles = listCommandFilesRecursive(sourceCommandDir);
        const targetCommandDir = path.join(
            workspaceFolder.uri.fsPath,
            GSL_AGENT_COMMANDS_MANAGED_DIR,
        );
        const managedCommandSyncResult = await syncManagedCommandFiles({
            sourceCommandDir,
            commandFiles,
            targetCommandDir,
        });
        if (!managedCommandSyncResult) {
            return;
        }
        backupPathsCreated.push(...managedCommandSyncResult.backupPathsCreated);
        const {
            overwrittenManagedCommandPaths,
            createdManagedCommandPaths,
            alreadyUpToDateManagedCommandPaths,
            keptManagedCommandPaths,
            deletedManagedCommandPaths,
        } = managedCommandSyncResult;

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

        const agentsFileOutcome = await syncAgentsFile({
            sourceAgentsFilePath,
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            backupPathsCreated,
        });
        const syncedAtUtc = new Date().toISOString();
        const sourceAgentsFileHash = sourceAgentsFilePath
            ? hashNormalizedFile(sourceAgentsFilePath)
            : undefined;
        const sourcePromptHashes = buildSourcePromptHashes(
            sourcePromptDir,
            promptFiles,
        );
        const sourceCommandFileHashes = buildSourceCommandFileHashes(
            sourceCommandDir,
            commandFiles,
        );
        const versionFilePath = writeSyncVersionFile({
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            sourceRepositoryUrl: GSL_AGENT_PROMPTS_REPO_SSH,
            sourceRepositoryBranch: GSL_AGENT_PROMPTS_BRANCH,
            sourceRepositorySha,
            syncedAtUtc,
        });
        writeAgentSyncStateFile({
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            sourceRepositorySha,
            syncedAtUtc,
            sourcePromptHashes,
            sourceAgentsFileHash,
            sourceCommandFileHashes,
        });
        const versionFilePathForDisplay = path
            .relative(workspaceFolder.uri.fsPath, versionFilePath)
            .replace(/\\/g, "/");

        const backupPathsForDisplay = backupPathsCreated.map((backupPath) =>
            path
                .relative(workspaceFolder.uri.fsPath, backupPath)
                .replace(/\\/g, "/"),
        );
        const managedPromptSections = buildManagedFileSections({
            overwrittenPaths: overwrittenManagedPromptPaths,
            createdPaths: createdManagedPromptPaths,
            alreadyUpToDatePaths: alreadyUpToDateManagedPromptPaths,
            keptPaths: keptManagedPromptPaths,
            deletedPaths: deletedManagedPromptPaths,
            emptyMessage: "- No managed prompt changes were detected.",
        });
        const managedCommandSections = buildManagedFileSections({
            overwrittenPaths: overwrittenManagedCommandPaths,
            createdPaths: createdManagedCommandPaths,
            alreadyUpToDatePaths: alreadyUpToDateManagedCommandPaths,
            keptPaths: keptManagedCommandPaths,
            deletedPaths: deletedManagedCommandPaths,
            emptyMessage: "- No managed command file changes were detected.",
        });
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
            `- Synced **${commandFiles.length}** agent command file(s) to \`${GSL_AGENT_COMMANDS_MANAGED_DIR}\`.`,
            "",
            "### Managed Prompt Results",
            "",
            ...managedPromptSections,
            "",
            "### Managed Command Results",
            "",
            ...managedCommandSections,
            "",
            ...backupSections,
            "### AGENTS File",
            "",
            `- ${agentsFileOutcome}`,
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
