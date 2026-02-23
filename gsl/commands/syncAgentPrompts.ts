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
const GSL_PROMPTS_SOURCE_SUBDIR = path.join("src", "prompts");
const GSL_AGENTS_SOURCE_SUBDIR = path.join("src", "agents");
const GSL_INSTRUCTIONS_SOURCE_SUBDIR = path.join("src", "instructions");
const GSL_SKILLS_SOURCE_SUBDIR = path.join("src", "skills");
const GSL_AGENT_COMMANDS_SOURCE_SUBDIR = path.join(
    "src",
    "gsl-extension-builtin-commands",
);
const GSL_COPILOT_CODE_REVIEW_COMMAND_FILE = "copilotCodeReview.command.txt";
const GSL_MANAGED_ROOT_DIR = path.join(".github", "gsl-managed");
const GSL_SYNC_SUMMARY_FILE = path.join(
    GSL_MANAGED_ROOT_DIR,
    "sync-summary.md",
);
export const GSL_AGENT_PROMPTS_MANAGED_DIR = path.join(
    GSL_MANAGED_ROOT_DIR,
    "prompts",
);
const GSL_AGENT_MANAGED_AGENTS_DIR = path.join(GSL_MANAGED_ROOT_DIR, "agents");
const GSL_AGENT_MANAGED_INSTRUCTIONS_DIR = path.join(
    GSL_MANAGED_ROOT_DIR,
    "instructions",
);
const GSL_AGENT_MANAGED_SKILLS_DIR = path.join(GSL_MANAGED_ROOT_DIR, "skills");
export const GSL_AGENT_COMMANDS_MANAGED_DIR = path.join(
    GSL_MANAGED_ROOT_DIR,
    "gsl-extension-builtin-commands",
);
export const GSL_AGENT_PROMPTS_VERSION_FILE = path.join(
    ".github",
    "version.txt",
);
const GSL_AGENT_PROMPTS_STATE_FILE = path.join(
    ".github",
    "gsl-agent-prompts-state.json",
);
const OVERWRITE_AGENTS_FILE_LABEL =
    "Overwrite workspace AGENTS.md (create backup first)";
const KEEP_AGENTS_FILE_LABEL = "Keep existing AGENTS.md";

interface ManagedFileSet {
    id: string;
    displayName: string;
    sourceSubdir: string;
    targetSubdir: string;
    registerForCopilot: boolean;
}

interface ManagedFileSetSourceData {
    fileSet: ManagedFileSet;
    sourceDir: string;
    sourceFiles: string[];
    sourceHashes: Record<string, string>;
}

interface ManagedFileSetSyncData {
    fileSet: ManagedFileSet;
    sourceFileCount: number;
    syncResult: ManagedFileSyncResult;
}

interface AgentSyncStateFile {
    sourceRepositorySha: string;
    syncedAtUtc: string;
    sourceManagedFileHashes: Record<string, Record<string, string>>;
    sourceAgentsFileHash?: string;
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

interface AgentsFileSyncResult {
    cancelled: boolean;
    summary: string;
}

const MANAGED_FILE_SETS: ManagedFileSet[] = [
    {
        id: "prompts",
        displayName: "Prompts",
        sourceSubdir: GSL_PROMPTS_SOURCE_SUBDIR,
        targetSubdir: GSL_AGENT_PROMPTS_MANAGED_DIR,
        registerForCopilot: true,
    },
    {
        id: "agents",
        displayName: "Agents",
        sourceSubdir: GSL_AGENTS_SOURCE_SUBDIR,
        targetSubdir: GSL_AGENT_MANAGED_AGENTS_DIR,
        registerForCopilot: true,
    },
    {
        id: "instructions",
        displayName: "Instructions",
        sourceSubdir: GSL_INSTRUCTIONS_SOURCE_SUBDIR,
        targetSubdir: GSL_AGENT_MANAGED_INSTRUCTIONS_DIR,
        registerForCopilot: true,
    },
    {
        id: "skills",
        displayName: "Skills",
        sourceSubdir: GSL_SKILLS_SOURCE_SUBDIR,
        targetSubdir: GSL_AGENT_MANAGED_SKILLS_DIR,
        registerForCopilot: true,
    },
    {
        id: "gsl-extension-builtin-commands",
        displayName: "Builtin Commands",
        sourceSubdir: GSL_AGENT_COMMANDS_SOURCE_SUBDIR,
        targetSubdir: GSL_AGENT_COMMANDS_MANAGED_DIR,
        registerForCopilot: false,
    },
];

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
    if (!value.startsWith("~")) {
        return value;
    }
    const suffix = value.slice(1);
    return path.join(os.homedir(), suffix);
}

function listFilesRecursive(rootDir: string): string[] {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const files = new Array<string>();
    const entries = fs
        .readdirSync(rootDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursive(fullPath));
            continue;
        }
        if (entry.isFile()) {
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

function isSha40(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function isSha64(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
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
            sourceManagedFileHashes,
            sourceAgentsFileHash,
        } = parsedState as {
            sourceRepositorySha?: unknown;
            syncedAtUtc?: unknown;
            sourceManagedFileHashes?: unknown;
            sourceAgentsFileHash?: unknown;
        };
        if (
            !isSha40(sourceRepositorySha) ||
            typeof syncedAtUtc !== "string" ||
            !sourceManagedFileHashes ||
            typeof sourceManagedFileHashes !== "object"
        ) {
            return undefined;
        }

        const normalizedManagedFileHashes = Object.entries(
            sourceManagedFileHashes,
        ).reduce<Record<string, Record<string, string>>>(
            (managedAcc, [setId, hashes]) => {
                if (!hashes || typeof hashes !== "object") {
                    return managedAcc;
                }

                const normalizedHashes = Object.entries(
                    hashes as Record<string, unknown>,
                ).reduce<Record<string, string>>(
                    (hashAcc, [filePath, hash]) => {
                        if (isSha64(hash)) {
                            hashAcc[filePath] = hash;
                        }
                        return hashAcc;
                    },
                    {},
                );
                managedAcc[setId] = normalizedHashes;
                return managedAcc;
            },
            {},
        );

        return {
            sourceRepositorySha,
            syncedAtUtc,
            sourceManagedFileHashes: normalizedManagedFileHashes,
            sourceAgentsFileHash: isSha64(sourceAgentsFileHash)
                ? sourceAgentsFileHash
                : undefined,
        };
    } catch {
        return undefined;
    }
}

function writeAgentSyncStateFile({
    workspaceFolderPath,
    sourceRepositorySha,
    syncedAtUtc,
    sourceManagedFileHashes,
    sourceAgentsFileHash,
}: {
    workspaceFolderPath: string;
    sourceRepositorySha: string;
    syncedAtUtc: string;
    sourceManagedFileHashes: Record<string, Record<string, string>>;
    sourceAgentsFileHash?: string;
}): string {
    const stateFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENT_PROMPTS_STATE_FILE,
    );
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });

    const statePayload: AgentSyncStateFile = {
        sourceRepositorySha,
        syncedAtUtc,
        sourceManagedFileHashes,
    };
    if (sourceAgentsFileHash) {
        statePayload.sourceAgentsFileHash = sourceAgentsFileHash;
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
    const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const backupPattern = new RegExp(`^${escapedBaseName}\\.backup\\.(\\d+)$`);
    for (const entry of fs.readdirSync(directoryPath)) {
        const match = backupPattern.exec(entry);
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

async function syncManagedFiles({
    sourceDir,
    sourceFiles,
    targetDir,
    displayName,
}: {
    sourceDir: string;
    sourceFiles: string[];
    targetDir: string;
    displayName: string;
}): Promise<ManagedFileSyncResult | undefined> {
    fs.mkdirSync(targetDir, { recursive: true });

    const sourcePathsByRelativePath = new Map<string, string>();
    for (const sourceFile of sourceFiles) {
        sourcePathsByRelativePath.set(
            normalizeRelativePath(path.relative(sourceDir, sourceFile)),
            sourceFile,
        );
    }

    const existingFiles = listFilesRecursive(targetDir);
    const backupRequiredTargets = new Array<string>();
    for (const targetFile of existingFiles) {
        const relativePath = normalizeRelativePath(
            path.relative(targetDir, targetFile),
        );
        const sourceFile = sourcePathsByRelativePath.get(relativePath);
        if (
            !sourceFile ||
            !filesMatchWithNormalization(sourceFile, targetFile)
        ) {
            if (shouldCreateBackup(targetFile)) {
                backupRequiredTargets.push(targetFile);
            }
        }
    }

    let shouldOverwriteManagedFiles = true;
    const backupPathsCreated = new Array<string>();
    if (backupRequiredTargets.length > 0) {
        const overwriteLabel = `Overwrite changed ${displayName.toLowerCase()} files (create backups first)`;
        const keepLabel = `Keep existing ${displayName.toLowerCase()} files`;
        const overwriteChoice = await window.showQuickPick(
            [{ label: overwriteLabel }, { label: keepLabel }],
            {
                placeHolder: `Overwrite changed ${displayName.toLowerCase()} files? Changed files will be backed up first.`,
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

    const overwrittenPaths = new Array<string>();
    const createdPaths = new Array<string>();
    const alreadyUpToDatePaths = new Array<string>();
    const keptPaths = new Array<string>();
    const deletedPaths = new Array<string>();

    for (const [relativePath, sourceFile] of sourcePathsByRelativePath) {
        const targetPath = path.join(targetDir, relativePath);
        const targetAlreadyExists = fs.existsSync(targetPath);
        if (
            targetAlreadyExists &&
            filesMatchWithNormalization(sourceFile, targetPath)
        ) {
            alreadyUpToDatePaths.push(relativePath);
            continue;
        }
        if (targetAlreadyExists && !shouldOverwriteManagedFiles) {
            keptPaths.push(relativePath);
            continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourceFile, targetPath);
        if (targetAlreadyExists) {
            overwrittenPaths.push(relativePath);
        } else {
            createdPaths.push(relativePath);
        }
    }

    for (const existingFile of existingFiles) {
        const relativePath = normalizeRelativePath(
            path.relative(targetDir, existingFile),
        );
        if (sourcePathsByRelativePath.has(relativePath)) {
            continue;
        }
        if (!shouldOverwriteManagedFiles) {
            keptPaths.push(relativePath);
            continue;
        }
        fs.rmSync(existingFile, { force: true });
        deletedPaths.push(relativePath);
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
}): Promise<AgentsFileSyncResult> {
    if (!sourceAgentsFilePath) {
        return {
            cancelled: false,
            summary: "No source AGENTS.md found in synced agent repo.",
        };
    }

    const workspaceAgentsFilePath = path.join(
        workspaceFolderPath,
        GSL_AGENTS_FILE,
    );
    if (!fs.existsSync(workspaceAgentsFilePath)) {
        fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
        return {
            cancelled: false,
            summary: "Created AGENTS.md from synced source.",
        };
    }

    if (
        filesMatchWithNormalization(
            sourceAgentsFilePath,
            workspaceAgentsFilePath,
        )
    ) {
        return {
            cancelled: false,
            summary: "Kept existing AGENTS.md (already up to date).",
        };
    }

    if (!shouldCreateBackup(workspaceAgentsFilePath)) {
        fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
        return {
            cancelled: false,
            summary: "Overwrote AGENTS.md with synced source.",
        };
    }

    const overwriteChoice = await window.showQuickPick(
        [
            { label: OVERWRITE_AGENTS_FILE_LABEL },
            { label: KEEP_AGENTS_FILE_LABEL },
        ],
        {
            placeHolder:
                "Do you want to overwrite workspace AGENTS.md with the synced version? Existing AGENTS.md will be backed up first.",
            ignoreFocusOut: true,
        },
    );
    if (!overwriteChoice) {
        return {
            cancelled: true,
            summary: "Kept existing AGENTS.md.",
        };
    }

    if (overwriteChoice.label !== OVERWRITE_AGENTS_FILE_LABEL) {
        return {
            cancelled: false,
            summary: "Kept existing AGENTS.md.",
        };
    }

    const backupPath = nextBackupPath(workspaceAgentsFilePath);
    fs.copyFileSync(workspaceAgentsFilePath, backupPath);
    backupPathsCreated.push(backupPath);
    fs.copyFileSync(sourceAgentsFilePath, workspaceAgentsFilePath);
    return {
        cancelled: false,
        summary: "Overwrote AGENTS.md with synced source.",
    };
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
async function cloneAgentPromptsRepo({
    tempRootPath,
    deployKey,
    showKnownHostsWarning,
}: {
    tempRootPath: string;
    deployKey: string;
    showKnownHostsWarning: boolean;
}): Promise<string> {
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
    if (showKnownHostsWarning && warningMessage) {
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
        sshCommandParts.push(`-o UserKnownHostsFile=${quotedKnownHostsPath}`);
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
    return clonePath;
}

function resolveManagedFileSetSourceData(
    clonePath: string,
): ManagedFileSetSourceData[] {
    return MANAGED_FILE_SETS.map((fileSet) => {
        const sourceDir = path.join(clonePath, fileSet.sourceSubdir);
        const sourceFiles = listFilesRecursive(sourceDir);
        return {
            fileSet,
            sourceDir,
            sourceFiles,
            sourceHashes: buildSourceFileHashes(sourceDir, sourceFiles),
        };
    });
}

async function ensureCopilotLocationsRegistered(): Promise<void> {
    const requiredLocations = MANAGED_FILE_SETS.filter(
        (fileSet) => fileSet.registerForCopilot,
    ).map((fileSet) => fileSet.targetSubdir);
    if (requiredLocations.length === 0) {
        return;
    }

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

    let shouldWrite = false;
    for (const requiredLocation of requiredLocations) {
        if (promptLocations[requiredLocation]) {
            continue;
        }
        promptLocations[requiredLocation] = true;
        shouldWrite = true;
    }

    if (!shouldWrite) {
        return;
    }
    await workspace
        .getConfiguration("chat")
        .update(
            "promptFilesLocations",
            promptLocations,
            ConfigurationTarget.Workspace,
        );
}

function warnIfCopilotReviewCommandMissing(clonePath: string): void {
    const requiredCommandFilePath = path.join(
        clonePath,
        GSL_AGENT_COMMANDS_SOURCE_SUBDIR,
        GSL_COPILOT_CODE_REVIEW_COMMAND_FILE,
    );
    if (fs.existsSync(requiredCommandFilePath)) {
        return;
    }

    const sourcePath = normalizeRelativePath(
        path.join(
            GSL_AGENT_COMMANDS_SOURCE_SUBDIR,
            GSL_COPILOT_CODE_REVIEW_COMMAND_FILE,
        ),
    );
    void window.showWarningMessage(
        `Required builtin command file is missing in source repository: ${sourcePath}`,
    );
}

function formatMarkdownBulletList(items: string[]): string {
    if (items.length === 0) {
        return "- none";
    }
    return items.map((item) => `- ${item}`).join("\n");
}

function buildManagedSetSummarySection({
    fileSet,
    sourceFileCount,
    syncResult,
}: ManagedFileSetSyncData): string[] {
    return [
        `### ${fileSet.displayName}`,
        "",
        `- Source files: ${sourceFileCount}`,
        `- Overwritten: ${syncResult.overwrittenPaths.length}`,
        `- Created: ${syncResult.createdPaths.length}`,
        `- Already up to date: ${syncResult.alreadyUpToDatePaths.length}`,
        `- Kept existing: ${syncResult.keptPaths.length}`,
        `- Removed: ${syncResult.deletedPaths.length}`,
        `- Backups created: ${syncResult.backupPathsCreated.length}`,
        "",
    ];
}

function buildSyncSummaryMarkdown({
    sourceRepositorySha,
    syncedAtUtc,
    managedSetSyncData,
    backupPathsForDisplay,
    agentsFileSummary,
}: {
    sourceRepositorySha: string;
    syncedAtUtc: string;
    managedSetSyncData: ManagedFileSetSyncData[];
    backupPathsForDisplay: string[];
    agentsFileSummary: string;
}): string {
    return [
        "# GSL Sync Results",
        "",
        "## Overview",
        "",
        `- Source repository: \`${GSL_AGENT_PROMPTS_REPO_SSH}\``,
        `- Source branch: \`${GSL_AGENT_PROMPTS_BRANCH}\``,
        `- Source SHA: \`${sourceRepositorySha}\``,
        `- Synced at (UTC): \`${syncedAtUtc}\``,
        "",
        "## Managed File Sets",
        "",
        ...managedSetSyncData.flatMap((syncData) =>
            buildManagedSetSummarySection(syncData),
        ),
        "## AGENTS.md",
        "",
        `- ${agentsFileSummary}`,
        "",
        "## Backup Files",
        "",
        formatMarkdownBulletList(backupPathsForDisplay),
        "",
    ].join("\n");
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

    const hasManagedFiles = MANAGED_FILE_SETS.some(
        ({ targetSubdir }) =>
            listFilesRecursive(path.join(workspaceFolderPath, targetSubdir))
                .length > 0,
    );
    if (
        !hasManagedFiles &&
        !fs.existsSync(path.join(workspaceFolderPath, GSL_AGENTS_FILE))
    ) {
        return;
    }

    const deployKey = await context.secrets.get(
        GSL_AGENT_PROMPTS_DEPLOY_KEY_SECRET,
    );
    if (!deployKey) {
        return;
    }

    const message = window.setStatusBarMessage(
        "Checking GSL managed customizations for updates...",
        30000,
    );
    let tempRootPath: string | undefined;
    try {
        tempRootPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "gsl-agent-prompts-"),
        );
        const clonePath = await cloneAgentPromptsRepo({
            tempRootPath,
            deployKey,
            showKnownHostsWarning: false,
        });

        const sourceRepositorySha = await resolveRepositoryHeadSha(clonePath);
        const sourceAgentsFilePath = resolveSourceAgentsFilePath(clonePath);
        const managedFileSetSourceData =
            resolveManagedFileSetSourceData(clonePath);

        const sourceManagedFileHashes: Record<
            string,
            Record<string, string>
        > = {};
        const storedSyncState = readAgentSyncStateFile(workspaceFolderPath);

        let updatedFileCount = 0;
        let skippedFileCount = 0;
        for (const {
            fileSet,
            sourceDir,
            sourceFiles,
            sourceHashes,
        } of managedFileSetSourceData) {
            sourceManagedFileHashes[fileSet.id] = sourceHashes;
            const previousSourceFileHashes =
                storedSyncState?.sourceManagedFileHashes[fileSet.id] ?? {};
            const targetDir = path.join(
                workspaceFolderPath,
                fileSet.targetSubdir,
            );
            const { updatedCount, skippedCount } = autoUpdateManagedFiles({
                sourceDir,
                sourceFiles,
                targetDir,
                previousSourceFileHashes,
            });
            updatedFileCount += updatedCount;
            skippedFileCount += skippedCount;
        }

        const { updatedAgentsFile, skippedAgentsFile } = autoUpdateAgentsFile({
            sourceAgentsFilePath,
            workspaceFolderPath,
            previousSourceAgentsFileHash: storedSyncState?.sourceAgentsFileHash,
        });

        const syncedAtUtc = new Date().toISOString();
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
            sourceManagedFileHashes,
            sourceAgentsFileHash: sourceAgentsFilePath
                ? hashNormalizedFile(sourceAgentsFilePath)
                : undefined,
        });

        if (
            updatedFileCount > 0 ||
            skippedFileCount > 0 ||
            updatedAgentsFile ||
            skippedAgentsFile
        ) {
            const skippedSummary =
                skippedFileCount > 0
                    ? `, ${skippedFileCount} file(s) not updated (local changes)`
                    : "";
            const agentsSummary = updatedAgentsFile
                ? ", AGENTS.md updated"
                : skippedAgentsFile
                  ? ", AGENTS.md not updated (local changes)"
                  : "";
            void window.showInformationMessage(
                `GSL customization auto-update: ${updatedFileCount} file(s) updated${skippedSummary}${agentsSummary}.`,
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
        "Syncing GSL managed customizations...",
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
        const clonePath = await cloneAgentPromptsRepo({
            tempRootPath,
            deployKey,
            showKnownHostsWarning: true,
        });

        warnIfCopilotReviewCommandMissing(clonePath);

        const sourceRepositorySha = await resolveRepositoryHeadSha(clonePath);
        const sourceAgentsFilePath = resolveSourceAgentsFilePath(clonePath);
        const managedFileSetSourceData =
            resolveManagedFileSetSourceData(clonePath);

        const backupPathsCreated = new Array<string>();
        const managedSetSyncData = new Array<ManagedFileSetSyncData>();
        const sourceManagedFileHashes: Record<
            string,
            Record<string, string>
        > = {};

        for (const {
            fileSet,
            sourceDir,
            sourceFiles,
            sourceHashes,
        } of managedFileSetSourceData) {
            const targetDir = path.join(
                workspaceFolder.uri.fsPath,
                fileSet.targetSubdir,
            );
            const syncResult = await syncManagedFiles({
                sourceDir,
                sourceFiles,
                targetDir,
                displayName: fileSet.displayName,
            });
            if (!syncResult) {
                return;
            }

            backupPathsCreated.push(...syncResult.backupPathsCreated);
            managedSetSyncData.push({
                fileSet,
                sourceFileCount: sourceFiles.length,
                syncResult,
            });
            sourceManagedFileHashes[fileSet.id] = sourceHashes;
        }

        await ensureCopilotLocationsRegistered();

        const agentsFileResult = await syncAgentsFile({
            sourceAgentsFilePath,
            workspaceFolderPath: workspaceFolder.uri.fsPath,
            backupPathsCreated,
        });
        if (agentsFileResult.cancelled) {
            return;
        }

        const syncedAtUtc = new Date().toISOString();
        writeSyncVersionFile({
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
            sourceManagedFileHashes,
            sourceAgentsFileHash: sourceAgentsFilePath
                ? hashNormalizedFile(sourceAgentsFilePath)
                : undefined,
        });

        const backupPathsForDisplay = backupPathsCreated.map((backupPath) =>
            normalizeRelativePath(
                path.relative(workspaceFolder.uri.fsPath, backupPath),
            ),
        );
        const summaryMarkdown = buildSyncSummaryMarkdown({
            sourceRepositorySha,
            syncedAtUtc,
            managedSetSyncData,
            backupPathsForDisplay,
            agentsFileSummary: agentsFileResult.summary,
        });
        const summaryFilePath = path.join(
            workspaceFolder.uri.fsPath,
            GSL_SYNC_SUMMARY_FILE,
        );
        fs.mkdirSync(path.dirname(summaryFilePath), { recursive: true });
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
