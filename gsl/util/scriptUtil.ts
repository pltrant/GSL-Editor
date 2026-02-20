import * as path from "path";
import { TextDocument } from "vscode";

export const scriptNumberFromFileName = (fileName: string): string => {
    return path.basename(fileName).replace(/\D+/g, "").replace(/^0+/, "");
};

export const getScriptNumber = (document: TextDocument): number | undefined => {
    const scriptNum = Number(scriptNumberFromFileName(document.fileName));
    if (!scriptNum || Number.isNaN(scriptNum)) return;
    return scriptNum;
};
