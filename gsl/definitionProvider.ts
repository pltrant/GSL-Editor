import { DefinitionProvider, Location, Position, Uri, workspace } from "vscode"

import * as path from "path"
import * as fs from "fs"

import { GSLExtension, vsc } from "../extension";

interface PromiseWrapper {
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
}

export class GSLDefinitionProvider implements DefinitionProvider {
  private enableAutomaticDownloads: boolean
  private inFlightScriptMap: Map<number, PromiseWrapper>

  constructor(enableAutomaticDownloads: boolean) {
    this.enableAutomaticDownloads = enableAutomaticDownloads
    this.inFlightScriptMap = new Map()
  }

  async provideDefinition (document: any, position: any, token: any) {
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
        // Attempt to find script file
        let script = ''
        if (txtArray.length === 2) { // call #
          script = txtArray[1]
        } else if (txtArray[3] === 'in') { // callmatch must_match "$*" in #
          script = txtArray[4]
        } else {
          return
        }
        const scriptNum = Number(script)
        if (isNaN(scriptNum)) return
        while (script.length < 5) {
          script = '0' + script
        }
        let scriptFile = path.join(
          GSLExtension.getDownloadLocation(),
          'S' + script
        ) + workspace.getConfiguration('gsl').get('fileExtension')
        if (!fs.existsSync(scriptFile)) {
          // Script file not found - attempt to download script
          if (!this.enableAutomaticDownloads) {
            console.warn('File not found and automatic downloads disabled')
            return
          }
          // Block on any in flight requests for the same definition
          const inFlight = this.inFlightScriptMap.get(scriptNum)
          if (inFlight) {
            try {
              await inFlight.promise
            }
            catch (e) {
              console.error(e)
              return
            }
          }
          else {
            try {
              // Download script
              this.inFlightScriptMap.set(
                scriptNum,
                makePromiseWrapper()
              )
              await vsc!.withEditorClient(client => {
                return GSLExtension.downloadScript(client, Number(script))
              })
            }
            catch (e: unknown) {
              console.error(e)
              this.inFlightScriptMap.get(scriptNum)?.reject(
                (e instanceof Error) ? e : new Error()
              )
            }
            finally {
              this.inFlightScriptMap.get(scriptNum)?.resolve()
              this.inFlightScriptMap.delete(scriptNum)
            }
          }
        }
        if (!fs.existsSync(scriptFile)) {
          // Something unknown went wrong
          console.error('Failed to find file')
          return
        }
        // Return location
        let idx = 0
        if (txtArray[4]) {
          let fileTxt = fs.readFileSync(scriptFile).toString().split(/\r?\n/)
          for (let i = 0; i < fileTxt.length; i++) {
            if (fileTxt[i].toLowerCase().startsWith(': ' + txtArray[2])) {
              idx = i
              break
            }
          }
        }
        return new Location(Uri.file(scriptFile), new Position(idx, 0))
      }
    }
  }
}

const makePromiseWrapper = (): PromiseWrapper => {
  let resolve: () => void
  let reject: (error: Error) => void
  const promise = new Promise<void>((resolveFn, rejectFn) =>
    [resolve, reject] = [resolveFn, rejectFn]
  )
  return {
    promise,
    resolve: resolve!,
    reject: reject!
  }
};