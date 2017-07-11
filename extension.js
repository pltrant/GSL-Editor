"use strict";

const vscode = require("vscode");
const net = require('net');
const fs = require('fs');
const path = require("path");

const sgeClient = new net.Socket();
const gameClient = new net.Socket();
var gameChannel;
var gslEditor = {
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
    scriptTxt: '',
    debug: '',
    input: '',
    lastMsg: ''
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

function getScriptNumFromFile(doc) {
    let fileName = doc.fileName;
    let nameLength = doc.fileName.length;
    if (fileName.toLowerCase().substr(nameLength - 3) == "gsl") { // Ends with *.gsl
        return doc.fileName.substr(nameLength - 9).substr(0, 5);
    } else { // No file extension
        return doc.fileName.substr(nameLength - 5)
    }
}

function LogIntoGame() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!gameClient.connected) {
            sgeClient.connect(7900, 'eaccess.play.net', function () {
                sgeClient.connected = true;
                gslEditor.msgCount = 0;
                outGameChannel('SGE connection established.');
                sendMsg('K\n');
            });
            sgeClient.on('close', onConnSGEClose);
            sgeClient.on('data', onConnSGEData);
            sgeClient.on('error', onConnError);
            sgeClient.setNoDelay(true);
        }
    });
}

function activate(context) {
    if (!this._DLstatusBarItem) {
        this._DLstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    }
    if (!this._ULstatusBarItem) {
        this._ULstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    }
    if (!this._MMstatusBarItem) {
        this._MMstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    }
    let self = this;
    if (vscode.workspace.getConfiguration('gsl').get('alwaysEnabled')) {
        showGSLStatusBarItems(self);
    } else {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            this._DLstatusBarItem.hide();
            this._ULstatusBarItem.hide();
            this._MMstatusBarItem.hide();
            return;
        }
        let doc = editor.document;
        if (doc.languageId === "gsl") {
            showGSLStatusBarItems(self);
        } else {
            this._DLstatusBarItem.hide();
            this._ULstatusBarItem.hide();
            this._MMstatusBarItem.hide();
        }
    }
    context.subscriptions.push(vscode.commands.registerCommand('extension.gslDownload', () => {
        gslDownload(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('extension.gslUpload', () => {
        gslUpload(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('extension.gslMatchmarkers', () => {
        gslMatchmarkers(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('extension.gslSendGameCommand', () => {
        gslSendGameCommand(context);
    }));

    if (vscode.workspace.getConfiguration('gsl').get('displayGameChannel')) {
        getGameChannel().show(true);
    }

    checkForUpdatedVersion(context);
}
exports.activate = activate;

function checkForUpdatedVersion(context) {
    const showReleaseNotes = "Show Release Notes";
    const gslExtensionVersionKey = 'gslExtensionVersion';
    var extensionVersion = vscode
        .extensions
        .getExtension("patricktrant.gsl")
        .packageJSON
        .version;
    var storedVersion = context.globalState.get(gslExtensionVersionKey);
    if (!storedVersion) {
    }
    else if (extensionVersion !== storedVersion) {
        vscode
            .window
            .showInformationMessage(`The GSL Editor extension has been updated to version ${extensionVersion}!`, showReleaseNotes)
            .then(choice => {
            if (choice === showReleaseNotes) {
                vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.resolve(__dirname, "./CHANGELOG.md")));
            }
        });
    }
    context.globalState.update(gslExtensionVersionKey, extensionVersion);
}

function showGSLStatusBarItems(context) {
    context._DLstatusBarItem.text = '↓ Download';
    context._DLstatusBarItem.command = 'extension.gslDownload';
    context._DLstatusBarItem.show();
    context._ULstatusBarItem.text = '↑ Upload';
    context._ULstatusBarItem.command = 'extension.gslUpload';
    context._ULstatusBarItem.show();
    context._MMstatusBarItem.text = 'Matchmarkers';
    context._MMstatusBarItem.command = 'extension.gslMatchmarkers';
    context._MMstatusBarItem.show();
}

function gslMatchmarkers(context) {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return vscode.window.showErrorMessage('You must have a script open before you can list its matchmarkers.');
    }
    let doc = editor.document;
    if (!doc) {
        return vscode.window.showErrorMessage('You must have a script open before you can list its matchmarkers.');
    }
    let matchmarkers = [];
    for (let index = 1; index < doc.lineCount; index++) {
        let text = doc.lineAt(index).text;
        if (/^: "(.*)"/.test(text)) {
            let myRegexp = /^: "(.*)"/;
            let match = myRegexp.exec(text);
            matchmarkers[matchmarkers.length] = match[1]
        }
    }
    vscode.window.showQuickPick(matchmarkers).then(val => {
        for (let index = 1; index < doc.lineCount; index++) {
            let text = doc.lineAt(index).text;
            if (/^: "(.*)"/.test(text)) {
                let myRegexp = /^: "(.*)"/;
                let match = myRegexp.exec(text);
                if (val == match[1]) {
                    let range = editor.document.lineAt(doc.lineCount - 1).range;
                    editor.revealRange(range);
                    range = editor.document.lineAt(index - 1).range;
                    editor.revealRange(range);
                }
            }
        }
    });
}

function gslSendGameCommand(context) {
    vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Command to send to game?' }).then(input => {
        if ((input == null) | (input == '')) {
            return vscode.window.showInformationMessage('Not input provided. Command aborted.');
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

function delayedGameCommand(command) {
    if (gameClient.connected) {
        getGameChannel().show(true);
        sendMsg(command + '\n');
    }
}

function gslUpload(context) {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return vscode.window.showErrorMessage('You must have a script open before you can upload it.');
    }
    let doc = editor.document;
    if (!doc) {
        return vscode.window.showErrorMessage('You must have a script open before you can upload it.');
    }
    let scriptNum = getScriptNumFromFile(doc);
    if (!/\d\d\d\d\d/.test(scriptNum)) {
        return vscode.window.showErrorMessage('Invalid script # to upload.  The script # is derived from the filename and must be in the S##### format.');
    }
    gslEditor.scriptNum = scriptNum;
    gslEditor.scriptTxt = doc.getText();
    gslEditor.sendScript = 1;
    gslEditor.getScript = 0;
    vscode.window.setStatusBarMessage('Uploading script ' + scriptNum + '...', 5000);
    LogIntoGame().then(function () {
        if (gameClient.connected) {
            uploadScript(' \nWelcome to \n \nAll Rights Reserved '); //Simulate initial login text
        }
    });
}

function uploadScript(receivedMsg) {
    if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
        sendMsg('/ms ' + gslEditor.scriptNum + '\n');
    } else if (/Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.test(receivedMsg)) {
        let myRegexp = /Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./;
        let match = myRegexp.exec(receivedMsg);
        sendMsg('/mv ' + match[2] + '\n');
    } else if ((/Edt:$/.test(receivedMsg)) && (gslEditor.sendScript == 1)) {
        sendMsg('Z\n');
    } else if (/ZAP!  All lines deleted\./.test(receivedMsg)) {
        let scriptArray = gslEditor.scriptTxt.split('\n');
        let delay = 0;
        for (let index = 0; index < scriptArray.length; index++) {
            setTimeout(function () { gameClient.write(scriptArray[index] + '\n'); gameClient.uncork(); }, delay);
            delay += 1;
        }
        setTimeout(function () { gameClient.write('\n'); gameClient.uncork(); }, delay);
        gslEditor.sendScript = 2;
    } else if ((/Edt:$/.test(receivedMsg)) && (gslEditor.sendScript == 2)) {
        sendMsg('G\n');
        gslEditor.sendScript = 3;
    } else if (/Edt:Inserting before line: 0/.test(receivedMsg)) {
        vscode.window.showErrorMessage("Upload error.  Please check to ensure you haven't gone past 118 characters on a single line.");
        sendMsg('Q\n');
        gslEditor.sendScript = 0;
        gslEditor.scriptTxt = '';
        vscode.window.setStatusBarMessage('Upload failed.', 5000);
        getGameChannel().show(true);
    } else if (/Compile Failed w\/(.*) errors and (.*) warnings\./.test(receivedMsg)) {
        let myRegexp = /(Compile Failed w\/(.*) errors and (.*) warnings\.)/;
        let match = myRegexp.exec(receivedMsg);
        vscode.window.showErrorMessage(match[1]);
        sendMsg('Q\n');
        gslEditor.sendScript = 0;
        gslEditor.scriptTxt = '';
        vscode.window.setStatusBarMessage('Upload failed.', 5000);
        getGameChannel().show(true);
    } else if (/Compile OK\./.test(receivedMsg)) {
        sendMsg('Q\n');
        gslEditor.sendScript = 0;
        gslEditor.scriptTxt = '';
        vscode.window.setStatusBarMessage('Upload successful.', 5000);
    }
}

function gslDownload(context) {
    vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Script number or verb name to download?' }).then(input => {
        if ((input == null) | (input == '')) {
            return vscode.window.showInformationMessage('Not input provided. Script download aborted.');
        }
        gslEditor.getScript = 1;
        gslEditor.scriptTxt = '';
        gslEditor.input = input;
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
    });
}

function downloadScript(receivedMsg) {
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
        let myRegexp = /Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./;
        let match = myRegexp.exec(receivedMsg);
        sendMsg('/mv ' + match[2] + '\n');
    } else if (/Error: Script #\d\d\d\d\d has not been created yet/.test(receivedMsg)) {
        return vscode.window.showErrorMessage('Script #' + gslEditor.input + ' has not been created yet.');
    } else if (/Verb not found/.test(receivedMsg)) {
        return vscode.window.showErrorMessage('Verb name ' + gslEditor.input + ' has not been created yet.');
    } else if (/LineEditor/.test(receivedMsg)) {
        let myRegexp = /File:\s\.\.\/scripts\/(S\d\d\d\d\d)/;
        let match = myRegexp.exec(receivedMsg);
        gslEditor.scriptNum = match[1];
        sendMsg('P\n');
        gslEditor.getScript = 2;
    } else if (/Edt:$/.test(receivedMsg)) {
        gslEditor.getScript = 0;
        sendMsg('Q\n');
        let extPath = vscode.workspace.getConfiguration('gsl').get('downloadPath');
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
            let fileName = extPath + '\\' + gslEditor.scriptNum;
            if (fs.existsSync(fileName)) { //Check for existing file
                fs.unlinkSync(fileName); //Already exists, delete it
            }
            fs.writeFileSync(fileName, gslEditor.scriptTxt); //Create new file with script text
            vscode.workspace.openTextDocument(fileName).then(document => {
                vscode.window.showTextDocument(document)
            });
            vscode.window.setStatusBarMessage('Download successful.', 5000);
        });
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
        gameClient.on('close', onConnGameClose);
        gameClient.on('data', onConnGameData);
        gameClient.on('error', onConnError);
        gameClient.setNoDelay(true);
    }
}

function onConnGameData(data) {
    let receivedMsg = data.toString();
    receivedMsg = receivedMsg.replace(/\n$/, ''); //Remove ending newline
    let msgArray = receivedMsg.split('\t');
    outGameChannel(receivedMsg);
    gslEditor.lastMsg = receivedMsg;
    gslEditor.msgCount++;

    if (receivedMsg.includes('Edt:')) { //Editing a script
        setTimeout(function () { checkState(receivedMsg, gslEditor.msgCount) }, 5000);
    }

    if (gslEditor.getScript == 2) { //Downloading script now, may span multiple messages
        gslEditor.scriptTxt += receivedMsg;
        gslEditor.scriptTxt = gslEditor.scriptTxt.replace(/Edt:$/, ''); //Remove ending Edit:
    }

    if (/^<mode id="GAME"\/>$/.test(receivedMsg)) {
        setTimeout(function () { sendMsg('<c>\n') }, 300);
        setTimeout(function () { sendMsg('<c>\n') }, 600);
    } else if (gslEditor.getScript) {
        downloadScript(receivedMsg);
    } else if (gslEditor.sendScript) {
        uploadScript(receivedMsg);
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