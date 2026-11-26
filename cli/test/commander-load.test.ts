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
 * commander is an ES module from 15 on, and ``require()`` takes an ES module
 * only on Node 22.12 or later. Jest's own loader cannot ``require()`` an ES
 * module before Node 24.9, so the Jest suites run a copy of commander that
 * ts-jest compiled to CommonJS.
 */
const CLI_ROOT = path.resolve(__dirname, '..');

test('plain Node loads commander with require(), as the compiled CLI does, and prints no warning', () => {
  const script = "const { Command } = require('commander'); process.stdout.write(typeof new Command('probe').parseAsync);";
  const child = spawnSync(process.execPath, ['--eval', script], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 0, stdout: 'function', stderr: '' });
});
