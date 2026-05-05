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
import { ChannelSource, TaskDetail, TaskEvent } from '../src/types';

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
    channel_source: 'api',
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
    trace: false,
    trace_s3_uri: null,
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
        '  Channel:       api',
        '  Description:   fix bug',
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

  test('renders Trace S3 line when trace_s3_uri is non-null', () => {
    // Contract parity with ``formatTaskDetail``: trace-enabled tasks must
    // surface the S3 URI in the default ``bgagent status <id>`` snapshot so
    // terminal users don't need to fall back to ``--output json`` to
    // discover where the trajectory was uploaded.
    const task = buildTask({
      trace: true,
      trace_s3_uri: 's3://trace-bucket/tenants/u1/tasks/abc123/trace.jsonl.gz',
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain(
      'Trace S3:      s3://trace-bucket/tenants/u1/tasks/abc123/trace.jsonl.gz',
    );
  });

  test('omits Trace S3 line when trace_s3_uri is null', () => {
    // Zero-diff for non-trace tasks — matches the conditional rendering of
    // ``PR:`` / ``Cost:`` in ``formatTaskDetail``.
    const task = buildTask();
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).not.toContain('Trace S3:');
  });

  // ---- Type + Reason (PR #52 CLI UX carry-forward) ----

  test('renders Type line for pr_iteration tasks with PR number', () => {
    const task = buildTask({ task_type: 'pr_iteration', pr_number: 42 });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Type:          pr_iteration (PR #42)');
  });

  test('renders Type line for pr_review tasks', () => {
    const task = buildTask({ task_type: 'pr_review', pr_number: 7 });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Type:          pr_review (PR #7)');
  });

  test('omits Type line for new_task (the compact default path)', () => {
    const task = buildTask({ task_type: 'new_task' });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).not.toContain('Type:');
  });

  test('omits PR-number suffix on Type line when pr_number is absent', () => {
    // Defensive: a pr_iteration task without a pr_number would be a
    // server-side data shape oddity, but the renderer must not emit a
    // dangling "PR #undefined".
    const task = buildTask({ task_type: 'pr_iteration', pr_number: null });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Type:          pr_iteration\n');
    expect(rendered).not.toContain('PR #');
  });

  test('FAILED status with structured classification renders Reason line', () => {
    const task = buildTask({
      status: 'FAILED',
      error_message: 'Agent exceeded max turns',
      error_classification: {
        category: 'timeout',
        title: 'Exceeded max turns',
        description: 'The agent hit the configured turn limit.',
        remedy: 'Raise --max-turns or simplify the task.',
        retryable: true,
      },
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Reason:        timeout: Exceeded max turns');
  });

  test('FAILED without classification falls back to trimmed error_message', () => {
    const task = buildTask({
      status: 'FAILED',
      error_message: '  Guardrail blocked: task_description rejected\n',
      error_classification: null,
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Reason:        Guardrail blocked: task_description rejected');
  });

  test('FAILED with neither classification nor message omits Reason line (no trailing colon)', () => {
    const task = buildTask({
      status: 'FAILED',
      error_message: null,
      error_classification: null,
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).not.toContain('Reason:');
  });

  test('CANCELLED and TIMED_OUT terminals also render Reason when available', () => {
    // Regression guard: the ``=== COMPLETED`` check must be exact so
    // other terminals still surface their cause.
    const cancelled = buildTask({
      status: 'CANCELLED',
      error_classification: {
        category: 'unknown',
        title: 'User cancelled',
        description: '',
        remedy: '',
        retryable: true,
      },
    });
    expect(formatStatusSnapshot(cancelled, [], NOW)).toContain('Reason:        unknown: User cancelled');

    const timedOut = buildTask({
      status: 'TIMED_OUT',
      error_classification: {
        category: 'timeout',
        title: 'Wall-clock budget exceeded',
        description: '',
        remedy: '',
        retryable: false,
      },
    });
    expect(formatStatusSnapshot(timedOut, [], NOW)).toContain('Reason:        timeout: Wall-clock budget exceeded');
  });

  test('COMPLETED status never renders a Reason line (even if stale classification lingers)', () => {
    const task = buildTask({
      status: 'COMPLETED',
      error_message: 'should-never-render',
      error_classification: {
        category: 'timeout',
        title: 'should-never-render',
        description: '',
        remedy: '',
        retryable: false,
      },
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).not.toContain('Reason:');
    expect(rendered).not.toContain('should-never-render');
  });

  test('RUNNING status never renders a Reason line', () => {
    // Non-terminal. An error_message on a running task would be
    // in-flight noise — do not render it at snapshot time.
    const task = buildTask({
      status: 'RUNNING',
      error_message: 'transient',
      error_classification: null,
    });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).not.toContain('Reason:');
  });

  // ---- Channel + Description (PR #52 CLI UX carry-forward) ----

  test('Channel line shows api for default task records', () => {
    const task = buildTask({ channel_source: 'api' });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Channel:       api');
  });

  test('Channel line shows webhook for webhook-submitted tasks', () => {
    const task = buildTask({ channel_source: 'webhook' });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Channel:       webhook');
  });

  test('Channel line is always present (even when channel_source is an unexpected value)', () => {
    // Defence-in-depth: even though ``ChannelSource`` narrows the type to
    // ``api | webhook``, a corrupt DDB record could still arrive at the
    // formatter. The snapshot degrades to the placeholder rather than
    // omitting the line — consistent with other always-present rows.
    const task = buildTask({ channel_source: '' as unknown as ChannelSource });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Channel:       —');
  });

  test('Description line renders the user prompt on short inputs', () => {
    const task = buildTask({ task_description: 'Make a small tweak to README.md' });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).toContain('Description:   Make a small tweak to README.md');
  });

  test('Description wraps to continuation lines on long inputs (~60 char cap, word boundaries)', () => {
    const long = 'This is a much longer description of a task that the user submitted and needs to be wrapped across multiple lines rather than truncated or shoved onto one very long row that overflows a normal terminal window';
    const task = buildTask({ task_description: long });
    const rendered = formatStatusSnapshot(task, [], NOW);
    const lines = rendered.split('\n');
    const descStart = lines.findIndex(l => l.startsWith('  Description:'));
    expect(descStart).toBeGreaterThan(-1);
    // At least two physical lines rendered for the description.
    const continuation = lines[descStart + 1];
    expect(continuation).toMatch(/^ {17}\S/); // 2-space indent + 15-char gutter + non-space
    // Every rendered physical line should be <= 80 chars (the snapshot
    // target terminal width).
    for (let i = descStart; i < lines.length && lines[i].startsWith(' '); i++) {
      if (!lines[i].match(/^ {2}[A-Z]/)) break; // next labeled row
      expect(lines[i].length).toBeLessThanOrEqual(80);
    }
  });

  test('Description is omitted when task_description is null (webhook / minimal record)', () => {
    const task = buildTask({ task_description: null });
    const rendered = formatStatusSnapshot(task, [], NOW);
    expect(rendered).not.toContain('Description:');
  });

  test('Description trims leading/trailing whitespace but preserves inner spacing', () => {
    const task = buildTask({ task_description: '  Fix   the   bug   ' });
    const rendered = formatStatusSnapshot(task, [], NOW);
    // Trimmed at the ends; words inside get single-space-joined because
    // the wrapper splits on whitespace.
    expect(rendered).toContain('Description:   Fix the bug');
    expect(rendered).not.toContain('  Description:     ');
  });
});
