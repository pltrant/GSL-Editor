import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
    try {
        // Parse command line arguments to separate file and test filters
        const args = process.argv.slice(2);
        const fileFilters = [];
        const testFilters = [];

        // Process args to separate file and test filters
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "--file-match" && i + 1 < args.length) {
                fileFilters.push(args[++i]);
            } else if (args[i] === "--test-match" && i + 1 < args.length) {
                testFilters.push(args[++i]);
            } else if (!args[i].startsWith("--")) {
                // Default to file filter if no flag is specified
                fileFilters.push(args[i]);
            }
        }

        const extensionDevelopmentPath = path.resolve(__dirname, "..");
        const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");

        // Set environment variables for test filters
        if (fileFilters.length > 0) {
            process.env.FILE_FILTERS = JSON.stringify(fileFilters);
            console.log(`File filters: ${fileFilters.join(", ")}`);
        }

        if (testFilters.length > 0) {
            process.env.TEST_FILTERS = JSON.stringify(testFilters);
            console.log(`Test filters: ${testFilters.join(", ")}`);
        }

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
        });
    } catch (err) {
        console.error("Failed to run tests:", err);
        process.exit(1);
    }
}
main();
