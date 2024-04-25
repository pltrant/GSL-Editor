
import { parse } from 'csv-parse/sync';

import { Disposable, StatusBarItem, ThemeColor, commands, window } from "vscode"
import { GSL_LANGUAGE_ID } from '../const'
import { getScriptNumber } from '../util/scriptUtil'
import { GSLExtension, VSCodeIntegration } from '../../extension'

const POLLING_FREQUENCY = 1_800_000 // 30 minutes
const WARNING_CLICKED_COMMAND = "internal.frozen_script.warning_clicked"

interface ResourceEntry {
    type: string
    id: number
    status: 'FROZEN'
    gm: string
    access: number
}

type ResourceEntryMap = {
    [type: string]: {
        [id: number]: ResourceEntry
    }
}

/**
 * Manages the status bar item that informs the user whether the current
 * active script is frozen according to `/FREEZE`. Uses periodic polling.
 */
export class FrozenScriptWarningManager {
    private pendingDataRefresh: NodeJS.Timeout | undefined
    private latestData: ResourceEntryMap | undefined

    constructor(
        private statusBarItem: StatusBarItem,
        private withEditorClient: VSCodeIntegration["withEditorClient"],
    ) {
        this.statusBarItem.hide()
        this.statusBarItem.text = "Frozen"
        this.statusBarItem.command = WARNING_CLICKED_COMMAND
    }

    activate(): Disposable {
        commands.registerCommand(
            WARNING_CLICKED_COMMAND,
            this.refreshData.bind(this)
        )

        // Begin polling
        this.pendingDataRefresh = setTimeout(this.refreshData.bind(this), 0)

        // Render when active editor changes
        const onChangeListener = window.onDidChangeActiveTextEditor(
            this.render.bind(this)
        )

        // Handle disposal
        return {
            dispose: () => {
                onChangeListener.dispose()
                clearTimeout(this.pendingDataRefresh)
            }
        }
    }

    private render(): void {
        this.statusBarItem.hide()

        const document = window.activeTextEditor?.document
        if (document?.languageId !== GSL_LANGUAGE_ID) return

        const scriptNum = getScriptNumber(document)
        if (!scriptNum) {
            console.error("Failed to find script number")
            return
        }

        const data = this.latestData?.['script']?.[scriptNum]
        if (!data) return

        if (data.status === 'FROZEN') {
            let freezer = data.gm
            if (freezer === GSLExtension.getAccountName()) {
                freezer = 'you'
                this.statusBarItem.backgroundColor = undefined
                this.statusBarItem.color = undefined
            }
            else {
                this.statusBarItem.backgroundColor = new ThemeColor(
                    'statusBarItem.warningBackground'
                )
                this.statusBarItem.color = new ThemeColor(
                    'statusBarItem.warningForeground'
                )
            }
            this.statusBarItem.tooltip = `This script was marked with /FREEZE by ${freezer}. Click to refresh.`
            this.statusBarItem.show()
        }
    }


    private async refreshData(): Promise<void> {
        clearTimeout(this.pendingDataRefresh)

        const document = window.activeTextEditor?.document
        if (document?.languageId !== GSL_LANGUAGE_ID) {
            this.pendingDataRefresh = setTimeout(
                this.refreshData.bind(this),
                POLLING_FREQUENCY / 8
            )
            return
        }

        await this.withEditorClient(async (client) => {
            try {
                const lines = await client.executeCommand(
                    "/freeze list csv",
                    {
                        captureStart: /CSV dump of frozen resources/,
                        captureEnd: /\d+ frozen resource\(s\)\./,
                        timeoutMillis: 15_000,
                    }
                )
                this.latestData = this.readCsvTable(lines)
                this.render()
                this.pendingDataRefresh = setTimeout(
                    this.refreshData.bind(this),
                    POLLING_FREQUENCY
                )
            }
            catch (e) {
                console.error(e)
            }
        })
    }

    private readCsvTable(lines: string[]): ResourceEntryMap {
        // Example Data:
        // type,id,status,gm,access
        // script,17323,FROZEN,"W_GS4-AKAYDAR",4
        // verb,age,FROZEN,"W_GS4-FAZLI",4
        // verb_script,13693,FROZEN,"W_GS4-FAZLI",4    <----- appended for verbs
        // segment,501,FROZEN,"W_GS4-KYNLEE",4
        const entries: ResourceEntry[] = parse(lines.join("\n"), {
            columns: true,
            skip_empty_lines: true
        })
        const result: ResourceEntryMap = {}

        for (let i = 0; i < entries.length; i++) {
            // Convert verbs to scripts
            let entry = entries[i]
            if (entry.type === 'verb') {
                const verb_script_entry = entries[i + 1]
                entry = {
                    ...entry,
                    type: 'script',
                    id: verb_script_entry.id
                }
                i++
            }
            if (!entry.id) {
                // Skip data integrity issues, e.g.
                // verb,curtsey,FROZEN,"W_GS4-XXX",5
                // verb_script,0,FROZEN,"W_GS4-XXXX",5
                continue
            }

            // Add to result
            result[entry.type] = result[entry.type] || {}
            result[entry.type][entry.id] = entry
        }

        return result
    }
}