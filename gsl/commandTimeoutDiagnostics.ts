// Retains only command-response text; never attach this to login traffic.
export class CommandTimeoutDiagnostics {
    private lines: string[] = [];
    private truncated = false;
    private readonly maxCharacters = 4096;
    private readonly maxLines = 20;

    constructor(private secrets: string[]) {
        this.secrets = secrets
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);
    }

    private redact(text: string, partial = false): string {
        for (const secret of this.secrets) {
            // A timeout can interrupt a secret midway through an unfinished line.
            if (partial) {
                for (
                    let length = Math.min(secret.length, text.length);
                    length > 0;
                    length--
                ) {
                    if (text.endsWith(secret.slice(0, length))) {
                        text = text.slice(0, -length) + "[REDACTED]";
                        break;
                    }
                }
            }
            text = text.split(secret).join("[REDACTED]");
        }
        return text;
    }

    record(line: string): void {
        this.lines.push(this.redact(line));
        this.trim();
    }

    private trim(): void {
        while (this.lines.length > this.maxLines) {
            this.lines.shift();
            this.truncated = true;
        }
        while (this.lines.join("\n").length > this.maxCharacters) {
            const excess = this.lines.join("\n").length - this.maxCharacters;
            if (this.lines[0].length <= excess) {
                this.lines.shift();
            } else {
                this.lines[0] = this.lines[0].slice(excess);
            }
            this.truncated = true;
        }
    }

    timeoutError({
        command,
        worker,
        seenStart,
        pending,
    }: {
        command: string;
        worker: string;
        seenStart: boolean;
        pending: string;
    }): Error {
        if (pending) {
            this.lines.push(this.redact(pending, true));
            this.trim();
        }
        // JSON escaping keeps control characters and server output inert in logs.
        const details = JSON.stringify({
            worker: this.redact(worker).slice(0, 128),
            seenStart,
            pendingLine: pending.length > 0,
            truncated: this.truncated,
            responseTail: this.lines.join("\n"),
        });
        return new Error(
            `Command timed out: ${JSON.stringify(this.redact(command).slice(0, 512))}\nDiagnostics: ${details}`,
        );
    }
}
