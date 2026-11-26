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
  type DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { createTaskCore as CreateTaskCoreFn } from './create-task-core';
import { logger } from './logger';
import { selectBaseBranch } from './orchestration-base-branch';
import { isIntegrationNode } from './orchestration-integration-node';
import { computeReconcilePlan } from './orchestration-reconcile';
import {
  PARENT_CONTEXT_TRUNCATED,
  type ChildStatus,
  type OrchestrationChildRow,
  type OrchestrationReleaseContext,
} from './orchestration-store';
import type { AttachmentRecord, ChannelSource } from './types';
import { MAX_ATTACHMENTS_PER_TASK, MAX_TASK_DESCRIPTION_LENGTH } from './validation';
import { CODING_WORKFLOW_ID } from './workflows';

const DEFAULT_ORCHESTRATION_CHANNEL: ChannelSource = 'linear';

/**
 * Read a user's free concurrency budget (``cap - active_count``).
 * Best-effort: on any read error returns the full ``cap``. Never negative.
 */
export async function readConcurrencyBudget(
  ddb: DynamoDBDocumentClient,
  concurrencyTableName: string,
  userId: string,
  maxConcurrent: number,
): Promise<number> {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: concurrencyTableName,
      Key: { user_id: userId },
      ProjectionExpression: 'active_count',
    }));
    const active = Number(res.Item?.active_count ?? 0);
    return Math.max(0, maxConcurrent - (Number.isFinite(active) ? active : 0));
  } catch (err) {
    logger.warn('Concurrency-budget read failed — releasing without throttle (admission still gates)', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return maxConcurrent;
  }
}

export interface ReleaseChildParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly row: OrchestrationChildRow;
  /** Platform user the child task is attributed to (parent's submitter). */
  readonly platformUserId: string;
  /** Linear OAuth secret ARN + slug for the agent's outbound Linear GraphQL. */
  readonly linearOauthSecretArn?: string;
  readonly linearWorkspaceSlug?: string;
  /** Vault credential-provider name for vault-onboarded workspaces (RFC #249
   *  Phase 1); workspace id rides the existing credentials_ref stamp. Absent ⇒
   *  Secrets-Manager path. */
  readonly linearProviderName?: string;
  readonly linearVaultUserId?: string;
  readonly linearProjectId?: string;
  /** The base branch this child stacks on. Absent → root (off main). */
  readonly baseBranch?: string;
  /**
   * Predecessor branches to merge into the child's branch before work (the
   * diamond case: two predecessors converging). Absent/empty for root +
   * linear children.
   */
  readonly mergeBranches?: readonly string[];
  readonly createTaskCore: typeof CreateTaskCoreFn;
  /**
   * Parent-issue attachments (screened + stored once at seed time), inherited by
   * every child. The PARENT owns these S3 objects — a child failure must NOT
   * delete them.
   */
  readonly preScreenedAttachments?: readonly AttachmentRecord[];
  /** The parent epic's title/body, inherited by every child. */
  readonly parentContext?: {
    readonly title?: string;
    readonly description?: string;
  };
  /** ISO timestamp. */
  readonly now: string;
  /** Trigger channel the child task is created under. Defaults to ``'linear'``. */
  readonly channelSource?: ChannelSource;
}

export type ReleaseChildResult =
  | { readonly kind: 'released'; readonly taskId: string }
  | { readonly kind: 'create_failed'; readonly statusCode: number; readonly body: string }
  | { readonly kind: 'create_failed_terminal'; readonly statusCode: number; readonly body: string; readonly failureReason: string }
  | { readonly kind: 'already_released' }
  | { readonly kind: 'error'; readonly message: string };

/** A {@link ReleaseChildResult} tagged with the child it came from. */
export type ReleaseChildReadyResult = ReleaseChildResult & { readonly subIssueId: string };

const HTTP_CONFLICT = 409;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

function isDeterministicCreateFailure(statusCode: number): boolean {
  if (statusCode === HTTP_CONFLICT) return false;
  return statusCode >= HTTP_CLIENT_ERROR_MIN && statusCode < HTTP_SERVER_ERROR_MIN;
}

const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;

function deterministicFailureReason(statusCode: number, body: string): string {
  const retry = 'then reply `@bgagent retry` on the epic to re-run.';
  if (statusCode === HTTP_UNPROCESSABLE) {
    return `Couldn't start — this repo isn't onboarded to ABCA. Onboard it, ${retry}`;
  }
  if (statusCode === HTTP_TOO_MANY_REQUESTS) {
    return `Couldn't start — a monthly budget is exhausted. Adjust the budget or wait for the next UTC month, ${retry}`;
  }
  if (/content policy|guardrail/i.test(body || '')) {
    return `Blocked by content policy — reword this sub-issue, ${retry}`;
  }
  return `Couldn't start (validation error) — edit this sub-issue, ${retry}`;
}

function parentContextBlock(
  parentContext: { readonly title?: string; readonly description?: string } | undefined,
  room: number,
): string {
  const title = parentContext?.title?.trim() ?? '';
  const description = parentContext?.description?.trim() ?? '';
  if (!title && !description) return '';
  // DESCRIPTIVE, not imperative: an instruction-shaped preamble makes the whole
  // task description trip the guardrail's PROMPT_ATTACK filter.
  const block = (body: string) => [
    '--- SHARED ORCHESTRATION CONTEXT (the parent epic) ---',
    'Several sub-issues of this epic are being built in parallel, and each was given',
    'the text below. The names, routes, fields and shapes it states are shared with',
    'those siblings; an alternative chosen here would not match theirs.',
    '',
    ...(title ? [`Epic: ${title}`, ''] : []),
    ...(body ? [body, ''] : []),
    '--- END SHARED ORCHESTRATION CONTEXT ---',
  ].join('\n');
  const whole = block(description);
  if (whole.length <= room) return whole;
  const keep = description.length - (whole.length - room) - PARENT_CONTEXT_TRUNCATED.length;
  const kept = keep > 0 ? description.slice(0, keep).replace(/\p{Surrogate}$/u, '').trimEnd() : '';
  if (kept) return block(`${kept}${PARENT_CONTEXT_TRUNCATED}`);
  return title && block('').length <= room ? block('') : '';
}

function buildChildDescription(
  row: OrchestrationChildRow,
  parentContext?: { readonly title?: string; readonly description?: string },
): string {
  const own = childOwnText(row);
  const shared = parentContextBlock(parentContext, MAX_TASK_DESCRIPTION_LENGTH - own.length - 2);
  return [shared, own].filter(Boolean).join('\n\n') || `Orchestration child ${row.sub_issue_id}`;
}

function childOwnText(row: OrchestrationChildRow): string {
  if (isIntegrationNode(row.sub_issue_id)) {
    return [
      'Integrate the completed sub-issue branches into one combined result.',
      '',
      "All predecessor sub-issue branches have already been merged into this task's",
      'branch before you started. Your job:',
      '- Resolve any merge conflicts left in the working tree.',
      '- Ensure the combined result builds and existing tests pass (run the build/tests).',
      '- Do NOT add new features — this is an integration/merge task only.',
      '- Open a PR with the combined result so the epic has a single reviewable artifact.',
    ].join('\n');
  }
  const parts: string[] = [];
  if (row.display_id && row.title) {
    parts.push(`${row.display_id}: ${row.title}`);
  } else if (row.title) {
    parts.push(row.title);
  } else if (row.display_id) {
    parts.push(row.display_id);
  }
  const desc = (row.description ?? '').trim();
  if (desc && desc !== row.title) parts.push(desc);
  return parts.join('\n\n');
}

/**
 * Release one orchestration child as an ABCA task. Idempotent: a
 * duplicate call (stream redelivery, racing reconcile) does not create a
 * second task, and the row flip to ``released`` is conditional.
 */
export async function releaseChild(params: ReleaseChildParams): Promise<ReleaseChildResult> {
  const { ddb, tableName, row, platformUserId, baseBranch, createTaskCore, now } = params;
  const channelSource = params.channelSource ?? DEFAULT_ORCHESTRATION_CHANNEL;

  const channelMetadata: Record<string, string> = {
    ...(row.channel_metadata ?? {}),
    orchestration_id: row.orchestration_id,
    orchestration_sub_issue_id: row.sub_issue_id,
  };

  if (channelSource === 'linear') {
    channelMetadata.linear_workspace_id = row.credentials_ref;
    channelMetadata.parent_linear_issue_id = row.parent_issue_ref;
    if (!isIntegrationNode(row.sub_issue_id)) {
      channelMetadata.linear_issue_id = row.sub_issue_id;
    }
    if (row.display_id) channelMetadata.linear_issue_identifier = row.display_id;
    if (params.linearProjectId) channelMetadata.linear_project_id = params.linearProjectId;
    if (params.linearOauthSecretArn) channelMetadata.linear_oauth_secret_arn = params.linearOauthSecretArn;
    if (params.linearWorkspaceSlug) channelMetadata.linear_workspace_slug = params.linearWorkspaceSlug;
    if (params.linearProviderName) channelMetadata.linear_provider_name = params.linearProviderName;
    if (params.linearVaultUserId) channelMetadata.linear_vault_user_id = params.linearVaultUserId;
  }
  if (params.baseBranch) channelMetadata.orchestration_base_branch = params.baseBranch;
  if (params.mergeBranches && params.mergeBranches.length > 0) {
    channelMetadata.orchestration_merge_branches = JSON.stringify(params.mergeBranches);
  }

  const baseKey = `${row.orchestration_id}_${row.sub_issue_id}`;
  const idempotencyKey = row.child_task_id
    ? `${baseKey}_${row.child_task_id}`
    : baseKey;

  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression: 'SET child_status = :releasing, updated_at = :now',
      ConditionExpression: 'child_status IN (:blocked, :ready)',
      ExpressionAttributeValues: {
        ':releasing': 'releasing',
        ':now': now,
        ':blocked': 'blocked',
        ':ready': 'ready',
      },
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      logger.info('Orchestration child already claimed by a racing releaser (flip-then-create)', {
        orchestration_id: row.orchestration_id,
        sub_issue_id: row.sub_issue_id,
      });
      return { kind: 'already_released' };
    }
    logger.error('Failed to claim orchestration child for release', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  const inheritedAttachments = params.preScreenedAttachments ?? [];
  const ownAttachments = row.pre_screened_attachments ?? [];
  const dedupedAttachments: AttachmentRecord[] = [];
  const seenAttachmentIds = new Set<string>();
  for (const rec of [...ownAttachments, ...inheritedAttachments]) {
    if (seenAttachmentIds.has(rec.attachment_id)) continue;
    seenAttachmentIds.add(rec.attachment_id);
    dedupedAttachments.push(rec);
  }
  const mergedAttachments = dedupedAttachments.slice(0, MAX_ATTACHMENTS_PER_TASK);
  if (dedupedAttachments.length > MAX_ATTACHMENTS_PER_TASK) {
    logger.warn('Child attachment set over the per-task cap at release — trimming (parent-spec files dropped first; user already notified at stamp time)', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      own_count: ownAttachments.length,
      inherited_count: inheritedAttachments.length,
      merged_count: dedupedAttachments.length,
      kept: mergedAttachments.length,
      cap: MAX_ATTACHMENTS_PER_TASK,
    });
  }

  let result;
  try {
    result = await createTaskCore(
      {
        repo: row.repo,
        task_description: buildChildDescription(row, params.parentContext),
        workflow_ref: CODING_WORKFLOW_ID,
      },
      {
        userId: platformUserId,
        channelSource,
        channelMetadata,
        idempotencyKey,
        ...(mergedAttachments.length > 0
          && !isIntegrationNode(row.sub_issue_id)
          && { preScreenedAttachments: mergedAttachments }),
      },
      idempotencyKey,
    );
  } catch (err) {
    logger.error('Orchestration child createTaskCore threw', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    await rollbackClaim(ddb, tableName, row, now);
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  if (result.statusCode !== 201 && result.statusCode !== 200) {
    logger.warn('Orchestration child task creation returned non-success', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      repo: row.repo,
      status: result.statusCode,
      response_body: result.body,
      idempotency_key: idempotencyKey,
    });
    if (isDeterministicCreateFailure(result.statusCode)) {
      const failureReason = deterministicFailureReason(result.statusCode, result.body);
      await failClaimTerminal(ddb, tableName, row, now, failureReason);
      return { kind: 'create_failed_terminal', statusCode: result.statusCode, body: result.body, failureReason };
    }
    await rollbackClaim(ddb, tableName, row, now);
    return { kind: 'create_failed', statusCode: result.statusCode, body: result.body };
  }

  const { taskId, branchName } = extractTaskIdAndBranch(result.body);

  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression:
        'SET child_status = :released, child_task_id = :tid, child_branch_name = :bn, updated_at = :now'
        + ' REMOVE failure_reason',
      ConditionExpression: 'child_status = :releasing',
      ExpressionAttributeValues: {
        ':released': 'released',
        ':tid': taskId,
        ':bn': branchName,
        ':now': now,
        ':releasing': 'releasing',
      },
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      logger.info('Orchestration child left releasing state before finalize (concurrent transition)', {
        orchestration_id: row.orchestration_id,
        sub_issue_id: row.sub_issue_id,
        task_id: taskId,
      });
      return { kind: 'released', taskId };
    }
    logger.error('Failed to mark orchestration child released', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  logger.info('Orchestration child released', {
    orchestration_id: row.orchestration_id,
    sub_issue_id: row.sub_issue_id,
    task_id: taskId,
    base_branch: baseBranch ?? 'main',
  });
  return { kind: 'released', taskId };
}

/**
 * Release a batch of child rows (the ``ready`` ones), using a shared
 * release context (from the meta row).
 *
 * Each child is released independently; one failure does not abort the
 * rest. A ``create_failed`` row stays ``ready`` and is retried on the next
 * reconcile pass.
 */
export async function releaseReadyChildren(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  rows: readonly OrchestrationChildRow[],
  releaseContext: OrchestrationReleaseContext,
  createTaskCore: typeof CreateTaskCoreFn,
  now: string,
  /**
   * The FULL child set (not just the releasable subset), so a
   * child's base branch can be derived from its predecessors' persisted
   * ``child_branch_name``. Defaults to ``rows``.
   */
  allChildren?: readonly OrchestrationChildRow[],
  /** Repo default branch for roots + diamond bases. Defaults to 'main'. */
  defaultBranch = 'main',
  /**
   * Max children to actually release this pass — the user's free
   * concurrency budget (``cap - active_count``). When set, only this many
   * ``ready`` children are released; the rest are LEFT ``ready`` (a no-op,
   * not a failure). ``undefined`` = release all.
   * A value ``<= 0`` releases nothing this pass.
   */
  maxToRelease?: number,
): Promise<readonly ReleaseChildReadyResult[]> {
  const all = allChildren ?? rows;
  const branchOf = new Map(
    all.filter((c) => c.child_branch_name).map((c) => [c.sub_issue_id, c.child_branch_name as string]),
  );
  const ready = rows.filter((r) => r.child_status === 'ready');
  const releasable = maxToRelease === undefined
    ? ready
    : [...ready].sort((a, b) => a.sub_issue_id.localeCompare(b.sub_issue_id)).slice(0, Math.max(0, maxToRelease));
  if (maxToRelease !== undefined && releasable.length < ready.length) {
    logger.info('Orchestration release throttled to concurrency budget', {
      ready: ready.length,
      releasing: releasable.length,
      budget: maxToRelease,
    });
  }
  const results: ReleaseChildReadyResult[] = [];
  for (const row of releasable) {
    const selection = selectBaseBranch({
      predecessors: row.depends_on.map((sub) => ({
        sub_issue_id: sub,
        branch_name: branchOf.get(sub) ?? '',
      })),
      defaultBranch,
    });
    const childResult = await releaseChild({
      ddb,
      tableName,
      row,
      platformUserId: releaseContext.platform_user_id,
      ...(releaseContext.linear_oauth_secret_arn !== undefined && {
        linearOauthSecretArn: releaseContext.linear_oauth_secret_arn,
      }),
      ...(releaseContext.linear_workspace_slug !== undefined && {
        linearWorkspaceSlug: releaseContext.linear_workspace_slug,
      }),
      ...(releaseContext.linear_provider_name !== undefined && {
        linearProviderName: releaseContext.linear_provider_name,
      }),
      ...(releaseContext.linear_vault_user_id !== undefined && {
        linearVaultUserId: releaseContext.linear_vault_user_id,
      }),
      ...(releaseContext.linear_project_id !== undefined && {
        linearProjectId: releaseContext.linear_project_id,
      }),
      ...(releaseContext.channel_source !== undefined && {
        channelSource: releaseContext.channel_source as ChannelSource,
      }),
      ...(releaseContext.pre_screened_attachments !== undefined && {
        preScreenedAttachments: releaseContext.pre_screened_attachments,
      }),
      ...(releaseContext.parent_context !== undefined && {
        parentContext: releaseContext.parent_context,
      }),
      ...(selection.shape !== 'root' && { baseBranch: selection.base_branch }),
      ...(selection.merge_branches.length > 0 && { mergeBranches: selection.merge_branches }),
      createTaskCore,
      now,
    });
    results.push({ ...childResult, subIssueId: row.sub_issue_id });
  }
  return results;
}

function extractTaskIdAndBranch(body: string): { taskId: string; branchName: string } {
  try {
    const parsed = JSON.parse(body) as {
      data?: { task_id?: string; branch_name?: string };
      task_id?: string;
      branch_name?: string;
    };
    return {
      taskId: parsed.data?.task_id ?? parsed.task_id ?? '',
      branchName: parsed.data?.branch_name ?? parsed.branch_name ?? '',
    };
  } catch {
    return { taskId: '', branchName: '' };
  }
}

async function rollbackClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  row: OrchestrationChildRow,
  now: string,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression: 'SET child_status = :ready, updated_at = :now',
      ConditionExpression: 'child_status = :releasing',
      ExpressionAttributeValues: { ':ready': 'ready', ':releasing': 'releasing', ':now': now },
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) return;
    logger.warn('Failed to roll back orchestration child claim (sweep will recover)', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function failClaimTerminal(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  row: OrchestrationChildRow,
  now: string,
  failureReason: string,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression: 'SET child_status = :failed, failure_reason = :reason, updated_at = :now',
      ConditionExpression: 'child_status = :releasing',
      ExpressionAttributeValues: {
        ':failed': 'failed',
        ':reason': failureReason,
        ':releasing': 'releasing',
        ':now': now,
      },
    }));
    logger.warn('Orchestration child marked terminally failed (deterministic create failure)', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
    });
  } catch (err) {
    if (isConditionalCheckFailed(err)) return;
    logger.warn('Failed to mark orchestration child terminally failed (sweep will recover)', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

/**
 * Persist the transitive skips caused by a child that failed DETERMINISTICALLY at
 * release time, and return the child view patched with the failure + skips.
 *
 * Idempotent: each skip write is guarded on ``child_status IN (blocked, ready)``,
 * so it never stamps a released/running sibling terminal.
 *
 * Returns ``children`` untouched when nothing failed terminally, so callers can
 * apply it unconditionally.
 */
export async function applyTerminalCreateFailures(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  children: readonly OrchestrationChildRow[],
  results: readonly ReleaseChildReadyResult[],
  now: string,
): Promise<readonly OrchestrationChildRow[]> {
  const failedReasons = new Map<string, string>();
  for (const r of results) {
    if (r.kind === 'create_failed_terminal') failedReasons.set(r.subIssueId, r.failureReason);
  }
  if (failedReasons.size === 0) return children;

  const statusById = new Map<string, ChildStatus>(children.map((c) => [c.sub_issue_id, c.child_status]));
  for (const failedId of failedReasons.keys()) {
    const plan = computeReconcilePlan(
      { sub_issue_id: failedId, status: 'FAILED' },
      children.map((c) => ({ ...c, child_status: statusById.get(c.sub_issue_id) ?? c.child_status })),
    );
    for (const u of plan.statusUpdates) statusById.set(u.sub_issue_id, u.child_status);
  }

  for (const [subIssueId, status] of statusById) {
    if (status !== 'skipped' || children.find((c) => c.sub_issue_id === subIssueId)?.child_status === 'skipped') {
      continue;
    }
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { orchestration_id: orchestrationId, sub_issue_id: subIssueId },
        UpdateExpression: 'SET child_status = :s, updated_at = :now',
        ConditionExpression: 'child_status IN (:blocked, :ready)',
        ExpressionAttributeValues: { ':s': 'skipped', ':blocked': 'blocked', ':ready': 'ready', ':now': now },
      }));
    } catch (err) {
      if (isConditionalCheckFailed(err)) continue;
      throw err;
    }
  }

  return children.map((c) => {
    if (failedReasons.has(c.sub_issue_id)) {
      return { ...c, child_status: 'failed' as const, failure_reason: failedReasons.get(c.sub_issue_id)! };
    }
    const s = statusById.get(c.sub_issue_id);
    return s === 'skipped' && c.child_status !== 'skipped' ? { ...c, child_status: 'skipped' as const } : c;
  });
}
