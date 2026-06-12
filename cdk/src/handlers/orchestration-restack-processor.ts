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
 * A6 re-stack processor (#305). Async-invoked by the GitHub webhook receiver
 * for a verified ``pull_request: synchronize`` event (new commits pushed to a
 * PR branch). Flow:
 *
 *   branch → ChildBranchIndex GSI → orchestration child (the changed node)
 *   load orchestration snapshot
 *   planRestack(snapshot, changedSubIssue) → ordered dependents to re-stack
 *   for each dependent: resolve its PR# (its TaskRecord) and create a
 *     coding/restack-v1 task (existing branch + updated predecessor branches)
 *
 * Best-effort, idempotent: each re-stack task's idempotency key includes the
 * predecessor head SHA, so the SAME predecessor update never re-stacks a
 * dependent twice (createTaskCore dedups on the key). A per-orchestration
 * budget bounds thrash if a predecessor PR is edited rapidly.
 *
 * Non-orchestration PRs (no child owns the branch) are a cheap no-op.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import {
  findOrchestrationChildByBranch,
  loadOrchestration,
} from './shared/orchestration-store';
import { planRestack, type RestackStep } from './shared/orchestration-restack';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
const CHILD_BRANCH_INDEX = process.env.ORCHESTRATION_CHILD_BRANCH_INDEX!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
/** Max re-stack tasks one webhook may spawn — thrash guard (design budget). */
const MAX_RESTACKS_PER_EVENT = 25;

interface PullRequestEnvelope {
  readonly raw_body: string;
}

interface PullRequestPayload {
  readonly action?: string;
  readonly pull_request?: {
    readonly head?: { readonly ref?: string; readonly sha?: string };
  };
  readonly repository?: { readonly full_name?: string };
}

export async function handler(event: PullRequestEnvelope): Promise<void> {
  if (!event.raw_body) {
    logger.error('Restack processor invoked without raw_body');
    return;
  }
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(event.raw_body) as PullRequestPayload;
  } catch (err) {
    logger.error('Restack processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const repo = payload.repository?.full_name;
  const branch = payload.pull_request?.head?.ref;
  const headSha = payload.pull_request?.head?.sha;
  if (!repo || !branch || !headSha) {
    logger.warn('Restack: pull_request payload missing repo/branch/sha', { repo, branch_present: Boolean(branch) });
    return;
  }

  // ── branch → orchestration child (the node whose PR changed) ──
  const changed = await findOrchestrationChildByBranch(ddb, ORCHESTRATION_TABLE, CHILD_BRANCH_INDEX, branch);
  if (!changed) {
    // Common case: a normal (non-orchestration) PR, or a child whose row was
    // reaped. Cheap no-op.
    logger.info('Restack: no orchestration child owns this branch — skipping', { repo, branch });
    return;
  }

  // ── load the orchestration + plan the dependents to re-stack ──
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, changed.orchestration_id);
  if (!snapshot) {
    logger.warn('Restack: orchestration not found for changed child', {
      orchestration_id: changed.orchestration_id,
      sub_issue_id: changed.sub_issue_id,
    });
    return;
  }

  const plan = planRestack(snapshot.children, changed.sub_issue_id);
  if (plan.length === 0) {
    logger.info('Restack: predecessor changed but no started dependents to re-stack', {
      orchestration_id: changed.orchestration_id,
      changed_sub_issue_id: changed.sub_issue_id,
    });
    return;
  }

  const steps = plan.slice(0, MAX_RESTACKS_PER_EVENT);
  if (plan.length > MAX_RESTACKS_PER_EVENT) {
    logger.warn('Restack: plan exceeds per-event budget — truncating', {
      orchestration_id: changed.orchestration_id,
      planned: plan.length,
      cap: MAX_RESTACKS_PER_EVENT,
    });
  }

  logger.info('Restack: predecessor changed — re-stacking dependents', {
    orchestration_id: changed.orchestration_id,
    changed_sub_issue_id: changed.sub_issue_id,
    head_sha: headSha,
    dependent_count: steps.length,
  });

  for (const step of steps) {
    await restackOne(step, snapshot.meta.release_context.platform_user_id, repo, headSha, changed.sub_issue_id);
  }
}

/** Issue one coding/restack-v1 task for a dependent. Best-effort per dependent. */
async function restackOne(
  step: RestackStep,
  platformUserId: string,
  repo: string,
  predHeadSha: string,
  changedSubIssueId: string,
): Promise<void> {
  const child = step.child;
  // The dependent's PR# lives on its TaskRecord (the orch row has only
  // task_id + branch). Resolve it so the restack workflow can push_resolve.
  const prNumber = await resolvePrNumber(child.child_task_id);
  if (prNumber === null) {
    logger.warn('Restack: dependent has no resolvable PR number — skipping', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      child_task_id: child.child_task_id,
    });
    return;
  }

  // Idempotency: same predecessor SHA never re-stacks the same dependent twice.
  // Truncate to stay within createTaskCore's 128-char / [A-Za-z0-9_-] key rule
  // (orchestration_id is orch_<32hex>, sub_issue_id a UUID, sha 40 hex).
  const idempotencyKey = `restack_${child.orchestration_id}_${child.sub_issue_id}_${predHeadSha}`.slice(0, 128);

  try {
    const result = await createTaskCore(
      {
        repo,
        workflow_ref: 'coding/restack-v1',
        pr_number: prNumber,
      },
      {
        userId: platformUserId,
        channelSource: 'webhook',
        channelMetadata: {
          orchestration_id: child.orchestration_id,
          orchestration_sub_issue_id: child.sub_issue_id,
          restack_predecessor_sub_issue_id: changedSubIssueId,
          // repo.py merges these updated predecessor branches into the
          // existing dependent branch before the agent runs.
          orchestration_merge_branches: JSON.stringify(step.mergeBranches),
        },
        idempotencyKey,
      },
      idempotencyKey,
    );
    logger.info('Restack: created restack task for dependent', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      pr_number: prNumber,
      status_code: result.statusCode,
    });
  } catch (err) {
    logger.error('Restack: createTaskCore threw for dependent', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read a dependent's PR number from its TaskRecord. Prefers the numeric
 * ``pr_number``, but orchestration child tasks commonly persist only
 * ``pr_url`` (``.../pull/N``) with ``pr_number`` left null — so fall back to
 * parsing the trailing number out of ``pr_url``. Null if neither resolves.
 */
async function resolvePrNumber(taskId?: string): Promise<number | null> {
  if (!taskId) return null;
  try {
    const res = await ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: taskId } }));
    const pr = res.Item?.pr_number;
    if (typeof pr === 'number') return pr;
    const url = res.Item?.pr_url;
    if (typeof url === 'string') {
      const m = url.match(/\/pull\/(\d+)\b/);
      if (m) return Number(m[1]);
    }
    return null;
  } catch (err) {
    logger.warn('Restack: failed to read dependent TaskRecord for PR number', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
