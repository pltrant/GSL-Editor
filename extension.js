"use strict";

const vscode = require("vscode");
const net = require('net');
const fs = require('fs');
const path = require("path");

const sgeClient = new net.Socket();
const gameClient = new net.Socket();
var gameChannel;
var gslEditor = {
    extContext: null,
    hashKey: '',
    pwHash: '',
    gameCode: '',
    characterID: '',
    gameHost: '',
    gamePort: '',
    gameKey: '',
    msgCount: 0,
    getScript: 0,
    sendScript: 0,
    scriptNum: 0,
    scriptArray: [],
    scriptTxt: '',
    debug: '',
    input: '',
    lastMsg: ''
}

class matchMarkersProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            this.refresh();
        });
        vscode.workspace.onDidChangeTextDocument((e) => {
            this.refresh();
        });
        this.dict = {}; // key value of matchmarkers and the line number each can be found at.
        this.refresh();
    }
    refresh() {
        this.getMatchMarkers();
        this._onDidChangeTreeData.fire();
    }
    getMatchMarkers() {
        this.tree = [];
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        let doc = editor.document;
        if (doc.languageId != "gsl") {
            return;
        }
        let header = true;
        for (let index = 1; index < doc.lineCount; index++) {
            let text = doc.lineAt(index).text;
            if (/^: "(.*)"/.test(text)) {
                header = false;
                let match = /^: "(.*)"/.exec(text);
                this.tree.push(match[1]);
                this.dict[match[1]] = index; //Store line number found at.
            } else if (header && !text.startsWith("!")) {
                header = false;
                this.tree.push('""');
                this.dict['""'] = index; //Store line number found at.
            }
        }
    }
    getChildren(element) {
        const nodes = this.tree.map(node => new vscode.TreeItem(node));
        return nodes;
    }
    getTreeItem(element) {
        element.command = {
            command: "revealLine",
            title: "",
            arguments: [{
                lineNumber: this.dict[element.label],
                at: "top"
            }]
        }
        return element;
    }
}

class symbolProvider {
    provideDocumentSymbols(document, token) {
        return new Promise((resolve, reject) => {
            let header = true;
            let symbols = [];
            for (let i = 0; i < document.lineCount; i++) {
                let line = document.lineAt(i);
                if (line.text.startsWith(": ")) {
                    header = false;
                    let matchMarker = /^:\s+\"(.*?)\"/.exec(line.text);
                    symbols.push({
                        name: matchMarker[1],
                        kind: vscode.SymbolKind.Function,
                        location: new vscode.Location(document.uri, line.range)
                    })
                } else if (header && !line.text.startsWith("!")) {
                    header = false;
                    symbols.push({
                        name: '""',
                        kind: vscode.SymbolKind.Function,
                        location: new vscode.Location(document.uri, line.range)
                    });
                }
            }
            resolve(symbols);
        });
    }
}

class hoverProvider {
    constructor() {
        this.nodeInfo = {
            'O': {
                'A': 'article',
                'J': 'adjective',
                'N': 'noun',
                'D': 'article adjective noun',
                'S': 'adjective noun',
                'C': 'opened/closed',
                'O': 'an opened/a closed',
                'T': "'the' followed by noun",
                'M': "'pronoun' field if set, otherwise noun"
            },
            'C': {
                'A': 'article',
                'J': 'adjective',
                'N': 'noun',
                'D': 'article adjective noun',
                'S': 'adjective noun',
                'T': "'crtr_name' field if set, otherwise 'the' followed by noun",
                'U': "'the' followed by adjective and noun",
                'M': "'pronoun' field if set, otherwise noun"
            },
            'P': {
                '': 'First name',
                'A': 'Master/Mistress',
                'B': 'First and last name',
                'F': 'himself/herself',
                'G': 'he/she',
                'H': 'his/her',
                'I': 'him/her',
                'L': 'Last name',
                'M': 'man/woman',
                'P': 'profession',
                'R': 'race',
                'S': 'sir/madam'
            },
            'X': {
                '': 'article adjective noun of creature OR first name of player.',
                'F': 'himself/herself of creature or player.',
                'G': 'he/she of creature or player.',
                'H': 'his/her of creature or player.',
                'I': 'him/her of creature or player.'
            },
            'E': {
                'A': 'article',
                'J': 'adjective',
                'N': 'noun',
                'D': 'article adjective noun',
                'S': 'adjective noun',
                'T': "'the' followed by noun",
                'M': "'pronoun' field if set, otherwise noun"
            },
            'r': {
                '': 'Room number.'
            }
        };
        this.varInfo = {
            'A': 'value',
            'B': 'value',
            'D': 'value / 100 with remainder as decimal',
            'V': 'value',
            'L': 'value right aligned to 7 characters',
            'S': 'value',
            'K': 'value right aligned to 16 characters',
            'T': 'value',
        };
        this.tokenInfo = {
            '$': '$ symbol',
            '\\': 'Suppresses automatic linefeed',
            '^': 'Uppercase first letter of string',
            'Q': '" symbol',
            'R': 'Linefeed',
            '*': 'ESC code (ASCII 27)',
            '+': 'Capitalizes first letter of next string token',
            "'": "Adds 's to next string token, properly XML wrapped",
            "ZE": "Outputs timestamp for token that follows"
        };
        this.baseHoverRegex = /\$(:\$[A-Z]+|:\d+\[\d+,\d+,\d+\]|[\w\d:_-]+|[ABDVLSKT]\d|[\$\\\^QR\*\+'])/;
        this.stringTokenRegex = /\$([POCEXr])(\d)([A-Z]?)$/;
        this.fieldRegex = /\$([POCEXr]\d):([\w\d_]+)$/;
        this.varRegex = /\$([ABDVLSKT])(\d)/;
        this.tokenRegex = /\$([\$\\\^QR\*\+']|ZE)/;
        this.systemRegex = /\$:(\$[A-Z]+)/;
        this.tableRegex = /\$:(\d+)(\[\d+,\d+,\d+\])/;
    }

    provideHover(document, position, token) {
        let wordRange = document.getWordRangeAtPosition(position, this.baseHoverRegex);
        if (!wordRange) return;

        let word = document.getText(wordRange);
        if (this.stringTokenRegex.test(word)) {
            return this.stringTokenHover(word);
        } else if (this.fieldRegex.test(word)) {
            return this.fieldHover(word);
        } else if (this.varRegex.test(word)) {
            return this.varHover(word);
        } else if (this.tokenRegex.test(word)) {
            return this.tokenHover(word);
        } else if (this.systemRegex.test(word)) {
            return this.systemHover(word);
        } else if (this.tableRegex.test(word)) {
            return this.tableHover(word);
        }
    }

    stringTokenHover(token) {
        let tokenTypes = this.stringTokenRegex.exec(token);
        if (tokenTypes[1] in this.nodeInfo && tokenTypes[3] in this.nodeInfo[tokenTypes[1]]) {
            return new vscode.Hover('N' + tokenTypes[1].toUpperCase() + tokenTypes[2] + ': ' + this.nodeInfo[tokenTypes[1]][tokenTypes[3]]);
        }
    }

    fieldHover(token) {
        let tokenTypes = this.fieldRegex.exec(token);
        return new vscode.Hover("N" + tokenTypes[1].toUpperCase() + ": '" + tokenTypes[2] + "' field");
    }

    varHover(token) {
        let tokenTypes = this.varRegex.exec(token);
        let varName = tokenTypes[1];
        if (varName == 'D' || varName == 'L') varName = 'V';
        if (varName == 'K') varName = 'S';
        return new vscode.Hover(varName + tokenTypes[2] + ": " + this.varInfo[tokenTypes[1]]);
    }

    tokenHover(word) {
        let token = this.tokenRegex.exec(word)[1];
        return new vscode.Hover(this.tokenInfo[token]);
    }

    systemHover(word) {
        let token = this.systemRegex.exec(word)[1];
        return new vscode.Hover('System variable ' + token);
    }

    tableHover(word) {
        let tokenTypes = this.tableRegex.exec(word);
        return new vscode.Hover('table #' + tokenTypes[1] + ': value in ' + tokenTypes[2]);
    }
}

var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator.throw(value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments)).next());
    });
};

function str2ab(str) { //String to Array Buffer
    var buffer = new ArrayBuffer(str.length);
    var bufferView = new Uint8Array(buffer);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
        bufferView[i] = str.charCodeAt(i);
    }
    return buffer;
}

function getGameChannel() {
    if (gameChannel === undefined) {
        gameChannel = vscode.window.createOutputChannel('Game');
    }
    return gameChannel;
}

function outGameChannel(message) {
    message = message.replace(/\n$/, ''); //Remove ending newline.
    getGameChannel().appendLine(`${message}`);
}

function LogIntoGame() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!gameClient.connected) {
            let game = vscode.workspace.getConfiguration('gsl').get('game');
            let character = vscode.workspace.getConfiguration('gsl').get('character');
            vscode.window.setStatusBarMessage('Logging into ' + game + ' with ' + character + '...', 5000);
            sgeClient.connect(7900, 'eaccess.play.net', function () {
                sgeClient.connected = true;
                gslEditor.msgCount = 0;
                outGameChannel('SGE connection established.');
                sendMsg('K\n');
            });
            sgeClient.setEncoding('ascii');
            sgeClient.on('close', onConnSGEClose);
            sgeClient.on('disconnect', onConnSGEClose);
            sgeClient.on('data', onConnSGEData);
            sgeClient.on('error', onConnError);
            sgeClient.setKeepAlive(true);
            sgeClient.setNoDelay(true);
        }
    });
}

function activate(context) {
    gslEditor.extContext = context;
    if (!this._DLstatusBarItem) {
        this._DLstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    }
    if (!this._ULstatusBarItem) {
        this._ULstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    }
    if (!this._DCstatusBarItem) {
        this._DCstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    }
    let self = this;
    if (vscode.workspace.getConfiguration('gsl').get('alwaysEnabled')) {
        showGSLStatusBarItems(self);
    } else {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            this._DLstatusBarItem.hide();
            this._ULstatusBarItem.hide();
            this._DCstatusBarItem.hide();
            return;
        }
        let doc = editor.document;
        if (doc.languageId === "gsl") {
            showGSLStatusBarItems(self);
        } else {
            this._DLstatusBarItem.hide();
            this._ULstatusBarItem.hide();
            this._DCstatusBarItem.hide();
        }
    }
    gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslDownload', () => {
        gslDownload();
    }));
    gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslUpload', () => {
        gslUpload();
    }));
    gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslDateCheck', () => {
        gslDateCheck();
    }));
    gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslSendGameCommand', () => {
        gslSendGameCommand();
    }));
    gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslListTokens', () => {
        gslListTokens();
    }));

    if (vscode.workspace.getConfiguration('gsl').get('displayGameChannel')) {
        getGameChannel().show(true);
    }

    gslEditor.extContext.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(
        {language: "gsl"},
        new symbolProvider()
    ));
    gslEditor.extContext.subscriptions.push(vscode.languages.registerHoverProvider(
        {language: "gsl"},
        new hoverProvider()
    ));

    const matchMarkersProvider1 = new matchMarkersProvider(gslEditor.extContext);
    vscode.window.registerTreeDataProvider('matchMarkers', matchMarkersProvider1);

    checkForUpdatedVersion();
    this.diagnostics = vscode.languages.createDiagnosticCollection('GSL-Compile-Errors');
}
exports.activate = activate;

function checkForUpdatedVersion() {
    // Check for new install.
    let newInstallFlag = gslEditor.extContext.globalState.get("newInstallFlag");
    if (!newInstallFlag) {
        let applyTheme = "Apply Theme"
        vscode.window
            .showInformationMessage(`For the best experience, the GSL Vibrant theme is recommended for the GSL Editor.`, applyTheme)
            .then(choice => {
            if (choice === applyTheme) {
                vscode.workspace.getConfiguration().update("workbench.colorTheme", "GSL Vibrant", true);
            }
        });
        gslEditor.extContext.globalState.update("newInstallFlag", true);
    }

    // Check for new Release Notes.
    let showReleaseNotes = "Show Release Notes";
    let gslExtensionVersionKey = 'gslExtensionVersion';
    let extensionVersion = vscode.extensions.getExtension("patricktrant.gsl").packageJSON.version;
    let storedVersion = gslEditor.extContext.globalState.get(gslExtensionVersionKey);
    if (storedVersion && (extensionVersion !== storedVersion)) {
        vscode.window
            .showInformationMessage(`The GSL Editor extension has been updated to version ${extensionVersion}!`, showReleaseNotes)
            .then(choice => {
            if (choice === showReleaseNotes) {
                vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.resolve(__dirname, "./CHANGELOG.md")));
            }
        });
    }
    gslEditor.extContext.globalState.update(gslExtensionVersionKey, extensionVersion);
}

function showGSLStatusBarItems(context) {
    context._DLstatusBarItem.text = '↓ Download';
    context._DLstatusBarItem.command = 'extension.gslDownload';
    context._DLstatusBarItem.show();
    context._ULstatusBarItem.text = '↑ Upload';
    context._ULstatusBarItem.command = 'extension.gslUpload';
    context._ULstatusBarItem.show();
    if (vscode.workspace.getConfiguration('gsl').get('displayDateCheck')) {
        context._DCstatusBarItem.text = 'Date Check';
        context._DCstatusBarItem.command = 'extension.gslDateCheck';
        context._DCstatusBarItem.show();
    }
}

function gslSendGameCommand(context) {
    vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Command to send to game?' }).then(input => {
        if ((input == null) | (input == '')) {
            return vscode.window.showErrorMessage('No input provided. Command aborted.');
        }
        LogIntoGame().then(function () {
            vscode.window.setStatusBarMessage('Sending game command...', 2000);
            if (gameClient.connected) {
                delayedGameCommand(input);
            } else {
                setTimeout(function () { delayedGameCommand(input) }, 2500)
            }
        });
    });
}

function gslListTokens() {
    vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.resolve(__dirname, "./syntaxes/tokens.md")));
}

function delayedGameCommand(command) {
    if (gameClient.connected) {
        getGameChannel().show(true);
        sendMsg(command + '\n');
    }
}

function gslUpload() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return vscode.window.showErrorMessage('You must have a script open before you can upload it.');
    }
    let doc = editor.document;
    if (!doc) {
        return vscode.window.showErrorMessage('You must have a script open before you can upload it.');
    }
    doc.save();
    gslEditor.scriptTxt = doc.getText();
    let scriptNum = path.basename(doc.fileName).replace(/\D+/g, '').replace(/^0+/, '');
    if (!/^\d{1,5}$/.test(scriptNum)) {
        vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Unable to parse script # from file name. Script number to upload?' }).then(input => {
            if ((input == null) | (input == '')) {
                return vscode.window.showErrorMessage('No input provided. Script upload aborted.');
            } else {
                gslEditor.scriptNum = input;
                gslUpload2(input)
            }
        });
    } else {
        gslEditor.scriptNum = scriptNum;
        gslUpload2(scriptNum)
    }
}

function gslUpload2(scriptNum) {
    gslEditor.sendScript = 1;
    gslEditor.getScript = 0;
    gslEditor.dateCheck = 0;
    diagnostics.clear();
    vscode.window.setStatusBarMessage('Uploading script ' + scriptNum + '...', 5000);
    LogIntoGame().then(function () {
        if (gameClient.connected) {
            uploadScript(' \nWelcome to \n \nAll Rights Reserved '); //Simulate initial login text
        }
    });
}

function uploadScript(receivedMsg) {
    if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
        sendMsg('/ss ' + gslEditor.scriptNum + '\n');
    } else if ((/^Name:[\s\S]*\d{4}\r\n.*>$/.test(receivedMsg)) && (gslEditor.sendScript == 1)) {
        let modifier = /Last modified by: ([\w-_\.]+)/.exec(receivedMsg)[1];
        let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg);
        let data = modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3];
        let lastMod = gslEditor.extContext.globalState.get('s' + gslEditor.scriptNum, '');
        if ((lastMod != '') && (lastMod != data)) {
            let msg = 'Script ' + gslEditor.scriptNum + ' appears to have been edited since you last downloaded it.';
            msg = msg + '\n\nLocal: ' + lastMod + '\nServer: ' + data + '\n\nWould you like to upload this script anyway?' 
            vscode.window.showWarningMessage(msg, { modal: true }, 'Yes').then(input => {
                if (input == 'Yes') {
                    sendMsg('/ms ' + gslEditor.scriptNum + '\n');
                } else {
                    gslEditor.sendScript = 0;
                    vscode.window.setStatusBarMessage('Upload canceled.', 5000);
                }
            });
        } else {
            sendMsg('/ms ' + gslEditor.scriptNum + '\n');
        }
    } else if (/Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.test(receivedMsg)) {
        let match = /Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.exec(receivedMsg);
        sendMsg('/mv ' + match[2] + '\n');
    } else if (/Invalid script number./.test(receivedMsg)) {
        return vscode.window.showErrorMessage(gslEditor.scriptNum + ' is an invalid script #.');
    } else if ((/Edt:$/.test(receivedMsg)) && (gslEditor.sendScript == 1)) {
        sendMsg('Z\n');
    } else if ((/ZAP!  All lines deleted\./.test(receivedMsg)) | (/New File/.test(receivedMsg))) {
        let scriptText = gslEditor.scriptTxt.replace(/\r/g,'\n').replace(/\n\n/g,'\n');
        gameClient.write(scriptText + '\n');
        if (!scriptText.endsWith('\n')) {
            gameClient.write('\n');
        }
        outGameChannel(scriptText);
        gslEditor.sendScript = 2;
    } else if ((/Edt:$/.test(receivedMsg)) && (gslEditor.sendScript == 2)) {
        sendMsg('G\n');
        gslEditor.sendScript = 3;
    } else if (/Edt:Inserting before line: 0/.test(receivedMsg)) {
        vscode.window.showErrorMessage("Upload error. Please check to ensure you haven't gone past 118 characters on a single line.");
        sendMsg('Q\n');
        gslEditor.sendScript = 0;
        gslEditor.scriptTxt = '';
        vscode.window.setStatusBarMessage('Upload failed.', 5000);
        getGameChannel().show(true);
    } else if (/Compile Failed w\/(.*) errors and (.*) warnings\./.test(receivedMsg)) {
        sendMsg('Q\n');
        gslEditor.sendScript = 0;
        gslEditor.scriptTxt = '';
        let diagnosticList = [];
        let lines = receivedMsg.split("\r\n");
        let startLine = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i] == "Line(s)  : Description") {
                startLine = i;
                break;
            }
        }
        for (let x = startLine + 2; x < lines.length; x += 2) {
            if (lines[x] && (/^\s*(\d+)\s:\s(.+)$/.test(lines[x]))) {
                let match = /^\s*(\d+)\s:\s(.+)$/.exec(lines[x]);
                let line = match[1];
                let errorMsg = match[2];
                let textLine = vscode.window.activeTextEditor.document.lineAt(Number(line) - 1);
                let diagnostic = new vscode.Diagnostic(textLine.range, errorMsg, vscode.DiagnosticSeverity.Error);
                diagnosticList.push(diagnostic);
            }
        }
        diagnostics.set(vscode.window.activeTextEditor.document.uri, diagnosticList);
        vscode.commands.executeCommand('workbench.actions.view.problems');
        let match = /(Compile Failed w\/(.*) errors and (.*) warnings\.)/.exec(receivedMsg);
        vscode.window.showErrorMessage(match[1]);
        vscode.window.setStatusBarMessage('Upload failed.', 5000);
    } else if (/Compile OK\./.test(receivedMsg)) {
        sendMsg('Q\n');
    } else if (/Compile ok\./.test(receivedMsg)) {
        sendMsg('/ss ' + gslEditor.scriptNum + '\n');
    } else if ((/^Name:[\s\S]*\d{4}\r\n.*>$/.test(receivedMsg)) && (gslEditor.sendScript == 3)) {
        let modifier = /Last modified by: ([\w-_\.]+)/.exec(receivedMsg)[1];
        let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg);
        let data = modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3];
        gslEditor.extContext.globalState.update('s' + gslEditor.scriptNum, data);
        gslEditor.sendScript = 0;
        gslEditor.scriptTxt = '';
        vscode.window.setStatusBarMessage('Upload successful.', 5000);
    }
}

function gslDownload() {
    vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Script number or verb name to download? Multiple scripts via 12316;profile or 15-19.' }).then(input => {
        if ((input == null) | (input == '')) {
            return vscode.window.showErrorMessage('No input provided. Script download aborted.');
        }
        gslEditor.scriptArray = [];
        let inputArray = input.split(";");
        let BreakException = {};
        try {
            for (let i = 0; i < inputArray.length; i++) {
                if (inputArray[i].indexOf('-') !== -1) {
                    let range = inputArray[i].split('-');
                    range[0] = parseInt(range[0]);
                    range[1] = parseInt(range[1]);
                    if (isNaN(range[0]) | isNaN(range[1]) | range[0] >= range[1]) {
                        BreakException.element = inputArray[i];
                        throw BreakException;
                    }
                    for (let x = 0; range[0] + x <= range[1]; x++) {
                        gslEditor.scriptArray.push(range[0] + x);
                    }
                } else {
                    gslEditor.scriptArray.push(inputArray[i])
                }
            }
        } catch (e) {
            if (e == BreakException) {
                return vscode.window.showErrorMessage('Invalid script range: ' + BreakException.element);
            }
        }
        gslDownload2(gslEditor.scriptArray[0]);
    });
}

function gslDownload2(script) {
    gslEditor.getScript = 1;
    gslEditor.scriptTxt = '';
    gslEditor.input = script;
    let type = '';
    if (isNaN(gslEditor.input)) {
        type = 'verb';
    } else {
        type = 'script';
    }
    vscode.window.setStatusBarMessage('Downloading ' + type + ' ' + gslEditor.input + '...', 5000);
    LogIntoGame().then(function () {
        if (gameClient.connected) {
            downloadScript(' \nWelcome to \n \nAll Rights Reserved '); //Simulate initial login text
        }
    });
}

function downloadScript(receivedMsg) {
    if (gslEditor.getScript == 2) { //Downloading script now, may span multiple messages
        gslEditor.scriptTxt += receivedMsg.replace(/Edt:$/, ''); //Remove ending Edt:
    }
    if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
        if (isNaN(gslEditor.input)) {
            vscode.window.setStatusBarMessage('Downloading verb ' + gslEditor.input + '...', 5000);
            sendMsg('/mv ' + gslEditor.input + '\n');
        } else {
            vscode.window.setStatusBarMessage('Downloading script ' + gslEditor.input + '...', 5000);
            sendMsg('/ms ' + gslEditor.input + '\n');
        }
        gslEditor.getScript = 1;
        gslEditor.scriptTxt = '';
    } else if (/Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.test(receivedMsg)) {
        let match = /Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.exec(receivedMsg);
        sendMsg('/mv ' + match[2] + '\n');
    } else if (/Error: Script #\d\d\d\d\d has not been created yet/.test(receivedMsg)) {
        return vscode.window.showErrorMessage('Script #' + gslEditor.input + ' has not been created yet.');
    } else if (/Verb not found/.test(receivedMsg)) {
        return vscode.window.showErrorMessage('Verb name ' + gslEditor.input + ' has not been created yet.');
    } else if (/LineEditor/.test(receivedMsg)) {
        let match = /(?:New\s)?File:\s\.\.\/scripts\/(S\d\d\d\d\d)/.exec(receivedMsg);
        if (/New File/.test(receivedMsg)) {
            sendMsg('\n');
        } else {
            sendMsg('P\n');
        }
        gslEditor.scriptNum = match[1];
        gslEditor.getScript = 2;
    } else if (/Edt:$/.test(receivedMsg)) {
        sendMsg('Q\n');
        let extPath = null;
        let useWorkspaceFolder = vscode.workspace.getConfiguration('gsl').get('downloadToWorkspace');
        if (useWorkspaceFolder && vscode.workspace.workspaceFolders) {
            extPath = vscode.workspace.workspaceFolders[0].uri.fsPath
        } else {
            extPath = vscode.workspace.getConfiguration('gsl').get('downloadPath');
        }
        if (!extPath) {
            let rootPath = path.resolve(__dirname, '../gsl');
            if (!fs.existsSync(rootPath)) { //Directory doesn't exist
                fs.mkdirSync(rootPath); //Create directory
            }
            extPath = path.resolve(__dirname, '../gsl/scripts');
        }
        if (!fs.existsSync(extPath)) { //Directory doesn't exist
            fs.mkdirSync(extPath); //Create directory
        }
        return __awaiter(this, void 0, void 0, function* () {
            let fileName = path.join(extPath, gslEditor.scriptNum) + vscode.workspace.getConfiguration('gsl').get('fileExtension');
            if (fs.existsSync(fileName)) { //Check for existing file
                fs.unlinkSync(fileName); //Already exists, delete it
            }
            fs.writeFileSync(fileName, gslEditor.scriptTxt); //Create new file with script text
            vscode.workspace.openTextDocument(fileName).then(document => {
                vscode.window.showTextDocument(document, {preview: false});
            });
            vscode.window.setStatusBarMessage('Download successful.', 5000);
        });
    } else if (/(Script edit aborted|Modification aborted)/.test(receivedMsg)) {
        let scriptNum = gslEditor.scriptNum.replace(/\D+/g, '').replace(/^0+/, '');
        sendMsg('/ss ' + scriptNum + '\n');
    } else if (/^Name:[\s\S]*\d{4}\r\n.*>$/.test(receivedMsg)) {
        let scriptNum = gslEditor.scriptNum.replace(/\D+/g, '').replace(/^0+/, '');
        let modifier = /Last modified by: ([\w-_\.]+)/.exec(receivedMsg)[1];
        let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg);
        let data = modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3];
        gslEditor.extContext.globalState.update('s' + scriptNum, data);
        gslEditor.scriptArray.shift();
        if (gslEditor.scriptArray.length > 0) {
            gslDownload2(gslEditor.scriptArray[0]);
        } else {
            gslEditor.getScript = 0;
        }
    }
}

function gslDateCheck() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return vscode.window.showErrorMessage('You must have a script open before you can check its date.');
    }
    let doc = editor.document;
    if (!doc) {
        return vscode.window.showErrorMessage('You must have a script open before you can check its date.');
    }
    let scriptNum = path.basename(doc.fileName).replace(/\D+/g, '').replace(/^0+/, '');
    if (!/^\d{1,5}$/.test(scriptNum)) {
        return vscode.window.showErrorMessage('Unable to parse script # from file name.');
    }
    gslEditor.scriptNum = scriptNum;
    gslEditor.dateCheck = 1;
    vscode.window.setStatusBarMessage('Checking last modified date of script ' + scriptNum + '...', 5000);
    LogIntoGame().then(function () {
        if (gameClient.connected) {
            dateCheck(' \nWelcome to \n \nAll Rights Reserved '); //Simulate initial login text
        }
    });
}

function dateCheck(receivedMsg) {
    if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
        sendMsg('/ss ' + gslEditor.scriptNum + '\n');
    } else if (/Last modified by: /.test(receivedMsg)) {
        let modifier = /Last modified by: ([\w-_\.]+)/.exec(receivedMsg)[1];
        let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg);
        let data = 'Last modified by ' + modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3] + '.';
        vscode.window.showInformationMessage(data);
        gslEditor.dateCheck = 0;
    }
}

function sendMsg(msg) {
    outGameChannel('Sent: ' + msg);
    if (sgeClient.connected) {
        sgeClient.write(msg);
    } else if (gameClient.connected) {
        gameClient.write(msg);
    }
}

function onConnSGEData(data) {
    let receivedMsg = data.toString();
    receivedMsg = receivedMsg.replace(/\n$/, ''); //Remove ending newline
    let msgArray = receivedMsg.split('\t');
    outGameChannel(receivedMsg);
    gslEditor.lastMsg = receivedMsg;
    gslEditor.msgCount++;

    if (/^.{32}$/gu.test(receivedMsg) && (gslEditor.msgCount == 1)) {
        gslEditor.hashKey = receivedMsg;
        let pw = vscode.workspace.getConfiguration('gsl').get('password');
        if (pw == '') {
            return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then input your password in the GSL section.');
        }
        gslEditor.pwHash = '';
        for (let i = 0; i < pw.length; i++) {
            gslEditor.pwHash += String.fromCharCode(((pw.charCodeAt(i) - 32) ^ gslEditor.hashKey.charCodeAt(i)) + 32);
        }
        let account = vscode.workspace.getConfiguration('gsl').get('account');
        if (account == '') {
            return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then input your account name in the GSL section.');
        }
        sendMsg('A\t' + account + '\t');
        sendMsg(Buffer.from(str2ab(gslEditor.pwHash)));
        sendMsg('\n');
    } else if (/^A\t\tNORECORD$/.test(receivedMsg)) {
        vscode.window.showErrorMessage('Invalid account name. Please recheck your credentials.');
    } else if (/^A\t\tPASSWORD$/.test(receivedMsg)) {
        vscode.window.showErrorMessage('Invalid password. Please recheck your credentials.');
    } else if (/^A\t.*\tKEY\t.*/.test(receivedMsg)) {
        sendMsg('M\n');
    } else if (/^M\t.*/.test(receivedMsg)) {
        let game = vscode.workspace.getConfiguration('gsl').get('game');
        if (game == '') {
            return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then select the game you want to log into under GSL section.');
        }
        gslEditor.gameCode = msgArray[msgArray.indexOf(game) - 1];
        sendMsg('N\t' + gslEditor.gameCode + '\n');
    } else if (/^N\t.*STORM$/.test(receivedMsg)) {
        sendMsg('F\t' + gslEditor.gameCode + '\n');
    } else if (/^F\t.*/.test(receivedMsg)) {
        sendMsg('G\t' + gslEditor.gameCode + '\n');
    } else if (/^G\t.*/.test(receivedMsg)) {
        sendMsg('P\t' + gslEditor.gameCode + '\n');
    } else if (/^P\t.*/.test(receivedMsg)) {
        sendMsg('C\n');
    } else if (/^C\t([0-9]+\t){4}.*/.test(receivedMsg)) {
        let lowerCaseMsgArray = msgArray.map(function (value) {
            return value.toLowerCase();
        });
        let character = vscode.workspace.getConfiguration('gsl').get('character');
        if (character == '') {
            return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then input the character name you want to log into under GSL section.');
        }
        let pos = (lowerCaseMsgArray.indexOf(character.toLowerCase()) - 1);
        gslEditor.characterID = msgArray[pos];
        sendMsg('L\t' + gslEditor.characterID + '\tSTORM\n');
    } else if (/^L\tOK\t.*/.test(receivedMsg)) {
        for (let i = 0; i < msgArray.length; i++) {
            if (msgArray[i].includes('GAMEHOST=')) {
                gslEditor.gameHost = msgArray[i].substring(msgArray[i].indexOf("=") + 1);
            } else if (msgArray[i].includes('GAMEPORT=')) {
                gslEditor.gamePort = msgArray[i].substring(msgArray[i].indexOf("=") + 1);
            } else if (msgArray[i].includes('KEY=')) {
                gslEditor.gameKey = msgArray[i].substring(msgArray[i].indexOf("=") + 1);
            }
        }
        sgeClient.destroy();
        gameClient.connect(gslEditor.gamePort, gslEditor.gameHost, function () {
            gameClient.connected = true;
            outGameChannel('Game connection established.');
            sendMsg(gslEditor.gameKey + '\n');
        });
        gameClient.setEncoding('ascii');
        gameClient.on('close', onConnGameClose);
        gameClient.on('disconnect', onConnGameClose);
        gameClient.on('data', onConnGameData);
        gameClient.on('error', onConnError);
        gameClient.setKeepAlive(true);
        gameClient.setNoDelay(true);
    }
}

function onConnGameData(data) {
    let receivedMsg = data.toString();
    receivedMsg = receivedMsg.replace(/\n$/, ''); //Remove ending newline
    outGameChannel(receivedMsg);
    gslEditor.lastMsg = receivedMsg;
    gslEditor.msgCount++;

    if (receivedMsg.includes('Edt:')) { //Editing a script
        setTimeout(function () { checkState(receivedMsg, gslEditor.msgCount) }, 5000);
    }

    if (/^<mode id="GAME"\/>$/.test(receivedMsg)) {
        setTimeout(function () { sendMsg('<c>\n') }, 300);
        setTimeout(function () { sendMsg('<c>\n') }, 600);
    } else if (gslEditor.getScript) {
        downloadScript(receivedMsg);
    } else if (gslEditor.sendScript) {
        uploadScript(receivedMsg);
    } else if (gslEditor.dateCheck) {
        dateCheck(receivedMsg);
    }
}

function checkState(msg, count) {
    if ((msg == gslEditor.lastMsg) && (count == gslEditor.msgCount)) { //Stuck on same last message after 5 seconds
        sendMsg('\n');
        setTimeout(function () { sendMsg('V\n') }, 200);
        setTimeout(function () { sendMsg('Y\n') }, 400);
        setTimeout(function () { sendMsg('Q\n') }, 600);
    }
}

function onConnSGEClose() {
    outGameChannel('SGE connection closed.');
    sgeClient.connected = false;
    sgeClient.removeAllListeners();
}

function onConnGameClose() {
    outGameChannel('Game connection closed.');
    gameClient.connected = false;
    gameClient.removeAllListeners();
}

function onConnError(err) {
    if (sgeClient.connected) {
        outGameChannel('SGE connection error: ' + err.message);
        sgeClient.destroy();
        sgeClient.removeAllListeners();
        sgeClient.connected = false;
    }
    if (gameClient.connected) {
        outGameChannel('Game connection error: ' + err.message);
        gameClient.destroy();
        gameClient.removeAllListeners();
        gameClient.connected = false;
    }
    showError(err);
}

function showError(err) {
    vscode.window.showErrorMessage('Error: ' + err.message);
    getGameChannel().show(true);
}