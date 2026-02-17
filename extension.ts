import * as path from "path";
import * as fs from "fs";

import {
    ExtensionContext,
    StatusBarAlignment,
    Disposable,
    DocumentSelector,
    Uri,
    QuickPickItem,
    StatusBarItem,
    OutputChannel,
    TextDocument,
    Diagnostic,
    DiagnosticCollection,
    CodeActionKind,
    Range,
} from "vscode";

import { workspace, window, commands, languages, extensions } from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
    DiagnosticSeverity,
} from "vscode-languageclient/node";

import {
    GSLDocumentSymbolProvider,
    GSLHoverProvider,
    GSLDefinitionProvider,
    GSLDocumentHighlightProvider,
    GSLDocumentFormattingEditProvider,
} from "./gsl";

import { EAccessClient } from "./gsl/eaccessClient";
import { GameTerminal } from "./gsl/gameTerminal";
import {
    ScriptCompileStatus,
    ScriptError,
    ScriptProperties,
    ScriptCompileResults,
    withEditorClient,
    EditorClientInterface,
} from "./gsl/editorClient";
import { formatDate } from "./gsl/util/dateUtil";
import { OutOfDateButtonManager } from "./gsl/status_bar/scriptOutOfDateButton";
import { scriptNumberFromFileName } from "./gsl/util/scriptUtil";
import {
    GSLX_AUTOMATIC_DOWNLOADS,
    GSLX_DEV_ACCOUNT,
    GSLX_DEV_CHARACTER,
    GSLX_DEV_INSTANCE,
    GSLX_DEV_PASSWORD,
    GSLX_DISABLE_LOGIN,
    GSLX_ENABLE_SCRIPT_SYNC_CHECKS,
    GSLX_NEW_INSTALL_FLAG,
    GSLX_SAVED_VERSION,
    GSL_LANGUAGE_ID,
} from "./gsl/const";
import { FrozenScriptWarningManager } from "./gsl/status_bar/frozenScriptWarning";
import {
    getAlignCommentsAction,
    GSLCodeActionProvider,
} from "./gsl/codeActionProvider";
import { subscribeToDocumentChanges } from "./gsl/diagnostics";
import { formatIndentation } from "./gsl/util/formattingUtil";
import { registerCopilotTools } from "./gsl/copilotTools";
import { runDiffWithPrimeCommand } from "./gsl/commands/diffWithPrime";
import { runPrimeSetupCommand } from "./gsl/commands/primeSetup";
import * as primeService from "./gsl/prime/primeService";

const rx_script_number = /^\d{1,6}$/;
const rx_script_number_in_filename = /(\d+)\.gsl/;

interface LastSeenScriptModification {
    modifier: string;
    lastModifiedDate: Date;
}

interface DownloadScriptResult {
    scriptNumber: number;
    /** Local file system path of downloaded script */
    scriptPath: string;
    /** Up-to-date script properties */
    scriptProperties: ScriptProperties;
    /** Status for "/ss checkedit"; undefined if feature is disabled */
    syncStatus: string | undefined;
}

export class GSLExtension {
    private static context: ExtensionContext;
    private static diagnostics: DiagnosticCollection;

    static init(context: ExtensionContext) {
        this.context = context;
        this.diagnostics = languages.createDiagnosticCollection();
    }

    static getDownloadLocation(): string {
        let extPath: any = null;
        let useWorkspaceFolder = workspace
            .getConfiguration(GSL_LANGUAGE_ID)
            .get("downloadToWorkspace");
        if (useWorkspaceFolder && workspace.workspaceFolders) {
            extPath = workspace.workspaceFolders[0].uri.fsPath;
        } else {
            extPath = workspace
                .getConfiguration(GSL_LANGUAGE_ID)
                .get("downloadPath");
        }
        if (!extPath) {
            let rootPath = path.resolve(__dirname, "../gsl");
            if (!fs.existsSync(rootPath)) {
                // Directory doesn't exist
                fs.mkdirSync(rootPath); // Create directory
            }
            extPath = path.resolve(__dirname, "../gsl/scripts");
        }
        if (!fs.existsSync(extPath)) {
            // Directory doesn't exist
            fs.mkdirSync(extPath); // Create directory
        }
        return extPath;
    }

    /** @returns path of newly downloaded script, or `undefined` if download failed */
    static async downloadScript(
        client: EditorClientInterface,
        script: number | string,
    ): Promise<DownloadScriptResult> {
        try {
            // Get script properties, keeping editor open
            const scriptProperties = await client
                .modifyScript(script, true)
                .catch((e: any) => {
                    throw new Error(
                        `Failed to get script properties: ${e.message}`,
                    );
                });
            // Write file
            const destinationPath = path.join(
                this.getDownloadLocation(),
                scriptProperties.path.split("/").pop()!,
            );
            if (scriptProperties.new) {
                fs.writeFileSync(destinationPath, "");
                await client.exitModifyScript();
            } else {
                // Note that captureScript closes modifyScript
                let content = await client.captureScript().catch((e) => {
                    throw new Error(`Failed to download script: ${e.message}`);
                });
                if (content) {
                    if (content.slice(-2) !== "\r\n") {
                        content += "\r\n";
                    }
                    fs.writeFileSync(destinationPath, content);
                }
            }
            // Record script modification info
            const scriptNumber = Number(
                path
                    .basename(destinationPath)
                    .match(rx_script_number_in_filename)![1],
            );
            if (Number.isNaN(scriptNumber))
                throw new Error("Expected script number, not NaN");
            this.recordScriptModification(
                scriptNumber,
                scriptProperties.modifier,
                scriptProperties.lastModifiedDate,
            );
            let syncStatus = undefined;
            if (
                workspace
                    .getConfiguration(GSL_LANGUAGE_ID)
                    .get(GSLX_ENABLE_SCRIPT_SYNC_CHECKS) &&
                this.context.globalState.get(GSLX_DEV_INSTANCE) === "GS4D" &&
                this.matchesRemoteAccount(scriptProperties.modifier)
            ) {
                syncStatus = await client
                    .showScriptCheckStatus(scriptNumber)
                    .catch((e: any) => {
                        console.error("Failed to run show script check", e);
                    });
            }
            // Return results
            return {
                scriptNumber,
                scriptProperties,
                scriptPath: destinationPath,
                syncStatus: syncStatus || undefined,
            };
        } catch (e) {
            // We passed keepalive=true to `modifyScript`, so we need to make sure
            // to exit the editor when something goes wrong.
            await client.exitModifyScript();
            throw e;
        }
    }

    static async uploadScript(
        client: EditorClientInterface,
        script: number,
        document: TextDocument,
        options?: { skipUploadConfirmation?: boolean },
    ): Promise<ScriptCompileResults | undefined> {
        // Get script properties, keeping editor open
        const scriptProperties = await client.modifyScript(script, true);
        // Confirm upload if needed
        if (!options?.skipUploadConfirmation) {
            const requiresConfirmation =
                GSLExtension.requiresUploadConfirmation(
                    script,
                    scriptProperties,
                );
            if (requiresConfirmation) {
                const confirmation = await window.showWarningMessage(
                    requiresConfirmation.prompt,
                    { modal: true },
                    "Yes",
                );
                if (confirmation !== "Yes") {
                    await client.exitModifyScript();
                    return;
                }
            }
        }
        // Send script
        const lines = new Array<string>();
        for (let n = 0, nn = document.lineCount; n < nn; n++) {
            lines.push(document.lineAt(n).text);
        }
        if (lines[lines.length - 1] !== "") {
            lines.push("");
        }
        // Note that sendScript closes modifyScript
        let compileResults = await client.sendScript(
            lines,
            scriptProperties.new,
        );
        // Verify success
        if (compileResults.status === ScriptCompileStatus.Failed) {
            const problems = compileResults.errorList.map(
                (error: ScriptError) => {
                    const line = document.lineAt(error.line - 1)!;
                    return new Diagnostic(
                        line.range,
                        error.message,
                        DiagnosticSeverity.Error,
                    );
                },
            );
            this.diagnostics.set(document.uri, problems);
            return compileResults;
        }
        this.diagnostics.clear();
        // Record updated script properties
        const newScriptProperties = await client.modifyScript(script);
        this.recordScriptModification(
            script,
            newScriptProperties.modifier,
            newScriptProperties.lastModifiedDate,
        );
        return compileResults;
    }

    static async checkModifiedDate(
        client: EditorClientInterface,
        script: number,
    ): Promise<Date | undefined> {
        try {
            const output = await client.showScript(script);
            if (!output || !output.lastModifiedDate) return;
            return output.lastModifiedDate;
        } catch (e) {
            console.error(e);
            throw new Error("Failed to get /ss output");
        }
    }

    static requiresUploadConfirmation(
        script: number,
        newestProperties: ScriptProperties,
    ): { prompt: string } | undefined {
        if (newestProperties.new) return; // New scripts don't need confirmation
        const lastSeenMod = this.findLastSeenScriptModification(script);
        let reasons = [];

        if (
            !lastSeenMod ||
            !lastSeenMod.lastModifiedDate ||
            !lastSeenMod.modifier
        ) {
            reasons.push(
                `I haven't seen you download this script before. This could be because you downloaded the script prior` +
                    ` to the safety guard being added. If you want to be extra safe, you can download the script from the` +
                    ` server, compare it with your local copy, and then proceed. At that point I will not warn you again` +
                    ` for this specific reason. You can also proceed now if you are confident that your local copy` +
                    ` should overwrite the server copy.`,
            );
        } else if (
            lastSeenMod.lastModifiedDate.toISOString() !==
            newestProperties.lastModifiedDate.toISOString()
        ) {
            reasons.push(
                `It appears to have been edited since you last downloaded it.` +
                    `\nLocal:  ${formatDate(lastSeenMod.lastModifiedDate)}.` +
                    `\nServer: ${formatDate(newestProperties.lastModifiedDate)}.`,
            );
        }
        const currentAccount = this.getAccountName();
        if (!this.matchesRemoteAccount(newestProperties.modifier)) {
            reasons.push(
                "Someone else modified it last." +
                    `\nLast Modifier: ${newestProperties.modifier}` +
                    `  (on ${formatDate(newestProperties.lastModifiedDate)})` +
                    `\nYou: ${currentAccount}`,
            );
        }

        return reasons.length === 0
            ? undefined
            : {
                  prompt:
                      `Overwriting script ${script} requires confirmation for the following reason(s):\n\n` +
                      reasons.join("\n\n") +
                      `\n\nWould you like to upload this script anyway?`,
              };
    }

    static recordScriptModification(
        script: number,
        modifier: string,
        lastModifiedDate: Date,
    ): void {
        this.context.globalState.update(this.scriptPropsKey(script), {
            modifier,
            lastModifiedDate: lastModifiedDate.toISOString(),
        });
    }

    static findLastSeenScriptModification(
        script: number,
    ): LastSeenScriptModification | undefined {
        const output = this.context.globalState.get<{
            modifier: string;
            lastModifiedDate: string;
        }>(this.scriptPropsKey(script));
        return output
            ? {
                  modifier: output.modifier,
                  lastModifiedDate: new Date(output.lastModifiedDate), // restore from ISO string
              }
            : undefined;
    }

    /** @returns key for storing script modification data */
    private static scriptPropsKey(script: number): string {
        return `script_properties.${script}`;
    }

    static getAccountName(): string | undefined {
        const name = this.context.globalState.get(GSLX_DEV_ACCOUNT);
        if (!name) return;
        return `W_${name}`;
    }

    /**
     * @returns true if the local account name matches the given remote account
     * name. Note that the server truncates account names to 12 characters, so
     * this will return false positives in the case where account names exceed
     * that count.
     */
    static matchesRemoteAccount(remoteAccountName: string): boolean {
        return this.getAccountName()?.startsWith(remoteAccountName) || false;
    }
}

interface QuickPickCommandItem extends QuickPickItem {
    name: string;
}

export class VSCodeIntegration {
    private context: ExtensionContext;

    private downloadButton: StatusBarItem;
    private uploadButton: StatusBarItem;
    private gslButton: StatusBarItem;
    private frozenScriptWarning: StatusBarItem;

    /** Managed entirely by `OutOfDateButtonManager` */
    private scriptOutOfDateButton: StatusBarItem;

    private commandList: Array<QuickPickCommandItem>;

    private outputChannel: OutputChannel;

    private gameTerminal?: GameTerminal;

    private loggingEnabled: boolean;

    private frozenScriptWarningManager: FrozenScriptWarningManager | undefined;
    private outOfDateButtonManager: OutOfDateButtonManager;

    constructor(context: ExtensionContext) {
        this.context = context;

        this.downloadButton = window.createStatusBarItem(
            StatusBarAlignment.Left,
            50,
        );
        this.uploadButton = window.createStatusBarItem(
            StatusBarAlignment.Left,
            50,
        );
        this.gslButton = window.createStatusBarItem(
            StatusBarAlignment.Left,
            50,
        );
        this.frozenScriptWarning = window.createStatusBarItem(
            StatusBarAlignment.Left,
            6,
        );
        // Place out-of-date button as far to the right as possible, but left of status message
        this.scriptOutOfDateButton = window.createStatusBarItem(
            StatusBarAlignment.Left,
            5,
        );

        this.commandList = [
            { label: "Download Script", name: "gsl.downloadScript" },
            { label: "Upload Script", name: "gsl.uploadScript" },
            { label: "Check script modification date", name: "gsl.checkDate" },
            { label: "List GSL Tokens", name: "gsl.listTokens" },
            {
                label: "Show GSL extension output channel",
                name: "gsl.showChannel",
            },
            { label: "Toggle output logging", name: "gsl.toggleLogging" },
            { label: "Open development terminal", name: "gsl.openTerminal" },
            {
                label: "Connect to development server",
                name: "gsl.openConnection",
            },
            { label: "User Setup", name: "gsl.userSetup" },
            {
                label: "Format Document Indentation",
                name: "gsl.formatIndentation",
            },
            { label: "Prime Server Setup", name: "gsl.primeSetup" },
            { label: "Diff with Prime Server", name: "gsl.diffWithPrime" },
        ];

        this.outputChannel = window.createOutputChannel("GSL Editor (debug)");

        this.loggingEnabled = false;

        this.registerCommands();
        this.initializeComponents();

        // Watch active editor for files that are out-of-date relative to
        // the server. If a stale file is seen, highlight the stale file
        // button, subtly prompting the user to refresh the local copy.
        this.outOfDateButtonManager = new OutOfDateButtonManager(
            this.scriptOutOfDateButton,
            this.withEditorClient.bind(this),
            this.showDownloadedScript.bind(this),
            this.context,
        );
        this.context.subscriptions.push(this.outOfDateButtonManager.activate());

        // Watch active editor for frozen files. Uses periodic polling.
        if (this.context.globalState.get(GSLX_DEV_INSTANCE) === "GS4D") {
            this.frozenScriptWarningManager = new FrozenScriptWarningManager(
                this.frozenScriptWarning,
                this.withEditorClient.bind(this),
            );
            this.context.subscriptions.push(
                this.frozenScriptWarningManager.activate(),
            );
        } else {
            this.frozenScriptWarning.hide();
        }
    }

    private initializeComponents() {
        this.downloadButton.text = "$(cloud-download) Download";
        this.downloadButton.command = "gsl.downloadScript";
        this.downloadButton.show();

        this.uploadButton.text = "$(cloud-upload) Upload";
        this.uploadButton.command = "gsl.uploadScript";
        this.uploadButton.show();

        this.gslButton.text = "$(ruby) GSL";
        this.gslButton.command = "gsl.showCommands";
        this.gslButton.show();

        if (
            workspace
                .getConfiguration(GSL_LANGUAGE_ID)
                .get("displayGameChannel")
        ) {
            this.outputChannel.show(true);
        }
    }

    /* commands */

    private async commandDownloadScript() {
        const prompt = "Script number(s) or verb name(s) to download?";
        const placeHolder = "29, incant, s07890.gsl, 9800-9805";
        const input = await window.showInputBox({ prompt, placeHolder });
        if (!input) {
            return;
        }
        const scriptOptions = input.split(/[\s,;]+/).filter(Boolean);
        const scriptList: Array<number | string> = [];
        for (let option of scriptOptions) {
            // Normalize: strip leading 's'/'S' (only if followed by a digit) and trailing '.gsl'
            option = option.replace(/^s(?=\d)/i, "").replace(/\.gsl$/i, "");
            if (option.indexOf("-") > -1) {
                let [first, second] = option.split("-");
                let low = parseInt(first);
                let high = parseInt(second);
                if (isNaN(low) || isNaN(high) || low > high) {
                    window.showErrorMessage("Invalid script range: " + option);
                }
                for (; low <= high; ) {
                    scriptList.push(low++);
                }
            } else {
                const script = Number(option);
                if (isNaN(script)) {
                    scriptList.push(option);
                } else {
                    scriptList.push(script);
                }
            }
        }
        let script: string | number | undefined = undefined;
        try {
            await this.withEditorClient(async (client) => {
                for (script of scriptList) {
                    const result = await GSLExtension.downloadScript(
                        client,
                        script,
                    );
                    if (!result) continue;
                    this.outOfDateButtonManager.renderButton({
                        state: "hidden",
                    });
                    await vsc?.showDownloadedScript(result);
                }
            });
        } catch (e: unknown) {
            console.error(e as any);
            const error = `Failed to download script ${script || scriptList[0]}`;
            window.showErrorMessage(
                e instanceof Error ? `${error} (${e.message})` : error,
            );
        }
    }
    private async showDownloadedScript(result: DownloadScriptResult) {
        const { scriptNumber, scriptPath, scriptProperties, syncStatus } =
            result;
        window.setStatusBarMessage(`Downloaded ${scriptPath}`, 5000);
        if (
            syncStatus &&
            !syncStatus.match(/All instances in sync/i) &&
            GSLExtension.matchesRemoteAccount(scriptProperties.modifier)
        ) {
            window.showInformationMessage(
                `s${scriptNumber} - instances out of sync - ${syncStatus.toLowerCase()}`,
            );
        }
        try {
            // Stop monitoring while we open the document so we don't
            // trigger an unnecessary download/check
            this.outOfDateButtonManager.stopMonitoring();
            await window.showTextDocument(
                await workspace.openTextDocument(scriptPath),
                { preview: false },
            );
            this.outOfDateButtonManager.renderButton({ state: "hidden" });
        } finally {
            this.outOfDateButtonManager.resumeMonitoring();
        }
    }

    private async commandUploadScript() {
        const document = window.activeTextEditor?.document;
        if (!document || !(document.languageId === GSL_LANGUAGE_ID)) {
            return void window.showWarningMessage(
                "Script upload requires an active GSL script editor",
            );
        }
        const fileName = path.basename(document.fileName);
        if (!/^s\d+\.gsl$/i.test(fileName)) {
            return void window.showErrorMessage(
                `Invalid script filename: "${fileName}". Expected format: s<number>.gsl`,
            );
        }
        if (document.isDirty) {
            let result = false;
            let i = 0;
            while (result === false && i++ < 3) {
                result = await document.save();
            }
            if (result === false) {
                return void window.showErrorMessage(
                    "Failed to save active script editor before upload.",
                );
            }
        }
        if (document.getText().match(/^\s*$/)) {
            return void window.showErrorMessage("Cannot upload empty script");
        }
        // Infer script number
        const inferredScriptNum = scriptNumberFromFileName(document.fileName);
        let scriptNum: number;
        if (rx_script_number.test(inferredScriptNum) === false) {
            const prompt =
                "Unable to parse script number from active editor file name.";
            const placeHolder = "Script number to upload as?";
            const input = await window.showInputBox({ prompt, placeHolder });
            if (!input || rx_script_number.test(input) === false) {
                return void window.showErrorMessage(
                    "Invalid script number provided.",
                );
            }
            scriptNum = Number(input);
        } else {
            scriptNum = Number(inferredScriptNum);
        }
        const uploadMessage = window.setStatusBarMessage(
            `Uploading Script...`,
            60000,
        );
        await this.withEditorClient(async (client) => {
            let compileResults: ScriptCompileResults | undefined;
            try {
                // Send script
                compileResults = await GSLExtension.uploadScript(
                    client,
                    scriptNum,
                    document,
                ); // closes modifyScript
                if (!compileResults) return;
                // Display compilation feedback
                if (compileResults.status === ScriptCompileStatus.Failed) {
                    const { script, errors, warnings } = compileResults;
                    window.showErrorMessage(
                        `Script ${script}: Compile failed; ${errors} error(s), ${warnings} warning(s).`,
                    );
                    commands.executeCommand("workbench.actions.view.problems");
                    return;
                }
                const { script, bytes, maxBytes } = compileResults;
                const bytesRemaining = maxBytes - bytes;
                const bytesMsg = `${bytes.toLocaleString()} bytes (${bytesRemaining.toLocaleString()} left)`;
                window.setStatusBarMessage(
                    `Script ${script}: Compile OK; ${bytesMsg}`,
                    5000,
                );
                this.outOfDateButtonManager.renderButton({ state: "hidden" });
            } catch (e) {
                const error = `Failed to upload script ${inferredScriptNum}`;
                window.showErrorMessage(
                    e instanceof Error ? `${error} (${e.message})` : error,
                );
                console.error(e);
                // We passed keepalive=true to `modifyScript`, so we need to make sure
                // to exit the editor when something goes wrong.
                await client.exitModifyScript();
            } finally {
                uploadMessage.dispose();
            }
        });
    }

    private async commandShowCommands() {
        const command = await window.showQuickPick(this.commandList, {
            placeHolder: "Select a command to execute.",
        });
        if (command) {
            commands.executeCommand(command.name);
        }
    }

    private async commandCheckDate() {
        if (!window.activeTextEditor || !window.activeTextEditor.document) {
            return void window.showErrorMessage(
                "You must have an open script before you can check its date.",
            );
        }
        let scriptNumber = path.basename(
            window.activeTextEditor.document.fileName,
        );
        scriptNumber = scriptNumber.replace(/\D+/g, "").replace(/^0+/, "");
        const script = Number(scriptNumber);
        await this.withEditorClient(async (client) => {
            window.setStatusBarMessage(
                `Checking modification date for script ${script} ...`,
                5000,
            );
            const date = await GSLExtension.checkModifiedDate(client, script);
            if (!date) {
                window.showErrorMessage(
                    `Failed to find modification date for script ${script}`,
                );
                return;
            }
            window.setStatusBarMessage(
                `Script ${script} was last modified on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`,
                5000,
            );
        });
    }

    private commandListTokens() {
        let uri = Uri.file(path.resolve(__dirname, "./syntaxes/tokens.md"));
        commands.executeCommand("markdown.showPreview", uri);
    }

    private async commandToggleLogging() {
        await this.withEditorClient(async (client) => {
            this.loggingEnabled = !this.loggingEnabled;
            client.toggleLogging();
            window.setStatusBarMessage(
                this.loggingEnabled ? "Logging enabled." : "Logging disabled.",
                5000,
            );
        });
    }

    private async commandUserSetup() {
        let account = await window.showInputBox({
            prompt: "PLAY.NET Account:",
            ignoreFocusOut: true,
        });
        if (!account) {
            return void window.showErrorMessage(
                "No account name entered; aborting setup.",
            );
        }

        let password = await window.showInputBox({
            prompt: "Password:",
            ignoreFocusOut: true,
            password: true,
        });
        if (!password) {
            return void window.showErrorMessage(
                "No password entered; aborting setup.",
            );
        }

        /* capture rejected promises */
        let error: Error | undefined;
        const captureError = (e: Error) => ((error = e), void 0);

        /* login */
        const gameChoice = await EAccessClient.login(account, password, {
            name: /.*?development.*?/i,
        }).catch(captureError);
        if (!gameChoice) {
            const message = error ? error.message : "Login failed?";
            return void window.showErrorMessage(message);
        }

        /* pick a game */
        const gamePickOptions = {
            ignoreFocusOut: true,
            placeholder: "Select a game ...",
        };
        const game = await window.showQuickPick(
            gameChoice.toNameList(),
            gamePickOptions,
        );
        if (!game) {
            gameChoice.cancel();
            return void window.showErrorMessage(
                "No game selected; aborting setup.",
            );
        }
        const characterChoice = await gameChoice
            .select(gameChoice.pick(game))
            .catch(captureError);
        if (!characterChoice) {
            const message = error ? error.message : "Game select failed?";
            gameChoice.cancel();
            return void window.showErrorMessage(message);
        }

        /* pick a character */
        const characterPickOptions = {
            ignoreFocusOut: true,
            placeholder: "Select a character ...",
        };
        const character = await window.showQuickPick(
            characterChoice.toNameList(),
            characterPickOptions,
        );
        if (!character) {
            characterChoice.cancel();
            return void window.showErrorMessage(
                "No character selected; aborting setup.",
            );
        }
        const result = await characterChoice
            .select(characterChoice.pick(character))
            .catch(captureError);
        if (!result) {
            const message = error ? error.message : "Character select failed?";
            return void window.showErrorMessage(message);
        }

        /* we now have the info we need to log into the same and save the details */
        const { sal, loginDetails } = result;

        /* store all the details for automated login */
        this.context.globalState.update(GSLX_DEV_ACCOUNT, loginDetails.account);
        this.context.globalState.update(GSLX_DEV_INSTANCE, loginDetails.game);
        this.context.globalState.update(
            GSLX_DEV_CHARACTER,
            loginDetails.character,
        );
        await this.context.secrets.store(GSLX_DEV_PASSWORD, password);
        window.showInformationMessage("Credentials stored for login");
    }

    private async commandOpenConnection() {
        const msg = window.setStatusBarMessage("Connecting to game...");
        try {
            await this.withEditorClient(() => {
                window.setStatusBarMessage(
                    "Connected to game successfully",
                    5000,
                );
            });
        } catch (e) {
            console.error(e);
            const error = "Failed to connect to game";
            window.setStatusBarMessage(error, 5000);
            window.showErrorMessage(
                e instanceof Error ? `${error} (${e.message})` : error,
            );
        } finally {
            msg.dispose();
        }
    }

    private async commandOpenTerminal() {
        if (this.gameTerminal) {
            this.gameTerminal.show(true);
            return;
        }
        try {
            const localGameTerminal = (this.gameTerminal = new GameTerminal(
                () => (this.gameTerminal = undefined),
            ));
            this.gameTerminal.show(true);
            await this.withEditorClient((client) => {
                if (localGameTerminal !== this.gameTerminal) return; // stale
                this.gameTerminal.bindClient(client);
            });
        } catch (e) {
            console.error(e);
            window.setStatusBarMessage(
                "Failed to bind terminal to game client",
                5000,
            );
        }
    }

    private async commandFormatIndentation() {
        const editor = window.activeTextEditor;
        if (!editor || editor.document.languageId !== GSL_LANGUAGE_ID) {
            return void window.showWarningMessage(
                "Format indentation requires an active GSL script editor",
            );
        }

        try {
            // Store the original text line by line
            const originalLines: string[] = [];
            for (let i = 0; i < editor.document.lineCount; i++) {
                originalLines.push(editor.document.lineAt(i).text);
            }

            // Format the document
            const formattedText = formatIndentation(editor.document);
            const formattedLines = formattedText.split("\n");

            // Count changed lines
            let changedLines = 0;
            for (
                let i = 0;
                i < Math.min(originalLines.length, formattedLines.length);
                i++
            ) {
                if (originalLines[i] !== formattedLines[i]) {
                    changedLines++;
                }
            }

            // Account for added or removed lines
            changedLines += Math.abs(
                originalLines.length - formattedLines.length,
            );

            if (!changedLines) {
                // Display the number of changed lines
                window.setStatusBarMessage(
                    `Document indentation formatted (no changes)`,
                    3000,
                );
                return;
            }

            // Replace the entire document text with the formatted text
            const entireDocument = new Range(
                0,
                0,
                editor.document.lineCount - 1,
                editor.document.lineAt(editor.document.lineCount - 1).text
                    .length,
            );

            await editor.edit((editBuilder) => {
                editBuilder.replace(entireDocument, formattedText);
            });

            // Display the number of changed lines
            window.setStatusBarMessage(
                `Document indentation formatted (${changedLines} line${changedLines !== 1 ? "s" : ""} changed)`,
                3000,
            );
        } catch (e) {
            console.error(e);
            window.showErrorMessage(
                `Formatting failed: ${e instanceof Error ? e.message : "Unknown error"}`,
            );
        }
    }

    private async commandAlignComments() {
        const editor = window.activeTextEditor;
        if (!editor || editor.document.languageId !== GSL_LANGUAGE_ID) {
            return void window.showWarningMessage(
                "Aligning comments requires an active GSL script editor",
            );
        }

        try {
            // Create a range that covers the entire document
            const entireDocument = new Range(
                0,
                0,
                editor.document.lineCount - 1,
                editor.document.lineAt(editor.document.lineCount - 1).text
                    .length,
            );

            // Get the alignment action from the code action provider
            const alignAction = getAlignCommentsAction(
                editor.document,
                entireDocument,
            );

            if (!alignAction || !alignAction.edit) {
                window.setStatusBarMessage(
                    "Comments aligned (no changes)",
                    3000,
                );
                return;
            }

            // Count how many edits will be made
            let changedLines = 0;
            alignAction.edit.entries().forEach(([_, edits]) => {
                changedLines += edits.length;
            });

            // Apply the edits
            await workspace.applyEdit(alignAction.edit);

            // Display the number of changed lines
            window.setStatusBarMessage(
                `Comments aligned (${changedLines} line${changedLines !== 1 ? "s" : ""} changed)`,
                3000,
            );
        } catch (e) {
            console.error(e);
            window.showErrorMessage(
                `Comment alignment failed: ${e instanceof Error ? e.message : "Unknown error"}`,
            );
        }
    }

    private async commandPrimeSetup() {
        return runPrimeSetupCommand({
            context: this.context,
        });
    }

    private async commandDiffWithPrime() {
        const { activeTextEditor } = window;
        if (
            !activeTextEditor ||
            activeTextEditor.document.languageId !== GSL_LANGUAGE_ID
        ) {
            return void window.showWarningMessage(
                "Diff with prime requires an active GSL script editor",
            );
        }

        const { document } = activeTextEditor;
        const scriptNumberStr = scriptNumberFromFileName(document.fileName);
        if (!rx_script_number.test(scriptNumberStr)) {
            return void window.showErrorMessage(
                "Could not determine script number from filename",
            );
        }

        const script = Number(scriptNumberStr);
        if (script < 1 || script > 999999) {
            return void window.showErrorMessage(
                "Script number must be between 1 and 999999",
            );
        }

        const msg = window.setStatusBarMessage(
            `Downloading script ${script} from prime server...`,
        );

        try {
            return await runDiffWithPrimeCommand({
                script,
                document,
                fetchPrimeScriptDiff: (targetScript, targetDocument) =>
                    this.fetchPrimeScriptDiff(targetScript, targetDocument),
            });
        } finally {
            msg.dispose();
        }
    }

    private getPrimeServiceDependencies(): primeService.PrimeServiceDependencies {
        return {
            context: this.context,
            outputChannel: this.outputChannel,
            downloadLocation: GSLExtension.getDownloadLocation(),
        };
    }

    async fetchPrimeScriptDiff(
        script: number,
        document: TextDocument,
    ): Promise<{
        localContent: string;
        primeContent: string;
        isNewOnPrime: boolean;
    }> {
        try {
            await this.withEditorClient(() => {});
        } catch {
            // Dev connection failed — that's fine
        }

        return primeService.fetchPrimeScriptDiff(
            script,
            document,
            this.getPrimeServiceDependencies(),
        );
    }

    async fetchPrimeScript(
        script: number,
    ): Promise<{ content: string; isNew: boolean }> {
        return primeService.fetchPrimeScript(
            script,
            this.getPrimeServiceDependencies(),
        );
    }

    async uploadScriptForAgent(
        script: number,
        document: TextDocument,
    ): Promise<ScriptCompileResults | undefined> {
        if (script !== 24661) {
            throw new Error(
                `Agent upload is restricted to script 24661. Refusing script ${script}.`,
            );
        }
        return this.withEditorClient(async (client) => {
            try {
                return await GSLExtension.uploadScript(
                    client,
                    script,
                    document,
                    {
                        skipUploadConfirmation: true,
                    },
                );
            } catch (error) {
                try {
                    await client.exitModifyScript();
                } catch (cleanupError) {
                    console.warn(
                        "Failed to exit modify script during agent upload cleanup",
                        cleanupError,
                    );
                }
                throw error;
            }
        });
    }

    private registerCommands() {
        let subscription: Disposable;
        subscription = commands.registerCommand(
            "gsl.downloadScript",
            this.commandDownloadScript,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.uploadScript",
            this.commandUploadScript,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.showCommands",
            this.commandShowCommands,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.checkDate",
            this.commandCheckDate,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.listTokens",
            this.commandListTokens,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.toggleLogging",
            this.commandToggleLogging,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.showChannel",
            this.showGameChannel,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.userSetup",
            this.commandUserSetup,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.openConnection",
            this.commandOpenConnection,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.openTerminal",
            this.commandOpenTerminal,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.formatIndentation",
            this.commandFormatIndentation,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.alignComments",
            this.commandAlignComments,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.primeSetup",
            this.commandPrimeSetup,
            this,
        );
        this.context.subscriptions.push(subscription);
        subscription = commands.registerCommand(
            "gsl.diffWithPrime",
            this.commandDiffWithPrime,
            this,
        );
        this.context.subscriptions.push(subscription);
    }

    /* public api */

    getGameInstance(): string | undefined {
        return this.context.globalState.get(GSLX_DEV_INSTANCE);
    }

    appendLineToGameChannel(text: string) {
        this.outputChannel.appendLine(text);
    }

    showGameChannel() {
        this.outputChannel.show(true);
    }

    outputGameChannel(text: string) {
        this.outputChannel.appendLine(text);
    }

    async promptUserSetup() {
        const message =
            "To start using the GSL Editor, you must run the User Setup process to store your Play.net account credentials.";
        const option = "Start User Setup";
        const choice = await window.showInformationMessage(message, option);
        if (choice === option) {
            this.commandUserSetup();
        }
    }

    async checkForNewInstall() {
        let flag = this.context.globalState.get(GSLX_NEW_INSTALL_FLAG);
        if (flag !== true) {
            const message =
                "For the best experience, the GSL Vibrant theme is recommended for the GSL Editor.";
            const option = "Apply Theme";
            const choice = await window.showInformationMessage(message, option);
            if (choice === option) {
                await workspace
                    .getConfiguration()
                    .update("workbench.colorTheme", "GSL Vibrant", true);
            }
            this.context.globalState.update(GSLX_NEW_INSTALL_FLAG, true);
        }
    }

    async checkForUpdatedVersion() {
        let extension = extensions.getExtension("patricktrant.gsl");
        if (extension) {
            let {
                packageJSON: { version },
            } = extension;
            let savedVersion = this.context.globalState.get(GSLX_SAVED_VERSION);
            if (savedVersion && savedVersion !== version) {
                const message = `The GSL Editor extension has been updated to version ${version}!`;
                const option = "Show Release Notes";
                const choice = await window.showInformationMessage(
                    message,
                    option,
                );
                if (choice === option) {
                    const changelogPath = path.resolve(
                        __dirname,
                        "./CHANGELOG.md",
                    );
                    commands.executeCommand(
                        "markdown.showPreview",
                        Uri.file(changelogPath),
                    );
                }
                this.copySpellCheckFiles();
                this.context.globalState.update(GSLX_SAVED_VERSION, version);
            }
        }
    }

    async copySpellCheckFiles() {
        let copyFile = false;
        let sourceFile = path.resolve(__dirname, "./spellcheck/cspell.json");
        let destinationFile = path.join(
            GSLExtension.getDownloadLocation(),
            "cspell.json",
        );
        if (!fs.existsSync(destinationFile)) {
            copyFile = true;
        } else if (
            fs.statSync(sourceFile).mtime > fs.statSync(destinationFile).mtime
        ) {
            copyFile = true;
        }
        if (copyFile) {
            fs.copyFile(sourceFile, destinationFile, () => {});
        }
        copyFile = false;
        sourceFile = path.resolve(
            __dirname,
            "./spellcheck/GemStoneDictionary.txt",
        );
        destinationFile = path.join(
            GSLExtension.getDownloadLocation(),
            "GemStoneDictionary.txt",
        );
        if (!fs.existsSync(destinationFile)) {
            copyFile = true;
        } else if (
            fs.statSync(sourceFile).mtime > fs.statSync(destinationFile).mtime
        ) {
            copyFile = true;
        }
        if (copyFile) {
            fs.copyFile(sourceFile, destinationFile, () => {});
        }
    }

    /**
     * Provides an `EditorClient` object that is guaranteed to be exclusively owned
     * by the caller, so long as all other callers are using this function. This
     * prevents callers from sending conflicting commands to the game. If the user
     * hasn't provided their login information yet this will skip execution of `task`
     * and instead prompt the user to provide that login info. This wraps another
     * function of the same name for convienence of ensuring preconditions and
     * passing common parameters.
     */
    async withEditorClient<T>(
        task: (client: EditorClientInterface) => T,
    ): Promise<T | undefined> {
        if (
            workspace.getConfiguration(GSL_LANGUAGE_ID).get(GSLX_DISABLE_LOGIN)
        ) {
            return void window.showErrorMessage("Game login is disabled");
        }
        const account = this.context.globalState.get<string>(GSLX_DEV_ACCOUNT);
        const instance =
            this.context.globalState.get<string>(GSLX_DEV_INSTANCE);
        const character =
            this.context.globalState.get<string>(GSLX_DEV_CHARACTER);
        const password = await this.context.secrets.get(GSLX_DEV_PASSWORD);
        if (!account || !instance || !character || !password) {
            this.promptUserSetup();
            return;
        }
        /** Redirect console to output channel */
        const consoleAdapter: { log: (...args: any) => void } = {
            log: (...args: any) => {
                this.outputChannel.append(
                    `[console(log): ${args.join(" ")}]\r\n`,
                );
            },
        };
        return withEditorClient(
            {
                login: {
                    account,
                    instance,
                    character,
                    password,
                },
                console: consoleAdapter,
                downloadLocation: GSLExtension.getDownloadLocation(),
                ...(this.loggingEnabled
                    ? {
                          loggingEnabled: true,
                          logFileName: "gsl-dev-server.log",
                      }
                    : { loggingEnabled: false }),
                onCreate: (client) => {
                    this.gameTerminal?.bindClient(client);
                },
            },
            task,
        );
    }
}

class ExtensionLanguageServer {
    private context: ExtensionContext;
    private lspClient: LanguageClient;

    constructor(context: ExtensionContext) {
        this.context = context;
        this.lspClient = this.startLanguageServer();
    }

    private startLanguageServer() {
        const relativePath = path.join(
            "gsl-language-server",
            "out",
            "server.js",
        );
        const module = this.context.asAbsolutePath(relativePath);
        const options = { execArgv: ["--nolazy", "--inspect=6009"] };
        const transport = TransportKind.ipc;

        const serverOptions: ServerOptions = {
            run: { module, transport },
            debug: { module, transport, options },
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ scheme: "file", language: GSL_LANGUAGE_ID }],
            synchronize: {
                fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
            },
        };

        const lspClient = new LanguageClient(
            "gslLanguageServer",
            "GSL Language Server",
            serverOptions,
            clientOptions,
        );

        lspClient.start();

        return lspClient;
    }
}

export let vsc: VSCodeIntegration | undefined = undefined;

export function activate(context: ExtensionContext) {
    vsc = new VSCodeIntegration(context);
    // const els = new ExtensionLanguageServer (context)

    EAccessClient.console = {
        log: (...args: any) => {
            vsc!.outputGameChannel(args.join(" "));
        },
    };

    EAccessClient.debug = false;

    GSLExtension.init(context);

    const selector: DocumentSelector = {
        scheme: "*",
        language: GSL_LANGUAGE_ID,
    };

    let subscription: Disposable;

    subscription = languages.registerDocumentSymbolProvider(
        selector,
        new GSLDocumentSymbolProvider(),
    );
    context.subscriptions.push(subscription);

    subscription = languages.registerHoverProvider(
        selector,
        new GSLHoverProvider(
            async (script: number) => {
                const config = workspace.getConfiguration(GSL_LANGUAGE_ID);
                if (!config.get(GSLX_AUTOMATIC_DOWNLOADS)) return;
                return vsc?.withEditorClient((client) =>
                    client.modifyScript(script),
                );
            },
            async (script: number) => {
                const config = workspace.getConfiguration(GSL_LANGUAGE_ID);
                if (!config.get(GSLX_AUTOMATIC_DOWNLOADS)) return;
                if (!config.get(GSLX_ENABLE_SCRIPT_SYNC_CHECKS)) return;
                if (context.globalState.get(GSLX_DEV_INSTANCE) !== "GS4D")
                    return;
                return vsc?.withEditorClient((client) =>
                    client.showScriptCheckStatus(script),
                );
            },
        ),
    );
    context.subscriptions.push(subscription);

    subscription = languages.registerDefinitionProvider(
        selector,
        new GSLDefinitionProvider(
            !!workspace
                .getConfiguration(GSL_LANGUAGE_ID)
                .get(GSLX_AUTOMATIC_DOWNLOADS),
        ),
    );
    context.subscriptions.push(subscription);

    subscription = languages.registerDocumentHighlightProvider(
        selector,
        new GSLDocumentHighlightProvider(),
    );
    context.subscriptions.push(subscription);

    subscription = languages.registerDocumentFormattingEditProvider(
        selector,
        new GSLDocumentFormattingEditProvider(),
    );
    context.subscriptions.push(subscription);

    context.subscriptions.push(
        languages.registerCodeActionsProvider(
            GSL_LANGUAGE_ID,
            new GSLCodeActionProvider(),
            {
                providedCodeActionKinds:
                    GSLCodeActionProvider.providedCodeActionKinds,
            },
        ),
    );

    // Add line length diagnostics
    const lineLengthDiagnostics =
        languages.createDiagnosticCollection("gsl-line-length");
    context.subscriptions.push(lineLengthDiagnostics);
    subscribeToDocumentChanges(context, lineLengthDiagnostics);

    // Register language model tools for Copilot agent mode
    registerCopilotTools(context, vsc);

    vsc.checkForNewInstall();
    vsc.checkForUpdatedVersion();
}

export function deactivate() {}
