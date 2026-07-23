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
  | { readonly kind: 'already_released' }
  | { readonly kind: 'error'; readonly message: string };

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
  // ABCA-659 epic RETRY: salt with the prior child_task_id so a re-run of a
  // failed child creates a NEW task instead of idempotently replaying the failed
  // one. The prior id (a ULID, 26 alnum chars) keeps the key inside the charset;
  // orch_<32> + _ + <uuid 36> + _ + <ulid 26> ≈ 100 chars, under the 128 cap.
  // Only applied on retry AND when a prior task exists (a first release is
  // unchanged). Redelivery-safe: same prior id → same key → one new task.
  const baseKey = `${row.orchestration_id}_${row.sub_issue_id}`;
  const idempotencyKey = params.retry && row.child_task_id
    ? `${baseKey}_${row.child_task_id}`
    : baseKey;

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
    return { kind: 'create_failed', statusCode: result.statusCode, body: result.body };
  }

  const { taskId, branchName } = extractTaskIdAndBranch(result.body);

  // Flip the row to released, conditionally — only from a not-yet-started
  // state. A racing release loses here (ConditionalCheckFailed) and
  // returns already_released; createTaskCore's idempotency key means the
  // loser created no second task.
  //
  // #247 A4: also persist the child's branch_name so a DEPENDENT child's
  // release can stack on / merge it (selectBaseBranch reads predecessor
  // branch names off these rows).
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression:
        'SET child_status = :released, child_task_id = :tid, child_branch_name = :bn, updated_at = :now',
      ConditionExpression: 'child_status IN (:blocked, :ready)',
      ExpressionAttributeValues: {
        ':released': 'released',
        ':tid': taskId,
        ':bn': branchName,
        ':now': now,
        ':blocked': 'blocked',
        ':ready': 'ready',
      },
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      logger.info('Orchestration child already released (idempotent race)', {
        orchestration_id: row.orchestration_id,
        sub_issue_id: row.sub_issue_id,
      });
      return { kind: 'already_released' };
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
): Promise<readonly ReleaseChildResult[]> {
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
  const results: ReleaseChildResult[] = [];
  for (const row of releasable) {
    // Derive the base from this child's predecessors' persisted branches.
    const selection = selectBaseBranch({
      predecessors: row.depends_on.map((sub) => ({
        sub_issue_id: sub,
        branch_name: branchOf.get(sub) ?? '',
      })),
      defaultBranch,
    });
    results.push(await releaseChild({
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
    }));
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

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
