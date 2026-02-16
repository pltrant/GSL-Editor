import { QuickPickItem, QuickPickItemKind, window } from "vscode";
import { makePromiseWrapper } from "../util/promiseUtil";

/**
 * Similar to `vscode.window.showQuickPick`, but accepts `QuickPickItem`
 * items. Also adds some type safety by strictly typing `id: T`.
 *
 * @returns a promise that resolves with the chosen item, or `undefined`
 * if the dialog is escaped prior to a choice being made.
 */
export const showQuickPick = <T extends string | number>({
    items,
    title,
}: {
    items: ((QuickPickItem & { id: T }) | QuickPickItemKind.Separator)[];
    title?: string;
}): Promise<T | undefined> => {
    const { promise, resolve, reject } = makePromiseWrapper<T | undefined>();

    try {
        const quickPick = window.createQuickPick();

        quickPick.items = items.map((item) =>
            item === QuickPickItemKind.Separator
                ? {
                      label: "",
                      kind: QuickPickItemKind.Separator,
                  }
                : item,
        );
        quickPick.title = title;
        quickPick.activeItems = []; // no initial selection

        let isResolved = false;
        quickPick.onDidChangeSelection((items) => {
            isResolved = true;
            resolve((items[0] as any).id);
            quickPick.dispose();
        });
        quickPick.onDidHide(() => {
            if (!isResolved) resolve(undefined);
        });

        quickPick.show();
    } catch (e) {
        reject(e as Error);
    }

    return promise;
};
