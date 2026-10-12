/** Patterns identifying a command's own GSL error traceback. */
export interface ScriptErrorPatterns {
    /** Matches the last line of a traceback. */
    end: RegExp;
    /**
     * Matches a traceback line identifying this command, so tracebacks from
     * other players' commands (e.g. screamers) are ignored.
     */
    owner: RegExp;
}

// Detects a GSL error traceback produced by the command being executed, so
// the command can fail with the traceback instead of waiting for a timeout.
export class CommandScriptErrorDetector {
    private lines: string[] = [];
    private readonly maxLines = 60;

    constructor(private readonly patterns: ScriptErrorPatterns) {}

    /** Records a line and returns the traceback lines once one completes. */
    record(line: string): string[] | undefined {
        this.lines.push(line);
        if (this.lines.length > this.maxLines) this.lines.shift();
        if (!this.patterns.end.test(line)) return undefined;
        const report = this.lines;
        this.lines = [];
        return report.some((reportLine) => this.patterns.owner.test(reportLine))
            ? report
            : undefined;
    }
}

/** Matches a traceback from this exact /agent command's script error. */
export function agentScriptErrorPatterns(
    fullCommand: string,
): ScriptErrorPatterns {
    // Tracebacks list the command words as S0[/agent] S1[...] ...; match
    // all of them so other characters' /agent errors are ignored.
    const keyVariables = fullCommand
        .trim()
        .split(/\s+/)
        .map((word, i) => `S${i}[${word}]`)
        .join(" ")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
        end: /^This call sequence was triggered by/,
        owner: new RegExp(`^\\s*${keyVariables}(?! S\\d)`, "i"),
    };
}

export function commandScriptError(
    command: string,
    report: string[],
    { seenStart }: { seenStart: boolean },
): Error {
    const error = new Error(
        `Command ${JSON.stringify(command.slice(0, 512))} failed with a script error:\n${report.join("\n")}`,
    );
    // After the start marker the server answered, so keep the connection
    // (CommandScriptError is non-resettable). Before it, the traceback may
    // be another character's identical command while this command's output
    // is still coming, so reset rather than leak it into the next command.
    error.name = seenStart ? "CommandScriptError" : "UnconfirmedScriptError";
    return error;
}
