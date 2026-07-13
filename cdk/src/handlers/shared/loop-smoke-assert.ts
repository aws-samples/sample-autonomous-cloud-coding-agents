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
 * Pure verifier for the Phase-1 full-lifecycle loop smoke test (self-host
 * reliability arc; the "Phase 1" tier named unbuilt in ADR-013).
 *
 * The integration harness deploys a full stack, submits ONE synthetic coding
 * task against a tiny fixture repo, and observes the task to terminal. This
 * module is the ASSERTION heart: given the observed event stream + the final
 * task snapshot, it decides whether the whole Linear→…→PR loop actually fired
 * end to end — the seam that unit tests never exercise (they mock one layer
 * too high; see the four #247 bugs that reached deploy that way).
 *
 * It is deliberately PURE — no AWS, no network, no clock. The live driver
 * (fetch events + task detail) is a thin shell around this; the driver is hard
 * to unit-test, so all the judgement lives here where it can be tested against
 * fixture streams with zero infrastructure. That inversion is the point: the
 * thing that decides pass/fail is itself covered.
 *
 * What a healthy single-task loop must show, in order, on the TaskEvents feed:
 *
 *   task_created          (createTaskCore wrote the row + async-invoked orchestrator)
 *   → hydration_complete  (orchestrator hydrated context)
 *   → session_started     (compute launched — ECS RunTask / AgentCore invoke)
 *   → agent_milestone(pr_created)   (the agent opened a PR; details = pr_url)
 *   → task_completed      (terminal success)
 *
 * plus, on the final task snapshot: status === COMPLETED and pr_url set. And —
 * the specific regression #37/#38 were about — the PR must target the repo's
 * DEFAULT branch (a fresh single task has no orchestration base, so it branches
 * off and PRs against the repo default; a wrong base is the bug class this gate
 * exists to catch).
 */

import { TaskStatus, TERMINAL_STATUSES, type TaskStatusType } from '../../constructs/task-status';

/**
 * A task event, normalized to the shape of the ``GET /tasks/{id}/events`` feed
 * (and the {@link ReplayEvent} embedded in a replay bundle): ``event_type`` +
 * an optional ``metadata`` bag. ``event_id`` is a ULID, so ascending
 * lexical/array order IS chronological order — the verifier relies on the
 * caller passing events in feed order (which both the feed and the bundle
 * already guarantee).
 */
export interface LoopEvent {
  readonly event_type: string;
  readonly metadata?: Record<string, unknown>;
}

/** The final task snapshot, as returned by ``GET /tasks/{id}``. */
export interface LoopTaskSnapshot {
  readonly status: TaskStatusType | string;
  readonly pr_url?: string | null;
  /** The base branch the PR targets, when the harness can resolve it (from the
   *  opened PR via the GitHub API). Optional so the event-only assertion still
   *  works when the harness cannot reach GitHub. */
  readonly pr_base_branch?: string | null;
}

/** Inputs to a loop verification. */
export interface LoopSmokeInput {
  /** TaskEvents for the task, in feed (chronological / ascending event_id) order. */
  readonly events: readonly LoopEvent[];
  /** The terminal task snapshot. */
  readonly task: LoopTaskSnapshot;
  /** The repo's default branch (e.g. ``linear-vercel`` on the fork, ``main``
   *  on aws-samples). When provided AND ``task.pr_base_branch`` is known, the
   *  verifier asserts the PR targets it. When either is absent, the base-branch
   *  check is SKIPPED (reported, never silently passed). */
  readonly expectedBaseBranch?: string;
}

/** The ordered lifecycle markers a healthy single-task loop must emit. */
export interface LifecycleMarker {
  /** Stable key for this stage (for the report + skip/fail messaging). */
  readonly key: string;
  /** Predicate over a single event: does it satisfy this stage? */
  readonly match: (e: LoopEvent) => boolean;
  /** Human description for the failure report. */
  readonly description: string;
}

/**
 * The lifecycle contract for a single (non-orchestrated) coding task. Order
 * matters: each marker must appear AT OR AFTER the previous one's first match,
 * so an out-of-order or missing stage fails. The ``pr_created`` marker is the
 * ``agent_milestone`` event whose ``metadata.milestone === 'pr_created'`` —
 * the cleanest proof the agent opened a PR (see agent/src/pipeline.py).
 */
export const SINGLE_TASK_LIFECYCLE: readonly LifecycleMarker[] = [
  {
    key: 'task_created',
    match: (e) => e.event_type === 'task_created',
    description: 'createTaskCore wrote the task row and invoked the orchestrator',
  },
  {
    key: 'hydration_complete',
    match: (e) => e.event_type === 'hydration_complete',
    description: 'orchestrator hydrated the task context',
  },
  {
    key: 'session_started',
    match: (e) => e.event_type === 'session_started',
    description: 'compute launched (ECS RunTask / AgentCore invoke)',
  },
  {
    key: 'pr_created',
    match: (e) =>
      e.event_type === 'agent_milestone' &&
      (e.metadata?.milestone as string | undefined) === 'pr_created',
    description: 'the agent opened a pull request (agent_milestone pr_created)',
  },
  {
    key: 'task_completed',
    match: (e) => e.event_type === 'task_completed',
    description: 'the task reached terminal success',
  },
] as const;

/** Outcome of a single check within the verification. */
export interface CheckResult {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly detail: string;
}

/** The full verification result. */
export interface LoopSmokeResult {
  /** True iff every non-skipped check passed. Skips do NOT fail the loop, but
   *  are surfaced so a silently-skipped assertion never reads as coverage. */
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  /** The pr_url observed on the pr_created milestone (or the task snapshot). */
  readonly prUrl?: string;
}

/**
 * Extract the PR URL from the loop: prefer the ``pr_created`` milestone's
 * ``details`` (what the agent actually emitted), fall back to the task
 * snapshot's ``pr_url``. Returns undefined when neither is present.
 */
export function extractPrUrl(input: LoopSmokeInput): string | undefined {
  for (const e of input.events) {
    if (
      e.event_type === 'agent_milestone' &&
      (e.metadata?.milestone as string | undefined) === 'pr_created'
    ) {
      const details = e.metadata?.details;
      if (typeof details === 'string' && details.length > 0) return details;
    }
  }
  const snap = input.task.pr_url;
  return typeof snap === 'string' && snap.length > 0 ? snap : undefined;
}

/**
 * Verify that the ordered lifecycle markers all appear, in order, in the event
 * stream. Returns one CheckResult per marker; a marker fails if it does not
 * appear at or after the previous matched marker's position.
 */
function checkLifecycleOrder(events: readonly LoopEvent[]): CheckResult[] {
  const results: CheckResult[] = [];
  let cursor = 0; // index in `events` at/after which the next marker must match
  for (const marker of SINGLE_TASK_LIFECYCLE) {
    let foundAt = -1;
    for (let i = cursor; i < events.length; i++) {
      if (marker.match(events[i])) {
        foundAt = i;
        break;
      }
    }
    if (foundAt === -1) {
      // Distinguish "present but out of order" from "absent entirely" — the two
      // failures point at different bugs (a reordered stream vs a stage that
      // never fired), and the report should say which.
      const anywhere = events.some((e) => marker.match(e));
      results.push({
        name: `lifecycle:${marker.key}`,
        status: 'fail',
        detail: anywhere
          ? `${marker.description} — event present but OUT OF ORDER (appeared before a prior stage)`
          : `${marker.description} — event NEVER emitted`,
      });
      // Do not advance the cursor; subsequent markers are reported against the
      // same position (they'll typically also fail, which is the right signal).
    } else {
      results.push({
        name: `lifecycle:${marker.key}`,
        status: 'pass',
        detail: marker.description,
      });
      cursor = foundAt + 1;
    }
  }
  return results;
}

/**
 * Verify a completed loop end to end. Pure — feed it the observed events + the
 * terminal task snapshot (+ optionally the repo default branch) and it returns
 * a structured pass/fail with a per-check breakdown. ``ok`` is true iff every
 * non-skipped check passed.
 */
export function verifyLoopSmoke(input: LoopSmokeInput): LoopSmokeResult {
  const checks: CheckResult[] = [];

  // 1. Ordered lifecycle markers.
  checks.push(...checkLifecycleOrder(input.events));

  // 2. Terminal status is COMPLETED (not just any terminal — a FAILED/TIMED_OUT
  //    task is a broken loop even though it "terminated").
  const status = input.task.status;
  if (status === TaskStatus.COMPLETED) {
    checks.push({ name: 'terminal:completed', status: 'pass', detail: 'task status is COMPLETED' });
  } else {
    const terminal = (TERMINAL_STATUSES as readonly string[]).includes(status);
    checks.push({
      name: 'terminal:completed',
      status: 'fail',
      detail: terminal
        ? `task reached a NON-SUCCESS terminal status: ${status}`
        : `task is NON-TERMINAL at observation: ${status} (loop did not finish)`,
    });
  }

  // 3. A PR URL exists (milestone or snapshot).
  const prUrl = extractPrUrl(input);
  if (prUrl) {
    checks.push({ name: 'pr:url', status: 'pass', detail: `pr_url present: ${prUrl}` });
  } else {
    checks.push({
      name: 'pr:url',
      status: 'fail',
      detail: 'no pr_url on the pr_created milestone or the task snapshot',
    });
  }

  // 4. PR base branch == repo default (the #37/#38 regression class). Skipped —
  //    NOT passed — when we can't resolve both sides, so a missing check never
  //    masquerades as a green one.
  if (input.expectedBaseBranch === undefined) {
    checks.push({
      name: 'pr:base_branch',
      status: 'skip',
      detail: 'expectedBaseBranch not provided — base-branch check skipped',
    });
  } else if (input.task.pr_base_branch === undefined || input.task.pr_base_branch === null) {
    checks.push({
      name: 'pr:base_branch',
      status: 'skip',
      detail: `PR base branch not resolved — cannot compare against '${input.expectedBaseBranch}'`,
    });
  } else if (input.task.pr_base_branch === input.expectedBaseBranch) {
    checks.push({
      name: 'pr:base_branch',
      status: 'pass',
      detail: `PR targets the repo default branch '${input.expectedBaseBranch}'`,
    });
  } else {
    checks.push({
      name: 'pr:base_branch',
      status: 'fail',
      detail: `PR targets '${input.task.pr_base_branch}' but the repo default is '${input.expectedBaseBranch}' (wrong-base regression, #37/#38 class)`,
    });
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checks, prUrl };
}

/** Render a verification result as a compact multi-line report for CI logs. */
export function formatLoopSmokeReport(result: LoopSmokeResult): string {
  const icon = (s: CheckResult['status']) => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️');
  const lines = result.checks.map((c) => `  ${icon(c.status)} ${c.name}: ${c.detail}`);
  const header = result.ok ? '✅ loop-smoke PASSED' : '❌ loop-smoke FAILED';
  return [header, ...lines].join('\n');
}
