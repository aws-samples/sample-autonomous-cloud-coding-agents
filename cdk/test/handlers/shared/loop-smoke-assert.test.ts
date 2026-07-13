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

import {
  extractPrUrl,
  formatLoopSmokeReport,
  verifyLoopSmoke,
  type LoopEvent,
  type LoopSmokeInput,
} from '../../../src/handlers/shared/loop-smoke-assert';

const PR_URL = 'https://github.com/isadeks/sample-autonomous-cloud-coding-agents/pull/123';

/** A healthy, in-order single-task loop event stream. */
function healthyEvents(overrides?: { prUrl?: string }): LoopEvent[] {
  return [
    { event_type: 'task_created' },
    { event_type: 'hydration_started' },
    { event_type: 'hydration_complete' },
    { event_type: 'session_started' },
    { event_type: 'agent_turn', metadata: { turn: 1 } },
    { event_type: 'agent_tool_call', metadata: { tool: 'Edit' } },
    {
      event_type: 'agent_milestone',
      metadata: { milestone: 'pr_created', details: overrides?.prUrl ?? PR_URL },
    },
    { event_type: 'task_completed' },
  ];
}

function healthyInput(over?: Partial<LoopSmokeInput>): LoopSmokeInput {
  return {
    events: healthyEvents(),
    task: { status: 'COMPLETED', pr_url: PR_URL, pr_base_branch: 'linear-vercel' },
    expectedBaseBranch: 'linear-vercel',
    ...over,
  };
}

describe('verifyLoopSmoke — happy path', () => {
  it('passes a full, in-order loop with matching base branch', () => {
    const r = verifyLoopSmoke(healthyInput());
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe(PR_URL);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('passes even with extra interleaved events (agent_turn/tool spam)', () => {
    const noisy = [
      ...healthyEvents().slice(0, 4),
      ...Array.from({ length: 40 }, (_, i) => ({ event_type: 'agent_turn', metadata: { turn: i } })),
      { event_type: 'agent_cost_update', metadata: { usd: 1.2 } },
      { event_type: 'agent_milestone', metadata: { milestone: 'pr_created', details: PR_URL } },
      { event_type: 'agent_milestone', metadata: { milestone: 'trajectory_uploaded' } },
      { event_type: 'task_completed' },
    ];
    const r = verifyLoopSmoke(healthyInput({ events: noisy }));
    expect(r.ok).toBe(true);
  });
});

describe('verifyLoopSmoke — lifecycle order failures', () => {
  it('fails when pr_created is never emitted (agent never opened a PR)', () => {
    const events = healthyEvents().filter(
      (e) => !(e.event_type === 'agent_milestone' && e.metadata?.milestone === 'pr_created'),
    );
    const r = verifyLoopSmoke(healthyInput({ events, task: { status: 'COMPLETED', pr_url: null } }));
    expect(r.ok).toBe(false);
    const prMarker = r.checks.find((c) => c.name === 'lifecycle:pr_created')!;
    expect(prMarker.status).toBe('fail');
    expect(prMarker.detail).toMatch(/NEVER emitted/);
  });

  it('fails when session never started (compute never launched)', () => {
    const events = healthyEvents().filter((e) => e.event_type !== 'session_started');
    const r = verifyLoopSmoke(healthyInput({ events }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'lifecycle:session_started')!.status).toBe('fail');
  });

  it('fails when a stage is present but OUT OF ORDER (pr_created before session_started)', () => {
    // Impossible ordering: the PR milestone arrives BEFORE the compute session
    // started. The greedy forward matcher consumes session_started at its real
    // (later) position, so the earlier pr_created can no longer be matched at or
    // after the cursor → pr_created is flagged present-but-out-of-order. That is
    // the correct victim: a stream where the PR predates the session is broken,
    // and the report names pr_created as the anomaly.
    const events: LoopEvent[] = [
      { event_type: 'task_created' },
      { event_type: 'hydration_complete' },
      { event_type: 'agent_milestone', metadata: { milestone: 'pr_created', details: PR_URL } },
      { event_type: 'session_started' },
      { event_type: 'task_completed' },
    ];
    const r = verifyLoopSmoke(healthyInput({ events }));
    expect(r.ok).toBe(false);
    const pr = r.checks.find((c) => c.name === 'lifecycle:pr_created')!;
    expect(pr.status).toBe('fail');
    expect(pr.detail).toMatch(/OUT OF ORDER/);
  });

  it('fails an empty event stream on every lifecycle marker', () => {
    const r = verifyLoopSmoke(healthyInput({ events: [] }));
    expect(r.ok).toBe(false);
    const lifecycle = r.checks.filter((c) => c.name.startsWith('lifecycle:'));
    expect(lifecycle).toHaveLength(5);
    expect(lifecycle.every((c) => c.status === 'fail')).toBe(true);
  });
});

describe('verifyLoopSmoke — terminal status', () => {
  it('fails a FAILED terminal status (loop ran but broke)', () => {
    const r = verifyLoopSmoke(
      healthyInput({ task: { status: 'FAILED', pr_url: PR_URL, pr_base_branch: 'linear-vercel' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'terminal:completed')!.detail).toMatch(/NON-SUCCESS/);
  });

  it('fails a non-terminal status (loop never finished / observation timed out)', () => {
    const r = verifyLoopSmoke(
      healthyInput({ task: { status: 'RUNNING', pr_url: PR_URL, pr_base_branch: 'linear-vercel' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'terminal:completed')!.detail).toMatch(/NON-TERMINAL/);
  });
});

describe('verifyLoopSmoke — PR url', () => {
  it('prefers the pr_created milestone details over the snapshot', () => {
    const milestoneUrl = 'https://github.com/o/r/pull/999';
    const r = verifyLoopSmoke(
      healthyInput({
        events: healthyEvents({ prUrl: milestoneUrl }),
        task: { status: 'COMPLETED', pr_url: PR_URL, pr_base_branch: 'linear-vercel' },
      }),
    );
    expect(r.prUrl).toBe(milestoneUrl);
  });

  it('falls back to the task snapshot pr_url when no milestone details', () => {
    const events = healthyEvents();
    // milestone present but with empty details
    (events[6].metadata as Record<string, unknown>).details = '';
    const input = healthyInput({ events });
    expect(extractPrUrl(input)).toBe(PR_URL);
  });

  it('fails when neither milestone nor snapshot carries a pr_url', () => {
    const events = healthyEvents();
    (events[6].metadata as Record<string, unknown>).details = '';
    const r = verifyLoopSmoke(healthyInput({ events, task: { status: 'COMPLETED', pr_url: null } }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'pr:url')!.status).toBe('fail');
  });
});

describe('verifyLoopSmoke — base branch (the #37/#38 regression class)', () => {
  it('fails when the PR targets the wrong base branch', () => {
    const r = verifyLoopSmoke(
      healthyInput({ task: { status: 'COMPLETED', pr_url: PR_URL, pr_base_branch: 'main' } }),
    );
    expect(r.ok).toBe(false);
    const base = r.checks.find((c) => c.name === 'pr:base_branch')!;
    expect(base.status).toBe('fail');
    expect(base.detail).toMatch(/wrong-base/);
  });

  it('SKIPS (not passes) when expectedBaseBranch is not provided', () => {
    const r = verifyLoopSmoke(healthyInput({ expectedBaseBranch: undefined }));
    expect(r.ok).toBe(true); // skip does not fail
    expect(r.checks.find((c) => c.name === 'pr:base_branch')!.status).toBe('skip');
  });

  it('SKIPS (not passes) when the PR base branch cannot be resolved', () => {
    const r = verifyLoopSmoke(
      healthyInput({ task: { status: 'COMPLETED', pr_url: PR_URL, pr_base_branch: null } }),
    );
    expect(r.ok).toBe(true);
    const base = r.checks.find((c) => c.name === 'pr:base_branch')!;
    expect(base.status).toBe('skip');
    expect(base.detail).toMatch(/not resolved/);
  });
});

describe('formatLoopSmokeReport', () => {
  it('renders PASSED with per-check icons', () => {
    const report = formatLoopSmokeReport(verifyLoopSmoke(healthyInput()));
    expect(report).toMatch(/^✅ loop-smoke PASSED/);
    expect(report).toMatch(/✅ lifecycle:pr_created/);
  });

  it('renders FAILED and surfaces the failing check', () => {
    const r = verifyLoopSmoke(
      healthyInput({ task: { status: 'FAILED', pr_url: PR_URL, pr_base_branch: 'linear-vercel' } }),
    );
    const report = formatLoopSmokeReport(r);
    expect(report).toMatch(/^❌ loop-smoke FAILED/);
    expect(report).toMatch(/❌ terminal:completed/);
  });
});
