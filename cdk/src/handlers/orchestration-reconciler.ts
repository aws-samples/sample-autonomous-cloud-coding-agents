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
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { TaskStatus, TERMINAL_STATUSES, type TaskStatusType } from '../constructs/task-status';
import { rollupTaskCost } from './budget-rollup';
import { publishTaskMetrics } from './scoreboard-metrics';
import { createTaskCore } from './shared/create-task-core';
import { classifyError } from './shared/error-classifier';
import { renderFailureReply, renderPanelFailureReason } from './shared/failure-reply';
import { sumIterationCostForIssue } from './shared/iteration-cost';
import { isNoChangeIteration, renderMaturingReply } from './shared/iteration-reply';
import { claimTerminalReply, releaseReplyClaim } from './shared/iteration-reply-claim';
import {
  buildAdfDocument,
  postIssueCommentAdf,
} from './shared/jira-feedback';
import { updateJiraIterationComment } from './shared/jira-iteration-comment';
import {
  jiraIterationFrame,
  renderJiraFinalStatusComment,
  renderJiraFinishedPointer,
} from './shared/jira-status-comment';
import { logger } from './shared/logger';
import { type LookupResult, LOOKUP_ABSENT, isLookupFailure, lookupFailed, lookupFound, lookupValueOr } from './shared/lookup-result';
import type { Channel, CommentRef, IssueRef } from './shared/orchestration-channel';
import { channelForSource, type ChannelRegistryTables } from './shared/orchestration-channel-factory';
import { computeLeaves, isIntegrationNode } from './shared/orchestration-integration-node';
import { ORCH_LOG } from './shared/orchestration-log-events';
import {
  computeReconcilePlan,
  computeRecoveryPlan,
  type ReconcileChild,
  type TerminalOutcome,
} from './shared/orchestration-reconcile';
import { applyTerminalCreateFailures, readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { planDirectRestack, type RestackStep } from './shared/orchestration-restack';
import { cascadeNodeLabel, upsertEpicPanel } from './shared/orchestration-rollup';
import {
  claimRollup,
  clearRollupClaim,
  loadOrchestration,
  ORCHESTRATION_META_SK,
  setRetryCommentId,
  setStatusCommentId,
  type OrchestrationChildRow,
} from './shared/orchestration-store';
import { encodeMarkdownUrl } from './shared/screenshot-url';
import { ORCHESTRATION_CHILD_TASK_INDEX_NAME } from './shared/storage-names';
import { readTaskPrNumber } from './shared/task-pr-number';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
const JIRA_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;

const CHANNEL_REGISTRY_TABLES: ChannelRegistryTables = {
  linear: WORKSPACE_REGISTRY_TABLE,
  jira: JIRA_REGISTRY_TABLE,
};

const channelForMeta = (meta: { release_context?: { channel_source?: string } }): Channel | undefined =>
  channelForSource(meta.release_context?.channel_source, CHANNEL_REGISTRY_TABLES);

const issueRef = (
  issueId: string,
  workspaceId: string,
  releaseContext?: {
    readonly jira_status_on_start?: string;
    readonly jira_status_on_pr?: string;
  },
): IssueRef => ({
  issueId,
  credentialsRef: workspaceId,
  ...((releaseContext?.jira_status_on_start || releaseContext?.jira_status_on_pr) && {
    stateOverrides: {
      ...(releaseContext.jira_status_on_start && {
        started: releaseContext.jira_status_on_start,
      }),
      ...(releaseContext.jira_status_on_pr && {
        inReview: releaseContext.jira_status_on_pr,
      }),
    },
  }),
});

const childIssueRef = (
  children: readonly OrchestrationChildRow[],
  subIssueId: string,
  workspaceId: string,
): IssueRef => issueRef(
  subIssueId,
  workspaceId,
  children.find((c) => c.sub_issue_id === subIssueId)?.channel_metadata,
);
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
const TERMINAL: ReadonlySet<TaskStatusType> = new Set<TaskStatusType>(TERMINAL_STATUSES);

interface TerminalTaskEvent {
  readonly taskId: string;
  readonly status: TaskStatusType;
  readonly buildPassed?: boolean;
  readonly errorMessage?: string;
  readonly orchestrationId?: string;
  readonly cascadeSubIssueId?: string;
  readonly cascadeIsIteration?: boolean;
  readonly triggerCommentId?: string;
  readonly triggerCommentIssueId?: string;
  readonly codeChanged?: boolean;
  readonly answerText?: string;
  readonly iterationReplyId?: string;
  readonly costUsd?: number;
  readonly durationS?: number;
  readonly turns?: number;
  readonly maxTurns?: number;
}

/**
 * Extract a terminal-task event from a TaskTable stream record. Returns
 * null for records we don't act on (inserts, non-terminal MODIFYs,
 * non-orchestration tasks, malformed images).
 */
// eslint-disable-next-line complexity -- predates the ceiling (71 when it landed); must not grow
export function parseTerminalTaskRecord(record: DynamoDBRecord): TerminalTaskEvent | null {
  if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') return null;
  const img = record.dynamodb?.NewImage;
  if (!img) return null;

  const taskId = img.task_id?.S;
  const status = img.status?.S as TaskStatusType | undefined;
  if (!taskId || !status) return null;
  if (!TERMINAL.has(status)) return null;

  const orchestrationId =
    img.orchestration_id?.S
    ?? img.channel_metadata?.M?.orchestration_id?.S;
  if (!orchestrationId) return null;

  const buildPassed = img.build_passed?.BOOL;
  const errorMessage = img.error_message?.S;
  const codeChanged = img.code_changed?.BOOL;
  const answerText = img.answer_text?.S;
  const iterationReplyId = img.channel_metadata?.M?.iteration_reply_comment_id?.S;
  const costUsd = img.cost_usd?.N !== undefined ? Number(img.cost_usd.N)
    : (img.cost_usd?.S !== undefined ? Number(img.cost_usd.S) : undefined);
  const durationS = img.duration_s?.N !== undefined ? Number(img.duration_s.N)
    : (img.duration_s?.S !== undefined ? Number(img.duration_s.S) : undefined);
  const turns = img.turns_attempted?.N !== undefined ? Number(img.turns_attempted.N)
    : (img.turns_attempted?.S !== undefined ? Number(img.turns_attempted.S) : undefined);
  const maxTurns = img.max_turns?.N !== undefined ? Number(img.max_turns.N)
    : (img.max_turns?.S !== undefined ? Number(img.max_turns.S) : undefined);

  const cm = img.channel_metadata?.M;
  const isIteration = cm?.orchestration_iteration?.S === 'true';
  const isCascadeSource =
    cm?.restack_predecessor_sub_issue_id?.S !== undefined || isIteration;
  const cascadeSubIssueId = isCascadeSource ? cm?.orchestration_sub_issue_id?.S : undefined;
  const triggerCommentId = isIteration ? cm?.trigger_comment_id?.S : undefined;
  const triggerCommentIssueId = isIteration ? cm?.trigger_comment_issue_id?.S : undefined;

  return {
    taskId,
    status,
    ...(buildPassed !== undefined && { buildPassed }),
    ...(errorMessage !== undefined && { errorMessage }),
    orchestrationId,
    ...(cascadeSubIssueId !== undefined && { cascadeSubIssueId }),
    ...(cascadeSubIssueId !== undefined && { cascadeIsIteration: isIteration }),
    ...(triggerCommentId !== undefined && { triggerCommentId }),
    ...(triggerCommentIssueId !== undefined && { triggerCommentIssueId }),
    ...(codeChanged !== undefined && { codeChanged }),
    ...(answerText !== undefined && { answerText }),
    ...(iterationReplyId !== undefined && { iterationReplyId }),
    ...(costUsd !== undefined && Number.isFinite(costUsd) && { costUsd }),
    ...(durationS !== undefined && Number.isFinite(durationS) && { durationS }),
    ...(turns !== undefined && Number.isFinite(turns) && { turns }),
    ...(maxTurns !== undefined && Number.isFinite(maxTurns) && { maxTurns }),
  };
}

async function resolveSubIssueId(taskId: string): Promise<string | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: ORCHESTRATION_TABLE,
    IndexName: ORCHESTRATION_CHILD_TASK_INDEX_NAME,
    KeyConditionExpression: 'child_task_id = :tid',
    ExpressionAttributeValues: { ':tid': taskId },
    Limit: 1,
  }));
  const item = res.Items?.[0] as OrchestrationChildRow | undefined;
  return item?.sub_issue_id ?? null;
}

async function resolveChildPrUrls(
  children: readonly OrchestrationChildRow[],
): Promise<Record<string, string>> {
  const withTask = children.filter((c) => c.child_task_id);
  if (withTask.length === 0) return {};
  const taskToSub = new Map(withTask.map((c) => [c.child_task_id!, c.sub_issue_id]));
  const keys = [...taskToSub.keys()].map((task_id) => ({ task_id }));
  const out: Record<string, string> = {};
  try {
    // BatchGet caps at 100 keys/request.
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await ddb.send(new BatchGetCommand({
        RequestItems: { [TASK_TABLE]: { Keys: chunk, ProjectionExpression: 'task_id, pr_url' } },
      }));
      for (const rec of res.Responses?.[TASK_TABLE] ?? []) {
        const taskId = rec.task_id as string | undefined;
        const prUrl = rec.pr_url as string | undefined;
        const sub = taskId ? taskToSub.get(taskId) : undefined;
        if (sub && prUrl) out[sub] = prUrl;
      }
    }
  } catch (err) {
    logger.warn('Rollup pr_url batch-read failed (non-fatal) — rollup posts without links', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

async function resolveChildFailureReasons(
  children: readonly OrchestrationChildRow[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of children) {
    if (c.child_status === 'failed' && c.failure_reason) out[c.sub_issue_id] = c.failure_reason;
  }
  const failed = children.filter((c) => c.child_status === 'failed' && c.child_task_id && !c.failure_reason);
  if (failed.length === 0) return out;
  const taskToSub = new Map(failed.map((c) => [c.child_task_id!, c.sub_issue_id]));
  const isIntegration = new Map(failed.map((c) => [c.sub_issue_id, isIntegrationNode(c.sub_issue_id)]));
  const keys = [...taskToSub.keys()].map((task_id) => ({ task_id }));
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await ddb.send(new BatchGetCommand({
        RequestItems: {
          [TASK_TABLE]: { Keys: chunk, ProjectionExpression: 'task_id, error_message, build_passed' },
        },
      }));
      for (const rec of res.Responses?.[TASK_TABLE] ?? []) {
        const taskId = rec.task_id as string | undefined;
        const sub = taskId ? taskToSub.get(taskId) : undefined;
        if (!sub || !taskId) continue;
        const reason = renderPanelFailureReason({
          ...(typeof rec.build_passed === 'boolean' && { buildPassed: rec.build_passed as boolean }),
          ...(typeof rec.error_message === 'string' && { errorMessage: rec.error_message as string }),
          taskId,
          isIntegration: isIntegration.get(sub) ?? false,
        });
        if (reason) out[sub] = reason;
      }
    }
  } catch (err) {
    logger.warn('Panel failure-reason batch-read failed (non-fatal) — panel posts without sub-lines', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

function soleLeafChild(
  children: readonly OrchestrationChildRow[],
): OrchestrationChildRow | undefined {
  const leaves = computeLeaves(children.map((c) => ({
    id: c.sub_issue_id,
    depends_on: [...c.depends_on],
    title: c.sub_issue_id,
  })));
  if (leaves.length !== 1) return undefined;
  return children.find((c) => c.sub_issue_id === leaves[0]);
}

async function resolveCombinedScreenshotUrl(
  taskId?: string,
): Promise<LookupResult<{ url: string; previewUrl?: string }>> {
  if (!taskId) return LOOKUP_ABSENT;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      ConsistentRead: true,
      ProjectionExpression: 'screenshot_url, screenshot_preview_url',
    }));
    const url = res.Item?.screenshot_url;
    if (typeof url !== 'string' || url.length === 0) return LOOKUP_ABSENT;
    const previewUrl = res.Item?.screenshot_preview_url;
    return lookupFound({
      url,
      ...(typeof previewUrl === 'string' && previewUrl.length > 0 && { previewUrl }),
    });
  } catch (err) {
    logger.warn('Combined screenshot read failed (non-fatal) — panel posts without it', {
      task_id: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
}

async function reloadIterationScreenshot(taskId?: string): Promise<{ screenshotUrl: string | null; deployUrl: string | null }> {
  if (!taskId) return { screenshotUrl: null, deployUrl: null };
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      ProjectionExpression: 'screenshot_url, screenshot_preview_url',
      ConsistentRead: true,
    }));
    const s = res.Item?.screenshot_url;
    const d = res.Item?.screenshot_preview_url;
    return {
      screenshotUrl: typeof s === 'string' && s.length > 0 ? s : null,
      deployUrl: typeof d === 'string' && d.length > 0 ? d : null,
    };
  } catch (err) {
    logger.warn('Iteration screenshot re-read failed (non-fatal)', {
      task_id: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return { screenshotUrl: null, deployUrl: null };
  }
}

/**
 * After this window a person may have taken the issue over, and the surface cannot tell
 * their running state from the agent's (#1073).
 */
const SETTLE_WINDOW_MINUTES = 5;

function writeTimeMs(record: DynamoDBRecord): number {
  const stamp: unknown = record.dynamodb?.ApproximateCreationDateTime;
  if (typeof stamp === 'number') return stamp * 1000;
  return typeof stamp === 'string' && /^\d+(\.\d+)?$/.test(stamp) ? Number(stamp) * 1000 : NaN;
}

function writtenLongAfterTaskEnded(record: DynamoDBRecord, verdictOnRow: boolean): boolean {
  const endedAtMs = Date.parse(record.dynamodb?.NewImage?.completed_at?.S ?? '');
  const writtenAtMs = writeTimeMs(record);
  if (Number.isNaN(endedAtMs) || Number.isNaN(writtenAtMs)) return verdictOnRow;
  return writtenAtMs - endedAtMs > SETTLE_WINDOW_MINUTES * 60 * 1000;
}

function logLateRecord(
  record: DynamoDBRecord,
  ids: { orchestration_id: string; sub_issue_id: string; task_id: string },
  broughtVerdict: boolean,
): void {
  const writtenAt = new Date(writeTimeMs(record));
  logger[broughtVerdict ? 'warn' : 'info']('Reconciler left the issue of a failed child alone: a late write on its task record', {
    ...ids,
    completed_at: record.dynamodb?.NewImage?.completed_at?.S ?? null,
    written_at: Number.isNaN(writtenAt.getTime()) ? null : writtenAt.toISOString(),
    brought_verdict: broughtVerdict,
  });
}

async function recordUnsettled(
  ids: { orchestration_id: string; sub_issue_id: string; task_id: string },
  owed: boolean,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: ORCHESTRATION_TABLE,
      Key: { orchestration_id: ids.orchestration_id, sub_issue_id: ids.sub_issue_id },
      UpdateExpression: owed ? 'SET unsettled_task_id = :tid' : 'REMOVE unsettled_task_id',
      ConditionExpression: owed ? 'child_task_id = :tid' : 'unsettled_task_id = :tid',
      ExpressionAttributeValues: { ':tid': ids.task_id },
    }));
    if (owed) {
      logger.warn('Settle of a failed child did not land: owed to the next record of its task', ids);
    } else {
      logger.info('Settle of a failed child is no longer owed', ids);
    }
  } catch (err) {
    if (isConditionalCheckFailed(err)) return;
    logger.warn('Could not record whether the settle of a failed child is owed (non-fatal)', {
      ...ids, owed, error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function reconcileTerminalChild(evt: TerminalTaskEvent, record: DynamoDBRecord): Promise<void> {
  const orchestrationId = evt.orchestrationId!;

  const subIssueId = await resolveSubIssueId(evt.taskId);
  if (!subIssueId) {
    logger.warn('Reconciler could not resolve sub_issue_id for terminal task', {
      task_id: evt.taskId,
      orchestration_id: orchestrationId,
    });
    return;
  }

  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot) {
    logger.warn('Reconciler found no orchestration snapshot (TTL-reaped?)', {
      orchestration_id: orchestrationId,
      task_id: evt.taskId,
    });
    return;
  }

  const children: ReconcileChild[] = snapshot.children.map((c) => ({
    sub_issue_id: c.sub_issue_id,
    depends_on: c.depends_on,
    child_status: c.child_status,
  }));

  const outcome: TerminalOutcome = {
    sub_issue_id: subIssueId,
    status: evt.status as TerminalOutcome['status'],
    ...(evt.buildPassed !== undefined && { build_passed: evt.buildPassed }),
  };

  const plan = computeReconcilePlan(outcome, children);
  const now = new Date().toISOString();

  let stale = false;
  for (const update of plan.statusUpdates) {
    if (plan.toRelease.includes(update.sub_issue_id)) continue;
    const skipGuard = update.child_status === 'skipped';
    const values: Record<string, unknown> = { ':s': update.child_status, ':now': now };
    let condition: string;
    if (skipGuard) {
      values[':blocked'] = 'blocked';
      values[':ready'] = 'ready';
      condition = 'child_status IN (:blocked, :ready)';
    } else {
      values[':tid'] = evt.taskId;
      values[':running'] = 'released';
      condition = 'child_task_id = :tid AND (child_status = :running OR child_status = :s)';
    }
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :s, updated_at = :now',
        ConditionExpression: condition,
        ExpressionAttributeValues: values,
      }));
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (skipGuard) continue;
      logger.info('Reconciler left a row alone: its status is no longer decided by this task', {
        orchestration_id: orchestrationId,
        sub_issue_id: subIssueId,
        task_id: evt.taskId,
        task_status: outcome.status,
      });
      stale = true;
      break;
    }
  }

  const settleChannel = channelForMeta(snapshot.meta);
  if (settleChannel && !plan.terminalSucceeded && !stale && !isIntegrationNode(subIssueId)) {
    const channel = settleChannel;
    const ids = { orchestration_id: orchestrationId, sub_issue_id: subIssueId, task_id: evt.taskId };
    const rowAsRead = snapshot.children.find((c) => c.sub_issue_id === subIssueId);
    const broughtVerdict = rowAsRead?.child_status !== 'failed';
    const owed = rowAsRead?.unsettled_task_id === evt.taskId;
    const late = writtenLongAfterTaskEnded(record, !broughtVerdict);
    if (late && !owed) {
      if (channel.revertState || channel.replaceIssueReaction) logLateRecord(record, ids, broughtVerdict);
    } else {
      const childRef = issueRef(subIssueId, snapshot.meta.credentials_ref);
      let reverted: boolean | null = null;
      let landed = false;
      try {
        reverted = (await channel.revertState?.(childRef)) ?? false;
        const reactionSwapped = await channel.replaceIssueReaction?.(childRef, 'failed');
        if (reverted || reactionSwapped) {
          logger.info('Reconciler settled a failed child to match the graph (state + reaction)', {
            orchestration_id: orchestrationId,
            sub_issue_id: subIssueId,
            task_status: outcome.status,
            build_passed: outcome.build_passed,
            state_reverted: reverted,
            reaction_swapped: reactionSwapped ?? false,
          });
        }
        landed = reactionSwapped !== false;
      } catch (err) {
        logger.warn('Failed to reconcile failed child Linear state/reaction (non-fatal)', {
          orchestration_id: orchestrationId,
          sub_issue_id: subIssueId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      let unsettled = false;
      if (!landed) {
        unsettled = !late;
        if (late) {
          logger.warn('Settle of a failed child did not land on its last try: its issue can contradict the graph', {
            ...ids,
            state_reverted: reverted,
          });
        }
      }
      if (unsettled !== owed) await recordUnsettled(ids, unsettled);
    }
  }

  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  let freshChildren = fresh?.children ?? snapshot.children;
  const succeeded = new Set(
    freshChildren.filter((c) => c.child_status === 'succeeded').map((c) => c.sub_issue_id),
  );
  const releasableRows = freshChildren
    .filter((c) =>
      (c.child_status === 'blocked' && c.depends_on.every((d) => succeeded.has(d)))
      || (c.child_status === 'ready' && c.depends_on.every((d) => succeeded.has(d))))
    .map((c) => ({ ...c, child_status: 'ready' as const }));

  if (releasableRows.length > 0) {
    const releaseCtx = (fresh ?? snapshot).meta.release_context;
    const budget = USER_CONCURRENCY_TABLE
      ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, releaseCtx.platform_user_id, MAX_CONCURRENT)
      : undefined;
    const results = await releaseReadyChildren(
      ddb,
      ORCHESTRATION_TABLE,
      releasableRows,
      releaseCtx,
      createTaskCore,
      now,
      freshChildren,
      'main',
      budget,
    );
    const started = new Set(results.filter((r) => r.kind === 'released').map((r) => r.subIssueId));
    logger.info('Reconciler released children', {
      orchestration_id: orchestrationId,
      trigger_sub_issue_id: subIssueId,
      released: started.size,
      terminally_failed: results.filter((r) => r.kind === 'create_failed_terminal').length,
      requested: releasableRows.length,
      ...(budget !== undefined && { concurrency_budget: budget }),
    });
    freshChildren = await applyTerminalCreateFailures(
      ddb, ORCHESTRATION_TABLE, orchestrationId, freshChildren, results, now,
    );
    freshChildren = freshChildren.map((c) =>
      (started.has(c.sub_issue_id) ? { ...c, child_status: 'released' as const } : c));
  }

  await refreshPanelAndSettle(orchestrationId, freshChildren, (fresh ?? snapshot).meta, now);
}

/**
 * Maintain the SINGLE maturing epic panel — one comment, edited in
 * place — and settle the parent state when the epic reaches all-terminal.
 *
 * Best-effort; only when the orchestration's surface has a usable adapter. The
 * panel BODY edit is idempotent (same body = no-op), so it always runs; the
 * parent-STATE mirror is claimed once via ``claimRollup`` on the first
 * all-terminal caller, which gives the claim back when its edit of the panel
 * does not land, for one day after the epic ended or was re-opened last.
 */
export async function refreshPanelAndSettle(
  orchestrationId: string,
  children: readonly OrchestrationChildRow[],
  meta: {
    credentials_ref: string;
    parent_issue_ref: string;
    status_comment_id?: string;
    retry_comment_id?: string;
    updated_at?: string;
    release_context?: {
      channel_source?: string;
      trigger_label?: string;
      jira_status_on_start?: string;
      jira_status_on_pr?: string;
    };
  },
  now: string,
): Promise<void> {
  const channel = channelForMeta(meta);
  if (!channel) return;

  const allTerminal = children.every((c) =>
    c.child_status === 'succeeded' || c.child_status === 'failed' || c.child_status === 'skipped',
  );

  const prUrls = await resolveChildPrUrls(children);
  const anyFailed = children.some((c) => c.child_status === 'failed');
  const failureReasons = anyFailed ? await resolveChildFailureReasons(children) : {};
  const integration = children.find((c) => isIntegrationNode(c.sub_issue_id));
  const combinedPrUrl = integration ? prUrls[integration.sub_issue_id] : undefined;
  const previewNode = integration ?? soleLeafChild(children);
  const combinedScreenshot = (allTerminal && previewNode)
    ? lookupValueOr(await resolveCombinedScreenshotUrl(previewNode.child_task_id), null)
    : null;

  if (allTerminal) {
    logger.info('Orchestration complete', {
      event: ORCH_LOG.orchestrationComplete,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: meta.parent_issue_ref,
      succeeded: children.filter((c) => c.child_status === 'succeeded').length,
      failed: children.filter((c) => c.child_status === 'failed').length,
      skipped: children.filter((c) => c.child_status === 'skipped').length,
    });
  }

  const won = !allTerminal || await claimRollup(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  const panel = await upsertEpicPanel({
    channel,
    parent: issueRef(meta.parent_issue_ref, meta.credentials_ref, meta.release_context),
    ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
    children,
    prUrls,
    ...(Object.keys(failureReasons).length > 0 && { failureReasons }),
    ...(combinedPrUrl !== undefined && { combinedPrUrl }),
    ...(combinedScreenshot !== null && { combinedScreenshotUrl: combinedScreenshot.url }),
    ...(combinedScreenshot?.previewUrl !== undefined && { combinedPreviewUrl: combinedScreenshot.previewUrl }),
    inProgress: !allTerminal,
    mirrorParentState: allTerminal ? won : false,
    ...(meta.release_context?.trigger_label !== undefined
      && { labelFilter: meta.release_context.trigger_label }),
  });
  const newId = lookupValueOr(panel, null);
  if (newId && !meta.status_comment_id) {
    try {
      await setStatusCommentId(ddb, ORCHESTRATION_TABLE, orchestrationId, newId);
    } catch (err) {
      logger.warn('Failed to persist panel comment id (non-fatal)', {
        orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const endedAt = Math.max(
    ...children.map((c) => Date.parse(c.updated_at)),
    meta.updated_at === undefined ? -Infinity : Date.parse(meta.updated_at),
  );
  if (allTerminal && won && meta.status_comment_id !== undefined && !panel.ok
    && Date.parse(now) - endedAt < GIVE_BACK_WINDOW_MS) {
    await releaseRollupClaim(orchestrationId, now);
    return;
  }

  if (allTerminal && won && meta.retry_comment_id) {
    await settleRetryComment(orchestrationId, meta.retry_comment_id, children, channel, meta);
  }
}

const GIVE_BACK_WINDOW_MS = 24 * 60 * 60 * 1000;

async function releaseRollupClaim(orchestrationId: string, stamp: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: ORCHESTRATION_TABLE,
      Key: { orchestration_id: orchestrationId, sub_issue_id: ORCHESTRATION_META_SK },
      UpdateExpression: 'REMOVE rollup_posted_at',
      ConditionExpression: 'rollup_posted_at = :ours',
      ExpressionAttributeValues: { ':ours': stamp },
    }));
    logger.warn('Final panel edit did not land — gave the settle claim back for another attempt', {
      orchestration_id: orchestrationId,
    });
  } catch (err) {
    if (isConditionalCheckFailed(err)) return;
    logger.warn('Could not give the settle claim back (non-fatal)', {
      orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function settleRetryComment(
  orchestrationId: string,
  retryCommentId: string,
  children: readonly OrchestrationChildRow[],
  channel: Channel,
  meta: { credentials_ref: string; parent_issue_ref: string },
): Promise<void> {
  const anyBad = children.some((c) => c.child_status === 'failed' || c.child_status === 'skipped');
  try {
    await setRetryCommentId(ddb, ORCHESTRATION_TABLE, orchestrationId, undefined);
    await channel.replaceCommentReaction?.(
      { commentId: retryCommentId },
      issueRef(meta.parent_issue_ref, meta.credentials_ref),
      anyBad ? 'failed' : 'succeeded',
    );
    logger.info('Settled the retry comment to match the epic outcome', {
      orchestration_id: orchestrationId,
      comment_id: retryCommentId,
      outcome: anyBad ? 'failed' : 'succeeded',
    });
  } catch (err) {
    logger.warn('Could not settle the retry comment (non-fatal)', {
      orchestration_id: orchestrationId,
      comment_id: retryCommentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cascadeRestack(evt: TerminalTaskEvent): Promise<void> {
  const orchestrationId = evt.orchestrationId!;
  const changedSubIssueId = evt.cascadeSubIssueId!;
  const succeeded = evt.status === TaskStatus.COMPLETED && evt.buildPassed !== false;
  const now = new Date().toISOString();

  if (evt.triggerCommentId) {
    await replyToIterationComment(evt, changedSubIssueId, succeeded);
  }

  if (!succeeded) {
    logger.info('Restack cascade: source task not successful — not cascading', {
      orchestration_id: orchestrationId,
      changed_sub_issue_id: changedSubIssueId,
      status: evt.status,
    });
    return;
  }

  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot) {
    logger.warn('Restack cascade: orchestration snapshot not found', { orchestration_id: orchestrationId });
    return;
  }

  const branchMoved = evt.codeChanged !== false;

  if (branchMoved) await maybeRecoverFailedNode(orchestrationId, snapshot, changedSubIssueId, now);

  const steps = branchMoved ? planDirectRestack(snapshot.children, changedSubIssueId) : [];
  if (steps.length === 0) {
    logger.info('Restack cascade: nothing to re-stack (branch unchanged, or no started direct dependent)', {
      orchestration_id: orchestrationId,
      changed_sub_issue_id: changedSubIssueId,
      branch_moved: branchMoved,
    });
    const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
    await refreshPanelAndSettle(orchestrationId, (fresh ?? snapshot).children, (fresh ?? snapshot).meta, now);
    return;
  }

  logger.info('Restack cascade: re-stacking direct dependents', {
    orchestration_id: orchestrationId,
    changed_sub_issue_id: changedSubIssueId,
    source_task_id: evt.taskId,
    dependent_count: steps.length,
  });

  const meta = snapshot.meta;
  const changedRow = snapshot.children.find((c) => c.sub_issue_id === changedSubIssueId);
  const changedLabel = cascadeNodeLabel(changedSubIssueId, changedRow?.display_id, changedRow?.title);

  const cascadeChannel = channelForMeta(meta);

  const updatingIds: string[] = [];
  for (const step of steps) {
    const created = await spawnRestackTask(step, meta.release_context.platform_user_id, evt.taskId, changedSubIssueId);
    if (created !== 'created') continue;
    updatingIds.push(step.child.sub_issue_id);
  }

  if (cascadeChannel && updatingIds.length > 0) {
    await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);
    const reason = evt.cascadeIsIteration
      ? `per ${changedLabel}'s comment`
      : `to include ${changedLabel}'s change`;
    const updating: Record<string, string> = {};
    for (const id of updatingIds) updating[id] = reason;
    const cascadeFresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
    const panelChildren = cascadeFresh?.children ?? snapshot.children;
    const prUrls = await resolveChildPrUrls(panelChildren);
    const integration = panelChildren.find((c) => isIntegrationNode(c.sub_issue_id));
    await upsertEpicPanel({
      channel: cascadeChannel,
      parent: issueRef(meta.parent_issue_ref, meta.credentials_ref, meta.release_context),
      ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
      children: panelChildren,
      prUrls,
      updating,
      ...(integration && prUrls[integration.sub_issue_id] !== undefined
        && { combinedPrUrl: prUrls[integration.sub_issue_id] }),
      inProgress: true,
    });
  }
}

async function maybeRecoverFailedNode(
  orchestrationId: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>,
  recoveredSubIssueId: string,
  now: string,
): Promise<void> {
  const children: ReconcileChild[] = snapshot.children.map((c) => ({
    sub_issue_id: c.sub_issue_id,
    depends_on: c.depends_on,
    child_status: c.child_status,
  }));
  const plan = computeRecoveryPlan(recoveredSubIssueId, children);
  if (plan.statusUpdates.length === 0) return;

  logger.info('Recovery cascade: un-failing node + resetting skipped subtree', {
    orchestration_id: orchestrationId,
    recovered_sub_issue_id: recoveredSubIssueId,
    un_skipped: plan.statusUpdates.length - 1,
    re_releasing: plan.toRelease.length,
  });

  for (const update of plan.statusUpdates) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :s, updated_at = :now',
        ConditionExpression: 'child_status <> :s',
        ExpressionAttributeValues: { ':s': update.child_status, ':now': now },
      }));
    } catch (err) {
      if (isConditionalCheckFailed(err)) continue;
      throw err;
    }
  }

  await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  const freshChildren = fresh?.children ?? snapshot.children;
  if (plan.toRelease.length > 0) {
    const releasableRows = freshChildren
      .filter((c) => plan.toRelease.includes(c.sub_issue_id))
      .map((c) => ({ ...c, child_status: 'ready' as const }));
    if (releasableRows.length > 0) {
      const releaseCtx = (fresh ?? snapshot).meta.release_context;
      const budget = USER_CONCURRENCY_TABLE
        ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, releaseCtx.platform_user_id, MAX_CONCURRENT)
        : undefined;
      const results = await releaseReadyChildren(
        ddb,
        ORCHESTRATION_TABLE,
        releasableRows,
        releaseCtx,
        createTaskCore,
        now,
        freshChildren,
        'main',
        budget,
      );
      logger.info('Recovery cascade: re-released children', {
        orchestration_id: orchestrationId,
        recovered_sub_issue_id: recoveredSubIssueId,
        released: results.filter((r) => r.kind === 'released').length,
        requested: releasableRows.length,
      });
    }
  }

  const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  await refreshPanelAndSettle(
    orchestrationId,
    (refreshed ?? fresh ?? snapshot).children,
    (refreshed ?? fresh ?? snapshot).meta,
    now,
  );
}

// eslint-disable-next-line complexity -- predates the ceiling (52, down from 54 when it landed); must not grow
async function replyToIterationComment(
  evt: TerminalTaskEvent,
  changedSubIssueId: string,
  succeeded: boolean,
): Promise<void> {
  const commentId = evt.triggerCommentId!;

  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, evt.orchestrationId!);
  if (!snapshot) return;
  const channel = channelForMeta(snapshot.meta);
  if (!channel) return;
  const workspaceId = snapshot.meta.credentials_ref;

  const claim = await claimTerminalReply(ddb, TASK_TABLE, evt.taskId, new Date().toISOString());
  if (!claim.won) return;

  const prNumberResult = await readTaskPrNumber(ddb, TASK_TABLE, evt.taskId);
  if (isLookupFailure(prNumberResult)) {
    logger.warn('Settle reply: PR number read failed (non-fatal) — number omitted', {
      task_id: evt.taskId,
      error: prNumberResult.error instanceof Error ? prNumberResult.error.message : String(prNumberResult.error),
    });
  }
  const prNumber = lookupValueOr(prNumberResult, null);
  const prUrl = lookupValueOr(await resolvePrUrl(evt.taskId), null);
  const { total: runningTotalUsd, partial: runningTotalPartial } = await sumIterationCostForIssue({
    ddb,
    taskTableName: TASK_TABLE,
    linearIssueId: changedSubIssueId,
    thisTaskId: evt.taskId,
    ...(evt.costUsd !== undefined && { thisCost: evt.costUsd }),
    logLabel: 'reconciler',
  });
  const isUpdated = !isNoChangeIteration(evt.codeChanged);
  const shot = isUpdated ? await reloadIterationScreenshot(evt.taskId) : { screenshotUrl: null, deployUrl: null };
  const linearBody = succeeded
    ? renderMaturingReply({
      state: isNoChangeIteration(evt.codeChanged) ? 'answered' : 'updated',
      prNumber,
      ...(prUrl !== null && { prUrl }),
      ...(evt.answerText !== undefined && { answerText: evt.answerText }),
      ...(evt.costUsd !== undefined && { costUsd: evt.costUsd }),
      ...(evt.durationS !== undefined && { durationS: evt.durationS }),
      ...(runningTotalUsd !== null && { runningTotalUsd, runningTotalPartial }),
      ...(shot.screenshotUrl ? { screenshotUrl: shot.screenshotUrl } : {}),
      ...(shot.screenshotUrl && shot.deployUrl ? { deployUrl: encodeMarkdownUrl(shot.deployUrl) } : {}),
    })
    : renderFailureReply({
      status: evt.status,
      buildPassed: evt.buildPassed,
      ...(evt.errorMessage !== undefined && { errorMessage: evt.errorMessage }),
      taskId: evt.taskId,
    });
  const replyIssueId = evt.triggerCommentIssueId ?? changedSubIssueId;
  const target = issueRef(replyIssueId, workspaceId);
  const existing = evt.iterationReplyId
    ? { commentId: evt.iterationReplyId }
    : undefined;
  let reply: CommentRef | null | undefined;
  let jiraFinalBody: Record<string, unknown> | undefined;
  if (channel.kind === 'jira') {
    const pointerKind = !succeeded
      ? 'details'
      : (isNoChangeIteration(evt.codeChanged) ? 'answer' : 'result');
    const jiraCtx = {
      cloudId: workspaceId,
      registryTableName: JIRA_REGISTRY_TABLE!,
    };
    jiraFinalBody = buildAdfDocument(renderJiraFinalStatusComment({
      ...jiraIterationFrame(
        `task_${evt.status.toLowerCase()}`,
        evt.buildPassed,
        classifyError(evt.errorMessage)?.title ?? null,
      ),
      prUrl,
      costUsd: evt.costUsd ?? null,
      turns: evt.turns ?? null,
      maxTurns: evt.maxTurns ?? null,
      durationS: evt.durationS ?? null,
      taskId: evt.taskId,
      answerText: evt.answerText,
    }));
    if (existing) {
      const pointer = await updateJiraIterationComment(
        ddb, TASK_TABLE, evt.taskId,
        jiraCtx,
        target.issueId,
        existing.commentId,
        { body: buildAdfDocument(renderJiraFinishedPointer(pointerKind)), terminal: true },
      );
      if (!pointer.ok) {
        reply = null;
      }
    }
    if (reply !== null) {
      const finalResult = await postIssueCommentAdf(
        jiraCtx,
        target.issueId,
        jiraFinalBody,
      );
      reply = finalResult.ok ? { commentId: finalResult.commentId } : null;
      if (!finalResult.ok && !finalResult.retryable && existing) {
        const fallback = await updateJiraIterationComment(
          ddb, TASK_TABLE, evt.taskId,
          jiraCtx,
          target.issueId,
          existing.commentId,
          { body: jiraFinalBody, terminal: true },
        );
        if (fallback.ok) {
          logger.warn('Jira iteration result post failed terminally — folded outcome into status comment', {
            task_id: evt.taskId,
            jira_issue_key: target.issueId,
            comment_id: existing.commentId,
          });
          reply = existing;
        }
      }
    }
  } else {
    reply = await channel.upsertThreadedReply?.(
      target,
      { commentId },
      linearBody,
      existing,
      { preservePreview: true, repairIfOverwritten: true },
    );
  }
  if (reply === null) {
    const release = await releaseReplyClaim(ddb, TASK_TABLE, evt.taskId, claim.stamp);
    if (release !== 'exhausted') {
      logger.warn('Iteration ack: reply failed — deferring the settle to another attempt', {
        task_id: evt.taskId,
        linear_issue_id: replyIssueId,
        release,
      });
      return;
    }
    if (channel.kind === 'jira' && existing && jiraFinalBody) {
      const fallback = await updateJiraIterationComment(
        ddb, TASK_TABLE, evt.taskId,
        {
          cloudId: workspaceId,
          registryTableName: JIRA_REGISTRY_TABLE!,
        },
        target.issueId,
        existing.commentId,
        { body: jiraFinalBody, terminal: true },
      );
      if (fallback.ok) {
        logger.warn('Jira iteration retries exhausted — folded outcome into status comment', {
          task_id: evt.taskId,
          jira_issue_key: target.issueId,
          comment_id: existing.commentId,
        });
        reply = existing;
      }
    }
    logger.error('Iteration ack: giving up on the reply — settling via the reaction alone', {
      task_id: evt.taskId,
      linear_issue_id: replyIssueId,
    });
  }

  const noChange = succeeded && isNoChangeIteration(evt.codeChanged);
  await channel.replaceCommentReaction?.(
    { commentId },
    issueRef(replyIssueId, workspaceId),
    noChange ? 'needs_input' : (succeeded ? 'succeeded' : 'failed'),
  );
  if (succeeded && !noChange) {
    await channel.transitionState?.(
      childIssueRef(snapshot.children, changedSubIssueId, workspaceId),
      'in_review',
    );
  }
}

async function spawnRestackTask(
  step: RestackStep,
  platformUserId: string,
  sourceTaskId: string,
  changedSubIssueId: string,
): Promise<'created' | 'exists' | 'failed'> {
  const child = step.child;
  const prNumberResult = child.child_task_id
    ? await readTaskPrNumber(ddb, TASK_TABLE, child.child_task_id)
    : LOOKUP_ABSENT;
  if (!prNumberResult.ok) {
    logger.warn(
      isLookupFailure(prNumberResult)
        ? 'Restack cascade: dependent TaskRecord read failed — cannot restack'
        : 'Restack cascade: dependent has no resolvable PR number — skipping',
      {
        orchestration_id: child.orchestration_id,
        sub_issue_id: child.sub_issue_id,
        child_task_id: child.child_task_id,
        ...(isLookupFailure(prNumberResult) && {
          error: prNumberResult.error instanceof Error ? prNumberResult.error.message : String(prNumberResult.error),
        }),
      },
    );
    return 'failed';
  }
  const prNumber = prNumberResult.value;

  const idempotencyKey = `restack_${child.sub_issue_id}_${sourceTaskId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);

  try {
    const result = await createTaskCore(
      {
        repo: child.repo,
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
          orchestration_merge_branches: JSON.stringify(step.mergeBranches),
        },
        idempotencyKey,
      },
      idempotencyKey,
    );
    logger.info('Restack cascade: created restack task for dependent', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      pr_number: prNumber,
      status_code: result.statusCode,
    });
    if (result.statusCode === 201) return 'created';
    if (result.statusCode === 200) return 'exists';
    return 'failed';
  } catch (err) {
    logger.error('Restack cascade: createTaskCore threw for dependent', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

async function resolvePrUrl(taskId: string): Promise<LookupResult<string>> {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TASK_TABLE, Key: { task_id: taskId }, ProjectionExpression: 'pr_url',
    }));
    const url = res.Item?.pr_url;
    return typeof url === 'string' ? lookupFound(url) : LOOKUP_ABSENT;
  } catch (err) {
    logger.warn('Settle reply: PR URL read failed (non-fatal) — link omitted', {
      task_id: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
}

/**
 * Lambda entry point — TaskTable stream handler.
 *
 * Processes records sequentially, in three steps: orchestration reconciliation,
 * the idempotent budget rollup, and the scoreboard metric line. Each step is
 * attempted independently, so an outage in one subsystem cannot prevent the
 * others from progressing.
 *
 * A failure of the first or the second step reports the record for retry. A
 * failure of the third never does: it is logged and counted, and this delivery
 * leaves the task out of the metrics. Lambda retries every record from the
 * first reported one on.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  let processed = 0;
  let budgetRolledUp = 0;
  let metricsPublished = 0;
  let metricsFailed = 0;
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const seq = record.dynamodb?.SequenceNumber;
    let orchestrationError: unknown;
    let budgetError: unknown;

    try {
      const evt = parseTerminalTaskRecord(record);
      if (evt) {
        if (evt.cascadeSubIssueId) {
          await cascadeRestack(evt);
        } else {
          await reconcileTerminalChild(evt, record);
        }
        processed += 1;
      }
    } catch (err) {
      orchestrationError = err;
    }

    try {
      if (await rollupTaskCost(record)) budgetRolledUp += 1;
    } catch (err) {
      budgetError = err;
    }

    try {
      if (await publishTaskMetrics(record)) metricsPublished += 1;
    } catch (err) {
      metricsFailed += 1;
      logger.error('Scoreboard metrics step failed: task not counted', {
        sequence_number: seq,
        task_id: record.dynamodb?.NewImage?.task_id?.S,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const error = orchestrationError ?? budgetError;
    if (error) {
      logger.error('TaskTable reconciler record failed — reporting for isolated retry', {
        sequence_number: seq,
        event_name: record.eventName,
        orchestration_error: orchestrationError instanceof Error
          ? orchestrationError.message
          : orchestrationError === undefined ? undefined : String(orchestrationError),
        budget_error: budgetError instanceof Error
          ? budgetError.message
          : budgetError === undefined ? undefined : String(budgetError),
      });
      if (!seq) throw error;
      batchItemFailures.push({ itemIdentifier: seq });
    }
  }
  logger.info('Orchestration reconciler batch processed', {
    records: event.Records.length,
    reconciled: processed,
    budget_rolled_up: budgetRolledUp,
    metrics_published: metricsPublished,
    metrics_failed: metricsFailed,
    failed: batchItemFailures.length,
  });
  return { batchItemFailures };
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
