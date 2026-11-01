import {
    Disposable,
    StatusBarItem,
    ThemeColor,
    commands,
    window,
} from "vscode";
import { GSL_LANGUAGE_ID } from "../const";
import { ResourceEntryMap, fetchFrozenResources } from "../frozenResources";
import { getScriptNumber } from "../util/scriptUtil";
import { GSLExtension, VSCodeIntegration } from "../../extension";

const POLLING_FREQUENCY = 1_800_000; // 30 minutes
const WARNING_CLICKED_COMMAND = "internal.frozen_script.warning_clicked";

/**
 * Manages the status bar item that informs the user whether the current
 * active script is frozen according to `/FREEZE`. Uses periodic polling.
 */
export class FrozenScriptWarningManager {
    private pendingDataRefresh: NodeJS.Timeout | undefined;
    private latestData: ResourceEntryMap | undefined;

    constructor(
        private statusBarItem: StatusBarItem,
        private withEditorClient: VSCodeIntegration["withEditorClient"],
    ) {
        this.statusBarItem.hide();
        this.statusBarItem.text = "Frozen";
        this.statusBarItem.command = WARNING_CLICKED_COMMAND;
    }

    activate(): Disposable {
        commands.registerCommand(
            WARNING_CLICKED_COMMAND,
            this.refreshData.bind(this),
        );

        // Begin polling
        this.pendingDataRefresh = setTimeout(this.refreshData.bind(this), 0);

        // Render when active editor changes
        const onChangeListener = window.onDidChangeActiveTextEditor(
            this.render.bind(this),
        );

        // Handle disposal
        return {
            dispose: () => {
                onChangeListener.dispose();
                clearTimeout(this.pendingDataRefresh);
            },
        };
    }

    private render(): void {
        this.statusBarItem.hide();

        const document = window.activeTextEditor?.document;
        if (document?.languageId !== GSL_LANGUAGE_ID) return;

        const scriptNum = getScriptNumber(document);
        if (!scriptNum) {
            console.error("Failed to find script number");
            return;
        }

        const data = this.latestData?.["script"]?.[scriptNum];
        if (!data) return;

        if (data.status === "FROZEN") {
            let freezer = data.gm;
            // Note that we don't need to use GSLExtension.matchesRemoteAccount
            // here because `/FREEZE LIST` does not truncate account names.
            if (freezer === GSLExtension.getAccountName()) {
                freezer = "you";
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.color = undefined;
            } else {
                this.statusBarItem.backgroundColor = new ThemeColor(
                    "statusBarItem.warningBackground",
                );
                this.statusBarItem.color = new ThemeColor(
                    "statusBarItem.warningForeground",
                );
            }
            this.statusBarItem.tooltip = `This script was marked with /FREEZE by ${freezer}. Click to refresh.`;
            this.statusBarItem.show();
        }
    }

    private async refreshData(): Promise<void> {
        clearTimeout(this.pendingDataRefresh);

        const document = window.activeTextEditor?.document;
        if (document?.languageId !== GSL_LANGUAGE_ID) {
            this.pendingDataRefresh = setTimeout(
                this.refreshData.bind(this),
                POLLING_FREQUENCY / 8,
            );
            return;
        }

        await this.withEditorClient(async (client) => {
            try {
                this.latestData = await fetchFrozenResources(client);
                this.render();
            } catch (e) {
                console.error(e);
            }
        }).catch((e) => console.error(e));

        this.pendingDataRefresh = setTimeout(
            this.refreshData.bind(this),
            POLLING_FREQUENCY,
        );
    }
}
