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

import { spawnSync } from 'node:child_process';
import * as path from 'path';

/**
 * Node loads commander the way the compiled CLI does.
 *
 * The CLI compiles to CommonJS (``module`` in tsconfig.json), so ``lib/`` loads
 * its dependencies with ``require()``. commander is an ES module from 15 on, and
 * ``require()`` takes an ES module only on Node 22.12 or later. The command
 * suites cannot show that this works: Jest loads modules with its own loader,
 * which before Node 24.9 cannot ``require()`` an ES module, so the jest block of
 * package.json has ts-jest compile commander to CommonJS first (``transform``
 * and ``transformIgnorePatterns``) and those suites run that compiled copy.
 *
 * This test asks a plain Node process instead, started in this package so that
 * it resolves the commander that ``lib/`` resolves.
 */
const CLI_ROOT = path.resolve(__dirname, '..');

test('plain Node loads commander with require(), as the compiled CLI does, and prints no warning', () => {
  const script = "const { Command } = require('commander'); process.stdout.write(typeof new Command('probe').parseAsync);";
  const child = spawnSync(process.execPath, ['--eval', script], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    // Not the developer's NODE_OPTIONS: a flag there can add a warning or hide one.
    env: { PATH: process.env.PATH },
  });
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 0, stdout: 'function', stderr: '' });
});
