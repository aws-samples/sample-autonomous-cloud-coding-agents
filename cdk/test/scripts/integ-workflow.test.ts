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

/**
 * Test for the command the `integ` job in `.github/workflows/integ.yml` runs.
 *
 * mise appends whatever follows `mise //cdk:integ --` to the task's last command,
 * `integ-runner`, which exits 1 on an option it does not declare. The job sits
 * behind the `deploy` approval gate, so a command that cannot start goes unseen
 * until someone approves a run. This test fails, without AWS access, as soon as
 * the workflow gives the task anything or runs it a second time; an option that
 * is meant to be passed has to be allowed here first.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/integ.yml'), 'utf-8');

/** What each invocation writes after the task name, continuation lines included. */
const AFTER_TASK = [...WORKFLOW.matchAll(/^[^#\n]*mise \/\/cdk:integ((?:.*\\\n)*.*)$/gm)].map((match) => match[1]);

describe('integ workflow', () => {
  test('runs the integ task once, with nothing after it', () => {
    expect(AFTER_TASK).toEqual(['']);
  });
});
