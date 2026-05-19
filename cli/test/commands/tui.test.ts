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

import { _setRunTuiForTests, makeTuiCommand } from '../../src/commands/tui';

describe('makeTuiCommand', () => {
  let runCalls = 0;
  beforeEach(() => {
    runCalls = 0;
    _setRunTuiForTests(async () => { runCalls += 1; });
  });
  afterEach(() => {
    _setRunTuiForTests(null);
  });

  it('registers the `tui` subcommand with expected options', () => {
    const cmd = makeTuiCommand();
    expect(cmd.name()).toBe('tui');
    expect(cmd.description()).toMatch(/interactive terminal UI/i);
    const names = cmd.options.map(o => o.long);
    expect(names).toContain('--mock');
  });

  it('calls runTui without setting BGAGENT_TUI_MOCK when --mock absent', async () => {
    const cmd = makeTuiCommand();
    const original = process.env.BGAGENT_TUI_MOCK;
    delete process.env.BGAGENT_TUI_MOCK;
    try {
      await cmd.parseAsync([], { from: 'user' });
      expect(runCalls).toBe(1);
      expect(process.env.BGAGENT_TUI_MOCK).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.BGAGENT_TUI_MOCK;
      else process.env.BGAGENT_TUI_MOCK = original;
    }
  });

  it('flips BGAGENT_TUI_MOCK=1 when --mock is passed', async () => {
    const cmd = makeTuiCommand();
    const original = process.env.BGAGENT_TUI_MOCK;
    delete process.env.BGAGENT_TUI_MOCK;
    try {
      await cmd.parseAsync(['--mock'], { from: 'user' });
      expect(process.env.BGAGENT_TUI_MOCK).toBe('1');
      expect(runCalls).toBe(1);
    } finally {
      if (original === undefined) delete process.env.BGAGENT_TUI_MOCK;
      else process.env.BGAGENT_TUI_MOCK = original;
    }
  });
});
