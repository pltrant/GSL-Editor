import * as path from "path";
import * as Mocha from "mocha";
import * as glob from "glob";

export async function run(): Promise<void> {
    // Parse filters from environment variables
    let fileFilters: string[] = [];
    let testFilters: string[] = [];

    if (process.env.FILE_FILTERS) {
        try {
            fileFilters = JSON.parse(process.env.FILE_FILTERS);
        } catch (e) {
            console.error("Error parsing FILE_FILTERS:", e);
        }
    }

    if (process.env.TEST_FILTERS) {
        try {
            testFilters = JSON.parse(process.env.TEST_FILTERS);
        } catch (e) {
            console.error("Error parsing TEST_FILTERS:", e);
        }
    }

    // Configure Mocha
    const mochaOpts: Mocha.MochaOptions = {
        ui: "tdd",
        color: true,
    };

    // If test name filters are provided, use Mocha's grep option
    if (testFilters.length === 1) {
        mochaOpts.grep = new RegExp(testFilters[0]);
    } else if (testFilters.length > 1) {
        // For multiple test filters, create a regex that matches any of them
        mochaOpts.grep = new RegExp(testFilters.map((f) => `(${f})`).join("|"));
    }

    const mocha = new Mocha(mochaOpts);

    // Find all test files
    const testsRoot = __dirname;
    const files = await glob.glob("**/*.test.js", { cwd: testsRoot });

    // Filter test files if file filters were provided
    const filteredFiles =
        fileFilters.length > 0
            ? files.filter((file) => {
                  return fileFilters.some((filter) => {
                      const fileNameWithoutExtension = path.basename(
                          file,
                          ".test.js",
                      );
                      return (
                          fileNameWithoutExtension === filter ||
                          file.includes(filter) ||
                          fileNameWithoutExtension.includes(filter)
                      );
                  });
              })
            : files;

    // Log filtering information
    if (fileFilters.length > 0) {
        console.log(`File filters: ${fileFilters.join(", ")}`);
        console.log(
            `Matching files (${filteredFiles.length}): ${filteredFiles.join(", ")}`,
        );
    }

    if (testFilters.length > 0) {
        console.log(`Test name filters: ${testFilters.join(", ")}`);
    }

    if (fileFilters.length === 0 && testFilters.length === 0) {
        console.log(`Running all ${files.length} test files`);
    }

    // Add files to the test suite
    for (const f of filteredFiles) {
        mocha.addFile(path.resolve(testsRoot, f));
    }

    // Run the tests
    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures) => {
                failures
                    ? reject(new Error(`${failures} tests failed`))
                    : resolve();
            });
        } catch (err) {
            console.error("Error running tests:", err);
            reject(err);
        }
    });
}
