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

import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../../../src/core/api/types';
import { buildTurns, stepsById } from '../../../src/core/util/turns';

let seq = 0;
function ev(event_type: string, metadata: Record<string, unknown> = {}): TaskEvent {
  seq += 1;
  return { event_id: `e${String(seq).padStart(4, '0')}`, event_type, timestamp: `2026-10-29T21:${String(10 + seq).padStart(2, '0')}:00Z`, metadata };
}
const message = (text = '', tools = 0) => ev('agent_turn', { text_preview: text, tool_calls_count: tools });
const call = (tool: string, preview: string) => ev('agent_tool_call', { tool_name: tool, tool_input_preview: preview });
const result = (tool: string, output: string, isError = false) => ev('agent_tool_result', { tool_name: tool, content_preview: output, is_error: isError });

describe('buildTurns', () => {
  it('starts a new turn after each answer that asked for tools, like the platform counts', () => {
    // A finished task with these events reports turns_completed = 3 (two tool turns + the final answer).
    const turns = buildTurns([
      message(), message('Looking around.', 1), call('Bash', "{'command': 'ls'}"), result('Bash', 'a.ts\nb.ts'),
      message(), message('', 1), call('Read', "{'file_path': '/w/a.ts'}"), result('Read', 'export const a = 1;'),
      message('All done.'),
    ]);
    expect(turns.map((t) => [t.number, t.said, t.tools.map((s) => s.tool)])).toEqual([
      [1, 'Looking around.', ['Bash']],
      [2, null, ['Read']],
      [3, 'All done.', []],
    ]);
    expect(turns[0].tools[0]).toMatchObject({ turn: 1, input: { command: 'ls' }, output: 'a.ts\nb.ts', isError: false, outputCutOff: false });
  });

  it('pairs results with their calls in order, including several calls in one turn', () => {
    const turns = buildTurns([
      message('', 2), call('Bash', "{'command': 'one'}"), call('Bash', "{'command': 'two'}"),
      result('Bash', 'first'), result('Bash', 'second', true),
    ]);
    expect(turns[0].tools.map((s) => [s.input.command, s.output, s.isError])).toEqual([['one', 'first', false], ['two', 'second', true]]);
  });

  it('marks shortened output and strips the marker', () => {
    const [turn] = buildTurns([message('', 1), call('Bash', "{'command': 'cat big'}"), result('Bash', `${'z'.repeat(200)}...`)]);
    expect(turn.tools[0]).toMatchObject({ output: 'z'.repeat(200), outputCutOff: true });
  });

  it('keeps a call without a result open, and ignores other events', () => {
    const turns = buildTurns([ev('task_created'), call('Bash', "{'command': 'sleep 60'}"), ev('agent_cost_update', { cost_usd: 1 })]);
    expect(turns).toHaveLength(1);
    expect(turns[0].tools[0].output).toBeNull();
    expect(buildTurns([ev('task_created')])).toEqual([]);
  });

  it('sorts events itself and indexes steps by event id', () => {
    const a = message('', 1);
    const b = call('Glob', "{'pattern': '*.ts'}");
    const steps = stepsById(buildTurns([b, a]));
    expect(steps.get(b.event_id)?.tool).toBe('Glob');
  });
});
