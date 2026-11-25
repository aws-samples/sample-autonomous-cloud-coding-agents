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
 * Tests for the command the `integ` job in `.github/workflows/integ.yml` runs, and
 * for the `integ` task of `cdk/mise.toml` behind it.
 *
 * mise appends whatever follows `mise //cdk:integ --` to the task's last command,
 * `integ-runner`, which exits 1 on an option it does not declare. The job sits
 * behind the `deploy` approval gate, so a command that cannot start goes unseen
 * until someone approves a run. The workflow test fails, without AWS access, as
 * soon as the workflow gives the task anything or runs it a second time; an option
 * that is meant to be passed has to be allowed here first.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/integ.yml'), 'utf-8');

/** What each invocation writes after the task name, continuation lines included. */
const AFTER_TASK = [...WORKFLOW.matchAll(/^[^#\n]*mise \/\/cdk:integ((?:.*\\\n)*.*)$/gm)].map((match) => match[1]);

const MISE = fs.readFileSync(path.resolve(__dirname, '../../mise.toml'), 'utf-8').split('\n');

function taskCommands(): string[] {
  const start = MISE.indexOf('[tasks.integ]');
  const body = MISE.slice(start + 1);
  const end = body.findIndex((line) => line.startsWith('['));
  const table = body.slice(0, end < 0 ? undefined : end);
  const first = table.indexOf('run = [');
  const last = table.indexOf(']', first);
  if (start < 0 || first < 0 || last < 0) {
    throw new Error('cdk/mise.toml has no [tasks.integ] with a `run = [` list');
  }
  return table.slice(first + 1, last)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      try {
        return JSON.parse(line.replace(/,$/, '')) as string;
      } catch {
        throw new Error(`cdk/mise.toml [tasks.integ]: this test reads one double-quoted string per line, not ${line}`);
      }
    });
}

describe('integ workflow', () => {
  test('runs the integ task once, with nothing after it', () => {
    expect(AFTER_TASK).toEqual(['']);
  });
});

describe('integ task', () => {
  // No snapshot is committed, so integ-runner lists every test as NEW and counts it as failed before it deploys anything.
  // In the job log that reads as a failed run (#569).
  test('says that a NEW snapshot is not a test failure, then runs integ-runner with --force', () => {
    const [notice, runner] = taskCommands().slice(-2);

    // One single-quoted literal without apostrophe, backslash or brace. sh prints it as written, and mise's template
    // engine finds nothing to render. Anything else could stop the task ahead of the deploy.
    expect(notice).toMatch(/^echo 'integ: [^'\\{}]*'$/);
    // The lines it is about, in the words integ-runner prints, and what it says of them.
    for (const phrase of ['snapshot check', 'NEW', 'failed', 'not a test failure', '--force', 'Test Results']) {
      expect(notice).toContain(phrase);
    }
    // mise appends the arguments after `--` to the last command only, and what the
    // notice says about --force holds only while that command passes the flag.
    expect(runner.split(' ').slice(0, 2)).toEqual(['npx', 'integ-runner']);
    expect(runner.split(' ')).toContain('--force');
  });
});
