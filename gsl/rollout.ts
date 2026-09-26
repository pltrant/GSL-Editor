import { BaseGameClient } from "./gameClients";
import { OutputProcessor, stripGamePrompt } from "./editorClient";

const uncertainClients = new WeakSet<BaseGameClient>();

export type RolloutItem = { kind: "script" | "verb"; id: string };

export function parseRolloutInput(input: string): RolloutItem[] {
    const items = new Map<string, RolloutItem>();
    function add(kind: RolloutItem["kind"], id: string) {
        items.set(`${kind} ${id}`, { kind, id });
        if (items.size > 1000)
            throw new Error("Enter at most 1,000 scripts/verbs per rollout.");
    }
    function scriptId(value: string): number {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id < 1 || id > 999999) {
            throw new Error(`Invalid script ID: ${value}`);
        }
        return id;
    }
    for (const token of input
        .trim()
        .split(/[\s,;]+/)
        .filter(Boolean)) {
        const script = token.match(/^s?(\d+)(?:\.gsl)?$/i);
        const range = token.match(/^s?(\d+)(?:\.gsl)?-s?(\d+)(?:\.gsl)?$/i);
        if (script) add("script", String(scriptId(script[1])));
        else if (range) {
            const low = scriptId(range[1]);
            const high = scriptId(range[2]);
            if (low > high || high - low >= 1000)
                throw new Error(`Invalid script range: ${token}`);
            for (let id = low; id <= high; id++) add("script", String(id));
        } else if (/^\/?[a-z][a-z0-9_-]*$/i.test(token)) {
            if (token.length > 7)
                throw new Error(
                    `Verb names must be at most 7 characters, including any leading slash: ${token}`,
                );
            add("verb", token.toLowerCase());
        } else throw new Error(`Invalid script or verb: ${token}`);
    }
    if (!items.size) throw new Error("Enter at least one script or verb.");
    return [...items.values()];
}

export function rolloutCommand(
    action: "deploy" | "rollin",
    item: RolloutItem,
): string {
    return `/${action} ${item.kind} ${item.id} confirm`;
}

/** Wait for the asynchronous DxR result, not the immediate command prompt.
 * Protocol: IFE coreDxR.c, ProcessDeployResponse and DoTheActual*Rollin.
 * No retries: a timeout/disconnect leaves the mutation's outcome unknown.
 */
export function executeRolloutCommand(
    client: BaseGameClient,
    action: "deploy" | "rollin",
    item: RolloutItem,
    scriptId: number | undefined,
    signal: AbortSignal,
    timeoutMillis = 20000,
): Promise<number> {
    const command = rolloutCommand(action, item);
    if (uncertainClients.has(client)) {
        const error = new Error(
            "Previous rollout outcome is unknown; reconnect before another rollout.",
        );
        error.name = "RolloutOutcomeUnknownError";
        return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
        let sent = false;
        let acknowledged = false;
        let resolvedId = item.kind === "script" ? Number(item.id) : scriptId;
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            client.off("text", onText);
            client.off("error", onError);
            client.off("quit", onQuit);
            signal.removeEventListener("abort", onAbort);
        };
        const fail = (message: string, uncertain = false) => {
            if (settled) return;
            settled = true;
            cleanup();
            const error = new Error(`${command}: ${message}`);
            if (uncertain && sent) uncertainClients.add(client);
            error.name =
                uncertain && sent
                    ? "RolloutOutcomeUnknownError"
                    : "RolloutCommandError";
            reject(error);
        };
        const complete = () => {
            if (settled || resolvedId === undefined) return;
            settled = true;
            cleanup();
            resolve(resolvedId);
        };
        const output = new OutputProcessor((raw) => {
            if (settled) return;
            const line = stripGamePrompt(raw).trim();
            const ack = line.match(
                /^Got the command \/(deploy|rollin) (script|verb) (\S+)\.$/i,
            );
            if (
                ack &&
                ack[1].toLowerCase() === action &&
                ack[2].toLowerCase() === item.kind
            ) {
                if (
                    action === "deploy" &&
                    item.kind === "verb" &&
                    /^\d+$/.test(ack[3])
                ) {
                    resolvedId = Number(ack[3]);
                    acknowledged = true;
                } else if (ack[3].toLowerCase() === item.id)
                    acknowledged = true;
                return;
            }
            // Deploy results are private to the initiating character. Rollin
            // completions are broadcast, so require acknowledgement and ID.
            const deploy = line.match(/^Deploy results: (-?\d+)\[/);
            if (action === "deploy" && deploy) {
                if (deploy[1] !== "0") fail(line);
                else if (acknowledged) complete();
                return;
            }
            const rollin = line.match(
                /^Roll in of script #(\d+) is completed\.$/,
            );
            if (
                action === "rollin" &&
                acknowledged &&
                rollin &&
                Number(rollin[1]) === resolvedId
            ) {
                complete();
                return;
            }
            if (
                /^(?:Deploy request failed|Rollin request failed|Rollin failed:|Failed to roll in|Could not roll in|The GSL verb .* wasn't found|Invalid .*number|Missing confirm|Usage:|Got the command .*could not find a deployed version)|^(?:Deploying |Rolling in |Script #|Verb ).*blocked/i.test(
                    line,
                )
            ) {
                fail(line);
            }
        });
        const onText = (text: string) => output.accumulate(text);
        const onError = (error: Error) =>
            fail(`Connection lost; outcome unknown. ${error.message}`, true);
        const onQuit = () =>
            fail(
                "Disconnected; outcome unknown. Check the terminal before retrying.",
                true,
            );
        const onAbort = () =>
            fail(
                `${signal.reason instanceof Error ? signal.reason.message : "Stopped."} Any command already sent may still complete.`,
                true,
            );
        const timer = setTimeout(
            () =>
                fail(
                    "No confirmed result; outcome unknown. Check the terminal before retrying.",
                    true,
                ),
            timeoutMillis,
        );
        client.on("text", onText);
        client.on("error", onError);
        client.on("quit", onQuit);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) return onAbort();
        try {
            sent = true;
            client.send(command, true);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error), true);
        }
    });
}
