/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Every workspace is compiled by the TypeScript it depends on, however ``tsc``
 * is started.
 *
 * ``yarn tsc`` inside a workspace does not run that workspace's compiler: Yarn 1
 * also looks in the repository-root ``node_modules/.bin`` and lets that entry
 * win, and it links that entry to the first installed ``typescript`` in path
 * order. A package that nests another version therefore takes the compiler over
 * without any manifest saying so. That is how cli and web were compiled by the
 * 5.9.3 nested under ``@cdklabs/eslint-plugin`` while declaring ^6.0.3.
 *
 * When this fails, run ``mise run install`` and try again. If it still fails,
 * the test title names the package that brought the other version: point its
 * ``typescript`` at the workspaces' range in the root package.json
 * ``resolutions`` (see the ``@cdklabs/eslint-plugin/typescript`` entry) and run
 * ``yarn install``. If that package cannot run on the workspaces' version,
 * declare ``typescript`` in the root ``devDependencies`` instead: Yarn links a
 * direct dependency last, so it wins the root ``.bin`` entry.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function versionOf(packageDir: string): string {
  return (JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version: string }).version;
}

const { workspaces } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces: string[] };
// What ``yarn tsc`` executes in every workspace: <package>/bin/tsc.
const rootTsc = fs.realpathSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'));

test.each(workspaces)(`%s: \`yarn tsc\` (${path.relative(REPO_ROOT, rootTsc)}) is the TypeScript the workspace depends on`, (workspace) => {
  const own = [path.join(REPO_ROOT, workspace), REPO_ROOT]
    .map(dir => path.join(dir, 'node_modules', 'typescript'))
    .find(dir => fs.existsSync(dir));
  expect(own).toBeDefined();
  // A mismatch means another package's TypeScript owns node_modules/.bin/tsc: see the comment above.
  expect(versionOf(path.resolve(rootTsc, '..', '..'))).toBe(versionOf(own as string));
});
