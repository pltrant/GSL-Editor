import * as fs from "fs";
import * as os from "os";
import { GameInstance, LoginCredentials } from "../agentToolOrchestrator";

interface LoginConfigFile {
    account?: string;
    devInstance?: string;
    devCharacter?: string;
    devCharacters?: string[];
    primeInstance?: string;
    primeCharacter?: string;
    primeCharacters?: string[];
    shatteredInstance?: string;
    shatteredCharacter?: string;
    shatteredCharacters?: string[];
    platinumInstance?: string;
    platinumCharacter?: string;
    platinumCharacters?: string[];
    testInstance?: string;
    testCharacter?: string;
    testCharacters?: string[];
    author?: string;
    downloadPath?: string;
}

const INSTANCE_FILE_KEYS: Record<
    GameInstance,
    { instance: keyof LoginConfigFile; character: keyof LoginConfigFile }
> = {
    dev: { instance: "devInstance", character: "devCharacter" },
    prime: { instance: "primeInstance", character: "primeCharacter" },
    shattered: {
        instance: "shatteredInstance",
        character: "shatteredCharacter",
    },
    platinum: {
        instance: "platinumInstance",
        character: "platinumCharacter",
    },
    test: { instance: "testInstance", character: "testCharacter" },
};

export function loadLoginConfig(env: NodeJS.ProcessEnv = process.env): {
    credentials: Map<GameInstance, LoginCredentials[]>;
    author: string | undefined;
    downloadPath: string;
    configError: string | undefined;
} {
    const loginConfigPath = env.GSL_LOGIN_CONFIG_FILE;
    if (!loginConfigPath) {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                "GSL_LOGIN_CONFIG_FILE environment variable is not set. " +
                "Point it at your loginConfig.json (typically ~/.gsl/loginConfig.json). " +
                "Run 'GSL: User Setup' in VS Code to create one, or see the extension README.",
        };
    }

    let file: LoginConfigFile = {};
    if (fs.existsSync(loginConfigPath)) {
        try {
            file = JSON.parse(fs.readFileSync(loginConfigPath, "utf8"));
        } catch (e) {
            return {
                credentials: new Map(),
                author: undefined,
                downloadPath: os.tmpdir(),
                configError:
                    `Failed to parse login config file at ${loginConfigPath}: ` +
                    `${e instanceof Error ? e.message : e}`,
            };
        }
    } else {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                `Login config file not found at ${loginConfigPath}. ` +
                "Run 'GSL: User Setup' in VS Code to create one, or see the extension README.",
        };
    }

    const account = file.account;
    const password = env.GSL_PASSWORD;

    if (!password) {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                "GSL_PASSWORD environment variable is not set. " +
                "The MCP server requires GSL_PASSWORD to authenticate with the game server.",
        };
    }

    if (!account) {
        return {
            credentials: new Map(),
            author: undefined,
            downloadPath: os.tmpdir(),
            configError:
                'No account configured. Add "account" to your login config file.',
        };
    }

    const author = file.author;
    const downloadPath =
        env.GSL_DOWNLOAD_PATH ?? file.downloadPath ?? os.tmpdir();

    const credentials = new Map<GameInstance, LoginCredentials[]>();

    for (const [key, cfg] of Object.entries(INSTANCE_FILE_KEYS)) {
        const instance = file[cfg.instance] as string | undefined;
        const charactersKey = `${key}Characters` as keyof LoginConfigFile;
        const configured = file[charactersKey] ?? file[cfg.character];
        // Legacy configs include empty fields for instances that are not used.
        if (file[charactersKey] == null && (!instance || !configured)) continue;
        const characters = Array.isArray(configured)
            ? configured
            : [configured];
        if (
            !instance ||
            typeof instance !== "string" ||
            characters.length === 0 ||
            characters.some(
                (character) =>
                    typeof character !== "string" || !character.trim(),
            )
        ) {
            return {
                credentials: new Map(),
                author,
                downloadPath,
                configError: `Invalid ${key} worker configuration. Set ${key}Instance and a non-empty ${key}Characters array of character names.`,
            };
        }
        const unique = new Map<string, string>();
        for (const character of characters as string[]) {
            unique.set(character.trim().toLowerCase(), character.trim());
        }
        credentials.set(
            key as GameInstance,
            [...unique.values()].map((character) => ({
                account,
                password,
                instance,
                character,
            })),
        );
    }

    return { credentials, author, downloadPath, configError: undefined };
}
