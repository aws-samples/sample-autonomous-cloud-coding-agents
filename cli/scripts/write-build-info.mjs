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

// Records what was compiled, for `bgagent --version` (#913): lib/build-info.json holds the
// package version and the commit of the checkout (12 characters of its SHA, never a tag
// name), with `-dirty` when tracked files had uncommitted changes. Runs after `tsc` in the
// compile script. When no commit can be read (not a git checkout, git missing, a repository
// git refuses), the version alone is recorded and the reason printed.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf-8'));

const git = (...args) => execFileSync('git', args, { cwd: cliDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let commit;
try {
  const sha = git('rev-parse', '--short=12', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  commit = `${sha}${dirty ? '-dirty' : ''}`;
} catch (err) {
  const reason = (err.stderr || err.message || String(err)).toString().trim().split('\n')[0];
  console.log(`write-build-info: no commit recorded (${reason}); bgagent --version prints the version alone`);
}

mkdirSync(join(cliDir, 'lib'), { recursive: true });
writeFileSync(join(cliDir, 'lib', 'build-info.json'), `${JSON.stringify({ version, commit })}\n`);
