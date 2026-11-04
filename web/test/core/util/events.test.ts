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
import { eventTypeLabel, summarizeEvent } from '../../../src/core/util/events';

const ev = (event_type: string, metadata: Record<string, unknown> = {}): TaskEvent => ({
  event_id: 'e1',
  event_type,
  timestamp: '2026-10-23T12:00:00.000Z',
  metadata,
});

describe('summarizeEvent', () => {
  it('reads the same fields as the CLI status view', () => {
    expect(summarizeEvent(ev('agent_milestone', { milestone: 'repo_cloned' }))).toBe('repo_cloned');
    expect(summarizeEvent(ev('agent_tool_call', { tool_name: 'Bash' }))).toBe('Bash');
    expect(summarizeEvent(ev('agent_turn', { turn: 7 }))).toBe('Message 7');
    expect(summarizeEvent(ev('agent_turn', { turn: 7, text_preview: 'Done.' }))).toBe('Said: Done.');
    expect(summarizeEvent(ev('agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'ls'}" }))).toBe("Bash: {'command': 'ls'}");
    expect(summarizeEvent(ev('agent_tool_result', { content_preview: 'boom', is_error: true }))).toBe('Error: boom');
    expect(summarizeEvent(ev('agent_cost_update', { cost_usd: 1.5 }))).toBe('$1.50 so far');
  });

  it('describes blockers with resource and remediation hint', () => {
    expect(summarizeEvent(ev('agent_blocked', { kind: 'build_failure', resource: 'core', remediation_hint: 'Upgrade Lombok' })))
      .toBe('build_failure [core] - Upgrade Lombok');
  });

  it('falls back to reason/error, then to scalar metadata, for other events', () => {
    expect(summarizeEvent(ev('task_failed', { reason: 'Budget exceeded' }))).toBe('Budget exceeded');
    expect(summarizeEvent(ev('approval_gate_cap', { count: 3, cap: 50, nested: { a: 1 } }))).toBe('count: 3, cap: 50');
    expect(summarizeEvent(ev('task_created'))).toBe('');
  });
});

describe('eventTypeLabel', () => {
  it('turns snake_case into a sentence', () => {
    expect(eventTypeLabel('agent_tool_call')).toBe('Agent tool call');
  });
});
