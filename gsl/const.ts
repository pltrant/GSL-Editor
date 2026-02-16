import { ScriptProperties } from "./editorClient";

export interface LastSeenScriptModification {
    modifier: string;
    lastModifiedDate: Date;
}

export interface DownloadScriptResult {
    scriptNumber: number;
    /** Local file system path of downloaded script */
    scriptPath: string;
    /** Up-to-date script properties */
    scriptProperties: ScriptProperties;
    /** Status for "/ss checkedit"; undefined if feature is disabled */
    syncStatus: string | undefined;
}

export const GSL_LANGUAGE_ID = "gsl";
export const GSLX_DEV_ACCOUNT = "developmentAccount";
export const GSLX_DEV_INSTANCE = "developmentInstance";
export const GSLX_DEV_CHARACTER = "developmentCharacter";
export const GSLX_DEV_PASSWORD = "developmentPassword";
export const GSLX_NEW_INSTALL_FLAG = "gslExtNewInstallFlag";
export const GSLX_SAVED_VERSION = "savedVersion";
export const GSLX_DISABLE_LOGIN = "disableLoginAttempts";
export const GSLX_AUTOMATIC_DOWNLOADS = "automaticallyDownloadScripts";
export const GSLX_ENABLE_SCRIPT_SYNC_CHECKS = "enableScriptSyncChecks";
export const GSLX_PRIME_INSTANCE = "primeInstance";
export const GSLX_PRIME_CHARACTER = "primeCharacter";
