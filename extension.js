"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = exports.GSLExtension = void 0;
const path = require("path");
const fs = require("fs");
const vscode_1 = require("vscode");
const vscode_2 = require("vscode");
const vscode_languageclient_1 = require("vscode-languageclient");
const gsl_1 = require("./gsl");
const eaccessClient_1 = require("./gsl/eaccessClient");
const gameTerminal_1 = require("./gsl/gameTerminal");
const editorClient_1 = require("./gsl/editorClient");
const GSL_LANGUAGE_ID = 'gsl';
const GSLX_DEV_ACCOUNT = 'developmentAccount';
const GSLX_DEV_INSTANCE = 'developmentInstance';
const GSLX_DEV_CHARACTER = 'developmentCharacter';
const GSLX_NEW_INSTALL_FLAG = 'gslExtNewInstallFlag';
const GSLX_SAVED_VERSION = 'savedVersion';
const GSLX_DISABLE_LOGIN = 'disableLoginAttempts';
const GSLX_KEYTAR_KEY = 'GSL-Editor';
const rx_script_number = /^\d{1,5}$/;
class GSLExtension {
    static init(vsc) {
        this.diagnostics = vscode_2.languages.createDiagnosticCollection();
        this.vsc = vsc;
    }
    static getDownloadLocation() {
        let extPath = null;
        let useWorkspaceFolder = vscode_2.workspace.getConfiguration(GSL_LANGUAGE_ID).get('downloadToWorkspace');
        if (useWorkspaceFolder && vscode_2.workspace.workspaceFolders) {
            extPath = vscode_2.workspace.workspaceFolders[0].uri.fsPath;
        }
        else {
            extPath = vscode_2.workspace.getConfiguration(GSL_LANGUAGE_ID).get('downloadPath');
        }
        if (!extPath) {
            let rootPath = path.resolve(__dirname, '../gsl');
            if (!fs.existsSync(rootPath)) { // Directory doesn't exist
                fs.mkdirSync(rootPath); // Create directory
            }
            extPath = path.resolve(__dirname, '../gsl/scripts');
        }
        if (!fs.existsSync(extPath)) { // Directory doesn't exist
            fs.mkdirSync(extPath); // Create directory
        }
        return extPath;
    }
    static async downloadScript(script, gotoDef) {
        const error = (e) => { error.caught = e; };
        const downloadPath = this.getDownloadLocation();
        const fileExtension = vscode_2.workspace.getConfiguration(GSL_LANGUAGE_ID).get('fileExtension');
        const client = await this.vsc.ensureGameConnection().catch(error);
        if (error.caught) {
            return void vscode_2.window.showErrorMessage(`Failed to connect to game: ${error.caught.message}`);
        }
        if (client) {
            const scriptProperties = await client.modifyScript(script).catch(error);
            if (error.caught) {
                return void vscode_2.window.showErrorMessage(error.caught.message);
            }
            let content = await client.captureScript().catch(error);
            if (error.caught) {
                return void vscode_2.window.showErrorMessage(`Failed to download script: ${error.caught.message}`);
            }
            if (content) {
                if (content.slice(-4) !== '\r\n\r\n') {
                    content += '\r\n';
                }
                const scriptFile = scriptProperties.path.split('/').pop();
                const scriptPath = path.join(downloadPath, scriptFile);
                fs.writeFileSync(scriptPath, content);
                const document = await vscode_2.workspace.openTextDocument(scriptPath);
                const editor = await vscode_2.window.showTextDocument(document, { preview: false });
                if (gotoDef) {
                    const gotoRegExp = new RegExp(`:\s+${gotoDef}`);
                    for (let n = 0, nn = document.lineCount; n < nn; n++) {
                        const line = document.lineAt(n);
                        if (line.text.match(gotoRegExp)) {
                            vscode_2.commands.executeCommand('revealLine', { lineNumber: n, at: 'center' });
                            break;
                        }
                    }
                }
            }
            vscode_2.window.setStatusBarMessage("Script download complete!", 5000);
        }
        else {
            vscode_2.window.showErrorMessage("Could not connect to game?");
        }
    }
    static async uploadScript(script, document) {
        const error = (e) => { error.caught = e; };
        const client = await this.vsc.ensureGameConnection().catch(error);
        if (error.caught) {
            return void vscode_2.window.showErrorMessage(`Failed to connect to game: ${error.caught.message}`);
        }
        if (client) {
            const lines = [];
            for (let n = 0, nn = document.lineCount; n < nn; n++) {
                lines.push(document.lineAt(n).text);
            }
            if (lines[lines.length - 1] !== '') {
                lines.push('');
            }
            let scriptProperties = await client.modifyScript(script).catch(error);
            if (error.caught) {
                return void vscode_2.window.showErrorMessage(error.caught.message);
            }
            let compileResults = await client.sendScript(lines).catch(error);
            if (error.caught) {
                return vscode_2.window.showErrorMessage(error.caught.message);
            }
            if (compileResults.status === editorClient_1.ScriptCompileStatus.Failed) {
                const problems = compileResults.errorList.map((error) => {
                    const line = document.lineAt(error.line - 1);
                    return new vscode_1.Diagnostic(line.range, error.message, vscode_languageclient_1.DiagnosticSeverity.Error);
                });
                this.diagnostics.set(document.uri, problems);
                vscode_2.window.showErrorMessage(`Script ${compileResults.script}: Compile failed; ${compileResults.errors} error(s), ${compileResults.warnings} warning(s).`);
                vscode_2.commands.executeCommand('workbench.actions.view.problems');
            }
            else {
                this.diagnostics.clear();
                vscode_2.window.setStatusBarMessage(`Script ${compileResults.script}: Compile OK; ${compileResults.bytes} bytes`, 5000);
            }
        }
        else {
            vscode_2.window.showErrorMessage("Could not connect to game?");
        }
    }
    static async checkModifiedDate(script) {
        const error = (e) => { error.caught = e; };
        const client = await this.vsc.ensureGameConnection().catch(error);
        if (error.caught) {
            return void vscode_2.window.showErrorMessage(`Failed to connet to game: ${error.caught.message}`);
        }
        vscode_2.window.setStatusBarMessage(`Checking modification date for script ${script} ...`, 5000);
        let scriptProperties = await client.checkScript(script).catch(error);
        if (error.caught) {
            return void vscode_2.window.showErrorMessage(`Failed to check modification date: ${error.caught.message}`);
        }
        const date = scriptProperties.lastModifiedDate;
        vscode_2.window.setStatusBarMessage(`Script ${script} was last modified on ${date.toLocaleDateString()} as ${date.toLocaleTimeString()}`, 5000);
    }
}
exports.GSLExtension = GSLExtension;
function scriptNumberFromFileName(fileName) {
    return path.basename(fileName).replace(/\D+/g, '').replace(/^0+/, '');
}
class VSCodeIntegration {
    constructor(context) {
        this.context = context;
        this.downloadButton = vscode_2.window.createStatusBarItem(vscode_1.StatusBarAlignment.Left, 50);
        this.uploadButton = vscode_2.window.createStatusBarItem(vscode_1.StatusBarAlignment.Left, 50);
        this.gslButton = vscode_2.window.createStatusBarItem(vscode_1.StatusBarAlignment.Left, 50);
        this.commandList = [
            { label: "Download Script", name: 'gsl.downloadScript' },
            { label: "Upload Script", name: 'gsl.uploadScript' },
            { label: "Check script modification date", name: 'gsl.checkDate' },
            { label: "List GSL Tokens", name: 'gsl.listTokens' },
            { label: "Show GSL extension output channel", name: 'gsl.showChannel' },
            { label: "Toggle output logging", name: 'gsl.toggleLogging' },
            { label: "Open development terminal", name: 'gsl.openTerminal' },
            { label: "Connect to development server", name: 'gsl.openConnection' },
            { label: "User Setup", name: 'gsl.userSetup' }
        ];
        this.outputChannel = vscode_2.window.createOutputChannel("GSL Editor (debug)");
        this.loggingEnabled = false;
        this.registerCommands();
        this.initializeComponents();
    }
    initializeComponents() {
        this.downloadButton.text = "$(cloud-download) Download";
        this.downloadButton.command = 'gsl.downloadScript';
        this.downloadButton.show();
        this.uploadButton.text = "$(cloud-upload) Upload";
        this.uploadButton.command = 'gsl.uploadScript';
        this.uploadButton.show();
        this.gslButton.text = "$(ruby) GSL";
        this.gslButton.command = 'gsl.showCommands';
        this.gslButton.show();
        if (vscode_2.workspace.getConfiguration(GSL_LANGUAGE_ID).get('displayGameChannel')) {
            this.outputChannel.show(true);
        }
    }
    /* commands */
    async commandDownloadScript() {
        const prompt = 'Script number or verb name to download?';
        const input = await vscode_2.window.showInputBox({ prompt });
        if (!input) {
            return;
        }
        const scriptOptions = input.replace(/\s/g, '').split(';');
        const scriptList = [];
        for (let option of scriptOptions) {
            if (option.indexOf('-') > -1) {
                let [first, second] = option.split('-');
                let low = parseInt(first);
                let high = parseInt(second);
                if (isNaN(low) || isNaN(high) || low > high) {
                    vscode_2.window.showErrorMessage("Invalid script range: " + option);
                }
                for (; low <= high;) {
                    scriptList.push(low++);
                }
            }
            else {
                var script = Number(option);
                if (isNaN(script)) {
                    scriptList.push(option);
                }
                else {
                    scriptList.push(script);
                }
            }
        }
        for (let script of scriptList) {
            await GSLExtension.downloadScript(script);
        }
    }
    async commandUploadScript() {
        var _a;
        const document = (_a = vscode_2.window.activeTextEditor) === null || _a === void 0 ? void 0 : _a.document;
        if (!document || !(document.languageId === GSL_LANGUAGE_ID)) {
            return void vscode_2.window.showWarningMessage("Script upload requires an active GSL script editor");
        }
        if (document.isDirty) {
            let result = await document.save();
            if (result === false) {
                return void vscode_2.window.showErrorMessage("Failed to save active script editor before upload.");
            }
        }
        const scriptNumber = scriptNumberFromFileName(document.fileName);
        if (rx_script_number.test(scriptNumber) === false) {
            const prompt = "Unable to parse script number from active editor file name.";
            const placeHolder = "Script number to upload as?";
            const input = await vscode_2.window.showInputBox({ prompt, placeHolder });
            if (!input || rx_script_number.test(input) === false) {
                return void vscode_2.window.showErrorMessage("Invalid script number provided.");
            }
            const script = Number(input);
            GSLExtension.uploadScript(script, document);
        }
        else {
            const script = Number(scriptNumber);
            GSLExtension.uploadScript(script, document);
        }
    }
    async commandShowCommands() {
        const command = await vscode_2.window.showQuickPick(this.commandList, { placeHolder: 'Select a command to execute.' });
        if (command) {
            vscode_2.commands.executeCommand(command.name);
        }
    }
    commandCheckDate() {
        if (!vscode_2.window.activeTextEditor || !vscode_2.window.activeTextEditor.document) {
            return void vscode_2.window.showErrorMessage("You must have an open script before you can check its date.");
        }
        let scriptNumber = path.basename(vscode_2.window.activeTextEditor.document.fileName);
        scriptNumber = scriptNumber.replace(/\D+/g, '').replace(/^0+/, '');
        const script = Number(scriptNumber);
        GSLExtension.checkModifiedDate(script);
    }
    commandListTokens() {
        let uri = vscode_1.Uri.file(path.resolve(__dirname, './syntaxes/tokens.md'));
        vscode_2.commands.executeCommand('markdown.showPreview', uri);
    }
    commandToggleLogging() {
        var _a;
        this.loggingEnabled = !this.loggingEnabled;
        (_a = this.gameClient) === null || _a === void 0 ? void 0 : _a.toggleLogging();
        vscode_2.window.setStatusBarMessage(this.loggingEnabled ? 'Logging enabled.' : 'Logging disabled.', 5000);
    }
    async commandUserSetup() {
        let account = await vscode_2.window.showInputBox({ prompt: "PLAY.NET Account:", ignoreFocusOut: true });
        if (!account) {
            return void vscode_2.window.showErrorMessage("No account name entered; aborting setup.");
        }
        let password = await vscode_2.window.showInputBox({ prompt: "Password:", ignoreFocusOut: true, password: true });
        if (!password) {
            return void vscode_2.window.showErrorMessage("No password entered; aborting setup.");
        }
        /* capture rejected promises */
        let error;
        const captureError = (e) => (error = e, void (0));
        /* login */
        const gameChoice = await eaccessClient_1.EAccessClient.login(account, password, { name: /.*?development.*?/i }).catch(captureError);
        if (!gameChoice) {
            const message = error ? error.message : "Login failed?";
            return void vscode_2.window.showErrorMessage(message);
        }
        /* pick a game */
        const gamePickOptions = {
            ignoreFocusOut: true, placeholder: "Select a game ..."
        };
        const game = await vscode_2.window.showQuickPick(gameChoice.toNameList(), gamePickOptions);
        if (!game) {
            gameChoice.cancel();
            return void vscode_2.window.showErrorMessage("No game selected; aborting setup.");
        }
        const characterChoice = await gameChoice.select(gameChoice.pick(game)).catch(captureError);
        if (!characterChoice) {
            const message = error ? error.message : "Game select failed?";
            gameChoice.cancel();
            return void vscode_2.window.showErrorMessage(message);
        }
        /* pick a character */
        const characterPickOptions = {
            ignoreFocusOut: true, placeholder: "Select a character ..."
        };
        const character = await vscode_2.window.showQuickPick(characterChoice.toNameList(), characterPickOptions);
        if (!character) {
            characterChoice.cancel();
            return void vscode_2.window.showErrorMessage("No character selected; aborting setup.");
        }
        const result = await characterChoice.select(characterChoice.pick(character)).catch(captureError);
        if (!result) {
            const message = error ? error.message : "Character select failed?";
            return void vscode_2.window.showErrorMessage(message);
        }
        /* we now have the info we need to log into the same and save the details */
        const { sal, loginDetails } = result;
        /* store all the details for automated login */
        const keytar = await Promise.resolve().then(() => require(`${vscode_2.env.appRoot}/node_modules.asar/keytar`));
        this.context.globalState.update(GSLX_DEV_ACCOUNT, loginDetails.account);
        this.context.globalState.update(GSLX_DEV_INSTANCE, loginDetails.game);
        this.context.globalState.update(GSLX_DEV_CHARACTER, loginDetails.character);
        keytar.setPassword(GSLX_KEYTAR_KEY, loginDetails.account, password);
    }
    async commandOpenConnection() {
        const error = (e) => { error.caught = e; };
        if (this.gameClient) {
            return void vscode_2.window.showErrorMessage("Development server connection is already established.");
        }
        const client = await this.ensureGameConnection().catch(error);
        if (error.caught) {
            return void vscode_2.window.showErrorMessage(`Failed to connect to development server: ${error.caught.message}`);
        }
    }
    async commandOpenTerminal() {
        if (this.gameTerminal) {
            return void vscode_2.window.showErrorMessage("Development terminal is already open.");
        }
        this.gameTerminal = new gameTerminal_1.GameTerminal(() => { this.gameTerminal = undefined; });
        this.gameTerminal.show(true);
        if (this.gameClient) {
            this.gameTerminal.bindClient(this.gameClient);
        }
        else {
            this.ensureGameConnection();
        }
    }
    registerCommands() {
        let subscription;
        subscription = vscode_2.commands.registerCommand('gsl.downloadScript', this.commandDownloadScript, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.uploadScript', this.commandUploadScript, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.showCommands', this.commandShowCommands, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.checkDate', this.commandCheckDate, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.listTokens', this.commandListTokens, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.toggleLogging', this.commandToggleLogging, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.showChannel', this.showGameChannel, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.userSetup', this.commandUserSetup, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.openConnection', this.commandOpenConnection, this);
        this.context.subscriptions.push(subscription);
        subscription = vscode_2.commands.registerCommand('gsl.openTerminal', this.commandOpenTerminal, this);
        this.context.subscriptions.push(subscription);
    }
    /* privates */
    async getLoginDetails() {
        const account = this.context.globalState.get(GSLX_DEV_ACCOUNT);
        const instance = this.context.globalState.get(GSLX_DEV_INSTANCE);
        const character = this.context.globalState.get(GSLX_DEV_CHARACTER);
        const keytar = await Promise.resolve().then(() => require(`${vscode_2.env.appRoot}/node_modules.asar/keytar`));
        const password = await keytar.getPassword(GSLX_KEYTAR_KEY, account);
        if (!(account || instance || character || password)) {
            return void this.promptUserSetup();
        }
        return { account, password, character, instance };
    }
    /* public api */
    appendLineToGameChannel(text) {
        this.outputChannel.appendLine(text);
    }
    showGameChannel() {
        this.outputChannel.show(true);
    }
    outputGameChannel(text) {
        this.outputChannel.appendLine(text);
    }
    async promptUserSetup() {
        const message = "To start using the GSL Editor, you must run the User Setup process to store your Play.net account credentials.";
        const option = 'Start User Setup';
        const choice = await vscode_2.window.showInformationMessage(message, option);
        if (choice === option) {
            this.commandUserSetup();
        }
    }
    async checkForNewInstall() {
        let flag = this.context.globalState.get(GSLX_NEW_INSTALL_FLAG);
        if (flag !== true) {
            const message = "For the best experience, the GSL Vibrant theme is recommended for the GSL Editor.";
            const option = 'Apply Theme';
            const choice = await vscode_2.window.showInformationMessage(message, option);
            if (choice === option) {
                await vscode_2.workspace.getConfiguration().update('workbench.colorTheme', 'GSL Vibrant', true);
            }
        }
    }
    async checkForUpdatedVersion() {
        let extension = vscode_2.extensions.getExtension('patricktrant.gsl');
        if (extension) {
            let { packageJSON: { version } } = extension;
            let savedVersion = this.context.globalState.get(GSLX_SAVED_VERSION);
            if (savedVersion && (savedVersion !== version)) {
                const message = `The GSL Editor extension has been updated to version ${version}!`;
                const option = 'Show Release Notes';
                const choice = await vscode_2.window.showInformationMessage(message, option);
                if (choice === option) {
                    const changelogPath = path.resolve(__dirname, './CHANGELOG.md');
                    vscode_2.commands.executeCommand('markdown.showPreview', vscode_1.Uri.file(changelogPath));
                }
            }
            this.context.globalState.update(GSLX_SAVED_VERSION, version);
        }
    }
    async ensureGameConnection() {
        const error = (e) => { error.caught = e; };
        const loginDisabled = vscode_2.workspace.getConfiguration(GSL_LANGUAGE_ID).get(GSLX_DISABLE_LOGIN);
        if (loginDisabled) {
            return Promise.reject(new Error("Game login is disabled."));
        }
        const loginDetails = await this.getLoginDetails();
        if (!loginDetails) {
            return Promise.reject(new Error("Could not find login details?"));
        }
        if (this.gameClient === undefined) {
            const console = {
                log: (...args) => {
                    this.outputChannel.append(`[console(log): ${args.join(' ')}]\r\n`);
                }
            };
            const log = path.join(GSLExtension.getDownloadLocation(), 'gsl-dev-server.log');
            const logging = this.loggingEnabled;
            const options = { log, logging, debug: true, console, echo: true };
            this.gameClient = new editorClient_1.EditorClient(options);
            this.gameClient.on('error', () => { this.gameClient = undefined; });
            this.gameClient.on('quit', () => { this.gameClient = undefined; });
            if (this.gameTerminal) {
                this.gameTerminal.bindClient(this.gameClient);
            }
            await this.gameClient.login(loginDetails);
        }
        return this.gameClient;
    }
}
class ExtensionLanguageServer {
    constructor(context) {
        this.context = context;
        this.lspClient = this.startLanguageServer();
    }
    startLanguageServer() {
        const relativePath = path.join('gsl-language-server', 'out', 'server.js');
        const module = this.context.asAbsolutePath(relativePath);
        const options = { execArgv: ['--nolazy', '--inspect=6009'] };
        const transport = vscode_languageclient_1.TransportKind.ipc;
        const serverOptions = {
            run: { module, transport },
            debug: { module, transport, options }
        };
        const clientOptions = {
            documentSelector: [{ scheme: 'file', language: GSL_LANGUAGE_ID }],
            synchronize: {
                fileEvents: vscode_2.workspace.createFileSystemWatcher('**/.clientrc')
            }
        };
        const lspClient = new vscode_languageclient_1.LanguageClient('gslLanguageServer', 'GSL Language Server', serverOptions, clientOptions);
        lspClient.start();
        return lspClient;
    }
}
function activate(context) {
    const vsc = new VSCodeIntegration(context);
    // const els = new ExtensionLanguageServer (context)
    eaccessClient_1.EAccessClient.console = {
        log: (...args) => { vsc.outputGameChannel(args.join(' ')); }
    };
    eaccessClient_1.EAccessClient.debug = true;
    GSLExtension.init(vsc);
    const selector = { scheme: '*', language: GSL_LANGUAGE_ID };
    let subscription;
    subscription = vscode_2.languages.registerDocumentSymbolProvider(selector, new gsl_1.GSLDocumentSymbolProvider());
    context.subscriptions.push(subscription);
    subscription = vscode_2.languages.registerHoverProvider(selector, new gsl_1.GSLHoverProvider());
    context.subscriptions.push(subscription);
    subscription = vscode_2.languages.registerDefinitionProvider(selector, new gsl_1.GSLDefinitionProvider());
    context.subscriptions.push(subscription);
    subscription = vscode_2.languages.registerDocumentHighlightProvider(selector, new gsl_1.GSLDocumentHighlightProvider());
    context.subscriptions.push(subscription);
    subscription = vscode_2.languages.registerDocumentFormattingEditProvider(selector, new gsl_1.GSLDocumentFormattingEditProvider());
    context.subscriptions.push(subscription);
    vsc.checkForNewInstall();
    vsc.checkForUpdatedVersion();
}
exports.activate = activate;
function deactivate() {
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map