import tsParser from "@typescript-eslint/parser";

export default [
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            semi: "warn",
        },
    },
    {
        ignores: ["node_modules/", "out/", "**/*.js", "**/*.js.map"],
    },
];
