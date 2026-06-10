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
 * Parent rollup comments for Linear orchestration (#247 A5).
 *
 * The fan-out plane (#243) posts a final-status comment on each CHILD's
 * sub-issue. The PARENT issue has no task, so its aggregate rollup is
 * posted here, by the reconciler, which already holds the orchestration
 * snapshot. The comment renderer is pure (unit-testable); ``postRollup``
 * wraps ``postIssueComment`` best-effort (a failed Linear comment must
 * never fail the reconcile — gating is the source of truth).
 */

import { type LinearFeedbackContext, postIssueComment } from './linear-feedback';
import { logger } from './logger';
import { ORCH_LOG } from './orchestration-log-events';
import type { OrchestrationChildRow } from './orchestration-store';

/** Which rollup we're posting — drives the heading + emoji. */
export type RollupKind = 'complete' | 'partial_failure' | 'cancelled';

export interface RollupChildView {
  readonly sub_issue_id: string;
  readonly linear_identifier?: string;
  readonly title?: string;
  readonly child_status: string;
  readonly child_task_id?: string;
}

const STATUS_ICON: Record<string, string> = {
  succeeded: '✅',
  failed: '❌',
  skipped: '⏭️',
  released: '🔄',
  ready: '🔄',
  blocked: '⏳',
};

/**
 * Render the parent rollup comment body (pure). Lists each child with its
 * status, and a one-line summary. ``kind`` is derived by the caller from
 * the terminal child statuses.
 */
export function renderRollupComment(
  kind: RollupKind,
  children: readonly RollupChildView[],
): string {
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  for (const c of children) {
    if (c.child_status === 'succeeded') counts.succeeded += 1;
    else if (c.child_status === 'failed') counts.failed += 1;
    else if (c.child_status === 'skipped') counts.skipped += 1;
  }

  const heading =
    kind === 'complete'
      ? '✅ **ABCA orchestration complete**'
      : kind === 'cancelled'
        ? '🛑 **ABCA orchestration cancelled**'
        : '⚠️ **ABCA orchestration finished with failures**';

  const lines = [...children]
    .sort((a, b) => (a.linear_identifier ?? a.sub_issue_id).localeCompare(b.linear_identifier ?? b.sub_issue_id))
    .map((c) => {
      const icon = STATUS_ICON[c.child_status] ?? '•';
      const label = c.linear_identifier
        ? (c.title ? `${c.linear_identifier}: ${c.title}` : c.linear_identifier)
        : (c.title ?? c.sub_issue_id);
      return `- ${icon} ${label} — ${c.child_status}`;
    });

  const summary = `${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.skipped} skipped `
    + `(of ${children.length}).`;

  return [heading, '', summary, '', ...lines].join('\n');
}

/**
 * Decide the rollup kind from the (terminal) child statuses.
 * - any failed/skipped → partial_failure
 * - all succeeded → complete
 * (cancelled is passed explicitly by the cancel path, not derived here)
 */
export function rollupKindFromChildren(children: readonly RollupChildView[]): RollupKind {
  const anyBad = children.some((c) => c.child_status === 'failed' || c.child_status === 'skipped');
  return anyBad ? 'partial_failure' : 'complete';
}

export interface PostRollupParams {
  readonly ctx: LinearFeedbackContext;
  readonly orchestrationId: string;
  readonly parentLinearIssueId: string;
  readonly kind: RollupKind;
  readonly children: readonly OrchestrationChildRow[];
}

/**
 * Post the parent rollup comment. Best-effort: never throws; logs a
 * stable event on both success and failure so automated tests can assert
 * on ``orch.rollup.posted`` / ``orch.rollup.failed``.
 */
export async function postRollup(params: PostRollupParams): Promise<boolean> {
  const { ctx, orchestrationId, parentLinearIssueId, kind, children } = params;
  const body = renderRollupComment(
    kind,
    children.map((c) => ({
      sub_issue_id: c.sub_issue_id,
      ...(c.linear_identifier !== undefined && { linear_identifier: c.linear_identifier }),
      ...(c.title !== undefined && { title: c.title }),
      child_status: c.child_status,
      ...(c.child_task_id !== undefined && { child_task_id: c.child_task_id }),
    })),
  );

  let ok = false;
  try {
    ok = await postIssueComment(ctx, parentLinearIssueId, body);
  } catch (err) {
    logger.warn('Parent rollup comment threw (non-fatal)', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
      rollup_kind: kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (ok) {
    logger.info('Parent rollup comment posted', {
      event: ORCH_LOG.rollupPosted,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
      rollup_kind: kind,
      child_count: children.length,
    });
  } else {
    logger.warn('Parent rollup comment post returned false', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
      rollup_kind: kind,
    });
  }
  return ok;
}
