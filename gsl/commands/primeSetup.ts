import { ExtensionContext, window } from "vscode";

import { EAccessClient } from "../eaccessClient";
import {
    GSLX_DEV_ACCOUNT,
    GSLX_DEV_INSTANCE,
    GSLX_DEV_PASSWORD,
    GSLX_PRIME_CHARACTER,
    GSLX_PRIME_INSTANCE,
} from "../const";

export interface PrimeSetupCommandDependencies {
    context: ExtensionContext;
}

export async function runPrimeSetupCommand(
    deps: PrimeSetupCommandDependencies,
): Promise<void> {
    const account = deps.context.globalState.get<string>(GSLX_DEV_ACCOUNT);
    const password = await deps.context.secrets.get(GSLX_DEV_PASSWORD);

    if (!account || !password) {
        return void window.showErrorMessage(
            "Please run User Setup first to store your account credentials.",
        );
    }

    /* login */
    const gameChoice = await EAccessClient.login(account, password).catch(
        (e: Error) => {
            window.showErrorMessage(e.message);
        },
    );
    if (!gameChoice) {
        return;
    }

    /* map dev instance code to prime game code */
    const DEV_TO_PRIME: Record<string, string> = { GS4D: "GS3", DRD: "DR" };
    const devInstance = deps.context.globalState.get<string>(GSLX_DEV_INSTANCE);
    const primeGameCode = devInstance ? DEV_TO_PRIME[devInstance] : undefined;

    if (!primeGameCode) {
        gameChoice.cancel();
        return void window.showErrorMessage(
            `Could not determine prime game from dev instance "${devInstance}". Please run User Setup first.`,
        );
    }

    /* auto-select the prime game */
    const characterChoice = await gameChoice
        .select(primeGameCode)
        .catch((e: Error) => {
            window.showErrorMessage(e.message);
        });
    if (!characterChoice) {
        gameChoice.cancel();
        return;
    }

    /* pick a character */
    const characterPickOptions = {
        ignoreFocusOut: true,
        placeholder: "Select a character ...",
    };
    const character = await window.showQuickPick(
        characterChoice.toNameList(),
        characterPickOptions,
    );
    if (!character) {
        characterChoice.cancel();
        return void window.showErrorMessage(
            "No character selected; aborting prime setup.",
        );
    }
    const result = await characterChoice
        .select(characterChoice.pick(character))
        .catch((e: Error) => {
            window.showErrorMessage(e.message);
        });
    if (!result) {
        characterChoice.cancel();
        return;
    }

    const { loginDetails } = result;
    await Promise.all([
        deps.context.globalState.update(GSLX_PRIME_INSTANCE, loginDetails.game),
        deps.context.globalState.update(
            GSLX_PRIME_CHARACTER,
            loginDetails.character,
        ),
    ]);
    window.showInformationMessage("Prime server credentials stored");
}
