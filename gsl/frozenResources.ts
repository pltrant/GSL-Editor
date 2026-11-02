import { parse } from "csv-parse/sync";

import { EditorClientInterface } from "./editorClient";

interface ResourceEntry {
    type: string;
    id: string;
    /** FROZEN or LOCKED; deploys are blocked by either */
    status: string;
    gm: string;
    access: number;
}

export type ResourceEntryMap = {
    [type: string]: {
        [id: string]: ResourceEntry;
    };
};

/** Reads the `/FREEZE` list, with verbs converted to their scripts. */
export async function fetchFrozenResources(
    client: EditorClientInterface,
): Promise<ResourceEntryMap> {
    const lines = await client.executeCommand("/freeze list csv", {
        captureStart: /CSV dump of frozen resources/,
        captureEnd: /\d+ frozen resource\(s\)\./,
        timeoutMillis: 15_000,
    });
    // Example Data:
    // type,id,status,gm,access
    // script,17323,FROZEN,"W_GS4-XXX",4
    // verb,age,FROZEN,"W_GS4-XXX",4
    // verb_script,13693,FROZEN,"W_GS4-XXX",4    <----- appended for verbs
    // segment,501,FROZEN,"W_GS4-XXX",4
    const entries: ResourceEntry[] = parse(lines.join("\n"), {
        columns: true,
        skip_empty_lines: true,
    });
    const result: ResourceEntryMap = {};

    for (let i = 0; i < entries.length; i++) {
        // Convert verbs to scripts
        let entry = entries[i];
        if (entry.type === "verb") {
            const verb_script_entry = entries[i + 1];
            if (verb_script_entry?.type !== "verb_script") continue;
            entry = {
                ...entry,
                type: "script",
                id: verb_script_entry.id,
            };
            i++;
        }
        if (!Number(entry.id)) {
            // Skip data integrity issues, e.g.
            // verb,curtsey,FROZEN,"W_GS4-XXX",5
            // verb_script,0,FROZEN,"W_GS4-XXXX",5
            continue;
        }

        // Add to result
        result[entry.type] = result[entry.type] || {};
        result[entry.type][entry.id] = entry;
    }

    return result;
}
