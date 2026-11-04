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

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { transitionTaskToCancelled, writeTaskCancelledEvent, type CancelTaskTables } from './cancel-task-core';
import { buildClarifyResumeDescription, isClarifyHold, type ClarifyHoldRow } from './clarify-resume';
import { createTaskCore } from './create-task-core';
import {
  agentSessionIdempotencyKey,
  buildAgentSessionTaskDescription,
  emitAgentActivity,
  fetchAgentSessionIssue,
  type AgentActivityContent,
  type AgentSessionIssue,
} from './linear-agent-session';
import {
  parseAgentSessionEvent,
  SESSION_STOP_CANCELLED_VIA,
  type AgentSessionRequest,
  type LinearAgentSessionEvent,
} from './linear-agent-session-event';
import { lookupLinearPlatformUser, vaultMetadata } from './linear-channel-metadata';
import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { fetchIssueParentId } from './linear-subissue-fetch';
import { lookupTaskByLinearIssue, prNumberFromTask, type LinearIssueTask } from './linear-task-by-issue';
import { logger } from './logger';
import { isLookupFailure, lookupValueOr } from './lookup-result';
import { submitNudge } from './nudge-core';
import { deriveOrchestrationId, loadOrchestration } from './orchestration-store';
import { NUDGE_MAX_MESSAGE_LENGTH } from './types';
import { makeDocClient } from './ua';
import { CODING_WORKFLOW_ID } from './workflows';
import { TERMINAL_STATUSES, type TaskStatusType } from '../../constructs/task-status';

const ddb = makeDocClient();

const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.LINEAR_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME;
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const TASK_EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
/** Optional: without it a follow-up to a running task cannot be forwarded to the agent. */
const NUDGES_TABLE_NAME = process.env.NUDGES_TABLE_NAME;
const NUDGE_RATE_LIMIT_PER_MINUTE = Number(process.env.NUDGE_RATE_LIMIT_PER_MINUTE ?? '10');

const PR_ITERATION_WORKFLOW_ID = 'coding/pr-iteration-v1';

const UNLINKED_ACTOR_MESSAGE =
  'I can only act on requests from a linked ABCA user. Link your Linear account first '
  + '(ask your ABCA admin, or run `bgagent linear link`), then try again.';
const ORCHESTRATION_MESSAGE =
  'This issue is part of an ABCA epic orchestration. Its sub-issue tasks are managed from the '
  + 'epic panel: @-mention me in a comment on the epic or the sub-issue to retry or iterate.';
const NOT_OWNER_MESSAGE =
  'Only the person who started the running task can steer or stop it. Ask them, or follow up '
  + 'here once it finishes.';
const NOT_MAPPED_MESSAGE =
  'This issue\'s Linear project isn\'t mapped to a repository. An ABCA admin can map it with '
  + '`bgagent linear map`, then mention me again.';

/**
 * Entry point for ``AgentSessionEvent`` deliveries (ADR-018 Phase 2). Called by
 * the webhook processor after the receiver verified the signature and the
 * processor bound the workspace; only reached when
 * ``LINEAR_AGENT_SESSIONS_ENABLED`` is on.
 *
 * - ``created`` (bgagent @-mentioned or delegated an issue) → start a task, or
 *   iterate on the issue's existing PR when the mention carries an instruction.
 * - ``prompted`` → a ``stop`` signal cancels the running task; any other prompt
 *   is forwarded to the running agent as a nudge, or starts a follow-up task
 *   (PR iteration when a PR exists) once the previous one finished.
 *
 * Throws only for transient lookup failures, so the async-invoke retry replays
 * the delivery; every path that has already created a task is idempotent on
 * the delivery id.
 */
export async function handleAgentSessionEvent(payload: LinearAgentSessionEvent): Promise<void> {
  const request = parseAgentSessionEvent(payload);
  if (!request) {
    logger.info('Agent-session delivery missing required fields or unhandled action — ignoring', {
      action: payload.action,
      has_session: Boolean(payload.agentSession?.id),
    });
    return;
  }
  const logCtx = {
    linear_agent_session_id: request.sessionId,
    linear_issue_id: request.issueId,
    linear_workspace_id: request.workspaceId,
    action: request.action,
  };
  if (!WORKSPACE_REGISTRY_TABLE) {
    logger.warn('Agent-session delivery but LINEAR_WORKSPACE_REGISTRY_TABLE_NAME is unset — cannot respond', logCtx);
    return;
  }

  const resolved = await resolveLinearOauthToken(request.workspaceId, WORKSPACE_REGISTRY_TABLE);
  if (!resolved) {
    // No token ⇒ no way to emit an activity; Linear will mark the session unresponsive.
    logger.warn('Agent-session delivery for an unresolvable workspace — ignoring', logCtx);
    return;
  }
  const emit = (content: AgentActivityContent, ephemeral = false) =>
    emitSessionActivity(resolved.accessToken, request, content, ephemeral);

  if (request.stopRequested) {
    // Orchestration children are cancelled through the epic, never from a
    // per-issue session (the reconciler owns their lifecycle).
    if (await belongsToOrchestration(resolved.accessToken, request.issueId)) {
      await emit({ type: 'response', body: `Stop request ignored. ${ORCHESTRATION_MESSAGE}` });
      return;
    }
    await handleStopRequest(request, emit);
    return;
  }

  // Acknowledge first: Linear marks the session unresponsive unless an activity
  // lands within 10s of `created`. Everything below may take longer.
  // Ephemeral, so an async-invoke retry's repeat ack replaces rather than stacks.
  await emit({
    type: 'thought',
    body: request.action === 'created'
      ? 'On it — checking this issue and its repository.'
      : 'Got your follow-up — checking the current task.',
  }, true);

  const platformUserId = request.actorId
    ? await lookupLinearPlatformUser(ddb, USER_MAPPING_TABLE, request.workspaceId, request.actorId)
    : null;
  if (!platformUserId) {
    logger.warn('Agent-session actor has no linked platform user — refusing', {
      ...logCtx, linear_user_id: request.actorId,
    });
    await emit({ type: 'error', body: UNLINKED_ACTOR_MESSAGE });
    return;
  }

  if (await belongsToOrchestration(resolved.accessToken, request.issueId)) {
    await emit({ type: 'response', body: ORCHESTRATION_MESSAGE });
    return;
  }

  const priorTask = await findPriorTask(request);
  if (priorTask && !isTerminal(priorTask.status)) {
    await steerRunningTask(request, priorTask, platformUserId, emit);
    return;
  }

  const issueResult = await fetchAgentSessionIssue(resolved.accessToken, request.issueId);
  if (isLookupFailure(issueResult)) {
    throw issueResult.error instanceof Error
      ? issueResult.error
      : new Error(`Linear issue lookup failed for agent session ${request.sessionId}`);
  }
  if (!issueResult.ok) {
    await emit({ type: 'error', body: 'I couldn\'t read this issue from Linear, so I can\'t start work on it.' });
    return;
  }
  const issue = issueResult.value;

  const prNumber = priorTask ? prNumberFromTask(priorTask) : null;
  const iterate = Boolean(priorTask?.repo && prNumber !== null && request.directive);
  // The previous run paused to ask a question (surfaced as an `elicitation`):
  // this reply is the answer, so resume the original request with it.
  const clarifyResume = !iterate && Boolean(request.directive) && isClarifyHold(priorTask) && Boolean(priorTask?.repo);
  const repo = iterate || clarifyResume ? priorTask!.repo! : await resolveMappedRepo(issue, request.workspaceId);
  if (!repo) {
    await emit({ type: 'error', body: NOT_MAPPED_MESSAGE });
    return;
  }

  const channelMetadata: Record<string, string> = {
    linear_issue_id: request.issueId,
    linear_workspace_id: request.workspaceId,
    linear_agent_session_id: request.sessionId,
    ...(issue.projectId && { linear_project_id: issue.projectId }),
    ...(issue.identifier && { linear_issue_identifier: issue.identifier }),
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    ...vaultMetadata(resolved),
  };
  const idempotencyKey = agentSessionIdempotencyKey(request);
  const taskId = ulid();
  const result = await createTaskCore(
    iterate
      ? {
        repo,
        workflow_ref: PR_ITERATION_WORKFLOW_ID,
        pr_number: prNumber!,
        task_description: request.directive,
      }
      : {
        repo,
        workflow_ref: CODING_WORKFLOW_ID,
        task_description: clarifyResume
          ? buildClarifyResumeDescription(priorTask!.task_description, priorTask!.answer_text, request.directive)
          : buildAgentSessionTaskDescription(issue, request.directive, request.promptContext),
      },
    {
      userId: platformUserId,
      channelSource: 'linear',
      channelMetadata,
      taskId,
      idempotencyKey,
    },
    idempotencyKey,
  );

  if (result.statusCode === 200) {
    // Idempotent replay of a delivery we already admitted — its activity was emitted then.
    logger.info('Agent-session delivery replayed an existing task — no new activity', { ...logCtx, idempotency_key: idempotencyKey });
    return;
  }
  if (result.statusCode !== 201) {
    logger.warn('Agent-session task creation rejected', { ...logCtx, status_code: result.statusCode });
    await emit({ type: 'error', body: describeCreateTaskFailure(result.statusCode, result.body) });
    return;
  }
  logger.info('Agent-session task created', { ...logCtx, task_id: taskId, repo, iterate, clarify_resume: clarifyResume });
  await emit(iterate
    ? { type: 'action', action: 'Iterating on pull request', parameter: `${repo}#${prNumber}`, result: `Task \`${taskId}\`` }
    : { type: 'action', action: 'Started coding task', parameter: repo, result: `Task \`${taskId}\`` });
}

/**
 * ``stop`` signal: Linear requires the agent to take no further action and
 * confirm with a final ``response``/``error``. The CANCELLED transition is what
 * stops the agent (it re-reads its record between turns); the fan-out
 * dispatcher skips its own cancel confirmation for this path.
 */
async function handleStopRequest(
  request: AgentSessionRequest,
  emit: (content: AgentActivityContent) => Promise<void>,
): Promise<void> {
  const platformUserId = request.actorId
    ? await lookupLinearPlatformUser(ddb, USER_MAPPING_TABLE, request.workspaceId, request.actorId)
    : null;
  if (!platformUserId) {
    await emit({ type: 'error', body: `Stop request ignored. ${UNLINKED_ACTOR_MESSAGE}` });
    return;
  }
  const priorTask = await findPriorTask(request);
  if (!priorTask || isTerminal(priorTask.status)) {
    await emit({ type: 'response', body: 'Stopped. Nothing was running for this issue.' });
    return;
  }
  // Same rule as DELETE /tasks/{id}: only the task's owner can cancel it.
  if (priorTask.user_id !== platformUserId) {
    logger.warn('Agent-session stop from a user who does not own the running task — refusing', {
      linear_agent_session_id: request.sessionId, task_id: priorTask.task_id,
    });
    await emit({ type: 'error', body: `Stop request ignored. ${NOT_OWNER_MESSAGE}` });
    return;
  }
  const tables: CancelTaskTables = {
    ddb,
    taskTableName: TASK_TABLE_NAME,
    taskEventsTableName: TASK_EVENTS_TABLE_NAME,
    retentionDays: TASK_RETENTION_DAYS,
  };
  const now = new Date().toISOString();
  if (await transitionTaskToCancelled(tables, priorTask.task_id, now) === 'already_terminal') {
    await emit({ type: 'response', body: `Stopped. Task \`${priorTask.task_id}\` had already finished.` });
    return;
  }
  await writeTaskCancelledEvent(tables, priorTask.task_id, platformUserId, now, {
    cancelled_via: SESSION_STOP_CANCELLED_VIA,
  });
  logger.info('Agent-session stop cancelled task', {
    linear_agent_session_id: request.sessionId, task_id: priorTask.task_id, cancelled_by: platformUserId,
  });
  await emit({
    type: 'response',
    body: `Stopped. Task \`${priorTask.task_id}\` is cancelled; the agent exits after its current step.`,
  });
}

/**
 * A follow-up while a task is running is forwarded to the agent as a nudge.
 *
 * The task's own session hears about its outcome from the fan-out plane, so a
 * reply there is a ``thought``. Any other session (a second mention, or a
 * session on a label-triggered run) never will — it gets a final ``response``
 * so Linear does not leave it hanging until it goes stale.
 */
async function steerRunningTask(
  request: AgentSessionRequest,
  task: PriorTask,
  platformUserId: string,
  emit: (content: AgentActivityContent) => Promise<void>,
): Promise<void> {
  const ownSession = request.action === 'prompted'
    && task.channel_metadata?.linear_agent_session_id === request.sessionId;
  const reply = (body: string) => emit(ownSession ? { type: 'thought', body } : { type: 'response', body });
  if (!request.directive) {
    await reply(ownSession
      ? `Already working on this (task \`${task.task_id}\`) — I'll report back here.`
      : `Already working on this issue in task \`${task.task_id}\`; its progress is reported where it was started.`);
    return;
  }
  // Same rule as POST /tasks/{id}/nudge: only the owner steers a running agent,
  // since the nudge runs under the owner's identity and budget.
  if (task.user_id !== platformUserId) {
    await reply(`Task \`${task.task_id}\` is still running. ${NOT_OWNER_MESSAGE}`);
    return;
  }
  if (!NUDGES_TABLE_NAME) {
    await reply(`Task \`${task.task_id}\` is still running and I can't pass messages to it on this deployment. `
      + 'Send this again once it finishes, or stop it first.');
    return;
  }
  const truncated = request.directive.length > NUDGE_MAX_MESSAGE_LENGTH;
  const result = await submitNudge({
    ddb,
    nudgesTableName: NUDGES_TABLE_NAME,
    taskId: task.task_id,
    userId: platformUserId,
    message: request.directive.slice(0, NUDGE_MAX_MESSAGE_LENGTH),
    rateLimitPerMinute: NUDGE_RATE_LIMIT_PER_MINUTE,
  });
  const body = {
    accepted: 'Passed your message to the running agent — it will pick it up at its next step.'
      + (truncated ? ` (Only the first ${NUDGE_MAX_MESSAGE_LENGTH} characters were sent.)` : ''),
    blocked: 'Your message was blocked by the content policy, so I didn\'t pass it on.',
    rate_limited: 'Too many messages in the last minute — wait a moment and send it again.',
    screening_unavailable: 'Content screening is temporarily unavailable, so I couldn\'t pass your message on. Try again shortly.',
  }[result.kind];
  logger.info('Agent-session follow-up forwarded as nudge', {
    linear_agent_session_id: request.sessionId, task_id: task.task_id, outcome: result.kind, truncated,
  });
  await reply(body);
}

/** The prior task as read from the base table (strongly consistent). */
type PriorTask = LinearIssueTask & ClarifyHoldRow & {
  readonly channel_metadata?: Readonly<Record<string, string>>;
};

/**
 * The issue's newest ABCA task, scoped to this workspace. Throws on a lookup
 * failure: guessing "no task" would start a duplicate run beside a live one.
 */
async function findPriorTask(request: AgentSessionRequest): Promise<PriorTask | null> {
  const lookup = await lookupTaskByLinearIssue(ddb, TASK_TABLE_NAME, request.issueId);
  if (lookup.kind === 'error') {
    throw new Error(`Task lookup for Linear issue ${request.issueId} failed: ${lookup.message}`);
  }
  if (lookup.kind === 'none') return null;
  // The GSI is eventually consistent and projects no clarify/owner detail: re-read
  // the row itself so "still running?" (nudge vs. new task) and "who owns it?"
  // are decided on current data, not a lagging index.
  const { Item: record } = await ddb.send(new GetCommand({
    TableName: TASK_TABLE_NAME,
    Key: { task_id: lookup.task.task_id },
    ConsistentRead: true,
  }));
  if (!record) return null;
  const task = record as PriorTask;
  const ownerWorkspaceId = task.channel_metadata?.linear_workspace_id;
  if (ownerWorkspaceId !== request.workspaceId) {
    logger.warn('Agent-session issue\'s task belongs to another workspace — ignoring it', {
      linear_issue_id: request.issueId,
      event_workspace_id: request.workspaceId,
      owner_workspace_id: ownerWorkspaceId,
    });
    return null;
  }
  return task;
}

/**
 * Same membership test the comment path routes on: the issue is an epic with
 * its own orchestration, or a STARTED child of one. Those stay on the comment
 * path, which owns the epic panel and dependency cascade (ADR-018: sessions are
 * per-issue and have no cross-issue rollup).
 */
async function belongsToOrchestration(accessToken: string, issueId: string): Promise<boolean> {
  if (!ORCHESTRATION_TABLE) return false;
  const own = await loadOrchestration(ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issueId));
  if (own && own.meta.parent_issue_ref === issueId) return true;
  const parentResult = await fetchIssueParentId(accessToken, issueId);
  if (isLookupFailure(parentResult)) {
    throw parentResult.error instanceof Error
      ? parentResult.error
      : new Error(`Linear issue-parent lookup failed: ${String(parentResult.error)}`);
  }
  const parentId = lookupValueOr(parentResult, null);
  if (!parentId) return false;
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(parentId));
  const child = snapshot?.children.find((c) => c.sub_issue_id === issueId);
  return Boolean(child?.child_task_id);
}

/** Project → repo mapping, scoped to the delivering workspace. */
async function resolveMappedRepo(issue: AgentSessionIssue, workspaceId: string): Promise<string | null> {
  if (!issue.projectId) return null;
  const result = await ddb.send(new GetCommand({
    TableName: PROJECT_MAPPING_TABLE,
    Key: { linear_project_id: issue.projectId },
  }));
  const item = result.Item;
  if (!item || item.status !== 'active' || typeof item.repo !== 'string') return null;
  if (item.linear_workspace_id !== workspaceId) {
    logger.warn('Agent-session issue\'s project mapping belongs to another workspace — refusing', {
      linear_project_id: issue.projectId, event_workspace_id: workspaceId,
    });
    return null;
  }
  return item.repo;
}

function isTerminal(status: string | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as TaskStatusType);
}

async function emitSessionActivity(
  accessToken: string,
  request: AgentSessionRequest,
  content: AgentActivityContent,
  ephemeral: boolean,
): Promise<void> {
  const result = await emitAgentActivity(accessToken, request.sessionId, content, { ephemeral });
  if (!result.ok) {
    // Best-effort: the task outcome is still delivered by the fan-out plane.
    logger.warn('Failed to emit Linear agent activity', {
      linear_agent_session_id: request.sessionId,
      activity_type: content.type,
      retryable: result.retryable,
    });
  }
}

/**
 * User-facing reason for a rejected task. Validation and guardrail messages
 * (400) are written for the requester and shown as-is, matching the comment
 * channel; everything else gets a fixed string, because a session is readable
 * by the whole workspace and budget/limit responses carry spend and team ids.
 */
function describeCreateTaskFailure(statusCode: number, rawBody: string): string {
  if (statusCode === 400) {
    try {
      const message = (JSON.parse(rawBody) as { error?: { message?: string } }).error?.message;
      if (typeof message === 'string' && message.trim()) return `ABCA couldn't start this task: ${message.trim()}`;
    } catch {
      // fall through to the generic message
    }
  }
  if (statusCode === 429) {
    return 'ABCA couldn\'t start this task: a concurrency or budget limit was reached. Try again later or ask your ABCA admin.';
  }
  if (statusCode === 503) return 'ABCA is temporarily unavailable. Mention me again in a few minutes.';
  return `ABCA couldn't start this task (status ${statusCode}). Check the ABCA admin logs for details.`;
}
