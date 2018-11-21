'use strict'

const vscode = require('vscode')
const net = require('net')
const fs = require('fs')
const path = require('path')

const sgeClient = new net.Socket()
const gameClient = new net.Socket()
var gslEditor = {
  extContext: null,
  hashKey: '',
  pwHash: '',
  gameCode: '',
  characterID: '',
  gameHost: '',
  gamePort: '',
  gameKey: '',
  gameChannel: null,
  logging: false,
  msgCount: 0,
  getScript: 0,
  sendScript: 0,
  scriptNum: 0,
  scriptArray: [],
  scriptTxt: '',
  debug: '',
  diagnostic: null,
  input: '',
  lastMsg: '',
  goToDefinition: ''
}

class SymbolProvider {
  provideDocumentSymbols (document, token) {
    return new Promise((resolve, reject) => {
      let header = true
      let symbols = []
      for (let i = 0; i < document.lineCount; i++) {
        let line = document.lineAt(i)
        if (line.text.startsWith(': ')) {
          header = false
          let matchMarker = /^:\s+"(.*?)"/.exec(line.text)
          let endLine = null
          let endChar = null
          for (let i = line.lineNumber; i < document.lineCount; i++) {
            let lineTxt = document.lineAt(i)
            if (lineTxt.text.startsWith('.')) {
              // Attribute any comments after the closing period to the current matchmarker
              for (let j = i + 1; j < document.lineCount; j++) {
                let lineTxt2 = document.lineAt(j)
                if (!lineTxt2.text.startsWith('!')) {
                  break
                } else {
                  i++
                }
              }
              endLine = i
              endChar = document.lineAt(i).range.end.character
              break
            }
          }
          let symbolRange = null
          if ((endLine == null) || (endChar == null)) {
            symbolRange = line.range
          } else {
            symbolRange = new vscode.Range(
              line.lineNumber,
              line.range.start.character,
              endLine,
              endChar
            )
          }
          symbols.push({
            name: matchMarker[1],
            kind: vscode.SymbolKind.Method,
            location: new vscode.Location(document.uri, symbolRange)
          })
        } else if (header && !line.text.startsWith('!')) {
          header = false
          let endLine = null
          let endChar = null
          for (let i = line.lineNumber; i < document.lineCount; i++) {
            let lineTxt = document.lineAt(i)
            if (lineTxt.text.startsWith(':')) {
              i--
              endLine = i
              endChar = document.lineAt(i).range.end.character
              break
            }
          }
          if ((endLine == null) || (endChar == null)) { // the whole script is in the empty matchmarker
            endLine = document.lineCount - 1
            endChar = document.lineAt(document.lineCount - 1).range.end.character
          }
          let symbolRange = new vscode.Range(
            line.lineNumber,
            line.range.start.character,
            endLine,
            endChar
          )
          symbols.push({
            name: '""',
            kind: vscode.SymbolKind.Method,
            location: new vscode.Location(document.uri, symbolRange)
          })
        }
      }
      resolve(symbols)
    })
  }
}

class HoverProvider {
  constructor () {
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
    }
    this.varInfo = {
      'A': 'value',
      'B': 'value',
      'D': 'value / 100 with remainder as decimal',
      'V': 'value',
      'L': 'value right aligned to 7 characters',
      'S': 'value',
      'K': 'value right aligned to 16 characters',
      'T': 'value'
    }
    this.tokenInfo = {
      '$': '$ symbol',
      '\\': 'Suppresses automatic linefeed',
      '^': 'Uppercase first letter of string',
      'Q': '" symbol',
      'R': 'Linefeed',
      '*': 'ESC code (ASCII 27)',
      '+': 'Capitalizes first letter of next string token',
      "'": "Adds 's to next string token, properly XML wrapped",
      'ZE': 'Outputs timestamp for token that follows'
    }
    this.baseHoverRegex = /\$(:\$[A-Z]+|:\d+\[\d+,\d+,\d+\]|[\w\d:_-]+|[ABDVLSKT]\d|[$\\^QR*+'])/
    this.stringTokenRegex = /\$([POCEXr])(\d)([A-Z]?)$/
    this.fieldRegex = /\$([POCEXr]\d):([\w\d_]+)$/
    this.varRegex = /\$([ABDVLSKT])(\d)/
    this.tokenRegex = /\$([$\\^QR*+']|ZE)/
    this.systemRegex = /\$:(\$[A-Z]+)/
    this.tableRegex = /\$:(\d+)(\[\d+,\d+,\d+\])/
  }

  provideHover (document, position, token) {
    let wordRange = document.getWordRangeAtPosition(position, this.baseHoverRegex)
    if (!wordRange) return

    let word = document.getText(wordRange)
    if (this.stringTokenRegex.test(word)) {
      return this.stringTokenHover(word)
    } else if (this.fieldRegex.test(word)) {
      return this.fieldHover(word)
    } else if (this.varRegex.test(word)) {
      return this.varHover(word)
    } else if (this.tokenRegex.test(word)) {
      return this.tokenHover(word)
    } else if (this.systemRegex.test(word)) {
      return this.systemHover(word)
    } else if (this.tableRegex.test(word)) {
      return this.tableHover(word)
    }
  }

  stringTokenHover (token) {
    let tokenTypes = this.stringTokenRegex.exec(token)
    if (tokenTypes[1] in this.nodeInfo && tokenTypes[3] in this.nodeInfo[tokenTypes[1]]) {
      return new vscode.Hover('N' + tokenTypes[1].toUpperCase() + tokenTypes[2] + ': ' + this.nodeInfo[tokenTypes[1]][tokenTypes[3]])
    }
  }

  fieldHover (token) {
    let tokenTypes = this.fieldRegex.exec(token)
    return new vscode.Hover('N' + tokenTypes[1].toUpperCase() + ": '" + tokenTypes[2] + "' field")
  }

  varHover (token) {
    let tokenTypes = this.varRegex.exec(token)
    let varName = tokenTypes[1]
    if (varName === 'D' || varName === 'L') varName = 'V'
    if (varName === 'K') varName = 'S'
    return new vscode.Hover(varName + tokenTypes[2] + ': ' + this.varInfo[tokenTypes[1]])
  }

  tokenHover (word) {
    let token = this.tokenRegex.exec(word)[1]
    return new vscode.Hover(this.tokenInfo[token])
  }

  systemHover (word) {
    let token = this.systemRegex.exec(word)[1]
    return new vscode.Hover('System variable ' + token)
  }

  tableHover (word) {
    let tokenTypes = this.tableRegex.exec(word)
    return new vscode.Hover('table #' + tokenTypes[1] + ': value in ' + tokenTypes[2])
  }
}

class DefinitionProvider {
  provideDefinition (document, position, token) {
    let txt = document.lineAt(position.line).text.trim().toLowerCase()
    if (txt.includes('call')) {
      let txtArray = txt.split(' ')
      if (txtArray[4] === '$thisscript') {
        for (let i = 0; i < document.lineCount; i++) {
          let line = document.lineAt(i)
          if (line.text.toLowerCase().startsWith(': ' + txtArray[2])) {
            return new vscode.Location(document.uri, new vscode.Position(i, 0))
          }
        }
      } else {
        let scriptNum = ''
        if (txtArray.length === 2) { // call #
          scriptNum = txtArray[1]
        } else if (txtArray[3] === 'in') { // callmatch must_match "$*" in #
          scriptNum = txtArray[4]
        } else {
          return
        }
        if (isNaN(scriptNum)) { // Not a number
          return
        }
        while (scriptNum.length < 5) {
          scriptNum = '0' + scriptNum
        }
        let scriptFile = path.join(getDownloadLocation(), 'S' + scriptNum) + vscode.workspace.getConfiguration('gsl').get('fileExtension')
        if (fs.existsSync(scriptFile)) {
          let idx = 0
          if (txtArray[4]) {
            let fileTxt = fs.readFileSync(scriptFile).toString().split('\r\n')
            for (let i = 0; i < fileTxt.length; i++) {
              if (fileTxt[i].toLowerCase().startsWith(': ' + txtArray[2])) {
                idx = i
                break
              }
            }
          }
          return new vscode.Location(vscode.Uri.file(scriptFile), new vscode.Position(idx, 0))
        } else {
          gslEditor.goToDefinition = txtArray[2]
          gslDownload2(scriptNum)
        }
      }
    }
  }
}

class DocumentHighlightProvider {
  constructor () {
    this.startKeywords = /^:|^\s*(if|ifnot|loop|when|is|default|fastpush|push)\b.*$/i
    this.middleKeywords = /^\s*(else|else_if|else_ifnot)\b.*$/i
    this.endKeywords = /^\s*\.|(fastpop|pop)\b.*$/i
    this.gslWords = /:|\.|if|ifnot|loop|when|is|default|else_ifnot|else_if|else|fastpush|fastpop|push|pop/i
  }

  provideDocumentHighlights (document, position, token) {
    let highlights = []
    let textRange = document.getWordRangeAtPosition(position, /[\S]+/)
    let lineNum = textRange.start.line
    let starts = 0
    let ends = 0
    if (this.startKeywords.test(document.getText(textRange))) {
      highlights.push(new vscode.DocumentHighlight(textRange, {kind: 0}))
      this.searchLinesAfter(document, lineNum, highlights, starts, ends)
    } else if (this.middleKeywords.test(document.getText(textRange))) {
      highlights.push(new vscode.DocumentHighlight(textRange, {kind: 0}))
      // Check for the starting keyword
      ends = 1
      this.searchLinesBefore(document, lineNum, highlights, starts, ends)
      // Check for the ending keyword
      lineNum = textRange.start.line
      starts = 1
      ends = 0
      this.searchLinesAfter(document, lineNum, highlights, starts, ends)
    } else if (this.endKeywords.test(document.getText(textRange))) {
      highlights.push(new vscode.DocumentHighlight(textRange, {kind: 0}))
      this.searchLinesBefore(document, lineNum, highlights, starts, ends)
    }
    return highlights
  }

  searchLinesAfter (document, lineNum, highlights, starts, ends) {
    let foundEnd = false
    let textLine = ''
    while (foundEnd === false) {
      textLine = document.lineAt(lineNum).text
      if (this.startKeywords.test(textLine)) {
        starts++
      } else if ((starts === ends + 1) && (this.middleKeywords.test(textLine))) {
        this.addHighlight(highlights, document, lineNum, textLine)
      } else if (this.endKeywords.test(textLine)) {
        ends++
      }
      if (starts === ends) {
        this.addHighlight(highlights, document, lineNum, textLine)
        foundEnd = true
      }
      lineNum++
    }
  }

  searchLinesBefore (document, lineNum, highlights, starts, ends) {
    let foundEnd = false
    let textLine = ''
    while (foundEnd === false) {
      textLine = document.lineAt(lineNum).text
      if (this.startKeywords.test(textLine)) {
        starts++
      } else if ((starts + 1 === ends) && (this.middleKeywords.test(textLine))) {
        this.addHighlight(highlights, document, lineNum, textLine)
      } else if (this.endKeywords.test(textLine)) {
        ends++
      }
      if (starts === ends) {
        this.addHighlight(highlights, document, lineNum, textLine)
        foundEnd = true
      }
      lineNum--
    }
  }

  addHighlight (highlights, document, lineNum, textLine) {
    let startIdx = textLine.search(/\S|$/)
    if (startIdx > -1) {
      let endPos = new vscode.Position(lineNum, startIdx)
      if (endPos) {
        let endRange = document.getWordRangeAtPosition(endPos, this.gslWords)
        if (endRange) {
          highlights.push(new vscode.DocumentHighlight(endRange))
        }
      }
    }
  }
}

class DocumentFormatProvider {
  provideDocumentFormattingEdits (document) {
    let textEdits = []
    let firstLine = document.lineAt(0)
    let lastLine = document.lineAt(document.lineCount - 1)
    let textRange = new vscode.Range(
      0,
      firstLine.range.start.character,
      document.lineCount - 1,
      lastLine.range.end.character
    )
    // Remove non-printable characters
    // eslint-disable-next-line no-control-regex
    textEdits.push(vscode.TextEdit.replace(textRange, document.getText().replace(/[^\x00-\x7f]/g, '')))
    return textEdits
  }
}

var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
  return new (P || (P = Promise))(function (resolve, reject) {
    function fulfilled (value) { try { step(generator.next(value)) } catch (e) { reject(e) } }
    function rejected (value) { try { step(generator.throw(value)) } catch (e) { reject(e) } }
    function step (result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value) }).then(fulfilled, rejected) }
    step((generator = generator.apply(thisArg, _arguments)).next())
  })
}

function str2ab (str) { // String to Array Buffer
  var buffer = new ArrayBuffer(str.length)
  var bufferView = new Uint8Array(buffer)
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufferView[i] = str.charCodeAt(i)
  }
  return buffer
}

function getGameChannel () {
  if (gslEditor.gameChannel == null) {
    gslEditor.gameChannel = vscode.window.createOutputChannel('Game')
  }
  return gslEditor.gameChannel
}

function outGameChannel (message) {
  message = message.replace(/\n$/, '') // Remove ending newline
  getGameChannel().appendLine(`${message}`)
}

function LogIntoGame () {
  if (vscode.workspace.getConfiguration('gsl').get('disableLoginAttempts') === true) {
    return __awaiter(this, void 0, void 0, function * () { return Promise.reject })
  }
  return __awaiter(this, void 0, void 0, function * () {
    if (!gameClient.connected) {
      let game = vscode.workspace.getConfiguration('gsl').get('game')
      let character = vscode.workspace.getConfiguration('gsl').get('character')
      vscode.window.setStatusBarMessage('Logging into ' + game + ' with ' + character + '...', 5000)
      sgeClient.connect(7900, 'eaccess.play.net', function () {
        sgeClient.connected = true
        gslEditor.msgCount = 0
        outGameChannel('SGE connection established.')
        sendMsg('K\n')
      })
      sgeClient.setEncoding('ascii')
      sgeClient.on('close', onConnSGEClose)
      sgeClient.on('disconnect', onConnSGEClose)
      sgeClient.on('data', onConnSGEData)
      sgeClient.on('error', onConnError)
      sgeClient.setKeepAlive(true)
      sgeClient.setNoDelay(true)
    }
  })
}

function activate (context) {
  gslEditor.extContext = context
  if (!this._DLstatusBarItem) {
    this._DLstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  }
  if (!this._ULstatusBarItem) {
    this._ULstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  }
  if (!this._GSLstatusBarItem) {
    this._GSLstatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  }
  let self = this
  if (vscode.workspace.getConfiguration('gsl').get('alwaysEnabled')) {
    showGSLStatusBarItems(self)
  } else {
    let editor = vscode.window.activeTextEditor
    if (!editor) {
      this._DLstatusBarItem.hide()
      this._ULstatusBarItem.hide()
      this._GSLstatusBarItem.hide()
      return
    }
    let doc = editor.document
    if (doc.languageId === 'gsl') {
      showGSLStatusBarItems(self)
    } else {
      this._DLstatusBarItem.hide()
      this._ULstatusBarItem.hide()
      this._GSLstatusBarItem.hide()
    }
  }
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslDownload', () => {
    gslDownload()
  }))
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslUpload', () => {
    gslUpload()
  }))
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslCommands', () => {
    gslCommands()
  }))
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslDateCheck', () => {
    gslDateCheck()
  }))
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslSendGameCommand', () => {
    gslSendGameCommand()
  }))
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslListTokens', () => {
    gslListTokens()
  }))
  gslEditor.extContext.subscriptions.push(vscode.commands.registerCommand('extension.gslLogging', () => {
    gslLogging()
  }))

  if (vscode.workspace.getConfiguration('gsl').get('displayGameChannel')) {
    getGameChannel().show(true)
  }

  gslEditor.extContext.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(
    {scheme: '*', language: 'gsl'},
    new SymbolProvider()
  ))
  gslEditor.extContext.subscriptions.push(vscode.languages.registerHoverProvider(
    {scheme: '*', language: 'gsl'},
    new HoverProvider()
  ))
  gslEditor.extContext.subscriptions.push(vscode.languages.registerDefinitionProvider(
    {scheme: '*', language: 'gsl'},
    new DefinitionProvider()
  ))
  gslEditor.extContext.subscriptions.push(vscode.languages.registerDocumentHighlightProvider(
    {scheme: '*', language: 'gsl'},
    new DocumentHighlightProvider()
  ))
  gslEditor.extContext.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    {scheme: '*', language: 'gsl'},
    new DocumentFormatProvider()
  ))

  gslEditor.diagnostics = vscode.languages.createDiagnosticCollection()

  checkForUpdatedVersion()
}
exports.activate = activate

function checkForUpdatedVersion () {
  // Check for new install
  let newInstallFlag = gslEditor.extContext.globalState.get('newInstallFlag')
  if (!newInstallFlag) {
    let applyTheme = 'Apply Theme'
    vscode.window
      .showInformationMessage('For the best experience, the GSL Vibrant theme is recommended for the GSL Editor.', applyTheme)
      .then(choice => {
        if (choice === applyTheme) {
          vscode.workspace.getConfiguration().update('workbench.colorTheme', 'GSL Vibrant', true)
        }
      })
    gslEditor.extContext.globalState.update('newInstallFlag', true)
  }

  // Check for new Release Notes
  let showReleaseNotes = 'Show Release Notes'
  let gslExtensionVersionKey = 'gslExtensionVersion'
  let extensionVersion = vscode.extensions.getExtension('patricktrant.gsl').packageJSON.version
  let storedVersion = gslEditor.extContext.globalState.get(gslExtensionVersionKey)
  if (storedVersion && (extensionVersion !== storedVersion)) {
    vscode.window
      .showInformationMessage(`The GSL Editor extension has been updated to version ${extensionVersion}!`, showReleaseNotes)
      .then(choice => {
        if (choice === showReleaseNotes) {
          vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.resolve(__dirname, './CHANGELOG.md')))
        }
      })
  }
  gslEditor.extContext.globalState.update(gslExtensionVersionKey, extensionVersion)
}

function showGSLStatusBarItems (context) {
  context._DLstatusBarItem.text = '↓ Download'
  context._DLstatusBarItem.command = 'extension.gslDownload'
  context._DLstatusBarItem.show()
  context._ULstatusBarItem.text = '↑ Upload'
  context._ULstatusBarItem.command = 'extension.gslUpload'
  context._ULstatusBarItem.show()
  context._GSLstatusBarItem.text = 'GSL'
  context._GSLstatusBarItem.command = 'extension.gslCommands'
  context._GSLstatusBarItem.show()
}

function gslCommands (context) {
  vscode.window.showQuickPick(['Download Script', 'Upload Script', 'Check Script Modification Date', 'List GSL Tokens', 'Show Game Output Channel', 'Send Game Command', 'Enable Logging'], { placeHolder: 'Select a command to execute.' }).then(input => {
    switch (input) {
      case 'Download Script':
        gslDownload()
        break
      case 'Upload Script':
        gslUpload()
        break
      case 'Check Script Modification Date':
        gslDateCheck()
        break
      case 'List GSL Tokens':
        gslListTokens()
        break
      case 'Show Game Output Channel':
        getGameChannel().show(true);
        break
      case 'Send Game Command':
        gslSendGameCommand()
        break
      case 'Enable Logging':
        gslLogging()
        break
    }
  })
}

function gslSendGameCommand (context) {
  vscode.window.showInputBox({ prompt: 'Command to send to game?' }).then(input => {
    if ((input == null) | (input === '')) {
      return vscode.window.setStatusBarMessage('No input provided. Command aborted.', 2000)
    }
    LogIntoGame().then(function () {
      if (gameClient.connected) {
        vscode.window.setStatusBarMessage('Sending game command...', 2000)
        delayedGameCommand(input)
      }
    })
  })
}

function gslListTokens () {
  vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.resolve(__dirname, './syntaxes/tokens.md')))
}

function gslLogging () {
  if (gslEditor.logging) {
    gslEditor.logging = false
    vscode.window.setStatusBarMessage('Logging disabled.', 5000)
  } else {
    gslEditor.logging = true
    vscode.window.setStatusBarMessage('Logging enabled.', 5000)
  }
}

function delayedGameCommand (command) {
  if (gameClient.connected) {
    getGameChannel().show(true)
    sendMsg(command + '\n')
  }
}

function gslUpload () {
  let editor = vscode.window.activeTextEditor
  if (!editor) {
    return vscode.window.showErrorMessage('You must have a script open before you can upload it.')
  }
  let doc = editor.document
  if (!doc) {
    return vscode.window.showErrorMessage('You must have a script open before you can upload it.')
  }
  doc.save()
  gslEditor.scriptTxt = doc.getText()
  let scriptNum = path.basename(doc.fileName).replace(/\D+/g, '').replace(/^0+/, '')
  if (!/^\d{1,5}$/.test(scriptNum)) {
    vscode.window.showInputBox({ prompt: 'Unable to parse script # from file name. Script number to upload?' }).then(input => {
      if ((input == null) | (input === '')) {
        return vscode.window.setStatusBarMessage('No input provided. Script upload aborted.', 2000)
      } else {
        gslEditor.scriptNum = input
        gslUpload2(input)
      }
    })
  } else {
    gslEditor.scriptNum = scriptNum
    gslUpload2(scriptNum)
  }
}

function gslUpload2 (scriptNum) {
  gslEditor.sendScript = 1
  gslEditor.getScript = 0
  gslEditor.dateCheck = 0
  gslEditor.diagnostics.clear()
  LogIntoGame().then(function () {
    if (gameClient.connected) {
      vscode.window.setStatusBarMessage('Uploading script ' + scriptNum + '...', 5000)
      uploadScript(' \nWelcome to \n \nAll Rights Reserved ') // Simulate initial login text
    }
  })
}

function uploadScript (receivedMsg) {
  if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
    sendMsg('/ss ' + gslEditor.scriptNum + '\n')
  } else if ((/Name:[\s\S]*\d{4}\r\n.*>$/.test(receivedMsg)) && (gslEditor.sendScript === 1)) {
    let modifier = /Last modified by: ([\w-_.]+)/.exec(receivedMsg)[1]
    let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg)
    let data = modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3]
    let lastMod = gslEditor.extContext.globalState.get('s' + gslEditor.scriptNum, '')
    if ((lastMod !== '') && (lastMod !== data)) {
      let msg = 'Script ' + gslEditor.scriptNum + ' appears to have been edited since you last downloaded it.'
      msg = msg + '\n\nLocal: ' + lastMod + '\nServer: ' + data + '\n\nWould you like to upload this script anyway?'
      vscode.window.showWarningMessage(msg, { modal: true }, 'Yes').then(input => {
        if (input === 'Yes') {
          sendMsg('/ms ' + gslEditor.scriptNum + '\n')
        } else {
          gslEditor.sendScript = 0
          vscode.window.setStatusBarMessage('Upload canceled.', 5000)
        }
      })
    } else {
      sendMsg('/ms ' + gslEditor.scriptNum + '\n')
    }
  } else if (/Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.test(receivedMsg)) {
    let match = /Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.exec(receivedMsg)
    sendMsg('/mv ' + match[2] + '\n')
  } else if (/Invalid script number./.test(receivedMsg)) {
    return vscode.window.showErrorMessage(gslEditor.scriptNum + ' is an invalid script #.')
  } else if ((/Edt:$/.test(receivedMsg)) && (gslEditor.sendScript === 1)) {
    sendMsg('Z\n')
  } else if ((/ZAP! {2}All lines deleted\./.test(receivedMsg)) | (/New File/.test(receivedMsg))) {
    let scriptText = gslEditor.scriptTxt.replace(/\r/g, '\n').replace(/\n\n/g, '\n')
    gameClient.write(scriptText + '\n')
    if (!scriptText.endsWith('\n')) {
      gameClient.write('\n')
    }
    outGameChannel(scriptText)
    gslEditor.sendScript = 2
  } else if ((/Edt:$/.test(receivedMsg)) && (gslEditor.sendScript === 2)) {
    sendMsg('G\n')
    gslEditor.sendScript = 3
  } else if (/Edt:Inserting before line: 0/.test(receivedMsg)) {
    vscode.window.showErrorMessage("Upload error. Please check to ensure you haven't gone past 118 characters on a single line.")
    sendMsg('Q\n')
    gslEditor.sendScript = 0
    gslEditor.scriptTxt = ''
    vscode.window.setStatusBarMessage('Upload failed.', 5000)
    getGameChannel().show(true)
  } else if (/Compile Failed w\/(.*) errors and (.*) warnings\./.test(receivedMsg)) {
    sendMsg('Q\n')
    gslEditor.sendScript = 0
    gslEditor.scriptTxt = ''
    let diagnosticList = []
    let lines = receivedMsg.split('\r\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] && (/^\s*(\d+)\s:\s(.+)$/.test(lines[i]))) {
        let match = /^\s*(\d+)\s:\s(.+)$/.exec(lines[i])
        let line = match[1]
        let errorMsg = match[2]
        let textLine = vscode.window.activeTextEditor.document.lineAt(Number(line) - 1)
        let diagnostic = new vscode.Diagnostic(textLine.range, errorMsg, vscode.DiagnosticSeverity.Error)
        diagnosticList.push(diagnostic)
      }
    }
    gslEditor.diagnostics.set(vscode.window.activeTextEditor.document.uri, diagnosticList)
    vscode.commands.executeCommand('workbench.action.problems.focus')
    let match = /(Compile Failed w\/(.*) errors and (.*) warnings\.)/.exec(receivedMsg)
    vscode.window.showErrorMessage(match[1])
    vscode.window.setStatusBarMessage('Upload failed.', 5000)
  } else if (/Compile OK\./.test(receivedMsg)) {
    sendMsg('Q\n')
  } else if (/Compile ok\./.test(receivedMsg)) {
    sendMsg('/ss ' + gslEditor.scriptNum + '\n')
  } else if ((/Name:[\s\S]*\d{4}\r\n.*>$/.test(receivedMsg)) && (gslEditor.sendScript === 3)) {
    let modifier = /Last modified by: ([\w-_.]+)/.exec(receivedMsg)[1]
    let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg)
    let data = modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3]
    gslEditor.extContext.globalState.update('s' + gslEditor.scriptNum, data)
    gslEditor.sendScript = 0
    gslEditor.scriptTxt = ''
    vscode.window.setStatusBarMessage('Upload successful.', 5000)
  }
}

function gslDownload () {
  vscode.window.showInputBox({ prompt: 'Script number or verb name to download? Multiple scripts via 12316;profile or 15-19.' }).then(input => {
    if ((input == null) | (input === '')) {
      return vscode.window.setStatusBarMessage('No input provided. Script download aborted.', 2000)
    }
    gslEditor.scriptArray = []
    let inputArray = input.split(';')
    let BreakException = {}
    try {
      for (let i = 0; i < inputArray.length; i++) {
        if (inputArray[i].indexOf('-') !== -1) {
          let range = inputArray[i].split('-')
          range[0] = parseInt(range[0])
          range[1] = parseInt(range[1])
          if (isNaN(range[0]) | isNaN(range[1]) | range[0] >= range[1]) {
            BreakException.element = inputArray[i]
            throw BreakException
          }
          for (let x = 0; range[0] + x <= range[1]; x++) {
            gslEditor.scriptArray.push(range[0] + x)
          }
        } else {
          gslEditor.scriptArray.push(inputArray[i])
        }
      }
    } catch (e) {
      if (e === BreakException) {
        return vscode.window.showErrorMessage('Invalid script range: ' + BreakException.element)
      }
    }
    gslEditor.scriptNum = gslEditor.scriptArray[0]
    gslDownload2(gslEditor.scriptArray[0])
  })
}

function gslDownload2 (script) {
  gslEditor.getScript = 1
  gslEditor.scriptTxt = ''
  gslEditor.input = script
  let type = ''
  if (isNaN(gslEditor.input)) {
    type = 'verb'
  } else {
    type = 'script'
  }
  LogIntoGame().then(function () {
    if (gameClient.connected) {
      vscode.window.setStatusBarMessage('Downloading ' + type + ' ' + gslEditor.input + '...', 5000)
      downloadScript(' \nWelcome to \n \nAll Rights Reserved ') // Simulate initial login text
    }
  })
}

function downloadScript (receivedMsg) {
  if (gslEditor.getScript === 2) { // Downloading script now, may span multiple messages
    gslEditor.scriptTxt += receivedMsg.replace(/Edt:$/, '') // Remove ending Edt:
  }
  if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
    if (isNaN(gslEditor.input)) {
      vscode.window.setStatusBarMessage('Downloading verb ' + gslEditor.input + '...', 5000)
      sendMsg('/mv ' + gslEditor.input + '\n')
    } else {
      vscode.window.setStatusBarMessage('Downloading script ' + gslEditor.input + '...', 5000)
      sendMsg('/ms ' + gslEditor.input + '\n')
    }
    gslEditor.getScript = 1
    gslEditor.scriptTxt = ''
  } else if (/Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.test(receivedMsg)) {
    let match = /Error: Script #(.*) is a verb. Please use \/mv (.*) instead\./.exec(receivedMsg)
    sendMsg('/mv ' + match[2] + '\n')
  } else if (/Error: Script #\d\d\d\d\d has not been created yet/.test(receivedMsg)) {
    return vscode.window.showErrorMessage('Script #' + gslEditor.input + ' has not been created yet.')
  } else if (/Verb not found/.test(receivedMsg)) {
    return vscode.window.showErrorMessage('Verb name ' + gslEditor.input + ' has not been created yet.')
  } else if (/LineEditor/.test(receivedMsg)) {
    let match = /(?:New\s)?File:\s\.\.\/scripts\/(S\d\d\d\d\d)/.exec(receivedMsg)
    if (/New File/.test(receivedMsg)) {
      sendMsg('\n')
    } else {
      sendMsg('P\n')
    }
    gslEditor.scriptNum = match[1]
    gslEditor.getScript = 2
  } else if (/Edt:$/.test(receivedMsg)) {
    sendMsg('Q\n')
    return __awaiter(this, void 0, void 0, function * () {
      let fileName = path.join(getDownloadLocation(), gslEditor.scriptNum) + vscode.workspace.getConfiguration('gsl').get('fileExtension')
      if (fs.existsSync(fileName)) { // Check for existing file
        fs.unlinkSync(fileName) // Already exists, delete it
      }
      fs.writeFileSync(fileName, gslEditor.scriptTxt) // Create new file with script text
      vscode.workspace.openTextDocument(fileName).then(document => {
        vscode.window.showTextDocument(document, {preview: false})
      })
      vscode.window.setStatusBarMessage('Download successful.', 5000)
    })
  } else if (/(Script edit aborted|Modification aborted)/.test(receivedMsg)) {
    if (gslEditor.goToDefinition) {
      let doc = vscode.window.activeTextEditor.document
      for (let i = 0; i < doc.lineCount; i++) {
        let line = doc.lineAt(i)
        if (line.text.toLowerCase().startsWith(': ' + gslEditor.goToDefinition)) {
          vscode.commands.executeCommand('revealLine', {lineNumber: i, at: 'top'})
          break
        }
      }
      gslEditor.goToDefinition = ''
    }
    let scriptNum = gslEditor.scriptNum.replace(/\D+/g, '').replace(/^0+/, '')
    sendMsg('/ss ' + scriptNum + '\n')
  } else if (/Name:[\s\S]*\d{4}\r\n.*>$/.test(receivedMsg)) {
    let scriptNum = gslEditor.scriptNum.replace(/\D+/g, '').replace(/^0+/, '')
    let modifier = /Last modified by: ([\w-_.]+)/.exec(receivedMsg)[1]
    let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg)
    let data = modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3]
    gslEditor.extContext.globalState.update('s' + scriptNum, data)
    gslEditor.scriptArray.shift()
    if (gslEditor.scriptArray.length > 0) {
      gslDownload2(gslEditor.scriptArray[0])
    } else {
      gslEditor.getScript = 0
    }
  }
}

function getDownloadLocation () {
  let extPath = null
  let useWorkspaceFolder = vscode.workspace.getConfiguration('gsl').get('downloadToWorkspace')
  if (useWorkspaceFolder && vscode.workspace.workspaceFolders) {
    extPath = vscode.workspace.workspaceFolders[0].uri.fsPath
  } else {
    extPath = vscode.workspace.getConfiguration('gsl').get('downloadPath')
  }
  if (!extPath) {
    let rootPath = path.resolve(__dirname, '../gsl')
    if (!fs.existsSync(rootPath)) { // Directory doesn't exist
      fs.mkdirSync(rootPath) // Create directory
    }
    extPath = path.resolve(__dirname, '../gsl/scripts')
  }
  if (!fs.existsSync(extPath)) { // Directory doesn't exist
    fs.mkdirSync(extPath) // Create directory
  }
  return extPath
}

function gslDateCheck () {
  let editor = vscode.window.activeTextEditor
  if (!editor) {
    return vscode.window.showErrorMessage('You must have a script open before you can check its date.')
  }
  let doc = editor.document
  if (!doc) {
    return vscode.window.showErrorMessage('You must have a script open before you can check its date.')
  }
  let scriptNum = path.basename(doc.fileName).replace(/\D+/g, '').replace(/^0+/, '')
  if (!/^\d{1,5}$/.test(scriptNum)) {
    return vscode.window.showErrorMessage('Unable to parse script # from file name.')
  }
  gslEditor.scriptNum = scriptNum
  gslEditor.dateCheck = 1
  LogIntoGame().then(function () {
    if (gameClient.connected) {
      vscode.window.setStatusBarMessage('Checking last modified date of script ' + scriptNum + '...', 5000)
      dateCheck(' \nWelcome to \n \nAll Rights Reserved ') // Simulate initial login text
    }
  })
}

function dateCheck (receivedMsg) {
  if (/Welcome to.*\s\n.*\s\nAll Rights Reserved/.test(receivedMsg)) {
    sendMsg('/ss ' + gslEditor.scriptNum + '\n')
  } else if (/Last modified by: /.test(receivedMsg)) {
    let modifier = /Last modified by: ([\w-_.]+)/.exec(receivedMsg)[1]
    let date = /\nOn \w+ (\w+) (\d+) (.+) (\d+)/.exec(receivedMsg)
    let data = 'Last modified by ' + modifier + ' on ' + date[1] + ' ' + date[2] + ', ' + date[4] + ' at ' + date[3] + '.'
    vscode.window.setStatusBarMessage(data, 5000)
    gslEditor.dateCheck = 0
  }
}

function sendMsg (msg) {
  if (gslEditor.logging && (sgeClient.connected === false)) { // Don't log SGE connection data (account, password hash, etc)
    fs.appendFile(path.join(getDownloadLocation(), 'GSL-Editor.log'), 'Sent: ' + msg)
  }
  outGameChannel('Sent: ' + msg)
  if (sgeClient.connected) {
    sgeClient.write(msg)
  } else if (gameClient.connected) {
    gameClient.write(msg)
  }
}

function onConnSGEData (data) {
  let receivedMsg = data.toString()
  receivedMsg = receivedMsg.replace(/\n$/, '') // Remove ending newline
  let msgArray = receivedMsg.split('\t')
  outGameChannel(receivedMsg)
  gslEditor.lastMsg = receivedMsg
  gslEditor.msgCount++

  if (/^.{32}$/gu.test(receivedMsg) && (gslEditor.msgCount === 1)) {
    gslEditor.hashKey = receivedMsg
    let pw = vscode.workspace.getConfiguration('gsl').get('password')
    if (pw === '') {
      return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then input your password in the GSL section.')
    }
    gslEditor.pwHash = ''
    for (let i = 0; i < pw.length; i++) {
      gslEditor.pwHash += String.fromCharCode(((pw.charCodeAt(i) - 32) ^ gslEditor.hashKey.charCodeAt(i)) + 32)
    }
    let account = vscode.workspace.getConfiguration('gsl').get('account')
    if (account === '') {
      return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then input your account name in the GSL section.')
    }
    sendMsg('A\t' + account + '\t')
    sendMsg(Buffer.from(str2ab(gslEditor.pwHash)))
    sendMsg('\n')
  } else if (/^A\t\tNORECORD$/.test(receivedMsg)) {
    vscode.window.showErrorMessage('Invalid account name. Please recheck your credentials.')
  } else if (/^A\t\tPASSWORD$/.test(receivedMsg)) {
    vscode.window.showErrorMessage('Invalid password. Please recheck your credentials.')
  } else if (/^A\t.*\tKEY\t.*/.test(receivedMsg)) {
    sendMsg('M\n')
  } else if (/^M\t.*/.test(receivedMsg)) {
    let game = vscode.workspace.getConfiguration('gsl').get('game')
    if (game === '') {
      return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then select the game you want to log into under GSL section.')
    }
    gslEditor.gameCode = msgArray[msgArray.indexOf(game) - 1]
    sendMsg('N\t' + gslEditor.gameCode + '\n')
  } else if (/^N\t.*STORM$/.test(receivedMsg)) {
    sendMsg('F\t' + gslEditor.gameCode + '\n')
  } else if (/^F\t.*/.test(receivedMsg)) {
    sendMsg('G\t' + gslEditor.gameCode + '\n')
  } else if (/^G\t.*/.test(receivedMsg)) {
    sendMsg('P\t' + gslEditor.gameCode + '\n')
  } else if (/^P\t.*/.test(receivedMsg)) {
    sendMsg('C\n')
  } else if (/^C\t([0-9]+\t){4}.*/.test(receivedMsg)) {
    let lowerCaseMsgArray = msgArray.map(function (value) {
      return value.toLowerCase()
    })
    let character = vscode.workspace.getConfiguration('gsl').get('character')
    if (character === '') {
      return vscode.window.showErrorMessage('Please use File > Preferences > Settings, then input the character name you want to log into under GSL section.')
    }
    let pos = (lowerCaseMsgArray.indexOf(character.toLowerCase()) - 1)
    gslEditor.characterID = msgArray[pos]
    sendMsg('L\t' + gslEditor.characterID + '\tSTORM\n')
  } else if (/^L\tOK\t.*/.test(receivedMsg)) {
    for (let i = 0; i < msgArray.length; i++) {
      if (msgArray[i].includes('GAMEHOST=')) {
        gslEditor.gameHost = msgArray[i].substring(msgArray[i].indexOf('=') + 1)
      } else if (msgArray[i].includes('GAMEPORT=')) {
        gslEditor.gamePort = msgArray[i].substring(msgArray[i].indexOf('=') + 1)
      } else if (msgArray[i].includes('KEY=')) {
        gslEditor.gameKey = msgArray[i].substring(msgArray[i].indexOf('=') + 1)
      }
    }
    sgeClient.destroy()
    gameClient.connect(gslEditor.gamePort, gslEditor.gameHost, function () {
      gameClient.connected = true
      outGameChannel('Game connection established.')
      sendMsg(gslEditor.gameKey + '\n')
    })
    gameClient.setEncoding('ascii')
    gameClient.on('close', onConnGameClose)
    gameClient.on('disconnect', onConnGameClose)
    gameClient.on('data', onConnGameData)
    gameClient.on('error', onConnError)
    gameClient.setKeepAlive(true)
    gameClient.setNoDelay(true)
  }
}

function onConnGameData (data) {
  let receivedMsg = data.toString()
  if (gslEditor.logging) {
    fs.appendFile(path.join(getDownloadLocation(), 'GSL-Editor.log'), 'Received: ' + receivedMsg)
  }
  receivedMsg = receivedMsg.replace(/\n$/, '') // Remove ending newline
  outGameChannel(receivedMsg)
  gslEditor.lastMsg = receivedMsg
  gslEditor.msgCount++

  if (receivedMsg.includes('Edt:')) { // Editing a script
    setTimeout(function () { checkState(receivedMsg, gslEditor.msgCount) }, 5000)
  }

  if (/^<mode id="GAME"\/>$/.test(receivedMsg)) {
    setTimeout(function () { sendMsg('<c>\n') }, 300)
    setTimeout(function () { sendMsg('<c>\n') }, 600)
  } else if (gslEditor.getScript) {
    downloadScript(receivedMsg)
  } else if (gslEditor.sendScript) {
    uploadScript(receivedMsg)
  } else if (gslEditor.dateCheck) {
    dateCheck(receivedMsg)
  }
}

function checkState (msg, count) {
  if ((msg === gslEditor.lastMsg) && (count === gslEditor.msgCount)) { // Stuck on same last message after 5 seconds
    sendMsg('\n')
    setTimeout(function () { sendMsg('V\n') }, 200)
    setTimeout(function () { sendMsg('Y\n') }, 400)
    setTimeout(function () { sendMsg('Q\n') }, 600)
  }
}

function onConnSGEClose () {
  outGameChannel('SGE connection closed.')
  sgeClient.destroy()
  sgeClient.removeAllListeners()
  sgeClient.connected = false
}

function onConnGameClose () {
  outGameChannel('Game connection closed.')
  gameClient.destroy()
  gameClient.removeAllListeners()
  gameClient.connected = false
}

function onConnError (err) {
  if (sgeClient.connected) {
    outGameChannel('SGE connection error: ' + err.message)
    sgeClient.destroy()
    sgeClient.removeAllListeners()
    sgeClient.connected = false
  }
  if (gameClient.connected) {
    outGameChannel('Game connection error: ' + err.message)
    gameClient.destroy()
    gameClient.removeAllListeners()
    gameClient.connected = false
  }
  if ((err.code === 'ECONNABORTED') || (err.code === 'ECONNRESET')) {
    if (gslEditor.sendScript) {
      gslUpload2(gslEditor.scriptNum)
      return
    } else if (gslEditor.getScript) {
      gslDownload2(gslEditor.scriptNum)
      return
    } else if (gslEditor.dateCheck) {
      gslDateCheck()
      return
    }
  }
  showError(err)
}

function showError (err) {
  vscode.window.showErrorMessage('Error: ' + err.message)
  getGameChannel().show(true)
}
