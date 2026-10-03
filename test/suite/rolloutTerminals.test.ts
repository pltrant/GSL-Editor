import * as assert from "assert";
import {
    EventEmitter,
    commands,
    ExtensionTerminalOptions,
    Terminal,
    TerminalLocation,
    window,
} from "vscode";
import { GameInstance } from "../../gsl/agentToolOrchestrator";
import { createRolloutTerminals } from "../../gsl/commands/rolloutTerminals";
import { BaseGameClient } from "../../gsl/gameClients";
import { GameTerminal } from "../../gsl/gameTerminal";

suite("Rollout terminal groups", () => {
    const createTerminal = window.createTerminal;
    const onDidCloseTerminal = window.onDidCloseTerminal;
    let closed: EventEmitter<Terminal>;
    let views: {
        terminal: Terminal;
        options: ExtensionTerminalOptions;
        disposed: boolean;
        opened: boolean;
    }[];
    let terminals: Map<GameInstance, GameTerminal>;

    setup(() => {
        closed = new EventEmitter<Terminal>();
        views = [];
        terminals = new Map();
        Object.defineProperty(window, "onDidCloseTerminal", {
            value: closed.event,
        });
        window.createTerminal = ((options: ExtensionTerminalOptions) => {
            const { location } = options;
            if (typeof location === "object" && "parentTerminal" in location) {
                const parent = views.find(
                    ({ terminal }) => terminal === location.parentTerminal,
                );
                assert.ok(parent && !parent.disposed);
                // Reproduce hosts that cannot resolve an initialized parent's
                // changed ID. A fresh group must use the pending parent.
                assert.strictEqual(parent.opened, false);
            }
            const view = {
                terminal: undefined as unknown as Terminal,
                options,
                disposed: false,
                opened: false,
            };
            view.terminal = {
                // VS Code delivers its close notification asynchronously.
                dispose: () => {
                    view.disposed = true;
                },
            } as Terminal;
            views.push(view);
            return view.terminal;
        }) as typeof window.createTerminal;
    });

    teardown(() => {
        for (const pane of terminals.values()) pane.dispose();
        window.createTerminal = createTerminal;
        Object.defineProperty(window, "onDidCloseTerminal", {
            value: onDidCloseTerminal,
        });
        closed.dispose();
    });

    test("repeated runs replace old groups and keep game sessions alive", async () => {
        const client = new BaseGameClient({});
        for (const instances of [
            ["dev", "prime", "platinum"],
            ["dev", "prime"],
            ["prime", "dev", "platinum"],
        ] as GameInstance[][]) {
            const oldPanes = new Map(terminals);
            const panes = createRolloutTerminals(
                terminals,
                instances.map((instance) => ({ instance, character: "GM" })),
            );
            const origin = panes.get(instances[0])!;
            for (const [instance, pane] of panes) {
                assert.notStrictEqual(pane, oldPanes.get(instance));
                assert.strictEqual(pane.inputEnabled, false);
                const view = views.find(
                    ({ terminal }) => terminal === pane.terminal,
                )!;
                assert.deepStrictEqual(
                    view.options.location,
                    pane === origin
                        ? TerminalLocation.Panel
                        : { parentTerminal: origin.terminal },
                );
                view.opened = true;
                view.options.pty.open(undefined);
                await pane.ready;
                // A delayed close from a replaced view cannot remove its replacement.
                const old = oldPanes.get(instance);
                if (old) {
                    assert.strictEqual(old.isClosed, true);
                    assert.strictEqual(old.isConnected, false);
                    closed.fire(old.terminal);
                    assert.strictEqual(terminals.get(instance), pane);
                }
            }
            panes.get("dev")!.bindClient(client);
            assert.strictEqual(client.listenerCount("text"), 1);
        }
        client.destroy();
    });

    test("disposing before open settles readiness and closes only once", async () => {
        let closeCount = 0;
        const pane = new GameTerminal(() => closeCount++);
        pane.dispose();
        await pane.ready;
        assert.strictEqual(pane.isClosed, true);
        assert.strictEqual(closeCount, 1);
        views[0].options.pty.open(undefined);
        views[0].options.pty.close();
        closed.fire(pane.terminal);
        pane.dispose();
        assert.strictEqual(closeCount, 1);
    });

    test("terminal close without a pty callback removes the cached view", async () => {
        const panes = createRolloutTerminals(terminals, [
            { instance: "dev", character: "GM" },
        ]);
        const pane = panes.get("dev")!;
        const client = new BaseGameClient({});
        pane.bindClient(client);
        closed.fire(pane.terminal);
        await pane.ready;
        assert.strictEqual(pane.isClosed, true);
        assert.strictEqual(terminals.has("dev"), false);
        assert.strictEqual(client.listenerCount("text"), 0);
        client.destroy();
    });
});

suite("Rollout terminal layout in VS Code", () => {
    test("rebuilds a navigable split group after repeated runs and unsplitting", async function () {
        this.timeout(20000);
        const terminals = new Map<GameInstance, GameTerminal>();
        async function waitForActive(terminal: Terminal) {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (window.activeTerminal === terminal) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.strictEqual(window.activeTerminal, terminal);
        }
        try {
            // Begin with an already initialized standalone Dev terminal.
            const old = new GameTerminal(() => {});
            terminals.set("dev", old);
            old.show();
            await old.ready;
            for (let run = 0; run < 3; run++) {
                const panes = createRolloutTerminals(terminals, [
                    { instance: "dev", character: "Layout test" },
                    { instance: "prime", character: "Layout test" },
                ]);
                for (const pane of panes.values()) {
                    pane.show(true);
                    await pane.ready;
                }
                const origin = panes.get("dev")!;
                const target = panes.get("prime")!;
                origin.show();
                await waitForActive(origin.terminal);
                await commands.executeCommand(
                    "workbench.action.terminal.focusNextPane",
                );
                await waitForActive(target.terminal);
                await commands.executeCommand(
                    "workbench.action.terminal.unsplit",
                );
            }
        } finally {
            for (const pane of terminals.values()) pane.dispose();
        }
    });
});
