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
 * ``yarn tsc`` inside a workspace does not run that workspace's compiler: Yarn 1
 * also looks in the repository-root ``node_modules/.bin`` and lets that entry
 * win, and it links that entry to the first installed ``typescript`` in path
 * order, so a package that nests another version takes the compiler over.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function versionOf(packageDir: string): string {
  return (JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version: string }).version;
}

const { workspaces } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces: string[] };
const rootTsc = fs.realpathSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'));

test.each(workspaces)(`%s: \`yarn tsc\` (${path.relative(REPO_ROOT, rootTsc)}) is the TypeScript the workspace depends on`, (workspace) => {
  const own = [path.join(REPO_ROOT, workspace), REPO_ROOT]
    .map(dir => path.join(dir, 'node_modules', 'typescript'))
    .find(dir => fs.existsSync(dir));
  expect(own).toBeDefined();
  expect(versionOf(path.resolve(rootTsc, '..', '..'))).toBe(versionOf(own as string));
});
