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

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type {
  DynamoDBBatchItemFailure,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { TaskStatus, TERMINAL_STATUSES } from '../constructs/task-status';
import { clearTokenCache, resolveGitHubToken } from './shared/context-hydration';
import { classifyError } from './shared/error-classifier';
import { renderFailureReply } from './shared/failure-reply';
import { renderCommentBody, upsertTaskComment } from './shared/github-comment';
import { sumIterationCostForIssue as sumIterationCostForIssueShared } from './shared/iteration-cost';
import { renderMaturingReply } from './shared/iteration-reply';
import { claimTerminalReply, releaseReplyClaim, terminalReplyClaimed } from './shared/iteration-reply-claim';
import {
  buildAdfDocument,
  parseMarkdownBlocks,
  postIssueCommentAdf,
  type AdfBlock,
} from './shared/jira-feedback';
import { updateJiraIterationComment } from './shared/jira-iteration-comment';
import {
  jiraIterationFrame,
  renderJiraFinalStatusComment,
  renderJiraFinishedPointer,
  type JiraFinishedPointerKind,
} from './shared/jira-status-comment';
import { addAgentSessionExternalUrl, emitAgentActivity, type AgentActivityContent } from './shared/linear-agent-session';
import { isLinearAgentSessionsEnabled, SESSION_STOP_CANCELLED_VIA } from './shared/linear-agent-session-event';
import {
  EMOJI_FAILURE,
  EMOJI_NEEDS_INPUT,
  EMOJI_SUCCESS,
  postIssueComment,
  resolveToken,
  swapCommentReaction,
  upsertThreadedReply,
  type LinearFeedbackContext,
  type LinearPostResult,
} from './shared/linear-feedback';
import { logger } from './shared/logger';
import { coerceNumericOrNull } from './shared/numeric';
import { loadRepoConfig } from './shared/repo-config';
import { encodeMarkdownUrl } from './shared/screenshot-url';
import { prNumberFromTask } from './shared/task-pr-number';
import type { ChannelConfig, TaskNotificationsConfig, TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';
import { dispatchSlackEvent, SlackApiError } from './slack-notify';

export type { ChannelConfig, TaskNotificationsConfig };

const TERMINAL_EVENT_TYPES = [
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_stranded',
] as const;

const LINEAR_SESSION_HEARTBEAT_EVENT = 'agent_turn';

const APPROVAL_NOTIFICATION_EVENTS = [
  'approval_requested',
  'approval_stranded',
] as const;

export type NotificationChannel = 'slack' | 'email' | 'github' | 'linear' | 'jira';

/** Per-channel default event-type subscriptions (design §6.2). */
export const CHANNEL_DEFAULTS: Record<NotificationChannel, ReadonlySet<string>> = {
  slack: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'task_timed_out',
    'task_created',
    'session_started',
    'agent_error',
    ...APPROVAL_NOTIFICATION_EVENTS,
    'status_response',
  ]),
  email: new Set<string>([
    'task_completed',
    'task_failed',
    'approval_requested',
  ]),
  github: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'task_timed_out',
    'pr_created',
  ]),
  linear: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'pr_created',
    'task_timed_out',
    ...(isLinearAgentSessionsEnabled() ? [LINEAR_SESSION_HEARTBEAT_EVENT] : []),
  ]),
  jira: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'task_timed_out',
  ]),
};

/**
 * Resolve the effective event-type filter for a channel.
 *
 * Resolution rules:
 *   - ``{ enabled: false }`` → empty set (channel opted out).
 *   - ``events`` absent      → channel default.
 *   - ``events: []``         → empty set (treated as opt-out with
 *                              a WARN).
 *   - ``events: ["default", …]`` → ``"default"`` expands to the
 *                              channel default, other entries are
 *                              added on top.
 *   - ``events: [only literals]`` → the explicit list REPLACES the
 *                              default entirely.
 */
export function resolveChannelFilter(
  channel: NotificationChannel,
  overrides?: TaskNotificationsConfig,
): ReadonlySet<string> {
  const channelOverride = overrides?.[channel];
  if (channelOverride?.enabled === false) return new Set<string>();
  if (!channelOverride?.events) return CHANNEL_DEFAULTS[channel];
  if (channelOverride.events.length === 0) {
    logger.warn('[fanout] channel override has empty events list — muting channel', {
      event: 'fanout.resolve.empty_events_override',
      channel,
    });
    return new Set<string>();
  }
  const expanded = new Set<string>();
  for (const e of channelOverride.events) {
    if (e === 'default') {
      for (const d of CHANNEL_DEFAULTS[channel]) expanded.add(d);
    } else {
      expanded.add(e);
    }
  }
  return expanded;
}

const CHANNELS = Object.keys(CHANNEL_DEFAULTS) as readonly NotificationChannel[];

function unionSubscribedTypes(overrides?: TaskNotificationsConfig): ReadonlySet<string> {
  const u = new Set<string>();
  for (const ch of CHANNELS) {
    for (const t of resolveChannelFilter(ch, overrides)) u.add(t);
  }
  return u;
}

const MAX_EVENTS_PER_TASK_PER_INVOCATION = 20;

export interface FanOutEvent {
  readonly task_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Flatten a DynamoDB Stream NEW_IMAGE record to a plain `FanOutEvent`.
 * Returns `null` for records we can't parse (deletes, garbage, test
 * harness events).
 */
export function parseStreamRecord(record: DynamoDBRecord): FanOutEvent | null {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return null;
  const img = record.dynamodb?.NewImage;
  if (!img) return null;

  const task_id = img.task_id?.S;
  const event_id = img.event_id?.S;
  const event_type = img.event_type?.S;
  const timestamp = img.timestamp?.S;
  if (!task_id || !event_id || !event_type || !timestamp) return null;

  let metadata: Record<string, unknown> | undefined;
  const metaImg = img.metadata;
  if (metaImg?.M) {
    metadata = {};
    for (const [k, v] of Object.entries(metaImg.M)) {
      if (v.S !== undefined) metadata[k] = v.S;
      else if (v.N !== undefined) metadata[k] = Number(v.N);
      else if (v.BOOL !== undefined) metadata[k] = v.BOOL;
      else if (v.NULL !== undefined) metadata[k] = null;
    }
  }

  return { task_id, event_id, event_type, timestamp, metadata };
}

const ROUTABLE_MILESTONES: ReadonlySet<string> = new Set(['pr_created']);

/**
 * Unwrap ``agent_milestone`` events to their milestone name for
 * routing and rendering purposes.
 *
 * Unwrap is restricted to ``ROUTABLE_MILESTONES``. Non-milestone events,
 * bare ``agent_milestone`` events without a well-formed milestone name,
 * and milestones outside the allowlist all keep their original
 * ``event_type``.
 */
export function effectiveEventType(event: FanOutEvent): string {
  if (event.event_type !== 'agent_milestone') return event.event_type;
  const milestone = event.metadata?.milestone;
  if (typeof milestone !== 'string' || milestone.length === 0) return event.event_type;
  if (!ROUTABLE_MILESTONES.has(milestone)) return event.event_type;
  return milestone;
}

/** True if any subscribed channel wants this event. Matches on the
 *  unwrapped effective event type. */
export function shouldFanOut(event: FanOutEvent, overrides?: TaskNotificationsConfig): boolean {
  return unionSubscribedTypes(overrides).has(effectiveEventType(event));
}

const ddb = makeDocClient();

async function dispatchToSlack(event: FanOutEvent): Promise<void> {
  const effectiveType = effectiveEventType(event);
  const effectiveEvent = effectiveType === event.event_type
    ? event
    : { ...event, event_type: effectiveType };
  try {
    await dispatchSlackEvent(effectiveEvent, ddb);
  } catch (err) {
    const isSlackApiErr =
      err instanceof SlackApiError
      || (err instanceof Error && err.name === 'SlackApiError');
    if (isSlackApiErr) {
      logger.warn('[fanout/slack] Slack API error — swallowing per channel policy', {
        event: 'fanout.slack.api_error',
        task_id: event.task_id,
        event_id: event.event_id,
        event_type: event.event_type,
        effective_event_type: effectiveType,
        error: (err as Error).message,
      });
      return;
    }
    throw err;
  }
}

async function loadTaskForComment(taskId: string): Promise<TaskRecord | null> {
  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) {
    logger.warn('[fanout/github] TASK_TABLE_NAME not set — cannot dispatch', {
      event: 'fanout.github.missing_env',
    });
    return null;
  }
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { task_id: taskId },
  }));
  return (result.Item as TaskRecord | undefined) ?? null;
}

async function terminalReplyAlreadyClaimed(taskId: string): Promise<boolean> {
  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) return false;
  return terminalReplyClaimed(ddb, tableName, taskId);
}

async function reloadScreenshotFields(taskId: string): Promise<{ screenshotUrl: string | null; deployUrl: string | null }> {
  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) return { screenshotUrl: null, deployUrl: null };
  try {
    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { task_id: taskId },
      ProjectionExpression: 'screenshot_url, screenshot_preview_url',
      ConsistentRead: true,
    }));
    const item = res.Item as { screenshot_url?: string; screenshot_preview_url?: string } | undefined;
    return {
      screenshotUrl: typeof item?.screenshot_url === 'string' ? item.screenshot_url : null,
      deployUrl: typeof item?.screenshot_preview_url === 'string' ? item.screenshot_preview_url : null,
    };
  } catch (err) {
    logger.warn('[fanout/linear] screenshot re-read failed (non-fatal)', {
      task_id: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return { screenshotUrl: null, deployUrl: null };
  }
}

async function saveCommentState(
  taskId: string,
  commentId: number,
  previousCommentId: number | undefined,
): Promise<void> {
  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) return;
  const base = {
    TableName: tableName,
    Key: { task_id: taskId },
    UpdateExpression: 'SET github_comment_id = :cid',
  };
  // DynamoDB's UpdateItem creates the item when the key is absent: without
  // `attribute_exists(task_id)` a TTL-evicted task returns as a row with only this field.
  if (previousCommentId === undefined) {
    await ddb.send(new UpdateCommand({
      ...base,
      ExpressionAttributeValues: { ':cid': commentId },
      ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(github_comment_id)',
    }));
  } else {
    await ddb.send(new UpdateCommand({
      ...base,
      ExpressionAttributeValues: {
        ':cid': commentId,
        ':prev': previousCommentId,
      },
      ConditionExpression: 'attribute_exists(task_id) AND github_comment_id = :prev',
    }));
  }
}

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

async function saveDispatchMarker(opts: {
  readonly taskId: string;
  readonly updateExpression: string;
  readonly conditionExpression: string;
  readonly values: Record<string, unknown>;
  readonly channel: string;
  readonly errorId: string;
  readonly logContext?: Record<string, unknown>;
}): Promise<void> {
  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: opts.taskId },
      UpdateExpression: opts.updateExpression,
      ExpressionAttributeValues: opts.values,
      ConditionExpression: opts.conditionExpression,
    }));
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === CONDITIONAL_CHECK_FAILED) {
      logger.info(`[fanout/${opts.channel}] marker condition failed — benign (eviction or sibling race)`, {
        event: `fanout.${opts.channel}.marker_condition_failed`,
        task_id: opts.taskId,
        ...opts.logContext,
      });
      return;
    }
    logger.error(`[fanout/${opts.channel}] marker persist failed — next event/retry may duplicate`, {
      event: `fanout.${opts.channel}.marker_persist_failed`,
      error_id: opts.errorId,
      task_id: opts.taskId,
      error_name: name,
      error: err instanceof Error ? err.message : String(err),
      ...opts.logContext,
    });
  }
}

async function saveLinearCommentState(taskId: string, eventId: string): Promise<void> {
  await saveDispatchMarker({
    taskId,
    updateExpression: 'SET linear_final_comment_event_id = :eid',
    conditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(linear_final_comment_event_id)',
    values: { ':eid': eventId },
    channel: 'linear',
    errorId: 'FANOUT_LINEAR_PERSIST_FAILED',
    logContext: { event_id: eventId },
  });
}

async function saveLinearPrCommentState(taskId: string, eventId: string): Promise<void> {
  await saveDispatchMarker({
    taskId,
    updateExpression: 'SET linear_pr_comment_event_id = :eid',
    conditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(linear_pr_comment_event_id)',
    values: { ':eid': eventId },
    channel: 'linear',
    errorId: 'FANOUT_LINEAR_PR_PERSIST_FAILED',
    logContext: { event_id: eventId },
  });
}

async function saveLinearSessionPrLinkState(taskId: string, eventId: string): Promise<void> {
  await saveDispatchMarker({
    taskId,
    updateExpression: 'SET linear_session_pr_link_event_id = :eid',
    conditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(linear_session_pr_link_event_id)',
    values: { ':eid': eventId },
    channel: 'linear',
    errorId: 'FANOUT_LINEAR_SESSION_LINK_PERSIST_FAILED',
    logContext: { event_id: eventId },
  });
}

async function saveJiraCommentState(taskId: string, eventId: string): Promise<void> {
  await saveDispatchMarker({
    taskId,
    updateExpression: 'SET jira_final_comment_event_id = :eid',
    conditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(jira_final_comment_event_id)',
    values: { ':eid': eventId },
    channel: 'jira',
    errorId: 'FANOUT_JIRA_PERSIST_FAILED',
    logContext: { event_id: eventId },
  });
}

function resolveCommentTarget(task: TaskRecord): number | null {
  return task.pr_number ?? task.issue_number ?? null;
}

function prUrlFor(task: TaskRecord, event: FanOutEvent): string | null {
  if (task.pr_url) return task.pr_url;
  const details = event.metadata?.details;
  return effectiveEventType(event) === 'pr_created' && typeof details === 'string' && /^https:\/\/\S+$/.test(details)
    ? details
    : null;
}

async function resolveTokenSecretArn(repo: string): Promise<string | null> {
  let repoConfig: Awaited<ReturnType<typeof loadRepoConfig>> = null;
  try {
    repoConfig = await loadRepoConfig(repo);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AccessDeniedException') {
      throw err;
    }
    if (name === 'ResourceNotFoundException') {
      logger.info('[fanout/github] RepoTable not present — using platform default token', {
        event: 'fanout.github.repo_table_absent',
        repo,
      });
    } else {
      logger.error('[fanout/github] loadRepoConfig transient error — falling back to platform token', {
        event: 'fanout.github.repo_config_failed',
        error_id: 'FANOUT_REPO_CONFIG_FAILED',
        repo,
        error_name: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return repoConfig?.github_token_secret_arn
    ?? process.env.GITHUB_TOKEN_SECRET_ARN
    ?? null;
}

async function dispatchToGitHubComment(event: FanOutEvent): Promise<void> {
  const task = await loadTaskForComment(event.task_id);
  if (!task) {
    logger.warn('[fanout/github] task not found — skipping comment', {
      event: 'fanout.github.task_missing',
      task_id: event.task_id,
    });
    return;
  }

  if (!task.repo) {
    logger.info('[fanout/github] repo-less task — skipping GitHub channel', {
      event: 'fanout.github.no_repo',
      task_id: event.task_id,
    });
    return;
  }

  const targetNumber = resolveCommentTarget(task);
  if (targetNumber === null) {
    logger.info('[fanout/github] no issue/pr target for task — skipping', {
      event: 'fanout.github.no_target',
      task_id: event.task_id,
    });
    return;
  }

  const tokenArn = await resolveTokenSecretArn(task.repo);
  if (!tokenArn) {
    logger.warn('[fanout/github] no GitHub token ARN configured — skipping', {
      event: 'fanout.github.no_token_arn',
      task_id: event.task_id,
      repo: task.repo,
    });
    return;
  }

  let token: string;
  try {
    token = await resolveGitHubToken(tokenArn);
  } catch (err) {
    logger.warn('[fanout/github] token resolution failed — skipping', {
      event: 'fanout.github.token_resolve_failed',
      task_id: event.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const renderedEventType = effectiveEventType(event);
  const body = renderCommentBody({
    taskId: task.task_id,
    status: task.status,
    repo: task.repo,
    latestEventType: renderedEventType,
    latestEventAt: event.timestamp,
    prUrl: prUrlFor(task, event),
    durationS: coerceNumericOrNull(
      task.duration_s,
      { field: 'duration_s', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    costUsd: coerceNumericOrNull(
      task.cost_usd,
      { field: 'cost_usd', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
  });

  const upsertParams = {
    repo: task.repo,
    issueOrPrNumber: targetNumber,
    body,
    token,
    existingCommentId: task.github_comment_id,
  };

  let result;
  try {
    result = await upsertTaskComment(upsertParams);
  } catch (err) {
    const isGhErr = err instanceof Error && err.name === 'GitHubCommentError';
    const httpStatus = (err as { httpStatus?: unknown }).httpStatus;
    if (isGhErr && httpStatus === 401) {
      logger.warn('[fanout/github] 401 from GitHub — evicting token cache and retrying once', {
        event: 'fanout.github.token_stale_retry',
        task_id: event.task_id,
        token_arn: tokenArn,
      });
      clearTokenCache();
      const freshToken = await resolveGitHubToken(tokenArn);
      try {
        result = await upsertTaskComment({ ...upsertParams, token: freshToken });
      } catch (retryErr) {
        if (
          !(retryErr instanceof Error)
          || retryErr.name !== 'GitHubCommentError'
          || (retryErr as { httpStatus?: unknown }).httpStatus !== 401
        ) {
          throw retryErr;
        }
        logger.warn('[fanout/github] 401 from GitHub with a fresh token too — swallowing per channel policy', {
          event: 'fanout.github.api_error',
          task_id: event.task_id,
          event_id: event.event_id,
          http_status: 401,
          token_arn: tokenArn,
          error: retryErr.message,
        });
        return;
      }
    } else if (
      isGhErr
      && typeof httpStatus === 'number'
      && httpStatus >= 400
      && httpStatus < 500
      // GitHub answers 403 as well as 429 when a rate limit is exceeded.
      && httpStatus !== 403
      && httpStatus !== 429
    ) {
      logger.warn('[fanout/github] terminal 4xx from GitHub — swallowing per channel policy', {
        event: 'fanout.github.api_error',
        task_id: event.task_id,
        event_id: event.event_id,
        http_status: httpStatus,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    } else {
      throw err;
    }
  }

  if (result.created) {
    try {
      await saveCommentState(task.task_id, result.commentId, task.github_comment_id);
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      if (errName === CONDITIONAL_CHECK_FAILED) {
        logger.info('[fanout/github] saveCommentState condition failed — benign (eviction or sibling race)', {
          event: 'fanout.github.persist_benign_evicted',
          task_id: task.task_id,
        });
      } else {
        logger.error('[fanout/github] saveCommentState failed — next event may duplicate comment', {
          event: 'fanout.github.persist_failed',
          error_id: 'FANOUT_GITHUB_PERSIST_FAILED',
          task_id: task.task_id,
          comment_id: result.commentId,
          created: result.created,
          error_name: errName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info('[fanout/github] comment dispatched', {
    event: 'fanout.github.dispatched',
    task_id: task.task_id,
    comment_id: result.commentId,
    created: result.created,
    event_type: event.event_type,
    effective_event_type: renderedEventType,
  });
}

async function dispatchToEmail(event: FanOutEvent): Promise<void> {
  logger.info('[fanout/email] would send', {
    event: 'fanout.email.dispatch_stub',
    task_id: event.task_id,
    event_type: event.event_type,
    effective_event_type: effectiveEventType(event),
  });
}

export function renderLinearPrOpenedComment(prUrl: string, prNumber: number | null): string {
  const ref = prNumber != null ? `PR #${prNumber}` : 'a pull request';
  return `🔗 Opened ${ref}: ${prUrl}`;
}

/**
 * Render the Linear final-status comment body. Inputs are already
 * coerced to native types by the caller; this function only formats.
 *
 * ``prUrl``, when present, renders on the ✅ frame as much as the ⚠️ one.
 * Only the framing/header flips on the outcome.
 *
 * The framing flips between three outcomes based on `(eventType, prUrl)`:
 *
 *   1. ``task_completed``                        → ✅ "Task completed"
 *   2. any non-completed terminal event WITH PR  → ⚠️ "Shipped a PR but stopped early"
 *   3. any non-completed terminal event NO PR    → ❌ "Task <subtype>" + classifier title
 *
 * The ⚠️ frame appends the classifier title when one is available.
 *
 * Cost / turns / duration appear as a subtitle line. Missing values
 * render as `—`.
 */
export function renderLinearFinalStatusComment(args: {
  eventType: string;
  prUrl: string | null;
  costUsd: number | null;
  turns: number | null;
  maxTurns: number | null;
  durationS: number | null;
  taskId: string;
  errorTitle: string | null;
  /** When true, render the answer text as a 💬 question rather than a ✅. */
  needsInput?: boolean;
  /** The agent's clarifying question (surfaced verbatim when needsInput). */
  answerText?: string | null;
}): string {
  const isCompleted = args.eventType === 'task_completed';
  const shippedDespiteFailure = !isCompleted && args.prUrl != null;

  if (args.needsInput) {
    const question = (args.answerText ?? '').trim();
    const lines = ['💬 **A quick question before I start**', ''];
    lines.push(question || 'Could you share a bit more detail so I build the right thing?');
    lines.push('', 'Reply with the details and I\'ll get going.', '', `_task ${args.taskId}_`);
    return lines.join('\n');
  }

  let header: string;
  if (isCompleted) {
    header = '✅ **Task completed**';
  } else if (shippedDespiteFailure) {
    const reason = args.errorTitle ? ` — ${args.errorTitle}` : '';
    header = `⚠️ **Shipped a PR but stopped early${reason}** — review and decide if more work is needed`;
  } else {
    const reason = args.errorTitle ? `: ${args.errorTitle}` : '';
    header = `❌ **Task ${args.eventType.replace(/^task_/, '').replace(/_/g, ' ')}${reason}**`;
  }

  const costStr = args.costUsd != null ? `$${args.costUsd.toFixed(2)}` : '—';
  const turnsStr = args.turns != null
    ? `${args.turns}${args.maxTurns != null ? ` / ${args.maxTurns}` : ''}`
    : '—';
  const durationStr = args.durationS != null
    ? formatDuration(args.durationS)
    : '—';

  const lines: string[] = [
    header,
    '',
    `cost: ${costStr} • turns: ${turnsStr} • duration: ${durationStr}`,
  ];
  if (args.prUrl) {
    lines.push('', `PR: ${args.prUrl}`);
  }
  lines.push('', `_task ${args.taskId}_`);
  return lines.join('\n');
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

async function dispatchToLinear(event: FanOutEvent): Promise<void> {
  const registryTableName = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    logger.warn('[fanout/linear] LINEAR_WORKSPACE_REGISTRY_TABLE_NAME not set — skipping', {
      event: 'fanout.linear.missing_env',
      error_id: 'FANOUT_LINEAR_MISSING_ENV',
      task_id: event.task_id,
    });
    return;
  }

  const isHeartbeat = event.event_type === LINEAR_SESSION_HEARTBEAT_EVENT;
  if (isHeartbeat && heartbeatCanSkipTaskRead(event.task_id)) return;

  const task = await loadTaskForComment(event.task_id);
  if (isHeartbeat && task) rememberHeartbeatTask(event.task_id, task);
  if (!task) {
    logger.warn('[fanout/linear] task not found — skipping comment', {
      event: 'fanout.linear.task_missing',
      task_id: event.task_id,
    });
    return;
  }

  if (task.channel_source !== 'linear') {
    return;
  }

  const issueId = task.channel_metadata?.linear_issue_id;
  const workspaceId = task.channel_metadata?.linear_workspace_id;
  if (!issueId || !workspaceId) {
    logger.warn('[fanout/linear] task missing linear_issue_id or linear_workspace_id — skipping', {
      event: 'fanout.linear.metadata_missing',
      task_id: event.task_id,
      has_issue_id: Boolean(issueId),
      has_workspace_id: Boolean(workspaceId),
    });
    return;
  }

  // Linear renders an agent session's final `response` as the thread comment itself.
  const agentSessionId = task.channel_metadata?.linear_agent_session_id;
  if (agentSessionId) {
    await dispatchToLinearAgentSession(event, task, agentSessionId, {
      linearWorkspaceId: workspaceId,
      registryTableName,
    });
    return;
  }
  if (event.event_type === LINEAR_SESSION_HEARTBEAT_EVENT) return;

  const iterationReplyId = task.channel_metadata?.iteration_reply_comment_id;
  const triggerCommentId = task.channel_metadata?.trigger_comment_id;
  const isIteration = Boolean(triggerCommentId);

  if (event.event_type === 'agent_milestone') {
    if (isIteration && iterationReplyId && triggerCommentId) {
      if (await terminalReplyAlreadyClaimed(task.task_id)) {
        logger.info('[fanout/linear] skipping a progress edit — the reply already settled', {
          event: 'fanout.linear.progress_after_settle',
          task_id: task.task_id,
        });
        return;
      }
      await upsertThreadedReply(
        { linearWorkspaceId: workspaceId, registryTableName },
        issueId,
        triggerCommentId,
        renderMaturingReply({
          state: 'working',
          ...(typeof task.pr_number === 'number' && { prNumber: task.pr_number }),
        }),
        iterationReplyId,
        { skipIfSettled: true },
      );
      return;
    }
    const prUrl = prUrlFor(task, event);
    if (task.linear_pr_comment_event_id || !prUrl) return;
    const prBody = renderLinearPrOpenedComment(prUrl, task.pr_number ?? null);
    const prResult = await postIssueComment(
      { linearWorkspaceId: workspaceId, registryTableName },
      issueId,
      prBody,
    );
    if (prResult.ok) {
      logger.info('[fanout/linear] PR-opened comment dispatched', {
        event: 'fanout.linear.pr_comment_dispatched',
        task_id: task.task_id,
        issue_id: issueId,
      });
      await saveLinearPrCommentState(task.task_id, event.event_id);
    } else {
      logger.warn('[fanout/linear] PR-opened comment post failed', {
        event: 'fanout.linear.pr_comment_failed',
        error_id: 'FANOUT_LINEAR_PR_COMMENT_FAILED',
        task_id: task.task_id,
        issue_id: issueId,
        retryable: prResult.retryable,
      });
      if (prResult.retryable) {
        throw new Error(
          `[fanout/linear] transient Linear PR-opened post failure for task ${task.task_id} — escalating for batch retry`,
        );
      }
    }
    return;
  }

  if (task.linear_final_comment_event_id) {
    logger.info('[fanout/linear] final comment already posted — skipping (idempotent retry)', {
      event: 'fanout.linear.already_posted',
      task_id: task.task_id,
      posted_event_id: task.linear_final_comment_event_id,
      event_id: event.event_id,
    });
    return;
  }

  if (!isIteration) {
    const body = renderLinearFinalStatusComment(linearFinalStatusArgs(task, event));

    const postResult = await postIssueComment(
      { linearWorkspaceId: workspaceId, registryTableName },
      issueId,
      body,
    );

    if (postResult.ok) {
      logger.info('[fanout/linear] comment dispatched', {
        event: 'fanout.linear.dispatched',
        task_id: task.task_id,
        issue_id: issueId,
        event_type: event.event_type,
        posted: true,
      });
      await saveLinearCommentState(task.task_id, event.event_id);
    } else {
      logger.warn('[fanout/linear] postIssueComment failed — Linear API path failed', {
        event: 'fanout.linear.post_failed',
        error_id: 'FANOUT_LINEAR_POST_FAILED',
        task_id: task.task_id,
        issue_id: issueId,
        event_type: event.event_type,
        posted: false,
        retryable: postResult.retryable,
      });
      if (postResult.retryable) {
        throw new Error(
          `[fanout/linear] transient Linear post failure for task ${task.task_id} — escalating for batch retry`,
        );
      }
    }
  }

  await replyToStandaloneTrigger(event, task, registryTableName, workspaceId, issueId);
}

interface HeartbeatTaskMemo {
  readonly sessionTask: boolean;
  readonly heartbeatAtMs: number;
}
const HEARTBEAT_MEMO_MAX_ENTRIES = 2000;
const heartbeatMemo = new Map<string, HeartbeatTaskMemo>();

function heartbeatCanSkipTaskRead(taskId: string): boolean {
  const memo = heartbeatMemo.get(taskId);
  if (!memo) return false;
  return !memo.sessionTask || Date.now() - memo.heartbeatAtMs < LINEAR_SESSION_HEARTBEAT_INTERVAL_MS;
}

function rememberHeartbeatTask(taskId: string, task: TaskRecord, heartbeatAtMs?: number): void {
  if (heartbeatMemo.size >= HEARTBEAT_MEMO_MAX_ENTRIES && !heartbeatMemo.has(taskId)) heartbeatMemo.clear();
  const recorded = task.linear_session_heartbeat_at ? Date.parse(task.linear_session_heartbeat_at) : 0;
  heartbeatMemo.set(taskId, {
    sessionTask: task.channel_source === 'linear' && Boolean(task.channel_metadata?.linear_agent_session_id),
    heartbeatAtMs: heartbeatAtMs ?? (Number.isFinite(recorded) ? recorded : 0),
  });
}

export function resetLinearHeartbeatMemoForTests(): void {
  heartbeatMemo.clear();
}

/** Linear marks a session `stale` after 30 minutes without an activity. */
const LINEAR_SESSION_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const LINEAR_SESSION_TERMINAL_EVENTS: ReadonlySet<string> = new Set([...TERMINAL_EVENT_TYPES, 'task_timed_out']);

async function dispatchToLinearAgentSession(
  event: FanOutEvent,
  task: TaskRecord,
  agentSessionId: string,
  ctx: LinearFeedbackContext,
): Promise<void> {
  const effective = effectiveEventType(event);
  const isTerminalEvent = LINEAR_SESSION_TERMINAL_EVENTS.has(effective);
  if (effective !== 'pr_created' && effective !== LINEAR_SESSION_HEARTBEAT_EVENT && !isTerminalEvent) return;
  const logCtx = { task_id: task.task_id, linear_agent_session_id: agentSessionId, event_type: effective };

  if (effective === LINEAR_SESSION_HEARTBEAT_EVENT) {
    await emitLinearSessionHeartbeat(event, task, agentSessionId, ctx);
    return;
  }
  if (effective === 'task_cancelled' && event.metadata?.cancelled_via === SESSION_STOP_CANCELLED_VIA) {
    logger.info('[fanout/linear-session] cancel came from a session stop — confirmation already posted', logCtx);
    if (!task.linear_final_comment_event_id) await saveLinearCommentState(task.task_id, event.event_id);
    return;
  }
  if (effective === 'pr_created'
    && (task.linear_pr_comment_event_id || !task.pr_url || task.status === TaskStatus.CANCELLED)) return;
  if (isTerminalEvent && task.linear_final_comment_event_id) {
    logger.info('[fanout/linear-session] final activity already emitted — skipping (idempotent retry)', logCtx);
    return;
  }

  const token = await resolveToken(ctx);
  if (!token) {
    logger.warn('[fanout/linear-session] no Linear token for workspace — skipping', {
      ...logCtx, error_id: 'FANOUT_LINEAR_SESSION_NO_TOKEN',
    });
    return;
  }

  let result: LinearPostResult;
  if (effective === 'pr_created') {
    const prUrl = task.pr_url!;
    const label = typeof task.pr_number === 'number' ? `Pull request #${task.pr_number}` : 'Pull request';
    // Linear's `addedExternalUrls` appends: repeating it duplicates the header link.
    if (!task.linear_session_pr_link_event_id) {
      const link = await addAgentSessionExternalUrl(token, agentSessionId, { label, url: prUrl });
      if (link.ok) {
        await saveLinearSessionPrLinkState(task.task_id, event.event_id);
      } else {
        logger.warn('[fanout/linear-session] could not attach PR link to session', { ...logCtx, retryable: link.retryable });
        if (link.retryable) {
          throw new Error(
            `[fanout/linear-session] transient Linear PR-link failure for task ${task.task_id} — escalating for batch retry`,
          );
        }
      }
    }
    result = await emitAgentActivity(token, agentSessionId, {
      type: 'action', action: 'Opened pull request', parameter: prUrl,
    });
    if (result.ok) await saveLinearPrCommentState(task.task_id, event.event_id);
  } else {
    result = await emitAgentActivity(token, agentSessionId, linearSessionTerminalActivity(task, event));
    if (result.ok) await saveLinearCommentState(task.task_id, event.event_id);
  }

  if (result.ok) {
    logger.info('[fanout/linear-session] activity dispatched', logCtx);
    return;
  }
  logger.warn('[fanout/linear-session] activity emit failed', {
    ...logCtx, error_id: 'FANOUT_LINEAR_SESSION_EMIT_FAILED', retryable: result.retryable,
  });
  if (result.retryable) {
    throw new Error(
      `[fanout/linear-session] transient Linear activity failure for task ${task.task_id} — escalating for batch retry`,
    );
  }
}

export function linearSessionTerminalActivity(task: TaskRecord, event: FanOutEvent): AgentActivityContent {
  const args = linearFinalStatusArgs(task, event);
  const body = renderLinearFinalStatusComment(args);
  if (event.event_type === 'task_completed') {
    return args.needsInput ? { type: 'elicitation', body } : { type: 'response', body };
  }
  if (event.event_type === 'task_cancelled') return { type: 'response', body };
  return { type: 'error', body };
}

async function emitLinearSessionHeartbeat(
  event: FanOutEvent,
  task: TaskRecord,
  agentSessionId: string,
  ctx: LinearFeedbackContext,
): Promise<void> {
  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName || TERMINAL_STATUSES.includes(task.status)) return;
  const now = Date.now();
  const cutoffIso = new Date(now - LINEAR_SESSION_HEARTBEAT_INTERVAL_MS).toISOString();
  // A failed conditional write still costs a DynamoDB write unit.
  if (task.linear_session_heartbeat_at && task.linear_session_heartbeat_at >= cutoffIso) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET linear_session_heartbeat_at = :now',
      ConditionExpression: 'attribute_exists(task_id) AND (attribute_not_exists(linear_session_heartbeat_at) OR linear_session_heartbeat_at < :cutoff)',
      ExpressionAttributeValues: {
        ':now': new Date(now).toISOString(),
        ':cutoff': cutoffIso,
      },
    }));
  } catch (err) {
    if ((err as Error)?.name !== CONDITIONAL_CHECK_FAILED) {
      logger.warn('[fanout/linear-session] heartbeat claim failed', {
        task_id: task.task_id, error: err instanceof Error ? err.message : String(err),
      });
    }
    if ((err as Error)?.name === CONDITIONAL_CHECK_FAILED) rememberHeartbeatTask(task.task_id, task, now);
    return;
  }
  rememberHeartbeatTask(task.task_id, task, now);
  const token = await resolveToken(ctx);
  if (!token) return;
  const turn = typeof event.metadata?.turn === 'number' ? event.metadata.turn : null;
  const result = await emitAgentActivity(
    token,
    agentSessionId,
    { type: 'thought', body: turn !== null ? `Still working (turn ${turn}).` : 'Still working.' },
    { ephemeral: true },
  );
  if (!result.ok) {
    logger.warn('[fanout/linear-session] heartbeat emit failed', {
      task_id: task.task_id, linear_agent_session_id: agentSessionId, retryable: result.retryable,
    });
  }
}

function linearFinalStatusArgs(
  task: TaskRecord,
  event: FanOutEvent,
): Parameters<typeof renderLinearFinalStatusComment>[0] {
  const classification = classifyError(task.error_message);
  return {
    eventType: event.event_type,
    prUrl: task.pr_url ?? null,
    needsInput: task.code_changed === false && !task.pr_url,
    answerText: typeof task.answer_text === 'string' ? task.answer_text : null,
    costUsd: coerceNumericOrNull(
      task.cost_usd,
      { field: 'cost_usd', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    turns: coerceNumericOrNull(
      task.turns_attempted,
      { field: 'turns_attempted', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    maxTurns: coerceNumericOrNull(
      task.max_turns,
      { field: 'max_turns', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    durationS: coerceNumericOrNull(
      task.duration_s,
      { field: 'duration_s', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    taskId: task.task_id,
    errorTitle: classification?.title ?? null,
  };
}

async function replyToStandaloneTrigger(
  event: FanOutEvent,
  task: TaskRecord,
  registryTableName: string,
  workspaceId: string,
  issueId: string,
): Promise<void> {
  const cm = task.channel_metadata;
  const triggerCommentId = cm?.trigger_comment_id;
  if (!triggerCommentId || cm?.orchestration_iteration === 'true') return;

  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) return;

  const claim = await claimTerminalReply(ddb, tableName, task.task_id, event.timestamp);
  if (!claim.won) return;

  const completed = event.event_type === 'task_completed';
  const succeeded = completed && task.build_passed !== false;
  const prNumber = prNumberFromTask(task);

  const issueIdForCost = task.channel_metadata?.linear_issue_id ?? issueId;
  const { total: runningTotalUsd, partial: runningTotalPartial } =
    await sumIterationCostForIssue(issueIdForCost, task);
  const thisCost = coerceNumericOrNull(
    task.cost_usd, { field: 'cost_usd', task_id: task.task_id, event_id: event.event_id }, logger,
  );
  const durationS = coerceNumericOrNull(
    task.duration_s, { field: 'duration_s', task_id: task.task_id, event_id: event.event_id }, logger,
  );
  const shot = await reloadScreenshotFields(task.task_id);
  const screenshotUrl = shot.screenshotUrl ?? (typeof task.screenshot_url === 'string' ? task.screenshot_url : null);
  const deployUrl = shot.deployUrl ?? (typeof task.screenshot_preview_url === 'string' ? task.screenshot_preview_url : null);

  let state: 'updated' | 'answered' | 'failed';
  if (!succeeded) state = 'failed';
  else if (task.code_changed === false) state = 'answered';
  else state = 'updated';

  const body = state === 'failed'
    ? renderFailureReply({
      status: completed ? TaskStatus.COMPLETED : TaskStatus.FAILED,
      buildPassed: typeof task.build_passed === 'boolean' ? task.build_passed : null,
      ...(typeof task.error_message === 'string' && { errorMessage: task.error_message }),
      taskId: task.task_id,
    })
    : renderMaturingReply({
      state,
      prNumber,
      ...(typeof task.pr_url === 'string' && { prUrl: task.pr_url }),
      ...(typeof task.answer_text === 'string' && { answerText: task.answer_text }),
      costUsd: thisCost,
      durationS,
      runningTotalUsd,
      runningTotalPartial,
      ...(state === 'updated' && screenshotUrl ? { screenshotUrl } : {}),
      ...(state === 'updated' && screenshotUrl && deployUrl ? { deployUrl: encodeMarkdownUrl(deployUrl) } : {}),
    });

  const replyCtx = { linearWorkspaceId: workspaceId, registryTableName };
  const existingReplyId = task.channel_metadata?.iteration_reply_comment_id;
  const replyId = await upsertThreadedReply(
    replyCtx, issueId, triggerCommentId, body, existingReplyId,
    { preservePreview: true, repairIfOverwritten: true },
  );
  if (!replyId) {
    const release = await releaseReplyClaim(ddb, tableName, task.task_id, claim.stamp);
    if (release !== 'exhausted') {
      logger.warn('[fanout/linear] terminal reply edit failed — deferring to another attempt', {
        event: 'fanout.linear.terminal_reply_failed',
        task_id: task.task_id,
        issue_id: issueId,
        release,
      });
      if (release === 'released') {
        throw new Error(
          `[fanout/linear] terminal reply failed for task ${task.task_id} — escalating for batch retry`,
        );
      }
      return;
    }
    logger.error('[fanout/linear] giving up on the terminal reply — settling via the reaction alone', {
      event: 'fanout.linear.terminal_reply_abandoned',
      task_id: task.task_id,
      issue_id: issueId,
    });
  }

  const reaction = state === 'failed' ? EMOJI_FAILURE : (state === 'answered' ? EMOJI_NEEDS_INPUT : EMOJI_SUCCESS);
  await swapCommentReaction(replyCtx, triggerCommentId, reaction);
}

async function sumIterationCostForIssue(
  issueId: string,
  current: TaskRecord,
): Promise<{ total: number | null; partial: boolean }> {
  const tableName = process.env.TASK_TABLE_NAME;
  const currentCost = coerceNumericOrNull(current.cost_usd, { field: 'cost_usd', task_id: current.task_id }, logger) ?? 0;
  if (!tableName || !issueId) return { total: currentCost || null, partial: false };
  return sumIterationCostForIssueShared({
    ddb,
    taskTableName: tableName,
    linearIssueId: issueId,
    thisTaskId: current.task_id,
    thisCost: currentCost,
    logLabel: 'fanout/linear',
  });
}

export { renderJiraFinalStatusComment };

function renderJiraHoldQuestion(task: TaskRecord, event: FanOutEvent): ReadonlyArray<AdfBlock> | null {
  if (
    task.channel_metadata?.trigger_comment_id
    || event.event_type !== 'task_completed'
    || task.code_changed !== false
    || task.pr_url
  ) {
    return null;
  }
  const question = typeof task.answer_text === 'string' ? task.answer_text.trim() : '';
  return [
    // Jira attributes this comment to the user who authorized the app.
    [{ text: '🤖 ' }, { text: 'ABCA has a question before it starts', strong: true }],
    ...parseMarkdownBlocks(question || 'Could you share a bit more detail so I build the right thing?'),
    [{ text: 'Add the details to the issue, then re-apply the trigger label to run it again.' }],
    [{ text: `task ${task.task_id}`, em: true }],
  ];
}

async function dispatchToJira(event: FanOutEvent): Promise<void> {
  const registryTableName = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    logger.warn('[fanout/jira] JIRA_WORKSPACE_REGISTRY_TABLE_NAME not set — skipping', {
      event: 'fanout.jira.missing_env',
      error_id: 'FANOUT_JIRA_MISSING_ENV',
      task_id: event.task_id,
    });
    return;
  }

  const task = await loadTaskForComment(event.task_id);
  if (!task) {
    logger.warn('[fanout/jira] task not found — skipping comment', {
      event: 'fanout.jira.task_missing',
      task_id: event.task_id,
    });
    return;
  }

  if (task.channel_source !== 'jira') {
    return;
  }

  const cloudId = task.channel_metadata?.jira_cloud_id;
  const issueKey = task.channel_metadata?.jira_issue_key;
  if (!cloudId || !issueKey) {
    logger.warn('[fanout/jira] task missing jira_cloud_id or jira_issue_key — skipping', {
      event: 'fanout.jira.metadata_missing',
      task_id: event.task_id,
      has_cloud_id: Boolean(cloudId),
      has_issue_key: Boolean(issueKey),
    });
    return;
  }

  const iterationReplyId = task.channel_metadata?.iteration_reply_comment_id;
  const isIteration = Boolean(task.channel_metadata?.trigger_comment_id);
  const isOrchestratedIteration =
    task.channel_metadata?.orchestration_iteration === 'true';
  if (isOrchestratedIteration) return;

  if ((!isIteration || !iterationReplyId) && task.jira_final_comment_event_id) {
    logger.info('[fanout/jira] final comment already posted — skipping (idempotent retry)', {
      event: 'fanout.jira.already_posted',
      task_id: task.task_id,
      posted_event_id: task.jira_final_comment_event_id,
      event_id: event.event_id,
    });
    return;
  }

  const classifiedTitle = classifyError(task.error_message)?.title ?? null;

  const { eventType, errorTitle } = isIteration && task.code_changed !== false
    ? jiraIterationFrame(event.event_type, task.build_passed, classifiedTitle)
    : { eventType: event.event_type, errorTitle: classifiedTitle };

  const paragraphs = renderJiraHoldQuestion(task, event) ?? renderJiraFinalStatusComment({
    eventType,
    prUrl: task.pr_url ?? null,
    costUsd: coerceNumericOrNull(
      task.cost_usd,
      { field: 'cost_usd', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    turns: coerceNumericOrNull(
      task.turns_attempted,
      { field: 'turns_attempted', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    maxTurns: coerceNumericOrNull(
      task.max_turns,
      { field: 'max_turns', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    durationS: coerceNumericOrNull(
      task.duration_s,
      { field: 'duration_s', task_id: task.task_id, event_id: event.event_id },
      logger,
    ),
    taskId: task.task_id,
    errorTitle,
    answerText: task.answer_text,
  });

  if (isIteration && iterationReplyId) {
    const tableName = process.env.TASK_TABLE_NAME;
    if (!tableName) return;
    const claim = await claimTerminalReply(
      ddb,
      tableName,
      task.task_id,
      event.timestamp,
    );
    if (!claim.won) return;

    const pointerKind: JiraFinishedPointerKind = eventType !== 'task_completed'
      ? 'details'
      : (task.code_changed === false ? 'answer' : 'result');
    const updateResult = await updateJiraIterationComment(
      ddb, tableName, task.task_id,
      { cloudId, registryTableName },
      issueKey,
      iterationReplyId,
      { body: buildAdfDocument(renderJiraFinishedPointer(pointerKind)), terminal: true },
    );
    if (!updateResult.ok) {
      const release = updateResult.retryable
        ? await releaseReplyClaim(ddb, tableName, task.task_id, claim.stamp)
        : undefined;
      logger.warn('[fanout/jira] iteration pointer update failed (non-fatal)', {
        event: 'fanout.jira.iteration_pointer_failed',
        task_id: task.task_id,
        jira_issue_key: issueKey,
        comment_id: iterationReplyId,
        retryable: updateResult.retryable,
        release,
      });
      if (updateResult.retryable && release !== 'exhausted') {
        throw new Error(
          `[fanout/jira] transient Jira iteration pointer failure for task ${task.task_id}`,
        );
      }
    }

    const finalResult = await postIssueCommentAdf(
      { cloudId, registryTableName },
      issueKey,
      buildAdfDocument(paragraphs),
    );
    if (finalResult.ok) {
      logger.info('[fanout/jira] iteration result posted separately', {
        event: 'fanout.jira.iteration_result_posted',
        task_id: task.task_id,
        jira_issue_key: issueKey,
        pointer_comment_id: iterationReplyId,
        result_comment_id: finalResult.commentId,
      });
      return;
    }

    if (!finalResult.retryable) {
      const fallback = await updateJiraIterationComment(
        ddb, tableName, task.task_id,
        { cloudId, registryTableName },
        issueKey,
        iterationReplyId,
        { body: buildAdfDocument(paragraphs), terminal: true },
      );
      if (fallback.ok) {
        logger.warn('[fanout/jira] iteration result post failed terminally — folded outcome into status comment', {
          event: 'fanout.jira.iteration_result_folded',
          task_id: task.task_id,
          jira_issue_key: issueKey,
          comment_id: iterationReplyId,
        });
        return;
      }
      logger.error('[fanout/jira] terminal result and fallback status update both failed', {
        event: 'fanout.jira.iteration_result_fallback_failed',
        task_id: task.task_id,
        jira_issue_key: issueKey,
        comment_id: iterationReplyId,
        fallback_retryable: fallback.retryable,
      });
      return;
    }

    const release = await releaseReplyClaim(
      ddb,
      tableName,
      task.task_id,
      claim.stamp,
    );
    logger.warn('[fanout/jira] iteration result post failed (non-fatal)', {
      event: 'fanout.jira.iteration_result_failed',
      task_id: task.task_id,
      jira_issue_key: issueKey,
      retryable: finalResult.retryable,
      release,
    });
    if (release === 'exhausted') {
      const fallback = await updateJiraIterationComment(
        ddb, tableName, task.task_id,
        { cloudId, registryTableName },
        issueKey,
        iterationReplyId,
        { body: buildAdfDocument(paragraphs), terminal: true },
      );
      logger.warn('[fanout/jira] iteration result retries exhausted — folded outcome into status comment', {
        event: 'fanout.jira.iteration_result_exhausted',
        task_id: task.task_id,
        jira_issue_key: issueKey,
        comment_id: iterationReplyId,
        folded: fallback.ok,
      });
      return;
    }
    if (release === 'released') {
      throw new Error(
        `[fanout/jira] transient Jira iteration result failure for task ${task.task_id}`,
      );
    }
    return;
  }

  const postResult = await postIssueCommentAdf(
    { cloudId, registryTableName },
    issueKey,
    buildAdfDocument(paragraphs),
  );

  if (postResult.ok) {
    logger.info('[fanout/jira] comment dispatched', {
      event: 'fanout.jira.dispatched',
      task_id: task.task_id,
      jira_cloud_id: cloudId,
      jira_issue_key: issueKey,
      event_type: event.event_type,
      posted: true,
    });
    await saveJiraCommentState(task.task_id, event.event_id);
  } else {
    logger.warn('[fanout/jira] postIssueCommentAdf failed — Jira REST path failed', {
      event: 'fanout.jira.post_failed',
      error_id: 'FANOUT_JIRA_POST_FAILED',
      task_id: task.task_id,
      jira_cloud_id: cloudId,
      jira_issue_key: issueKey,
      event_type: event.event_type,
      posted: false,
      retryable: postResult.retryable,
    });
    if (postResult.retryable) {
      throw new Error(
        `[fanout/jira] transient Jira post failure for task ${task.task_id} — escalating for batch retry`,
      );
    }
  }
}

const DISPATCHERS: Record<NotificationChannel, (ev: FanOutEvent) => Promise<void>> = {
  slack: dispatchToSlack,
  github: dispatchToGitHubComment,
  linear: dispatchToLinear,
  jira: dispatchToJira,
  email: dispatchToEmail,
};

/**
 * Outcome of routing one event to every subscribed channel. ``dispatched``
 * is the list of channels that succeeded; ``infraRejections`` is the list
 * of channels whose dispatcher rejected with an *infrastructure* error
 * (DDB throttle, Secrets Manager outage, transient Slack 5xx). Channel-
 * terminal errors (e.g. Slack ``channel_not_found``, GitHub 4xx PATCH)
 * are swallowed inside the dispatcher itself and never appear here.
 */
export interface RouteOutcome {
  readonly dispatched: ReadonlyArray<NotificationChannel>;
  readonly infraRejections: ReadonlyArray<NotificationChannel>;
}

/**
 * Route an event to every subscribed channel. A dispatcher rejection
 * does not block sibling channels.
 *
 * Returns ``{ dispatched, infraRejections }``. A successful dispatch
 * lands in ``dispatched``; a rejection lands in ``infraRejections``
 * and is, by contract, a retryable failure.
 */
export async function routeEvent(
  ev: FanOutEvent,
  overrides?: TaskNotificationsConfig,
): Promise<RouteOutcome> {
  const attempted: NotificationChannel[] = [];
  const tasks: Promise<unknown>[] = [];
  const effective = effectiveEventType(ev);
  for (const ch of CHANNELS) {
    const filter = resolveChannelFilter(ch, overrides);
    if (!filter.has(effective)) continue;
    attempted.push(ch);
    tasks.push(DISPATCHERS[ch](ev));
  }

  const results = await Promise.allSettled(tasks);

  const dispatched: NotificationChannel[] = [];
  const infraRejections: NotificationChannel[] = [];
  results.forEach((r, i) => {
    const ch = attempted[i];
    if (r.status === 'fulfilled') {
      dispatched.push(ch);
      return;
    }
    infraRejections.push(ch);
    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
    logger.warn('[fanout] dispatcher rejected — flagging record for retry', {
      event: 'fanout.dispatcher.rejected',
      channel: ch,
      task_id: ev.task_id,
      event_id: ev.event_id,
      event_type: ev.event_type,
      effective_event_type: effectiveEventType(ev),
      error: reason,
      retryable: true,
    });
  });
  return { dispatched, infraRejections };
}

/**
 * Lambda entry point. Invoked by the DynamoDB Streams event source
 * mapping with batches of NEW_IMAGE records from `TaskEventsTable`.
 *
 * Returns a ``DynamoDBBatchResponse`` for the event-source-mapping's
 * ``reportBatchItemFailures: true`` setting: a record that threw, or
 * that had a dispatcher rejection, is reported by its stream sequence
 * number. Lambda checkpoints at the lowest one reported and retries from
 * there: the failed record and those after it, not the ones before it.
 *
 * Lambda's nodejs24.x runtime detects any 3-arg handler as callback-style
 * and rejects it at init with ``Runtime.CallbackHandlerDeprecated``.
 */
export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> => {
  const perTaskCounts = new Map<string, number>();
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  let processed = 0;
  let dispatched = 0;
  let dropped = 0;

  const overrides: TaskNotificationsConfig | undefined = undefined;

  for (const record of event.Records) {
    processed++;
    const sequenceNumber = record.dynamodb?.SequenceNumber;
    try {
      const ev = parseStreamRecord(record);
      if (!ev) {
        dropped++;
        continue;
      }
      if (!shouldFanOut(ev, overrides)) {
        dropped++;
        continue;
      }

      const seen = perTaskCounts.get(ev.task_id) ?? 0;
      if (seen >= MAX_EVENTS_PER_TASK_PER_INVOCATION) {
        logger.warn('[fanout] per-task cap hit — dropping event', {
          event: 'fanout.rate_limit.hit',
          task_id: ev.task_id,
          event_id: ev.event_id,
          event_type: ev.event_type,
          effective_event_type: effectiveEventType(ev),
          cap: MAX_EVENTS_PER_TASK_PER_INVOCATION,
        });
        dropped++;
        continue;
      }
      perTaskCounts.set(ev.task_id, seen + 1);

      const outcome = await routeEvent(ev, overrides);
      if (outcome.dispatched.length > 0) dispatched++;
      if (outcome.infraRejections.length > 0 && sequenceNumber !== undefined) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    } catch (err) {
      logger.warn('[fanout] record threw — flagging for partial-batch retry', {
        event: 'fanout.record.failed',
        event_id: record.eventID,
        error: err instanceof Error ? err.message : String(err),
        error_name: err instanceof Error ? err.name : undefined,
      });
      if (sequenceNumber !== undefined) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    }
  }

  logger.info('[fanout] batch complete', {
    event: 'fanout.batch.complete',
    records: event.Records.length,
    processed,
    dispatched,
    dropped,
    failed: batchItemFailures.length,
    unique_tasks: perTaskCounts.size,
  });

  return { batchItemFailures };
};
