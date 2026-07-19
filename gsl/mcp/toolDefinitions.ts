/**
 * Single source of truth for all GSL tool definitions.
 *
 * Both the MCP server (external consumers) and the VS Code extension
 * (via contributes.mcpServers) consume these definitions. Adding or
 * modifying a tool here automatically exposes it in both contexts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolInputSchema {
    type: "object";
    required?: string[];
    properties: Record<string, unknown>;
}

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
    /** VS Code languageModelTools metadata */
    vscode: {
        displayName: string;
        toolReferenceName: string;
        userDescription: string;
        icon?: string;
    };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        name: "gsl_download_script",
        description:
            "Downloads a GSL script from the specified server instance and saves it to a " +
            "local file. Returns the file path. Use this when the user wants to read, " +
            "review, or inspect a version of a script on any server instance.",
        vscode: {
            displayName: "Download GSL Script",
            toolReferenceName: "gsl-download-script",
            userDescription:
                "Downloads a GSL script from a game server instance.",
            icon: "$(cloud-download)",
        },
        inputSchema: {
            type: "object",
            required: ["scriptNumber"],
            properties: {
                scriptNumber: {
                    type: "integer",
                    minimum: 1,
                    maximum: 999999,
                    description: "GSL script number to fetch.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to fetch from. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_diff_script_across_instances",
        description:
            "Downloads a GSL script from two server instances and returns a unified diff " +
            "showing exactly what lines differ between them. Use this when the user wants " +
            "to compare, diff, or check differences between two versions of a script " +
            "across server instances. " +
            "The diff reads as: baseInstance (---) compared against compareInstance (+++).",
        vscode: {
            displayName: "Diff GSL Script Across Instances",
            toolReferenceName: "gsl-diff-script",
            userDescription:
                "Compares a GSL script between two server instances.",
            icon: "$(diff)",
        },
        inputSchema: {
            type: "object",
            required: ["scriptNumber"],
            properties: {
                scriptNumber: {
                    type: "integer",
                    minimum: 1,
                    maximum: 999999,
                    description: "GSL script number to diff.",
                },
                baseInstance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "prime",
                    description:
                        "Reference instance (--- side of diff). Defaults to 'prime'.",
                },
                compareInstance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Instance to compare against base (+++ side of diff). Defaults to 'dev'.",
                },
                context: {
                    type: "integer",
                    minimum: 0,
                    maximum: 100,
                    default: 3,
                    description:
                        "Number of unchanged context lines around each change. Defaults to 3.",
                },
                ignoreWhitespace: {
                    type: "boolean",
                    default: false,
                    description:
                        "If true, ignore leading/trailing whitespace when comparing lines.",
                },
            },
        },
    },
    {
        name: "gsl_compile_check",
        description:
            "Use this tool whenever the task is to check, compile, or validate GSL script " +
            "compiler errors/warnings. It compiles a local GSL script file on the development server " +
            "and returns compiler output, including line-level errors and warnings, so the " +
            "model can diagnose and fix compilation problems. The file is uploaded to the " +
            "game-specific compilation slot (script 24661 in GemStone or 16224 in " +
            "DragonRealms). Use this tool when writing scripts or verifying GSL syntax.",
        vscode: {
            displayName: "Compile Check GSL Script",
            toolReferenceName: "gsl-compile-check",
            userDescription:
                "Compiles a GSL script and returns errors/warnings.",
            icon: "$(check-all)",
        },
        inputSchema: {
            type: "object",
            required: ["filename"],
            properties: {
                filename: {
                    type: "string",
                    description:
                        "Path to the .gsl file to compile. Prefer an absolute path " +
                        "(e.g. '/home/user/scripts/S02017.gsl'). A relative path " +
                        "like 'S02017.gsl' is resolved against the configured download directory.",
                },
            },
        },
    },
    {
        name: "gsl_get_current_author",
        description:
            "Returns the current GSL author value, per the configuration file. Use " +
            "this when generating changelog entries or script metadata that needs " +
            "the canonical author identity. Format: <AbbreviatedRealName>/<CharacterName>.",
        vscode: {
            displayName: "Get Current GSL Author",
            toolReferenceName: "gsl-get-current-author",
            userDescription:
                "Returns the current GSL author from the login config file.",
            icon: "$(account)",
        },
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "gsl_get_room_data",
        description:
            "Loads the segment for a given room ID, sends the /sr command to the game " +
            "server, and returns the full room data output, including room name, varfields " +
            "aka properties, flags, and directions. This does NOT show objects currently " +
            "in the room, except those explicitly linked in the room description texts. " +
            "Existence IDs referenced in room text (e.g. $+$-516105D) are PID'd " +
            "(permanent) and therefore negative — always preserve the negative sign when " +
            "using them with other tools such as `gsl_get_existence_data`. Can target any " +
            "server instance. Defaults to Dev.",
        vscode: {
            displayName: "Get Room Data",
            toolReferenceName: "gsl-get-room-data",
            userDescription: "Retrieves room data from the game server.",
            icon: "$(map)",
        },
        inputSchema: {
            type: "object",
            required: ["roomId"],
            properties: {
                roomId: {
                    type: "integer",
                    minimum: 1,
                    description: "The room ID to look up.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to query. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_get_existence_data",
        description:
            "Sends the /se (show existence) command to the game server for a given existence " +
            "ID and returns the full existence data output, including the item name, varfields " +
            "aka properties, flags, and location. Negative IDs are permanent IDs (PID'd) — " +
            "these are stable references that persist across unload/reload cycles. Positive " +
            "IDs are temporary and may change. Can target any server instance. Defaults to Dev.",
        vscode: {
            displayName: "Get Existence Data",
            toolReferenceName: "gsl-get-existence-data",
            userDescription:
                "Retrieves existence (item/object) data from the game server.",
            icon: "$(package)",
        },
        inputSchema: {
            type: "object",
            required: ["existenceId"],
            properties: {
                existenceId: {
                    type: "integer",
                    description:
                        "The existence ID to look up. Negative IDs are permanent (PID'd) and stable across reloads.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to query. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_get_player_varfields",
        description:
            "Sends the /svf command to the game server for a given player name and returns " +
            "varfield and flags output. Use this when the user wants to inspect a " +
            "character's current state — skills, stats, properties, and flag bits.",
        vscode: {
            displayName: "Get Player Varfields",
            toolReferenceName: "gsl-get-player-varfields",
            userDescription:
                "Retrieves player varfields and flags from the game server.",
            icon: "$(person)",
        },
        inputSchema: {
            type: "object",
            required: ["playerName"],
            properties: {
                playerName: {
                    type: "string",
                    description: "The player name to look up.",
                },
                verbosity: {
                    type: "string",
                    enum: ["Full", "NoTables", "SkipDefaults"],
                    default: "NoTables",
                    description:
                        "Controls output verbosity. 'NoTables' (default) omits table varfields. " +
                        "'SkipDefaults' omits fields at default values. 'Full' returns everything.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to query. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_slash_agent_command",
        description:
            "Sends a `/agent <subcommand> [args...]` command to the game server and returns " +
            "the full output. The /agent verb is a programmable dispatcher on the game server " +
            "that supports various subcommands for querying game data. Run with no arguments " +
            "to list available subcommands. Run with just a subcommand name (no args) to see " +
            "its usage. Can target any server instance. Defaults to Dev. See S24792.gsl for " +
            "implementation.",
        vscode: {
            displayName: "Run /agent Command",
            toolReferenceName: "gsl-agent-command",
            userDescription: "Runs a /agent subcommand on the game server.",
            icon: "$(terminal)",
        },
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description:
                        "The subcommand and its arguments, without the /agent prefix " +
                        "(e.g. 'vftable PlayerName tableName 0 5'). " +
                        "Omit to list all available subcommands.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to query. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_get_script_ss_metadata",
        description:
            "Sends the /ss (show script) command for a given script ID and returns the raw " +
            "script metadata output. This is the best way to identify when a script was last " +
            "updated, by whom, and whether scripts are in sync across servers — compare the " +
            "output for the same script ID across different instances (e.g. prime versus dev). " +
            "Warning: script owner property is typically not maintained and is weak signal — " +
            "better to look at who has touched the script recently by viewing the script's " +
            "changelog, found in the script file itself.",
        vscode: {
            displayName: "Get Script Metadata",
            toolReferenceName: "gsl-get-script-metadata",
            userDescription:
                "Retrieves script metadata (/ss) from the game server.",
            icon: "$(info)",
        },
        inputSchema: {
            type: "object",
            required: ["scriptId"],
            properties: {
                scriptId: {
                    type: "integer",
                    minimum: 1,
                    maximum: 999999,
                    description: "The script ID to look up.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which game instance to query script data for. Maps to game codes: " +
                        "dev=GS4D, prime=GS4, shattered=GSF, platinum=GS4X, test=GST. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_get_verb_data",
        description:
            "Sends the /sv (show verb) command for a given verb name and returns the raw " +
            "verb metadata output, including the script number that handles the verb, access " +
            "level, parse code, verb flags, and modification history. Can target any server " +
            "instance. Defaults to Dev. Warning: the 'Owned by' field is typically not " +
            "maintained and is a weak signal — to identify who actually works on a verb's " +
            "script, look at the 'Last modified by' field or the script's changelog found " +
            "in the script file itself.",
        vscode: {
            displayName: "Get Verb Data",
            toolReferenceName: "gsl-get-verb-data",
            userDescription: "Retrieves verb metadata from the game server.",
            icon: "$(symbol-event)",
        },
        inputSchema: {
            type: "object",
            required: ["verb"],
            properties: {
                verb: {
                    type: "string",
                    description:
                        "The verb name to look up (e.g. 'sit', '/mongen', 'quest', 'incant').",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to query. Defaults to 'dev'.",
                },
            },
        },
    },
    {
        name: "gsl_get_table_metadata",
        description:
            "Sends the /sl (show table) command for a given table ID and returns the table " +
            "metadata, including the table description, creator, access level, dimensions " +
            "(X/Y/Z), total size, and table type flags. Does not work on varfield tables " +
            "(e.g. on players/exists). Can target any server instance. Defaults to Dev.",
        vscode: {
            displayName: "Get Table Metadata",
            toolReferenceName: "gsl-get-table-metadata",
            userDescription:
                "Retrieves global table metadata from the game server.",
            icon: "$(table)",
        },
        inputSchema: {
            type: "object",
            required: ["tableId"],
            properties: {
                tableId: {
                    type: "integer",
                    minimum: 1,
                    maximum: 999999,
                    description: "The global table ID to look up.",
                },
                instance: {
                    type: "string",
                    enum: ["dev", "prime", "shattered", "platinum", "test"],
                    default: "dev",
                    description:
                        "Which server instance to query. Defaults to 'dev'.",
                },
            },
        },
    },
];
