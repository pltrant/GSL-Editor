export function throwOnControlCharacters(value: string): void {
    if (/[\x00-\x1f\x7f]/.test(value)) {
        throw new Error("Input contains invalid control characters.");
    }
}
