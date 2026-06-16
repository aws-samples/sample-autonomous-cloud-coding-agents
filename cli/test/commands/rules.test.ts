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
 * rules command tests (issue #230).
 */

import { makeRulesCommand } from '../../src/commands/rules';

describe('bgagent rules eval', () => {
  test('evaluates observe-repo-setup fixture successfully', async () => {
    const cmd = makeRulesCommand();
    const evalCmd = cmd.commands.find(c => c.name() === 'eval');
    expect(evalCmd).toBeDefined();

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await cmd.parseAsync(['eval', '--fixture', 'observe-repo-setup'], { from: 'user' });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});
