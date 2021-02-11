import { DefinitionProvider, Location, Position, Uri, workspace } from "vscode"

import * as path from "path"
import * as fs from "fs"

import { GSLExtension } from "../extension";

export class GSLDefinitionProvider implements DefinitionProvider {

  provideDefinition (document: any, position: any, token: any) {
    let txt = document.lineAt(position.line).text.trim().toLowerCase()
    if (txt.includes('call')) {
      let txtArray = txt.split(' ')
      if (txtArray[4] === '$thisscript') {
        for (let i = 0; i < document.lineCount; i++) {
          let line = document.lineAt(i)
          if (line.text.toLowerCase().startsWith(': ' + txtArray[2])) {
            return new Location(document.uri, new Position(i, 0))
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
        if (isNaN(Number(scriptNum))) { // Not a number
          return
        }
        while (scriptNum.length < 5) {
          scriptNum = '0' + scriptNum
        }
        let scriptFile = path.join(GSLExtension.getDownloadLocation(), 'S' + scriptNum)
                       + workspace.getConfiguration('gsl').get('fileExtension')
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
          return new Location(Uri.file(scriptFile), new Position(idx, 0))
        } else {
          // gslEditor.goToDefinition = txtArray[2]
          // gslDownload2(scriptNum)
          GSLExtension.downloadScript(Number(scriptNum), txtArray[2])
        }
      }
    }
  }
}
