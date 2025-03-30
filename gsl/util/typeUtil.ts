/**
 * Verifies that a type is `never` at compile time. This allows us to narrow
 * a type until it contains no known possibilities. Because we want to degrade
 * gracefully at runtime, we accept a `fallback` value to return if this
 * function is ever actually called. This should never happen if we have
 * written our code correctly, but bugs happen.
 *
 * @example
 * declare const animal: 'cat' | 'dog'
 *
 * switch (animal) {
 *     case 'cat':
 *         ...
 *         return
 *     case 'dog':
 *         ...
 *         return
 *     default:
 *         // The following `assertNever` call will alert us with a compiler
 *         // error if `animal` is ever broadened beyond 'cat' and 'dog'.
 *         assertNever(animal)
 * }
 */
export const assertNever = <T> (value: never, fallback: T): T => {
    console.error(`assertNever() called with ${value}`, value)
    return fallback
}

export const isNonVoid = <T> (value: T): value is Exclude<T, null | undefined> => {
    return value !== undefined && value !== null;
}