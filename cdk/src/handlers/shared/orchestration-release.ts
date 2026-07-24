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
 * Child-task release for orchestration (issue #247, Mode A — PR A3).
 *
 * The single path that turns an orchestration child row into a running
 * ABCA task. Used in two places:
 *   - seed time (the webhook processor / discovery): release the root
 *     children (layer 0) so the graph starts.
 *   - reconcile time (the TaskTable-stream reconciler): release children
 *     whose predecessors just all succeeded.
 *
 * Each release:
 *   1. createTaskCore(...) with channelSource 'linear' + orchestration
 *      metadata, idempotency-keyed on ``orchestration_id#sub_issue_id``
 *      so a duplicate stream event / webhook replay never double-creates.
 *   2. on 201, conditionally flip the row child_status blocked|ready →
 *      released and stamp child_task_id (the GSI then resolves the
 *      task back to its row on the child's terminal event).
 *
 * The conditional update (``child_status IN (blocked, ready)``) is the
 * second idempotency guard: if two reconcile invocations race the same
 * release, only one wins the status flip; createTaskCore's own
 * idempotency key means the loser doesn't create a second task either.
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
import type {
  OrchestrationChildRow,
  OrchestrationReleaseContext,
} from './orchestration-store';
import type { AttachmentRecord, ChannelSource } from './types';
import { MAX_ATTACHMENTS_PER_TASK } from './validation';

/**
 * The trigger channel an orchestration runs under. Defaults to ``'linear'``
 * everywhere (the only wired trigger today + back-compat for meta rows
 * seeded before the field existed). #247 trigger-agnostic seam.
 */
const DEFAULT_ORCHESTRATION_CHANNEL: ChannelSource = 'linear';

/**
 * #331: read a user's free concurrency budget (``cap - active_count``) so a
 * release pass throttles to it instead of over-releasing children that admission
 * control would then hard-fail. Best-effort: on any read error returns the full
 * ``cap`` (degrade to today's release-all behavior rather than stall the
 * orchestration — admission control is still the backstop). Never negative.
 *
 * NOTE this is an INSTANTANEOUS snapshot — between this read and the child task's
 * own admission attempt, other tasks may start. That race is fine: admission
 * control remains the hard ceiling; throttling here just keeps the common case
 * (a wide fan-out releasing into an empty/quiet user) from mass-failing. A child
 * that still loses a tighter race is left ``ready`` and retried (it is not over the
 * cap-as-guillotine path because the throttle keeps the batch small).
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
  /** The orchestration child row to release. */
  readonly row: OrchestrationChildRow;
  /** Platform user the child task is attributed to (parent's submitter). */
  readonly platformUserId: string;
  /** Linear OAuth secret ARN + slug for the agent's outbound Linear GraphQL
   *  (reactions/state via linear_reactions.py — there is no Linear MCP). */
  readonly linearOauthSecretArn?: string;
  readonly linearWorkspaceSlug?: string;
  readonly linearProjectId?: string;
  /** The base branch this child stacks on (#247 A4). Absent → root (off main). */
  readonly baseBranch?: string;
  /**
   * Predecessor branches to merge into the child's branch before work
   * (#247 A4 diamond case). Absent/empty for root + linear children.
   */
  readonly mergeBranches?: readonly string[];
  /** Injected createTaskCore (real handler in prod, mock in tests). */
  readonly createTaskCore: typeof CreateTaskCoreFn;
  /**
   * Parent-issue attachments (screened + stored once at seed time), inherited by
   * every child so the coding agent sees the parent's attached spec (finding #1).
   * Passed to createTaskCore's preScreenedAttachments seam. The PARENT owns these
   * S3 objects — a child failure must NOT delete them (createTaskCore only rolls
   * back its own inline uploads, of which children have none).
   */
  readonly preScreenedAttachments?: readonly AttachmentRecord[];
  /** ISO timestamp (injected for testability). */
  readonly now: string;
  /**
   * Trigger channel the child task is created under. Defaults to ``'linear'``.
   * Threaded from the orchestration's release context so a non-Linear trigger
   * attributes its children to the right plane. #247 trigger-agnostic seam.
   */
  readonly channelSource?: ChannelSource;
  /**
   * ABCA-659 epic RETRY: when true, the idempotency key is salted with the
   * child's PRIOR ``child_task_id`` so a re-run creates a genuinely NEW task
   * rather than idempotently replaying the failed one. The prior task id is
   * distinct per retry round (each round's prior task differs) yet stable within
   * a round (a webhook redelivery of the same retry sees the same prior id →
   * one new task, not many). A first release (no prior task id) is unaffected —
   * the key stays the back-compat ``orch_sub``. Without this, a retry flips the
   * row to ``released`` but ``createTaskCore`` returns the OLD failed task (200
   * idempotent replay) and nothing actually re-runs (live-caught on ABCA-659).
   */
  readonly retry?: boolean;
}

export type ReleaseChildResult =
  | { readonly kind: 'released'; readonly taskId: string }
  | { readonly kind: 'create_failed'; readonly statusCode: number; readonly body: string }
  // F9 (DE-stress 2026-07-24): the create failed DETERMINISTICALLY (a 4xx that
  // will fail identically on every retry — e.g. a guardrail/content-policy block
  // or a validation error), so the child was marked terminally ``failed`` rather
  // than rolled back to ``ready``. Distinct from ``create_failed`` (transient,
  // stays ``ready`` for the next sweep) so the caller settles the epic
  // finished-with-failures instead of re-attempting a doomed create forever.
  | { readonly kind: 'create_failed_terminal'; readonly statusCode: number; readonly body: string; readonly failureReason: string }
  | { readonly kind: 'already_released' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * A {@link ReleaseChildResult} tagged with the child it came from, returned by
 * {@link releaseReadyChildren} so a caller can correlate a result back to a row
 * (F9: patch a terminally-failed child into the in-memory view before settling).
 */
export type ReleaseChildReadyResult = ReleaseChildResult & { readonly subIssueId: string };

/** HTTP statuses that are TRANSIENT even though they're 4xx — a later sweep can
 *  succeed, so they roll back to 'ready' rather than terminally failing (F9). */
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_FORBIDDEN = 403; // access not yet granted — operationally fixable
const HTTP_NOT_FOUND = 404; // repo not yet onboarded — operationally fixable
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const TRANSIENT_4XX = new Set([HTTP_REQUEST_TIMEOUT, HTTP_TOO_MANY_REQUESTS, HTTP_FORBIDDEN, HTTP_NOT_FOUND]);

/**
 * F9: is a create-task HTTP status DETERMINISTIC (retrying it will fail the same
 * way) vs TRANSIENT (a later retry could succeed)? A guardrail/content-policy
 * block, a validation error, or a malformed request are 4xx that never change on
 * replay — re-attempting every sweep is an infinite silent strand. Throttle
 * (429) / timeout (408) ARE worth retrying, and 404/403 (un-onboarded repo /
 * access) are treated as transient too: they can be fixed operationally
 * (onboard the repo, grant access) without re-labelling, so a later sweep should
 * pick them up rather than terminally failing the child.
 */
function isDeterministicCreateFailure(statusCode: number): boolean {
  if (TRANSIENT_4XX.has(statusCode)) return false;
  return statusCode >= HTTP_CLIENT_ERROR_MIN && statusCode < HTTP_SERVER_ERROR_MIN;
}

/**
 * F9: a short, user-facing reason for a deterministic create failure, shown as
 * the child's panel ❌ sub-line (the child never got a task, so there's no
 * error_message to read). Recognises the guardrail/content-policy block — the
 * one deterministic 4xx a user can actually fix by rewording — and gives a
 * generic-but-honest line for other validation 4xx.
 */
function deterministicFailureReason(statusCode: number, body: string): string {
  const lower = (body || '').toLowerCase();
  if (lower.includes('content policy') || lower.includes('guardrail')) {
    return 'Blocked by content policy — reword this sub-issue and re-apply the label to retry.';
  }
  return `Could not start (validation error, HTTP ${statusCode}) — edit this sub-issue and re-apply the label to retry.`;
}

/** Build the child task description from the sub-issue's identifier/title. */
function buildChildDescription(row: OrchestrationChildRow): string {
  // #16: the synthetic integration node has no real sub-issue / feature
  // work — its job is to merge all leaf branches (already merged into its
  // branch by repo.py's predecessor-merge) into one combined result. Give
  // the agent a merge-focused instruction rather than a feature prompt.
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
  if (row.linear_identifier && row.title) {
    parts.push(`${row.linear_identifier}: ${row.title}`);
  } else if (row.title) {
    parts.push(row.title);
  } else if (row.linear_identifier) {
    parts.push(row.linear_identifier);
  }
  // PM-4: include the planner's scope below the title when it adds detail. The
  // reviewer approved a plan that may name a concrete deliverable (a filename, a
  // route); the coding agent must SEE it or it builds a title-only guess and the
  // plan's promise breaks (live-caught: plan said dashboard.html, agent shipped
  // team-dashboard.html → 404). Skip when the description just echoes the title.
  const desc = (row.description ?? '').trim();
  if (desc && desc !== row.title) parts.push(desc);
  return parts.join('\n\n') || `Linear sub-issue ${row.sub_issue_id}`;
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
    linear_workspace_id: row.linear_workspace_id,
    orchestration_id: row.orchestration_id,
    // The reconciler maps the terminal task back via this (real or synthetic) id.
    orchestration_sub_issue_id: row.sub_issue_id,
    parent_linear_issue_id: row.parent_linear_issue_id,
  };
  // #16: only set linear_issue_id (the agent's reaction/comment target) for a
  // REAL Linear sub-issue. A synthetic integration node has no Linear issue —
  // passing its id would make the agent's reactionCreate 4xx. Omitting it lets
  // the agent skip reactions cleanly.
  if (!isIntegrationNode(row.sub_issue_id)) {
    channelMetadata.linear_issue_id = row.sub_issue_id;
  }
  if (row.linear_identifier) channelMetadata.linear_issue_identifier = row.linear_identifier;
  if (params.linearProjectId) channelMetadata.linear_project_id = params.linearProjectId;
  if (params.linearOauthSecretArn) channelMetadata.linear_oauth_secret_arn = params.linearOauthSecretArn;
  if (params.linearWorkspaceSlug) channelMetadata.linear_workspace_slug = params.linearWorkspaceSlug;
  // #247 A4: stacked base branch + (diamond) predecessor merge-list. The
  // orchestrator reads these to set the agent payload's base_branch +
  // merge_branches. Absent for roots (agent branches off main as today).
  if (params.baseBranch) channelMetadata.orchestration_base_branch = params.baseBranch;
  if (params.mergeBranches && params.mergeBranches.length > 0) {
    channelMetadata.orchestration_merge_branches = JSON.stringify(params.mergeBranches);
  }

  // Deterministic idempotency key: same child never creates two tasks.
  // Separator is '_' (NOT '#') because createTaskCore validates the key
  // against /^[a-zA-Z0-9_-]{1,128}$/ — a '#' is rejected with a 400 and
  // the child silently never starts. orchestration_id (orch_<32hex>) +
  // '_' + sub_issue_id (a UUID, all hyphens) stays within 128 chars and
  // inside the allowed charset.
  //
  // RETRY REPLAY FIX (review blocker #2): salt the key with the prior
  // child_task_id WHENEVER the row already carries one — NOT only when the
  // caller passes retry=true. A child being (re-)released while it still has a
  // child_task_id inherently means that prior task is TERMINAL (a live child is
  // in 'released', never back in blocked/ready), so replaying it under the same
  // key would return the OLD failed task (200) and nothing runs. This bit a
  // dependency chain A→B: the epic-retry salts A (layer 0, retry=true) but B is
  // reset to blocked and later released by the reconciler with retry=false → the
  // unsalted key replayed B's dead task. Salting on the id's PRESENCE fixes both
  // the immediate layer and the downstream cascade. The prior id (a ULID, 26
  // alnum chars) keeps the key inside the charset; orch_<32> + _ + <uuid 36> +
  // _ + <ulid 26> ≈ 100 chars, under the 128 cap. A first release (no prior id)
  // is unchanged. Redelivery-safe: same prior id → same key → one new task.
  const baseKey = `${row.orchestration_id}_${row.sub_issue_id}`;
  const idempotencyKey = row.child_task_id
    ? `${baseKey}_${row.child_task_id}`
    : baseKey;

  // EXACTLY-ONCE FIX (review blocker #3): flip-then-create. The prior design
  // was create-then-flip — createTaskCore ran FIRST (irreversible: mints a task
  // + fire-and-forget invokes the orchestrator), and only afterward a conditional
  // row flip "deduped". But createTaskCore's own idempotency is an
  // eventually-consistent GSI read-then-write, so two concurrent releasers (the
  // live TaskTable-stream reconciler AND the #303 stranded sweep) could BOTH
  // pass the in-memory status check, BOTH createTaskCore before either flip
  // committed, and BOTH miss the other's not-yet-propagated write → two ECS
  // agents + two PRs for one sub-issue (documented in
  // docs/research/orchestration-reconciler-correctness.md §5-6, never fixed).
  //
  // Now we ATOMICALLY CLAIM the row (blocked|ready → releasing) BEFORE creating
  // the task. Only the invocation that wins this conditional Update proceeds to
  // createTaskCore; a racing releaser gets ConditionalCheckFailed and returns
  // already_released WITHOUT creating a task — the claim is the single
  // serialization point, now correctly ahead of the irreversible create. Do this
  // FIRST so a losing releaser bails before doing any attachment work below.
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

  // Attachments a feature child receives: the PARENT epic's spec (inherited via
  // release_context, finding #1) PLUS this sub-issue's OWN attachments (a mockup
  // attached to just this piece, hydrated at seed onto the child row). Merge both,
  // de-duped by attachment_id (a file both on the epic and the sub-issue isn't
  // passed twice). Integration nodes are a pure branch merge — they need neither.
  //
  // OWN attachments are listed FIRST so that, when the merged set would exceed the
  // per-task cap, the child's own files (most relevant to THIS piece) survive and
  // the shared epic spec is what gets trimmed. Capped at MAX_ATTACHMENTS_PER_TASK
  // with a loud log (never a silent truncation) — each source is independently
  // ≤10, so the merge can only overflow a pathological many-file epic+child.
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
    // BACKSTOP only: the webhook processor caps a child's OWN attachments against
    // the inherited count at stamp time AND posts a user-visible note there
    // (review #4). Reaching here means the merged set still overflowed (e.g. the
    // epic's own attachment set is large) — keep own-first ordering and log; this
    // is not the primary user-facing path, so a warn is the right level.
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
        task_description: buildChildDescription(row),
      },
      {
        userId: platformUserId,
        channelSource,
        channelMetadata,
        idempotencyKey,
        // Parent spec + this child's own attachments. Integration nodes are a pure
        // merge of already-built branches, so they don't need the spec — only real
        // feature children do. Records reference existing S3 objects (read-only).
        ...(mergedAttachments.length > 0
          && !isIntegrationNode(row.sub_issue_id)
          && { preScreenedAttachments: mergedAttachments }),
      },
      // requestId — reuse the idempotency key for trace correlation.
      idempotencyKey,
    );
  } catch (err) {
    logger.error('Orchestration child createTaskCore threw', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    // We won the claim (row is now 'releasing') but createTaskCore threw — roll
    // the claim BACK to 'ready' so a later reconcile/sweep can retry the release,
    // instead of leaving the child stuck in the transient 'releasing' state
    // forever. Conditional on still being 'releasing' (don't clobber a concurrent
    // transition). Best-effort — a failed rollback still gets swept by the
    // stranded-orchestration reconciler.
    await rollbackClaim(ddb, tableName, row, now);
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  // 201 = created; 200 = idempotent replay (task already existed). Both
  // mean "a task exists for this child" — treat alike.
  if (result.statusCode !== 201 && result.statusCode !== 200) {
    // Log the RESPONSE BODY, not just the status — a bare "status:400"
    // forces log-archaeology to find the cause (e.g. a rejected
    // idempotency key, an un-onboarded repo, a guardrail block). The
    // body carries the user-readable error message and code.
    logger.warn('Orchestration child task creation returned non-success', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      repo: row.repo,
      status: result.statusCode,
      response_body: result.body,
      idempotency_key: idempotencyKey,
    });
    // F9 (DE-stress 2026-07-24): split deterministic from transient failures.
    // A deterministic 4xx (guardrail/content-policy block, validation error)
    // fails identically on every retry — rolling back to 'ready' strands the
    // child in an infinite silent re-attempt loop (10-min sweep forever, no
    // terminal state, no ❌, epic stuck 👀). Mark it terminally 'failed' so the
    // reconcile settles the epic finished-with-failures and the child gets a ❌
    // + a reason (posted by the caller's terminal path). Only TRANSIENT failures
    // (5xx / throttle / un-onboarded-repo) roll back to 'ready' for a later retry.
    if (isDeterministicCreateFailure(result.statusCode)) {
      const failureReason = deterministicFailureReason(result.statusCode, result.body);
      await failClaimTerminal(ddb, tableName, row, now, failureReason);
      return { kind: 'create_failed_terminal', statusCode: result.statusCode, body: result.body, failureReason };
    }
    // Claim won but the create failed transiently (5xx, throttle, un-onboarded
    // repo) — roll the claim back to 'ready' so the next reconcile/sweep retries
    // it, rather than stranding the child in 'releasing'.
    await rollbackClaim(ddb, tableName, row, now);
    return { kind: 'create_failed', statusCode: result.statusCode, body: result.body };
  }

  const { taskId, branchName } = extractTaskIdAndBranch(result.body);

  // Finalize the claim: flip 'releasing' → 'released' and stamp the task id +
  // branch. We already hold the claim (won the conditional above), so this is
  // conditional only on still being 'releasing' — defensive against a concurrent
  // cancel/skip that legitimately moved the row on (in which case we do NOT
  // overwrite it; the created task's own terminal event reconciles).
  //
  // #247 A4: persist the child's branch_name so a DEPENDENT child's release can
  // stack on / merge it (selectBaseBranch reads predecessor branch names).
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression:
        'SET child_status = :released, child_task_id = :tid, child_branch_name = :bn, updated_at = :now',
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
      // The row moved off 'releasing' between our claim and finalize (a cancel
      // or skip landed). The task was created (idempotency-keyed), so its own
      // terminal event will reconcile — we just don't clobber the new state.
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
 * release context (from the meta row). Used both at seed time (release
 * roots) and by the reconciler (release newly-unblocked dependents).
 *
 * Each child is released independently; one failure does not abort the
 * rest (a transient create failure for child A shouldn't strand B). The
 * caller logs/handles per-child results — a ``create_failed`` row stays
 * ``ready`` and is retried on the next reconcile pass.
 */
export async function releaseReadyChildren(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  rows: readonly OrchestrationChildRow[],
  releaseContext: OrchestrationReleaseContext,
  createTaskCore: typeof CreateTaskCoreFn,
  now: string,
  /**
   * #247 A4: the FULL child set (not just the releasable subset), so a
   * child's base branch can be derived from its predecessors' persisted
   * ``child_branch_name``. Defaults to ``rows`` for back-compat with
   * callers that pass the full set as ``rows`` and release roots (roots
   * have no predecessors, so selection degrades to off-main).
   */
  allChildren?: readonly OrchestrationChildRow[],
  /** Repo default branch for roots + diamond bases. Defaults to 'main'. */
  defaultBranch = 'main',
  /**
   * #331: max children to actually release this pass — the user's free
   * concurrency budget (``cap - active_count``). When set, only this many
   * ``ready`` children are released; the rest are LEFT ``ready`` (a no-op,
   * not a failure) for a later reconcile pass to pick up as slots free.
   * ``undefined`` = release all (back-compat; callers that don't throttle).
   * A value ``<= 0`` releases nothing this pass.
   */
  maxToRelease?: number,
  /**
   * ABCA-659 epic RETRY: salt each child's idempotency key with its prior
   * ``child_task_id`` so a re-run spawns a NEW task instead of replaying the
   * failed one. Only the epic-retry path passes true; every other caller
   * (seed, extend, forward cascade, recovery) omits it → back-compat key.
   */
  retry = false,
): Promise<readonly ReleaseChildReadyResult[]> {
  const all = allChildren ?? rows;
  const branchOf = new Map(
    all.filter((c) => c.child_branch_name).map((c) => [c.sub_issue_id, c.child_branch_name as string]),
  );
  // #331: throttle to the available budget. Sort by sub_issue_id for a
  // deterministic, fair release order across passes. Releasing fewer than
  // are ready is intentional — the leftovers stay ``ready`` and the next
  // reconcile (sibling completion) or the #303 sweep releases them.
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
    // Derive the base from this child's predecessors' persisted branches.
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
      ...(releaseContext.linear_project_id !== undefined && {
        linearProjectId: releaseContext.linear_project_id,
      }),
      // #247 trigger-agnostic: carry the orchestration's channel onto the
      // child. ``releaseChild`` defaults to 'linear' when absent.
      ...(releaseContext.channel_source !== undefined && {
        channelSource: releaseContext.channel_source as ChannelSource,
      }),
      // finding #1: every child inherits the parent's screened attachments.
      ...(releaseContext.pre_screened_attachments !== undefined && {
        preScreenedAttachments: releaseContext.pre_screened_attachments,
      }),
      // Root → 'main' base, no merges (omit so today's off-main behavior
      // is unchanged). Linear → predecessor branch. Diamond → main + merges.
      ...(selection.shape !== 'root' && { baseBranch: selection.base_branch }),
      ...(selection.merge_branches.length > 0 && { mergeBranches: selection.merge_branches }),
      createTaskCore,
      now,
      retry,
    });
    // Correlate the result to its child so callers can patch their in-memory
    // view (F9: a terminally-failed child must be reflected in the settle that
    // runs right after this release, since no later stream event will re-drive
    // the reconciler for a child that never became a task).
    results.push({ ...childResult, subIssueId: row.sub_issue_id });
  }
  return results;
}

/** Pull task_id + branch_name out of a createTaskCore success body (best-effort). */
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

/**
 * Roll a claimed-but-not-created child back from the transient 'releasing' state
 * to 'ready' so a later reconcile/sweep can retry the release. Conditional on the
 * row still being 'releasing' (never clobber a concurrent transition). Best-effort:
 * if the rollback itself fails, the stranded-orchestration sweep still recovers a
 * child left in 'releasing' (it is treated as an in-flight release with no task id).
 * Preserves child_task_id so the retry-replay salt still applies on the next try.
 */
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
    if (isConditionalCheckFailed(err)) return; // already moved on — fine
    logger.warn('Failed to roll back orchestration child claim (sweep will recover)', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * F9: flip a claimed ('releasing') child to terminal 'failed' after a
 * DETERMINISTIC create failure (guardrail/validation) so it does NOT re-attempt
 * forever. Mirrors {@link rollbackClaim} but targets 'failed' instead of 'ready'
 * — the reconcile/sweep then settles the epic finished-with-failures and posts
 * the child's ❌. Conditional on still being 'releasing' (don't clobber a
 * concurrent cancel/skip). Best-effort: a failed write is swept by the
 * stranded-orchestration reconciler (which will see a 'releasing' row aged out).
 */
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
    if (isConditionalCheckFailed(err)) return; // already moved on — fine
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
