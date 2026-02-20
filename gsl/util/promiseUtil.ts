export interface PromiseWrapper<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

export const makePromiseWrapper = <T>(): PromiseWrapper<T> => {
    let resolve: (value: T) => void;
    let reject: (error: Error) => void;
    const promise = new Promise<T>(
        (resolveFn, rejectFn) => ([resolve, reject] = [resolveFn, rejectFn]),
    );
    return {
        promise,
        resolve: resolve!,
        reject: reject!,
    };
};
