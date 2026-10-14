import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

import {
    commands,
    extensions,
    ExtensionContext,
    ProgressLocation,
    Uri,
    window,
    workspace,
} from "vscode";

function resolveGitPath(): string {
    const configured = workspace.getConfiguration("git").get<string>("path");
    if (configured) {
        return configured;
    }
    const gitExtension = extensions.getExtension<{
        getAPI(version: number): { git: { path: string } };
    }>("vscode.git");
    if (gitExtension?.isActive) {
        return gitExtension.exports.getAPI(1).git.path;
    }
    return "git";
}

// The secret name predates this command; keep it so stored keys still work.
const GSL_AGENT_FILES_DEPLOY_KEY_SECRET = "gsl.agentPromptsDeployPrivateKey";
const GSL_AGENT_FILES_REPO_SSH = "git@github.com:pltrant/GSL-Editor-Agents.git";
const GSL_AGENT_FILES_BRANCH = "main";
const GSL_AGENTS_FILE = "AGENTS.md";
const NOTIFY_ON_UPDATES_SETTING = "notifyAgentFileUpdates";
const INSTALLED_SHA_KEY = "gsl.installAgentFiles.installedSha";
const INSTALLED_FILE_HASHES_KEY = "gsl.installAgentFiles.installedFileHashes";
const AGENTS_DIRECTORY_KEY = "gsl.installAgentFiles.agentsDirectory";
const SKILLS_DIRECTORY_KEY = "gsl.installAgentFiles.skillsDirectory";
const INSTALL_NOW_LABEL = "Install Now";
const NOTIFICATION_SETTINGS_LABEL = "Notification Settings";
const OVERWRITE_LABEL = "Overwrite";
const KEEP_MY_CHANGES_LABEL = "Keep My Changes";
const MAX_LISTED_CONFLICTS = 10;
const GIT_TIMEOUT_MS = 60_000;
const LEGACY_SYNC_DIRECTORY = path.join(".github", "gsl-managed");

/**
 * Installed file hashes, keyed by install root (see installRootKey), then
 * relative path.
 */
type InstalledFileHashes = Record<string, Record<string, string>>;

/** Where one kind of file (AGENTS.md or skills) is installed. */
interface InstallRoot {
    key: string;
    rootDir: string;
}

interface InstallFile {
    rootKey: string;
    relativePath: string;
    sourcePath: string;
    targetPath: string;
}

interface InstallPlan {
    creates: InstallFile[];
    updates: InstallFile[];
    conflicts: InstallFile[];
    removals: { rootDir: string; targetPath: string }[];
    sourceHashes: InstalledFileHashes;
}

function runCommand(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(
            command,
            args,
            {
                cwd: options?.cwd,
                env: options?.env,
                timeout: options?.timeoutMs,
            },
            (error, stdout, stderr) => {
                if (error) {
                    if ("code" in error && error.code === "ENOENT") {
                        reject(new Error(`Could not find "${command}".`));
                        return;
                    }
                    if (error.killed) {
                        reject(new Error(`"${command}" timed out.`));
                        return;
                    }
                    const stderrText = stderr?.toString().trim() ?? "";
                    const detail =
                        stderrText ||
                        stdout?.toString().trim() ||
                        error.message;
                    reject(new Error(detail));
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
        if (entry.name.toLowerCase() === ".gitignore") {
            continue;
        }
        if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

async function resolveRepositoryHeadSha(repoPath: string): Promise<string> {
    const { stdout } = await runCommand(
        resolveGitPath(),
        ["rev-parse", "HEAD"],
        {
            cwd: repoPath,
        },
    );
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error("Unable to resolve cloned repository SHA.");
    }
    return sha;
}

function normalizeTextForComparison(text: string): string {
    const normalizedNewlines = text.replace(/\r\n?/g, "\n");
    return normalizedNewlines.endsWith("\n")
        ? normalizedNewlines.slice(0, -1)
        : normalizedNewlines;
}

function hashNormalizedFile(filePath: string): string {
    return crypto
        .createHash("sha256")
        .update(
            normalizeTextForComparison(fs.readFileSync(filePath, "utf8")),
            "utf8",
        )
        .digest("hex");
}

function normalizeRelativePath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
}

function isInsideDirectory(filePath: string, rootDir: string): boolean {
    const relativePath = path.relative(rootDir, filePath);
    return (
        relativePath !== "" &&
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
    );
}

async function resolveAgentFilesDeployKey(
    context: ExtensionContext,
): Promise<string | undefined> {
    const existingKey = await context.secrets.get(
        GSL_AGENT_FILES_DEPLOY_KEY_SECRET,
    );
    if (existingKey) {
        return existingKey;
    }

    const defaultKeyPath = path.join(
        os.homedir(),
        "gsl-editor-agents-deploy-key.txt",
    );
    const input = await window.showInputBox({
        prompt: "Path to the deploy private key file for GSL agent files",
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

    await context.secrets.store(GSL_AGENT_FILES_DEPLOY_KEY_SECRET, deployKey);
    return deployKey;
}

async function createDeployKeyGitEnv({
    tempRootPath,
    deployKey,
    showKnownHostsWarning,
}: {
    tempRootPath: string;
    deployKey: string;
    showKnownHostsWarning: boolean;
}): Promise<NodeJS.ProcessEnv> {
    const keyPath = path.join(tempRootPath, "deploy_key");
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
        "-o BatchMode=yes",
    ];
    if (knownHostsPath) {
        const normalizedKnownHostsPath = knownHostsPath.replace(/\\/g, "/");
        const quotedKnownHostsPath = `"${normalizedKnownHostsPath.replace(/"/g, '\\"')}"`;
        sshCommandParts.push(`-o UserKnownHostsFile=${quotedKnownHostsPath}`);
    }
    return {
        ...process.env,
        GIT_SSH_COMMAND: sshCommandParts.join(" "),
    };
}

async function cloneAgentFilesRepo({
    tempRootPath,
    deployKey,
}: {
    tempRootPath: string;
    deployKey: string;
}): Promise<string> {
    const clonePath = path.join(tempRootPath, "repo");
    const env = await createDeployKeyGitEnv({
        tempRootPath,
        deployKey,
        showKnownHostsWarning: true,
    });
    await runCommand(
        resolveGitPath(),
        [
            "clone",
            "--depth",
            "1",
            "--branch",
            GSL_AGENT_FILES_BRANCH,
            GSL_AGENT_FILES_REPO_SSH,
            clonePath,
        ],
        { env, timeoutMs: GIT_TIMEOUT_MS },
    );
    return clonePath;
}

async function fetchRemoteHeadSha({
    tempRootPath,
    deployKey,
}: {
    tempRootPath: string;
    deployKey: string;
}): Promise<string> {
    const env = await createDeployKeyGitEnv({
        tempRootPath,
        deployKey,
        showKnownHostsWarning: false,
    });
    const { stdout } = await runCommand(
        resolveGitPath(),
        [
            "ls-remote",
            GSL_AGENT_FILES_REPO_SSH,
            `refs/heads/${GSL_AGENT_FILES_BRANCH}`,
        ],
        { env, timeoutMs: GIT_TIMEOUT_MS },
    );
    const sha = stdout.split(/\s/, 1)[0];
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error("Unable to resolve the remote branch SHA.");
    }
    return sha;
}

async function pickDirectory({
    context,
    stateKey,
    title,
    openLabel,
}: {
    context: ExtensionContext;
    stateKey: string;
    title: string;
    openLabel: string;
}): Promise<string | undefined> {
    const rememberedDirectory = context.workspaceState.get<string>(stateKey);
    const defaultUri =
        rememberedDirectory && fs.existsSync(rememberedDirectory)
            ? Uri.file(rememberedDirectory)
            : workspace.workspaceFolders?.[0]?.uri;
    const picked = await window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri,
        title,
        openLabel,
    });
    const directory = picked?.[0]?.fsPath;
    return directory ? path.resolve(directory) : undefined;
}

/**
 * Tracks each kind of file separately, so choosing a different folder for
 * one kind never treats the other kind's files as removed upstream.
 */
function installRootKey(kind: "agents" | "skills", rootDir: string): string {
    return `${kind}:${rootDir}`;
}

function listInstallFiles({
    clonePath,
    agentsDirectory,
    skillsDirectory,
}: {
    clonePath: string;
    agentsDirectory: string;
    skillsDirectory: string;
}): { roots: InstallRoot[]; files: InstallFile[] } {
    const sourceAgentsFilePath = path.join(clonePath, "src", GSL_AGENTS_FILE);
    if (!fs.existsSync(sourceAgentsFilePath)) {
        throw new Error("The agent files repository has no src/AGENTS.md.");
    }
    const sourceSkillsDirectory = path.join(clonePath, "src", "skills");
    const agentsRoot = {
        key: installRootKey("agents", agentsDirectory),
        rootDir: agentsDirectory,
    };
    const skillsRoot = {
        key: installRootKey("skills", skillsDirectory),
        rootDir: skillsDirectory,
    };

    return {
        roots: [agentsRoot, skillsRoot],
        files: [
            {
                rootKey: agentsRoot.key,
                relativePath: GSL_AGENTS_FILE,
                sourcePath: sourceAgentsFilePath,
                targetPath: path.join(agentsDirectory, GSL_AGENTS_FILE),
            },
            ...listFilesRecursive(sourceSkillsDirectory).map((sourcePath) => {
                const relativePath = normalizeRelativePath(
                    path.relative(sourceSkillsDirectory, sourcePath),
                );
                return {
                    rootKey: skillsRoot.key,
                    relativePath,
                    sourcePath,
                    targetPath: path.join(skillsDirectory, relativePath),
                };
            }),
        ],
    };
}

/**
 * Decides what an install will do without changing anything. A file that
 * differs from the source is only updated without asking when it still
 * matches what was last installed there. Files removed from the source are
 * only removed when this command installed them and they are unchanged.
 */
function buildInstallPlan(
    { roots, files }: { roots: InstallRoot[]; files: InstallFile[] },
    installedFileHashes: InstalledFileHashes,
): InstallPlan {
    const plan: InstallPlan = {
        creates: [],
        updates: [],
        conflicts: [],
        removals: [],
        sourceHashes: Object.fromEntries(roots.map(({ key }) => [key, {}])),
    };

    for (const installFile of files) {
        const sourceHash = hashNormalizedFile(installFile.sourcePath);
        plan.sourceHashes[installFile.rootKey][installFile.relativePath] =
            sourceHash;

        if (!fs.existsSync(installFile.targetPath)) {
            plan.creates.push(installFile);
            continue;
        }

        const targetHash = hashNormalizedFile(installFile.targetPath);
        if (targetHash === sourceHash) {
            continue;
        }

        const installedHash =
            installedFileHashes[installFile.rootKey]?.[
                installFile.relativePath
            ];
        if (targetHash === installedHash) {
            plan.updates.push(installFile);
        } else {
            plan.conflicts.push(installFile);
        }
    }

    for (const { key, rootDir } of roots) {
        for (const [relativePath, installedHash] of Object.entries(
            installedFileHashes[key] ?? {},
        )) {
            if (relativePath in plan.sourceHashes[key]) {
                continue;
            }
            const targetPath = path.join(rootDir, relativePath);
            if (
                fs.existsSync(targetPath) &&
                hashNormalizedFile(targetPath) === installedHash
            ) {
                plan.removals.push({ rootDir, targetPath });
            }
        }
    }

    return plan;
}

async function confirmConflicts(
    conflicts: InstallFile[],
): Promise<"overwrite" | "keep" | undefined> {
    if (conflicts.length === 0) {
        return "keep";
    }

    const listedPaths = conflicts
        .slice(0, MAX_LISTED_CONFLICTS)
        .map(({ targetPath }) => targetPath);
    if (conflicts.length > MAX_LISTED_CONFLICTS) {
        listedPaths.push(
            `...and ${conflicts.length - MAX_LISTED_CONFLICTS} more`,
        );
    }
    const choice = await window.showWarningMessage(
        `${conflicts.length} file(s) have local changes or were not installed by this command. Overwrite them with the latest version?`,
        { modal: true, detail: listedPaths.join("\n") },
        OVERWRITE_LABEL,
        KEEP_MY_CHANGES_LABEL,
    );
    if (choice === OVERWRITE_LABEL) {
        return "overwrite";
    }
    return choice === KEEP_MY_CHANGES_LABEL ? "keep" : undefined;
}

function removeEmptyParentDirectories(filePath: string, rootDir: string) {
    let directory = path.dirname(filePath);
    while (
        isInsideDirectory(directory, rootDir) &&
        fs.readdirSync(directory).length === 0
    ) {
        fs.rmdirSync(directory);
        directory = path.dirname(directory);
    }
}

function applyInstallPlan(plan: InstallPlan, overwriteConflicts: boolean) {
    const filesToWrite = [
        ...plan.creates,
        ...plan.updates,
        ...(overwriteConflicts ? plan.conflicts : []),
    ];
    for (const { sourcePath, targetPath } of filesToWrite) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
    }

    for (const { rootDir, targetPath } of plan.removals) {
        fs.rmSync(targetPath, { force: true });
        removeEmptyParentDirectories(targetPath, rootDir);
    }
}

function describeInstallResult(
    plan: InstallPlan,
    overwriteConflicts: boolean,
): string {
    const updatedCount =
        plan.updates.length + (overwriteConflicts ? plan.conflicts.length : 0);
    const parts = [
        plan.creates.length > 0 ? `${plan.creates.length} added` : undefined,
        updatedCount > 0 ? `${updatedCount} updated` : undefined,
        plan.removals.length > 0
            ? `${plan.removals.length} removed`
            : undefined,
        !overwriteConflicts && plan.conflicts.length > 0
            ? `${plan.conflicts.length} kept with your changes`
            : undefined,
    ].filter((part): part is string => part !== undefined);
    return parts.length > 0
        ? `Installed GSL AGENTS.md and skills: ${parts.join(", ")}.`
        : "GSL AGENTS.md and skills are already up to date.";
}

export interface InstallAgentFilesCommandDependencies {
    context: ExtensionContext;
}

export async function runStartupAgentFilesUpdateCheck({
    context,
}: InstallAgentFilesCommandDependencies): Promise<void> {
    const notifyOnUpdates = workspace
        .getConfiguration("gsl")
        .get<boolean>(NOTIFY_ON_UPDATES_SETTING, true);
    if (!notifyOnUpdates) {
        return;
    }

    // Only check workspaces that have installed the files, or that still
    // have the folder written by the old Sync Agent Prompts command.
    const workspaceFolderPath = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolderPath) {
        return;
    }
    const installedSha = context.workspaceState.get<string>(INSTALLED_SHA_KEY);
    if (
        !installedSha &&
        !fs.existsSync(path.join(workspaceFolderPath, LEGACY_SYNC_DIRECTORY))
    ) {
        return;
    }

    const deployKey = await context.secrets.get(
        GSL_AGENT_FILES_DEPLOY_KEY_SECRET,
    );
    if (!deployKey) {
        return;
    }

    let sourceRepositorySha: string;
    let tempRootPath: string | undefined;
    try {
        tempRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-agents-"));
        sourceRepositorySha = await fetchRemoteHeadSha({
            tempRootPath,
            deployKey,
        });
    } catch {
        return;
    } finally {
        if (tempRootPath) {
            fs.rmSync(tempRootPath, { recursive: true, force: true });
        }
    }

    if (sourceRepositorySha === installedSha) {
        return;
    }

    const choice = await window.showInformationMessage(
        "Updated GSL AGENTS.md and skills are available.",
        INSTALL_NOW_LABEL,
        NOTIFICATION_SETTINGS_LABEL,
    );
    if (choice === INSTALL_NOW_LABEL) {
        void commands.executeCommand("gsl.installAgentFiles");
    } else if (choice === NOTIFICATION_SETTINGS_LABEL) {
        void commands.executeCommand(
            "workbench.action.openSettings",
            `gsl.${NOTIFY_ON_UPDATES_SETTING}`,
        );
    }
}

export async function runInstallAgentFilesCommand({
    context,
}: InstallAgentFilesCommandDependencies): Promise<void> {
    let tempRootPath: string | undefined;
    try {
        const deployKey = await resolveAgentFilesDeployKey(context);
        if (!deployKey) {
            return;
        }

        const agentsDirectory = await pickDirectory({
            context,
            stateKey: AGENTS_DIRECTORY_KEY,
            title: "Select the folder to install AGENTS.md into",
            openLabel: "Install AGENTS.md Here",
        });
        if (!agentsDirectory) {
            return;
        }
        const skillsDirectory = await pickDirectory({
            context,
            stateKey: SKILLS_DIRECTORY_KEY,
            title: "Select the folder to install GSL skills into (for example .claude/skills)",
            openLabel: "Install Skills Here",
        });
        if (!skillsDirectory) {
            return;
        }

        tempRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "gsl-agents-"));
        const cloneRoot = tempRootPath;
        const clonePath = await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: "Downloading GSL AGENTS.md and skills...",
            },
            () =>
                cloneAgentFilesRepo({
                    tempRootPath: cloneRoot,
                    deployKey,
                }),
        );
        const sourceRepositorySha = await resolveRepositoryHeadSha(clonePath);

        const installedFileHashes =
            context.globalState.get<InstalledFileHashes>(
                INSTALLED_FILE_HASHES_KEY,
            ) ?? {};
        const plan = buildInstallPlan(
            listInstallFiles({ clonePath, agentsDirectory, skillsDirectory }),
            installedFileHashes,
        );
        const conflictChoice = await confirmConflicts(plan.conflicts);
        if (!conflictChoice) {
            return;
        }

        const overwriteConflicts = conflictChoice === "overwrite";
        applyInstallPlan(plan, overwriteConflicts);
        await context.globalState.update(INSTALLED_FILE_HASHES_KEY, {
            ...installedFileHashes,
            ...plan.sourceHashes,
        });
        await context.workspaceState.update(
            INSTALLED_SHA_KEY,
            sourceRepositorySha,
        );
        await context.workspaceState.update(
            AGENTS_DIRECTORY_KEY,
            agentsDirectory,
        );
        await context.workspaceState.update(
            SKILLS_DIRECTORY_KEY,
            skillsDirectory,
        );
        void window.showInformationMessage(
            describeInstallResult(plan, overwriteConflicts),
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const isAuthError = /permission denied|authentication|publickey/i.test(
            detail,
        );
        const guidance = isAuthError
            ? " Check that your deploy key is correctly configured."
            : "";
        window.showErrorMessage(
            `Installing GSL agent files failed: ${detail}${guidance}`,
        );
    } finally {
        if (tempRootPath) {
            fs.rmSync(tempRootPath, { recursive: true, force: true });
        }
    }
}
