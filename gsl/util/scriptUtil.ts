import * as path from "path";
import { TextDocument } from "vscode";

export const inferredScriptNumRegex = /^.*(?<script>s[0-9]{5}\.gsl)$/i;

export const scriptNumberFromFileName = (fileName: string): string => {
    const scriptMatch = inferredScriptNumRegex.exec(path.basename(fileName));
    let script = scriptMatch?.groups ? scriptMatch?.groups['script'] : "";

    return script.replace(/\D+/g, "").replace(/^0+/, "");
};

export const getScriptNumber = (document: TextDocument): number | undefined => {
    const scriptNum = Number(scriptNumberFromFileName(document.fileName));
    if (!scriptNum || Number.isNaN(scriptNum)) return;
    return scriptNum;
};
