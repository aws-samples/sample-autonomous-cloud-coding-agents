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

import { formatStatusSnapshot } from '../src/format';
import { TaskDetail, TaskEvent } from '../src/types';

const NOW = Date.parse('2026-04-29T15:30:20Z');

/**
 * Build a TaskDetail with sensible defaults for status-snapshot tests.
 * Callers override only the fields relevant to the scenario under test.
 */
function buildTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task_id: 'abc123',
    status: 'RUNNING',
    repo: 'org/repo',
    issue_number: null,
    task_type: 'new_task',
    pr_number: null,
    task_description: 'fix bug',
    branch_name: 'bgagent/abc123/fix',
    session_id: null,
    pr_url: null,
    error_message: null,
    error_classification: null,
    created_at: '2026-04-29T15:27:00Z',
    updated_at: '2026-04-29T15:30:00Z',
    started_at: '2026-04-29T15:27:06Z', // 3m 14s before NOW
    completed_at: null,
    duration_s: null,
    cost_usd: null,
    build_passed: null,
    max_turns: 12,
    max_budget_usd: 2.0,
    turns_attempted: null,
    turns_completed: null,
    ...overrides,
  };
}

function mkEvent(overrides: Partial<TaskEvent>): TaskEvent {
  return {
    event_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    event_type: 'agent_turn',
    timestamp: '2026-04-29T15:30:00Z',
    metadata: {},
    ...overrides,
  };
}

describe('formatStatusSnapshot', () => {
  test('happy path renders the full template', () => {
    const task = buildTask();
    // Events are newest-first per the ``?desc=1`` contract. ULIDs are
    // lexicographically time-sortable; event_ids are chosen so the
    // ascending lexical order matches the ascending timestamp order.
    const events: TaskEvent[] = [
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F04',
        event_type: 'agent_tool_call',
        timestamp: '2026-04-29T15:30:12Z',
        metadata: { tool_name: 'Bash', tool_input_preview: 'pytest tests/', turn: 7 },
      }),
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F03',
        event_type: 'agent_cost_update',
        timestamp: '2026-04-29T15:30:11Z',
        metadata: { cost_usd: 0.18, input_tokens: 1000, output_tokens: 200, turn: 7 },
      }),
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F02',
        event_type: 'agent_turn',
        timestamp: '2026-04-29T15:30:10Z',
        metadata: { turn: 7 },
      }),
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F01',
        event_type: 'agent_milestone',
        timestamp: '2026-04-29T15:29:38Z', // 42s before NOW
        metadata: { milestone: 'nudge_acknowledged' },
      }),
    ];

    const rendered = formatStatusSnapshot(task, events, NOW);

    expect(rendered).toBe(
      [
        'Task abc123 — RUNNING (3m 14s elapsed)',
        '  Repo:          org/repo',
        '  Turn:          7 / ~12',
        '  Last milestone: nudge_acknowledged (42s ago)',
        '  Current:       Bash tool call',
        '  Cost:          $0.18 / budget $2.00',
        '  Last event:    2026-04-29T15:30:12Z',
      ].join('\n'),
    );
  });

  test('just-submitted task degrades to placeholders', () => {
    const task = buildTask({
      status: 'SUBMITTED',
      started_at: null,
      created_at: '2026-04-29T15:30:18Z', // 2s before NOW
      max_turns: null,
      max_budget_usd: null,
      turns_attempted: null,
    });

    const rendered = formatStatusSnapshot(task, [], NOW);

    expect(rendered).toContain('Task abc123 — SUBMITTED (2s elapsed)');
    expect(rendered).toContain('Turn:          —');
    expect(rendered).toContain('Last milestone: —');
    expect(rendered).toContain('Current:       —');
    expect(rendered).toContain('Cost:          — / budget —');
    expect(rendered).toContain('Last event:    —');
  });

  test('terminal task reports SDK duration and "task completed" current state', () => {
    const task = buildTask({
      status: 'COMPLETED',
      completed_at: '2026-04-29T15:29:50Z',
      duration_s: 164, // 2m 44s — authoritative SDK value
      cost_usd: 0.44,
      turns_attempted: 11,
    });

    const rendered = formatStatusSnapshot(task, [], NOW);

    expect(rendered).toContain('Task abc123 — COMPLETED (2m 44s total)');
    expect(rendered).toContain('Current:       task completed');
    // With no live cost event, falls back to task.cost_usd.
    expect(rendered).toContain('Cost:          $0.44 / budget $2.00');
    // With no live turn event, falls back to task.turns_attempted.
    expect(rendered).toContain('Turn:          11 / ~12');
  });

  test('events without a milestone show the placeholder', () => {
    const task = buildTask();
    const events: TaskEvent[] = [
      mkEvent({
        event_type: 'agent_turn',
        timestamp: '2026-04-29T15:30:00Z',
        metadata: { turn: 5 },
      }),
    ];

    const rendered = formatStatusSnapshot(task, events, NOW);

    expect(rendered).toContain('Last milestone: —');
    expect(rendered).toContain('Current:       agent turn 5');
  });

  test('tool_call takes priority over turn for "Current"', () => {
    // Design contract: the newest agent_tool_call OR agent_turn wins —
    // whichever appears first in the newest-first list. A tool call
    // mid-turn is the most useful "what is the agent doing right now".
    const task = buildTask();
    const events: TaskEvent[] = [
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F0B',
        event_type: 'agent_tool_call',
        timestamp: '2026-04-29T15:30:14Z',
        metadata: { tool_name: 'Write', turn: 9 },
      }),
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F0A',
        event_type: 'agent_turn',
        timestamp: '2026-04-29T15:30:13Z',
        metadata: { turn: 9 },
      }),
    ];

    const rendered = formatStatusSnapshot(task, events, NOW);
    expect(rendered).toContain('Current:       Write tool call');
  });

  test('malformed timestamps fall back to placeholders without crashing', () => {
    const task = buildTask({
      started_at: 'not-a-date',
      created_at: 'also-not-a-date',
    });

    const rendered = formatStatusSnapshot(task, [], NOW);
    // Header still renders; elapsed becomes a placeholder.
    expect(rendered).toContain(`Task abc123 — RUNNING (${'—'})`);
  });

  test('formats hours for long-running tasks', () => {
    const task = buildTask({
      started_at: '2026-04-29T12:25:05Z', // ~3h 5m before NOW
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toMatch(/\(3h 05m elapsed\)/);
  });

  test('defensively resorts events so ascending input still renders the newest', () => {
    // Invariant lock: a future upstream regression (handler, GSI, proxy,
    // or caller wiring) could pass events ascending by mistake. The
    // formatter must still identify the newest milestone by event_id so
    // the snapshot never silently renders a stale tool call as "current".
    const task = buildTask();
    const older = mkEvent({
      event_id: '01ARZ3NDEKTSV4RRFFQ69G5F01',
      event_type: 'agent_milestone',
      timestamp: '2026-04-29T15:28:00Z',
      metadata: { milestone: 'older' },
    });
    const newer = mkEvent({
      event_id: '01ARZ3NDEKTSV4RRFFQ69G5F09',
      event_type: 'agent_milestone',
      timestamp: '2026-04-29T15:29:50Z',
      metadata: { milestone: 'newer' },
    });
    // Both orderings must resolve to "newer" as the latest milestone.
    expect(formatStatusSnapshot(task, [newer, older], NOW)).toContain(
      'Last milestone: newer',
    );
    expect(formatStatusSnapshot(task, [older, newer], NOW)).toContain(
      'Last milestone: newer',
    );
  });

  test('missing / non-string timestamp degrades "Last event" to placeholder', () => {
    // The event table is weakly typed at the storage layer: a malformed
    // agent write could produce a row without ``timestamp``. Without the
    // guard this line would render the literal ``undefined``.
    const task = buildTask();
    const brokenEvent = {
      event_id: '01ARZ3NDEKTSV4RRFFQ69G5F10',
      event_type: 'agent_turn',
      metadata: { turn: 4 },
    } as unknown as TaskEvent;
    const rendered = formatStatusSnapshot(task, [brokenEvent], NOW);
    expect(rendered).toContain('Last event:    —');
    expect(rendered).not.toContain('undefined');
  });

  test('live cost and turn events override persisted TaskDetail values', () => {
    // Contract: a running task may have a fresher ``agent_cost_update`` /
    // ``agent_turn`` than what was last persisted on the TaskRecord. The
    // snapshot prefers the live event so the user sees the current state,
    // not the stale DB row.
    const task = buildTask({
      cost_usd: 0.10,
      turns_attempted: 3, // stale — the live turn event below is more recent
    });
    const events: TaskEvent[] = [
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F20',
        event_type: 'agent_cost_update',
        timestamp: '2026-04-29T15:30:12Z',
        metadata: { cost_usd: 0.25, input_tokens: 10, output_tokens: 5, turn: 7 },
      }),
      mkEvent({
        event_id: '01ARZ3NDEKTSV4RRFFQ69G5F21',
        event_type: 'agent_turn',
        timestamp: '2026-04-29T15:30:10Z',
        metadata: { turn: 7 },
      }),
    ];
    const rendered = formatStatusSnapshot(task, events, NOW);
    expect(rendered).toContain('Cost:          $0.25 / budget $2.00');
    expect(rendered).toContain('Turn:          7 / ~12');
  });
});
