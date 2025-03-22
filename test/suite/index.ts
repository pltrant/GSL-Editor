import * as path from 'path'
import * as Mocha from 'mocha'
import * as glob from 'glob'

export async function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    // Find all test files
    const testsRoot = __dirname;
    const files = await glob.glob('**/*.test.js', { cwd: testsRoot })

    // Add files to the test suite
    for (const f of files) {
        mocha.addFile(path.resolve(testsRoot, f))
    }

    return new Promise((resolve, reject) => {
        mocha.run(failures => {
            failures ? reject(new Error(`${failures} tests failed`)) : resolve()
        });
    });
}