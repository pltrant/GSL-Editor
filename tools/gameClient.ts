import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { EAccessClient } from "../gsl/eaccessClient";
import { BaseGameClient } from "../gsl/gameClients";

interface Credentials {
    account: string;
    password: string;
    instance: string;
    character: string;
}

function loadCredentials(): Credentials {
    const credPath = path.join(__dirname, "credentials.json");
    if (!fs.existsSync(credPath)) {
        console.error(
            "Missing tools/credentials.json — copy credentials.example.json and fill in values.",
        );
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(credPath, "utf-8"));
}

async function main() {
    const credentials = loadCredentials();
    const { account, password, instance, character } = credentials;

    EAccessClient.console = console;

    console.log(`Logging in as ${account} to ${instance}...`);

    let sal;
    try {
        sal = await EAccessClient.quickLogin(
            account,
            password,
            instance,
            character,
            "storm",
        );
    } catch (e) {
        console.error("Login failed:", e);
        process.exit(1);
    }

    console.log(
        `Authenticated. Connecting to ${sal.gamehost}:${sal.gameport}...`,
    );

    const client = new BaseGameClient({
        debug: false,
        echo: true,
        console,
    });

    client.on("text", (text: string) => {
        process.stdout.write(text);
    });

    client.on("echo", (text: string) => {
        process.stdout.write(`> ${text}\n`);
    });

    client.on("error", (error: Error) => {
        console.error("Connection error:", error.message);
        process.exit(1);
    });

    client.on("quit", () => {
        console.log("\n[Disconnected]");
        rl.close();
        process.exit(0);
    });

    client.connect(sal);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "",
    });

    // Wait briefly for the server hello/login sequence before accepting input
    client.on("hello", () => {
        console.log("[Connected — type commands, Ctrl+C to quit]\n");
        rl.on("line", (line: string) => {
            client.send(line, false);
        });
    });

    rl.on("close", () => {
        try {
            client.quit();
        } catch {
            // Already disconnected.
        }
        process.exit(0);
    });
}

main();
