import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

import { ExtensionContext, QuickPickItemKind, StatusBarItem, TextDocument, ThemeColor, ThemeIcon, Uri, ViewColumn, commands, window, workspace } from "vscode"
import { GSLX_DEV_PASSWORD, GSL_LANGUAGE_ID } from '../const'
import { assertNever } from '../util/typeUtil'
import { showQuickPick } from '../dialog/QuickPick'
import { EditorClientInterface } from '../editorClient'
import { scriptNumberFromFileName } from '../util/scriptUtil'
import { GSLExtension, VSCodeIntegration } from '../../extension'

type OutOfDateButtonState =
    { state: 'loading' }
    | { state: 'out_of_date', lastModifier: string, lastModifiedDate: Date }
    | { state: 'hidden' }
    | { state: 'ignored', scriptNum: number }

enum OutOfDateChoice {
    SHOW_COMPARISON = 'SHOW_COMPARISON',
    OVERWRITE_LOCAL_COPY = 'OVERWRITE_LOCAL_COPY',
    STOP_MONITORING = 'STOP_MONITORING'
}

const DELAY_MAP = {
    "No Delay": 0,
    "5 Minutes": 60*5,
    "10 Minutes": 60*10,
    "60 Minutes": 60*60,
    "1 Day": 60*60*24
}

interface LastCheck {
    /** Epoch seconds of last check */
    time: number;
    /** Button state of last check */
    state: OutOfDateButtonState
}

/**
 * Tracks the last time a local script was checked against the remote
 * version. This is used in the case where the user has set a polling
 * delay.
 * @see DELAY_MAP
 */
const LAST_CHECK_MAP = new Map<string, LastCheck>()

/**
 * When a user navigates to a new file, checks to see if that file is
 * up-to-date. Displays a button in the status bar indicating the status.
 * Clicking on the button allows for learning more and taking action.
 */
export class OutOfDateButtonManager {
    private OUT_OF_DATE_BUTTON_CLICKED_CMD = 'internal.outOfDateManager.outOfDateClicked'
    private IGNORED_SCRIPT_BUTTON_CLICKED_CMD = 'internal.outOfDateManager.ignoredClicked'
    private DIFF_FILE_LOCAL = 'local.gsl'
    private DIFF_FILE_SERVER = 'server.gsl'
    private iteration = 0
    private isMonitoringActive = true

    constructor(
        private button: StatusBarItem,
        private withEditorClient: VSCodeIntegration["withEditorClient"],
        private showDownloadedScript: VSCodeIntegration["showDownloadedScript"],
        private context: ExtensionContext
    ) {}

    activate() {
        commands.registerCommand(
            this.OUT_OF_DATE_BUTTON_CLICKED_CMD,
            this.onClickOutOfDateButton,
            this
        )
        commands.registerCommand(
            this.IGNORED_SCRIPT_BUTTON_CLICKED_CMD,
            this.onClickIgnoredScriptButton,
            this
        )

        setTimeout(this.runCheck.bind(this), 0)
        return window.onDidChangeActiveTextEditor(this.runCheck.bind(this))
    }

    public renderButton(state: OutOfDateButtonState): void {
        if (state.state !== 'hidden') this.button.show()
        this.button.backgroundColor = undefined
        this.button.color = undefined
        this.button.command = undefined
        this.button.tooltip = undefined

        switch (state.state) {
            case ('loading'): {
                this.button.text = "Loading..."
                return
            }
            case ('ignored'): {
                this.button.text = "Not Monitoring Script"
                this.button.command = this.IGNORED_SCRIPT_BUTTON_CLICKED_CMD
                this.button.tooltip = 'Click to resume monitoring'
                return
            }
            case ('hidden'): {
                this.button.hide()
                return
            }
            case ('out_of_date'): {
                this.button.text = "$(alert) Script Out of Date"
                this.button.command = this.OUT_OF_DATE_BUTTON_CLICKED_CMD
                this.button.backgroundColor = new ThemeColor('statusBarItem.warningBackground')
                this.button.color = new ThemeColor('statusBarItem.warningForeground')
                return
            }
            default:
                assertNever(state, undefined)
        }
    }

    public stopMonitoring(): void {
        this.isMonitoringActive = false
    }

    public resumeMonitoring(): void {
        this.isMonitoringActive = true
    }

    private async runCheck() {
        const document = window.activeTextEditor?.document
        if (
            !this.isMonitoringActive
            || !document
            || document.languageId !== GSL_LANGUAGE_ID
        ) {
            return
        }
        // Check for cached state
        const cachedState = this.getCachedState(document)
        if (cachedState) {
            this.renderButton(cachedState)
            return
        }
        // Compare with remote
        const localIteration = ++this.iteration
        await this.withEditorClient(async client => {
            if (this.isExecutionStale(document, localIteration)) return

            const shouldHideButton = await this.shouldHideButton(document)
            if (this.isExecutionStale(document, localIteration)) return
            const scriptNum = this.getScriptNumber(document)

            if (shouldHideButton || !scriptNum) {
                return void this.renderButton({ state: 'hidden' })
            }

            this.renderButton({ state: 'loading' })
            const state = await this.calculateState(client, document, scriptNum)
            if (this.isExecutionStale(document, localIteration)) return

            this.renderButton(state)
            LAST_CHECK_MAP.set(
                document.uri.toString(),
                { time: nowInEpochSeconds(), state }
            )
        })
    }

    /**
     * If the user has configured a polling delay and the document was last
     * checked within that delay range, this function will return a cached
     * state to be rendered.
     */
    private getCachedState(
        document: TextDocument
    ): OutOfDateButtonState | undefined {
        const lastCheck = LAST_CHECK_MAP.get(document.uri.toString())
        if (!lastCheck) return
        const secondsSinceLastCheck = nowInEpochSeconds() - lastCheck.time
        const pollingDelay = DELAY_MAP[
            workspace.getConfiguration(GSL_LANGUAGE_ID).get(
                'scriptPollingDelay'
            ) as keyof typeof DELAY_MAP
        ] || 0
        if (secondsSinceLastCheck < pollingDelay) {
            return lastCheck.state
        }
    }

    private async shouldHideButton(document: TextDocument): Promise<boolean> {
        // Verify not viewing a diff with this same tool
        const { uri } = document
        if (
            uri.path.endsWith(this.DIFF_FILE_LOCAL) ||
            uri.path.endsWith(this.DIFF_FILE_SERVER)
        ) {
            return true
        }
        // Verify game access is possible
        const password = await this.context.secrets.get(GSLX_DEV_PASSWORD)
        return !password
    }

    private isExecutionStale(
        document: TextDocument,
        iteration: number
    ): boolean {
        return window.activeTextEditor?.document.uri !== document.uri
            || iteration !== this.iteration
    }

    /**
     * @returns the correct button state for the given `document`. If the
     * script is older than the server script, AND the scripts content does
     * not match, then the button should alert the user that the document
     * is out of date.
     *
     * We compare the content of the scripts because it is possible that the
     * user has updated the script via git rather than through the vscode
     * command, and we do not want to bother the user in that case.
     */
    private async calculateState(
        client: EditorClientInterface,
        document: TextDocument,
        scriptNum: number
    ): Promise<OutOfDateButtonState> {
        // Compare time stamps
        const lastSeenMod = GSLExtension.findLastSeenScriptModification(scriptNum)
        const scriptProperties = await client.modifyScript(scriptNum)
        // Check if script timestamp has changed since we last downloaded it
        if (
            lastSeenMod &&
            lastSeenMod.lastModifiedDate.toISOString()
                === scriptProperties.lastModifiedDate.toISOString()
        ) {
            return { state: 'hidden' }
        }
        // Check if we are ignoring this script version
        if (this.isIgnoringScript(scriptNum, scriptProperties.lastModifiedDate)) {
            return { state: 'ignored', scriptNum }
        }
        // Script timestamp has changed since we downloaded it and we are not
        // ignoring this script version. Let's compare the contents.
        await client.modifyScript(scriptNum, true)
        const newScript = await client.captureScript() // closes modifyScript
        if (
            this.normalizeScriptContents(document.getText())
            === this.normalizeScriptContents(newScript)
        ) {
            // Update last seen script modification so that we don't continue
            // to check this script. This is both a performance optimization
            // and solves for the case where the user edits the file - in that
            // case the contents will differ and we don't want to tell the user
            // that the script is "out of date".
            GSLExtension.recordScriptModification(
                scriptNum,
                scriptProperties.modifier,
                scriptProperties.lastModifiedDate
            )
            return { state: 'hidden' }
        }
        return {
            state: 'out_of_date',
            lastModifiedDate: scriptProperties.lastModifiedDate,
            lastModifier: scriptProperties.modifier
        }
    }

    private isIgnoringScript(scriptNum: number, serverLastModifiedDate: Date): boolean {
        return this.context.globalState.get<{lastModifiedDate: string}>(
            this.getIgnoreKey(scriptNum)
        )?.lastModifiedDate === serverLastModifiedDate.toISOString()
    }

    private ignoreScript(scriptNum: number, serverLastModifiedDate: Date): void {
        this.context.globalState.update(
            this.getIgnoreKey(scriptNum),
            {lastModifiedDate: serverLastModifiedDate.toISOString()}
        )
    }

    private stopIgnoringScript(scriptNum: number): void {
        this.context.globalState.update(
            this.getIgnoreKey(scriptNum),
            undefined
        )
    }

    private getIgnoreKey(scriptNum: number): string {
        return `OutOfDateButtonManager.ignore.${scriptNum}`
    }

    private normalizeScriptContents(contents: string): string {
        return contents.replaceAll(/\r?\n/g, '\n').trim()
    }

    async onClickIgnoredScriptButton(): Promise<void> {
        const document = window.activeTextEditor?.document
        if (!document) return
        const scriptNum = this.getScriptNumber(document)
        if (!scriptNum) throw new Error('Failed to get script number')
        this.stopIgnoringScript(scriptNum)
        this.renderButton({ 'state': 'loading' })
        setTimeout(() => this.runCheck(), 0)
    }

    async onClickOutOfDateButton(): Promise<void> {
        const localIteration = this.iteration
        const document = window.activeTextEditor?.document
        if (!document) return

        await this.withEditorClient(async client => {
            if (this.isExecutionStale(document, localIteration)) return
            const scriptNum = this.getScriptNumber(document)
            if (!scriptNum) throw new Error('Failed to get script number')
            const {
                SHOW_COMPARISON,
                OVERWRITE_LOCAL_COPY,
                STOP_MONITORING
            } = OutOfDateChoice

            // Ask user for action
            const userChoice = await showQuickPick({
                title: `Script ${scriptNum} Differs`,
                items: [
                    {
                        id: SHOW_COMPARISON,
                        label: "Show Comparison",
                        iconPath: new ThemeIcon('diff'),
                        description: "Compare local script with server script.",
                    },
                    QuickPickItemKind.Separator,
                    {
                        id: OVERWRITE_LOCAL_COPY,
                        label: "Overwrite Local Copy",
                        iconPath: new ThemeIcon('cloud-download'),
                        description: `Download s${scriptNum} from server.`
                    },
                    QuickPickItemKind.Separator,
                    {
                        id: STOP_MONITORING,
                        label: "Stop Monitoring",
                        iconPath: new ThemeIcon('sync-ignored'),
                        description: "Stop monitoring script until next version.",
                    },
                ]
            })
            if (
                this.isExecutionStale(document, localIteration)
                || !userChoice
            ) {
                return
            }

            // Take action
            switch (userChoice) {
                case SHOW_COMPARISON: {
                    this.button.hide()
                    return this.showDiff(client, scriptNum, document)
                }
                case OVERWRITE_LOCAL_COPY: {
                    this.button.hide()
                    const result = await GSLExtension.downloadScript(
                        client,
                        scriptNum,
                    )
                    if (!result) {
                        window.showErrorMessage('Failed to download script')
                        return
                    }
                    if (document.uri.fsPath !== result.scriptPath) {
                        window.showWarningMessage(
                            'Script downloaded, but download directory is different' +
                            ' than original file directory. The old file will remain' +
                            ' and the warning button will not appear again for the ' +
                            ' old file until a new server version is seen.' +
                            ` "${document.uri.fsPath}" vs "${result.scriptPath}"`
                        )
                    }
                    return void this.showDownloadedScript(result)
                }
                case STOP_MONITORING: {
                    this.renderButton({ state: 'ignored', scriptNum })
                    return this.stopCheckingScript(client, scriptNum)
                }
                default: {
                    console.error('Unexpected user choice', userChoice)
                    assertNever(userChoice, undefined)
                }
            }
        })
    }

    private getScriptNumber(document: TextDocument): number | undefined {
        const scriptNum = Number(scriptNumberFromFileName(document.fileName))
        if (!scriptNum || Number.isNaN(scriptNum)) return
        return scriptNum
    }

    /**
     * Display a diff to the user of the local vs remote script.
     */
    private async showDiff(
        client: EditorClientInterface,
        scriptNum: number,
        document: TextDocument
    ): Promise<void> {
        await client.modifyScript(scriptNum, true)
        const newScript = await client.captureScript() // closes modifyScript
        try {
            // Create a temporary directory
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-'));
            const oldFilePath = path.join(tempDir, this.DIFF_FILE_LOCAL);
            const newFilePath = path.join(tempDir, this.DIFF_FILE_SERVER);
            // Write content to temporary files
            fs.writeFileSync(
                oldFilePath,
                this.normalizeScriptContents(document.getText())
            );
            fs.writeFileSync(
                newFilePath,
                this.normalizeScriptContents(newScript)
            );
            // Open diff view
            await window.showTextDocument(
                Uri.file(oldFilePath),
                {viewColumn: ViewColumn.Beside}
            )
            await commands.executeCommand(
                'vscode.diff',
                Uri.file(oldFilePath),
                Uri.file(newFilePath),
                `Comparing s${scriptNum}: `
                    + `${this.DIFF_FILE_LOCAL} ↔ ${this.DIFF_FILE_SERVER}`
            );
        } catch (error) {
            window.showErrorMessage('Error comparing GSL files: ' + error);
        }
    }

    private async stopCheckingScript(
        client: EditorClientInterface,
        scriptNum: number
    ): Promise<void> {
        const lastModifiedDate = await GSLExtension.checkModifiedDate(
            client,
            scriptNum
        ) || GSLExtension.findLastSeenScriptModification(scriptNum)?.lastModifiedDate
        if (!lastModifiedDate) {
            console.error('Failed to find script properties', scriptNum)
            return
        }
        this.ignoreScript(scriptNum, lastModifiedDate)
    }
}

const nowInEpochSeconds = (): number => Math.floor(Date.now() / 1000)