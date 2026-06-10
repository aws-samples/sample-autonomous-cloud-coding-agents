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
 * Stable, machine-greppable log-event names for Linear orchestration
 * (#247). Emitted as the ``event`` field on structured logs.
 *
 * WHY A CENTRAL MODULE: these strings are a TEST CONTRACT. End-to-end and
 * automated dev tests assert on orchestration behavior by grepping
 * CloudWatch for these exact event names (the orchestration plane is
 * event-driven and has no synchronous API to assert against). Defining
 * them in one place means:
 *   - a test references ``ORCH_LOG.childReleased``, not a copy-pasted
 *     string that silently drifts when a log line is reworded;
 *   - renaming an event is a single edit that the type system propagates;
 *   - this file IS the catalogue of "what to look for in the logs",
 *     which is exactly the long-term automated-testing question.
 *
 * Convention: ``orch.<phase>.<outcome>`` so a test can match a whole
 * phase with a prefix (``orch.reconcile.*``) or an exact transition.
 * Every emit site should also include the structured fields listed in the
 * doc comment so log-based assertions can bind to ids, not just names.
 */
export const ORCH_LOG = {
  // ── Discovery (webhook → seed) ──────────────────────────────────
  /** A labeled parent had a valid sub-issue graph; rows seeded.
   *  Fields: orchestration_id, parent_linear_issue_id, child_count, root_count. */
  discoverySeeded: 'orch.discovery.seeded',
  /** Parent had no sub-issues → fell back to a single task.
   *  Fields: parent_linear_issue_id. */
  discoverySingleTask: 'orch.discovery.single_task',
  /** Graph rejected (cycle / dangling / dup) — no rows, terminal comment.
   *  Fields: parent_linear_issue_id, reason, offending_ids. */
  discoveryRejected: 'orch.discovery.rejected',
  /** Transient Linear error reading sub-issues — terminal comment, no seed.
   *  Fields: parent_linear_issue_id, message. */
  discoveryError: 'orch.discovery.error',

  // ── Release (root + reconciler) ─────────────────────────────────
  /** A child task was created (released). Fields: orchestration_id,
   *  sub_issue_id, child_task_id, base_branch, merge_branch_count, source
   *  ('root' | 'reconciler' | 'sweep'). */
  childReleased: 'orch.child.released',
  /** A release attempt's createTaskCore returned non-success. Fields:
   *  orchestration_id, sub_issue_id, status, response_body. */
  childReleaseFailed: 'orch.child.release_failed',

  // ── Reconcile (TaskTable stream → gating) ───────────────────────
  /** A child reached terminal-success; gating re-evaluated. Fields:
   *  orchestration_id, sub_issue_id, released_count. */
  reconcileSuccess: 'orch.reconcile.success',
  /** A child failed/cancelled/timed-out or built-broken; dependents
   *  skipped. Fields: orchestration_id, sub_issue_id, skipped_ids. */
  reconcileFailurePropagated: 'orch.reconcile.failure_propagated',

  // ── Rollup (parent comment via this plane) ──────────────────────
  /** A parent rollup comment was posted. Fields: orchestration_id,
   *  parent_linear_issue_id, rollup_kind ('progress' | 'complete' |
   *  'partial_failure' | 'cancelled'). */
  rollupPosted: 'orch.rollup.posted',
  /** Posting the parent rollup comment failed (best-effort). Fields:
   *  orchestration_id, parent_linear_issue_id, rollup_kind. */
  rollupFailed: 'orch.rollup.failed',

  // ── Completion / cancel ─────────────────────────────────────────
  /** Every child reached a terminal orchestration state. Fields:
   *  orchestration_id, parent_linear_issue_id, succeeded, failed, skipped. */
  orchestrationComplete: 'orch.complete',
  /** Parent cancel cascaded to non-terminal children. Fields:
   *  orchestration_id, parent_linear_issue_id, cancelled_count. */
  cancelCascaded: 'orch.cancel.cascaded',

  // ── Backstop (#303 scheduled sweep) ─────────────────────────────
  /** The sweep recovered a child the live reconciler missed. Fields:
   *  orchestration_id, sub_issue_id, recovery ('lost_release' |
   *  'lost_terminal'). */
  sweepRecovered: 'orch.sweep.recovered',
} as const;

export type OrchLogEvent = (typeof ORCH_LOG)[keyof typeof ORCH_LOG];
