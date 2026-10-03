import { TerminalLocation } from "vscode";
import { GameInstance } from "../agentToolOrchestrator";
import { GameTerminal } from "../gameTerminal";

export function createRolloutTerminals(
    terminals: Map<GameInstance, GameTerminal>,
    participants: { instance: GameInstance; character: string }[],
): Map<GameInstance, GameTerminal> {
    const panes = new Map<GameInstance, GameTerminal>();
    // Replace the views, retaining the separately cached game connections.
    // An old origin may have been closed, moved, or split from its group.
    for (const { instance } of participants) terminals.get(instance)?.dispose();
    try {
        let origin: GameTerminal | undefined;
        for (const { instance, character } of participants) {
            // Create the whole group synchronously. VS Code can lose the split
            // parent reference once an existing terminal's ID has changed.
            const pane = new GameTerminal(
                () => {
                    if (terminals.get(instance) === pane)
                        terminals.delete(instance);
                },
                {
                    name: `GSL ${instance} · ${character}`,
                    location: origin
                        ? { parentTerminal: origin.terminal }
                        : TerminalLocation.Panel,
                },
            );
            origin ??= pane;
            pane.inputEnabled = false;
            panes.set(instance, pane);
            terminals.set(instance, pane);
        }
        return panes;
    } catch (error) {
        for (const pane of panes.values()) pane.dispose();
        throw error;
    }
}
