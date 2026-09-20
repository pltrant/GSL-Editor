import {
    commands,
    ExtensionContext,
    ProgressLocation,
    TerminalLocation,
    window,
    workspace,
} from "vscode";
import { GSLExtension } from "../../extension";
import { GameInstance, LoginCredentials } from "../agentToolOrchestrator";
import { GSL_LANGUAGE_ID, GSLX_DISABLE_LOGIN } from "../const";
import {
    EditorClientInterface,
    InitOptions,
    withClientForInstance,
} from "../editorClient";
import { GameTerminal } from "../gameTerminal";
import { parseRolloutInput, rolloutCommand } from "../rollout";

const instances: GameInstance[] = [
    "dev",
    "prime",
    "platinum",
    "shattered",
    "test",
];

export function registerRolloutCommand(
    context: ExtensionContext,
    terminals: Map<GameInstance, GameTerminal>,
) {
    let active = false;
    context.subscriptions.push(
        commands.registerCommand("gsl.rollout", async () => {
            if (active)
                return void window.showInformationMessage(
                    "A rollout is already in progress.",
                );
            active = true;
            try {
                await runRollout(context, terminals);
            } catch (error) {
                void window.showErrorMessage(
                    `Rollout stopped: ${error instanceof Error ? error.message : String(error)}`,
                );
            } finally {
                active = false;
            }
        }),
    );
}

async function runRollout(
    context: ExtensionContext,
    terminals: Map<GameInstance, GameTerminal>,
) {
    if (workspace.getConfiguration(GSL_LANGUAGE_ID).get(GSLX_DISABLE_LOGIN))
        throw new Error("Game login is disabled.");
    const choices = instances.flatMap((instance) => {
        const login = GSLExtension.readLoginConfigForInstance(instance);
        return login
            ? [
                  {
                      label: instance,
                      description: `${login.instance} · ${login.character}`,
                      instance,
                      login,
                  },
              ]
            : [];
    });
    if (choices.length < 2)
        throw new Error(
            "Configure characters for an origin and at least one target with GSL: User Setup.",
        );
    const origin = await window.showQuickPick(choices, {
        title: "Deploy and Rollin: Origin server",
        placeHolder: "Choose the server to deploy from",
        ignoreFocusOut: true,
    });
    if (!origin) return;
    const targets = await window.showQuickPick(
        choices
            .filter(
                ({ login }) =>
                    login.instance.toLowerCase() !==
                    origin.login.instance.toLowerCase(),
            )
            .map((choice) => ({
                ...choice,
                picked:
                    origin.instance === "dev" &&
                    ["prime", "shattered", "platinum"].includes(
                        choice.instance,
                    ),
            })),
        {
            title: "Deploy and Rollin: Target servers",
            placeHolder: "Choose the server(s) to roll into",
            canPickMany: true,
            ignoreFocusOut: true,
        },
    );
    if (!targets?.length) return;
    if (
        new Set(targets.map(({ login }) => login.instance.toLowerCase()))
            .size !== targets.length
    )
        throw new Error(
            "Target settings refer to the same game instance more than once.",
        );
    const input = await window.showInputBox({
        title: "Deploy and Rollin: Scripts and verbs",
        prompt: "Enter script IDs, filenames, ranges, or verbs. Separate with commas, spaces, or semicolons.",
        placeHolder: "29, incant, s07890.gsl, 9800-9805",
        ignoreFocusOut: true,
        validateInput(value) {
            try {
                parseRolloutInput(value);
            } catch (error) {
                return (error as Error).message;
            }
            return undefined;
        },
    });
    if (input === undefined) return;
    const items = parseRolloutInput(input);
    const participants = [origin, ...targets];
    if (!participants.some(({ instance }) => instance === "dev")) {
        const dev = choices.find(({ instance }) => instance === "dev");
        if (!dev)
            throw new Error(
                "Configure a Dev character with GSL: User Setup for the final status check.",
            );
        participants.push(dev);
    }
    const logins = new Map<GameInstance, LoginCredentials>();
    for (const { instance } of participants) {
        const login = await GSLExtension.getLoginForInstance(instance, context);
        if (!login)
            throw new Error(
                `Missing credentials for ${instance}. Run GSL: User Setup.`,
            );
        logins.set(instance, login);
    }

    const abort = new AbortController();
    const panes = new Map<GameInstance, GameTerminal>();
    const subscriptions: { dispose(): void }[] = [];
    let started = false;
    let completed = 0;
    try {
        let originPane = terminals.get(origin.instance);
        if (originPane?.isClosed) originPane = undefined;
        for (const { instance } of participants) {
            const login = logins.get(instance)!;
            let pane = instance === origin.instance ? originPane : undefined;
            if (!pane) {
                // Recreate only the target view to join the split. The cached
                // connection is reused and its character remains logged in.
                terminals.get(instance)?.dispose();
                const newPane = new GameTerminal(
                    () => {
                        if (terminals.get(instance) === newPane)
                            terminals.delete(instance);
                    },
                    {
                        name: `GSL ${instance} · ${login.character}`,
                        location: originPane
                            ? { parentTerminal: originPane.terminal }
                            : TerminalLocation.Panel,
                    },
                );
                pane = newPane;
                terminals.set(instance, pane);
                context.subscriptions.push(pane);
            }
            originPane ??= pane;
            panes.set(instance, pane);
            pane.inputEnabled = false;
            pane.write(
                `[${instance} · ${login.character}: waiting for connection setup.]\r\n`,
            );
            subscriptions.push(pane.onDidClose(() => abort.abort()));
            pane.show(true);
        }
        originPane!.show();
        for (const pane of panes.values()) await pane.ready;
        const clients = new Map<GameInstance, EditorClientInterface>();
        function options(instance: GameInstance): InitOptions {
            return {
                login: logins.get(instance)!,
                downloadLocation: GSLExtension.getDownloadLocation(),
                loggingEnabled: false,
                console,
                onCreate: (client) => panes.get(instance)!.bindClient(client),
            };
        }
        function check() {
            if (abort.signal.aborted)
                throw abort.signal.reason instanceof Error
                    ? abort.signal.reason
                    : new Error(
                          "Cancelled or a rollout terminal was closed. Commands already sent may still complete.",
                      );
            if (
                workspace
                    .getConfiguration(GSL_LANGUAGE_ID)
                    .get(GSLX_DISABLE_LOGIN)
            )
                throw new Error("Game login is disabled.");
        }
        // Connect every participant before any deployment is sent.
        for (const { instance } of participants) {
            check();
            panes.get(instance)!.connecting();
            await withClientForInstance(
                instance,
                options(instance),
                (client) => {
                    check();
                    if (!client.matchesLogin(logins.get(instance)!))
                        throw new Error(
                            `${instance} is connected with different credentials. Reload the extension before rolling out.`,
                        );
                    clients.set(instance, client);
                    panes.get(instance)!.bindClient(client);
                    const disconnected = () =>
                        abort.abort(
                            new Error(
                                `${instance} disconnected. Inspect the terminals before retrying.`,
                            ),
                        );
                    client.on("quit", disconnected);
                    client.on("error", disconnected);
                    subscriptions.push({
                        dispose() {
                            client.off("quit", disconnected);
                            client.off("error", disconnected);
                        },
                    });
                },
            );
        }
        const total = items.length * (targets.length + 1);
        const summary = `${items.map(({ kind, id }) => `${kind} ${id}`).join(", ")}\r\n`;
        for (const [instance, pane] of panes) {
            pane.write(
                `\r\n[Rollout: ${origin.instance} → ${targets.map(({ instance }) => instance).join(", ")}]\r\n${summary}`,
            );
            if (
                instance === origin.instance ||
                targets.some((target) => target.instance === instance)
            )
                for (const item of items)
                    pane.write(
                        `[Queued] ${rolloutCommand(instance === origin.instance ? "deploy" : "rollin", item)}\r\n`,
                    );
        }
        for (const pane of panes.values())
            pane.write(
                "[All sessions connected. Waiting for Start rollout in the confirmation dialog.]\r\n",
            );
        const start = await window.showInformationMessage(
            `Rollin ${items.length} item(s) from ${origin.instance} to ${targets.map(({ instance }) => instance).join(", ")}?`,
            { modal: true },
            "Start rollout",
        );
        if (start !== "Start rollout") return;
        check();
        started = true;
        // Native terminals have no reliable visibility event. Reveal each one
        // before dispatch, and stop if the user leaves VS Code or closes a pane.
        subscriptions.push(
            window.onDidChangeWindowState(({ focused }) => {
                if (!focused)
                    abort.abort(
                        new Error(
                            "VS Code lost focus. Inspect the terminals before retrying.",
                        ),
                    );
            }),
        );
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: "GSL rollout",
                cancellable: true,
            },
            async (progress, token) => {
                const cancellation = token.onCancellationRequested(() =>
                    abort.abort(),
                );
                try {
                    const scriptIds = new Map<string, number>();
                    for (const { instance } of [origin, ...targets]) {
                        const action =
                            instance === origin.instance ? "deploy" : "rollin";
                        for (const item of items) {
                            check();
                            if (!window.state.focused)
                                throw new Error(
                                    "VS Code lost focus. Inspect the terminals before starting another rollout.",
                                );
                            const pane = panes.get(instance)!;
                            pane.show();
                            progress.report({
                                message: `${instance}: ${rolloutCommand(action, item)} (${completed}/${total})`,
                            });
                            const key = `${item.kind} ${item.id}`;
                            const id = await withClientForInstance(
                                instance,
                                options(instance),
                                async (client) => {
                                    check();
                                    if (client !== clients.get(instance))
                                        throw new Error(
                                            `${instance} reconnected. Inspect the terminal before retrying.`,
                                        );
                                    pane.show();
                                    return client.executeRollout(
                                        action,
                                        item,
                                        scriptIds.get(key),
                                        abort.signal,
                                    );
                                },
                            );
                            scriptIds.set(key, id);
                            completed++;
                            progress.report({ increment: 100 / total });
                        }
                    }
                    check();
                    const devPane = panes.get("dev")!;
                    devPane.show();
                    await withClientForInstance(
                        "dev",
                        options("dev"),
                        (client) => {
                            check();
                            if (client !== clients.get("dev"))
                                throw new Error(
                                    "Dev reconnected before the status check.",
                                );
                            client.send(
                                `/ss check ${[...new Set(scriptIds.values())].join(" ")}`,
                                true,
                            );
                        },
                    );
                } finally {
                    cancellation.dispose();
                }
            },
        );
        for (const pane of panes.values())
            pane.write("\r\n[Rollout complete.]\r\n");
        void window.showInformationMessage(
            `Rollout complete: ${completed} commands confirmed.`,
        );
    } catch (error) {
        for (const pane of panes.values())
            pane.write(
                `\r\n[Rollout stopped after ${completed} confirmed commands: ${error instanceof Error ? error.message : String(error)}]\r\n`,
            );
        throw error;
    } finally {
        for (const subscription of subscriptions) subscription.dispose();
        for (const pane of panes.values()) {
            pane.inputEnabled = true;
            if (!started) pane.write("\r\n[Rollout not started.]\r\n");
        }
    }
}
