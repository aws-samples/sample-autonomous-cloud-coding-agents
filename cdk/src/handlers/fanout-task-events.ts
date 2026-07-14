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
 * Fan-out plane router (design §6 / §8.9).
 *
 * DynamoDB Streams on `TaskEventsTable` deliver NEW_IMAGE records to
 * this Lambda. For each record we resolve a per-channel event filter
 * (``CHANNEL_DEFAULTS`` modulo optional per-task overrides from
 * `TaskRecord.notifications`, §6.5) and hand the event only to the
 * channels whose filter includes it. Channels do NOT share a single
 * union filter — Slack wants interactive signals (errors, approvals,
 * status responses) that would be noise on Email, while GitHub only
 * cares about PR activity + terminal outcomes.
 *
 * Dispatcher state: GitHub edits a single issue comment in place
 * (Chunk J). Slack posts threaded Block Kit messages with emoji
 * transitions and session-message cleanup via the ``slack-notify``
 * helper (issue #64 migrated the standalone SlackNotifyFn consumer onto
 * this router, dropping ``TaskEventsTable`` from two stream readers
 * back to one). Email remains a log-only stub until SES wiring lands.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type {
  DynamoDBBatchItemFailure,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { clearTokenCache, resolveGitHubToken } from './shared/context-hydration';
import { classifyError } from './shared/error-classifier';
import { renderCommentBody, upsertTaskComment } from './shared/github-comment';
import {
  buildAdfDocument,
  postIssueCommentAdf,
  type AdfParagraph,
  type AdfTextRun,
} from './shared/jira-feedback';
import { postIssueComment } from './shared/linear-feedback';
import { logger } from './shared/logger';
import { coerceNumericOrNull } from './shared/numeric';
import { loadRepoConfig } from './shared/repo-config';
import type { ChannelConfig, TaskNotificationsConfig, TaskRecord } from './shared/types';
import { dispatchSlackEvent, SlackApiError } from './slack-notify';

// Re-export the shared types so existing test imports (and any future
// caller that only imports from the handler module) continue to work.
export type { ChannelConfig, TaskNotificationsConfig };

/** Terminal task event types — shared by every channel's default filter.
 *  Kept as a single set so changes land in one place. */
const TERMINAL_EVENT_TYPES = [
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_stranded',
] as const;

/**
 * Cedar HITL approval milestones (design §11.1 + fan-out rules in §11.2).
 *
 * - ``approval_requested`` / ``approval_stranded`` go to Slack so the
 *   user sees the gate on their phone.
 * - ``approval_requested`` (high severity only — enforced by the
 *   dispatcher, not the filter) goes to Email.
 * - Granted / denied / timed_out are user-facing UX confirmations the
 *   CLI already surfaces; routing them to Slack too would create
 *   notification fatigue. Kept out of every channel's default.
 *
 * Events are milestone names from the `agent_milestone` event_type
 * stream; the fan-out Lambda unwraps them before routing.
 */
const APPROVAL_NOTIFICATION_EVENTS = [
  'approval_requested',
  'approval_stranded',
] as const;

/**
 * Per-channel default event-type subscriptions (design §6.2).
 *
 * Channels do NOT share a single filter — Slack wants interactive
 * signals (errors, approvals, status responses) while Email stays
 * minimal (terminal + approval only) and GitHub edits-in-place on
 * `pr_created` + terminal. Routing this per-channel up-front means
 * one user's chatty Slack settings can't spam their email, and
 * vice-versa, without any per-task config writer.
 *
 * Approval milestones (§11.2):
 *   - ``approval_requested`` / ``approval_stranded`` are the two
 *     user-facing "something needs you" signals that get fanned out.
 *     Every other ``approval_*`` milestone is internal bookkeeping
 *     (caps, clipping, late-wins) or a UX confirmation the CLI
 *     already surfaces; routing those to Slack / Email would create
 *     notification fatigue without adding value.
 *   - Per-user rate limit of 10 approval-related messages per minute
 *     is enforced in the dispatcher, not in this filter.
 */
export type NotificationChannel = 'slack' | 'email' | 'github' | 'linear' | 'jira';

export const CHANNEL_DEFAULTS: Record<NotificationChannel, ReadonlySet<string>> = {
  // Slack is the "on-call" channel per §6.2 — all terminal outcomes
  // (including cancellations, strands, and timeouts) plus agent_error,
  // the Cedar HITL approval-gate milestones, and the Phase 2/3
  // interactive signals. ``task_created`` and ``session_started`` are
  // additionally delivered for Slack-origin tasks so the
  // rocket/hourglass-flowing-sand message sequence lines up with the
  // @mention thread — the Slack dispatcher itself enforces
  // ``channel_source === 'slack'`` so the noisier early lifecycle
  // events do not reach non-Slack tasks.
  //
  // ``pr_created`` is intentionally NOT in the Slack default — even
  // though the original §6.2 design listed it. The
  // ``task_completed`` message renders a "View PR" button carrying
  // the same URL, and posting both produced visual duplication
  // (observed during issue #64 dev-stack verification: two messages
  // back-to-back with identical View PR buttons). GitHub's default
  // keeps ``pr_created`` because the edit-in-place comment surface
  // genuinely benefits from the early checkpoint.
  slack: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'task_timed_out',
    'task_created',
    'session_started',
    'agent_error',
    ...APPROVAL_NOTIFICATION_EVENTS,
    'status_response', // Phase 2 (not yet emitted)
  ]),
  // Email is deliberately minimal per §6.2: task_completed, task_failed,
  // and high-severity approval requests. Cancellations and strands are
  // intentionally NOT delivered. Severity-gating happens in the
  // dispatcher (§11.2 finding #4 — Slack approvals accept low/medium,
  // high severity stays CLI-only for Slack buttons but is still OK
  // for email-as-notification).
  email: new Set<string>([
    'task_completed',
    'task_failed',
    'approval_requested',
  ]),
  // GitHub edits a single issue comment in place (§6.4) covering
  // pr_created + terminal — including cancellations and strands so
  // the comment reflects the task's final outcome. Approval signals
  // are intentionally NOT posted to GitHub: the issue comment is
  // for progress, not synchronous gating.
  github: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'pr_created',
  ]),
  // Linear posts a single deterministic final-status comment on
  // terminal events. The agent's three-comment prompt contract (start /
  // PR-opened / completion) covers in-flight progress; this dispatcher
  // only fires once the task reaches a terminal state, with cost /
  // turns / duration / pr_url metrics the requester wouldn't otherwise
  // see. Crucially, this fires even when the agent crashes (e.g.
  // error_max_turns, OOM) before reaching its own step-3 completion
  // comment — the GH issue #239 motivating example.
  //
  // Linear's `save_comment` doesn't support edit, so this is post-once
  // (no live updates a la GitHub edit-in-place). Approvals / milestones
  // are excluded for the same reason — N comments rather than 1.
  linear: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
  ]),
  // Jira posts a single deterministic final-status comment on terminal
  // events — the Jira analogue of the Linear default above (issue #573).
  // Before this, Jira-origin tasks relied solely on the agent-side
  // ``jira_reactions.py`` terminal comment, which only carried
  // success/failure + PR URL and never fired at all if the agent crashed
  // before reaching its final-comment path (max-turns, OOM). This
  // dispatcher owns the terminal comment instead — with cost / turns /
  // duration — and fires even on an agent crash. ``task_timed_out`` is
  // included (unlike Linear, which predates it) because the orchestrator
  // now emits it as a distinct terminal event (``orchestrator.ts``); the
  // Slack + email defaults already subscribe to it.
  //
  // Jira has no comment-edit API (same as Linear), so this is post-once:
  // idempotency across partial-batch retries rides on the
  // ``jira_final_comment_event_id`` marker. The agent-side start comment
  // ("🤖 ABCA picked up this issue…") stays for in-flight progress.
  jira: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'task_timed_out',
  ]),
};

/**
 * Resolve the effective event-type filter for a channel.
 *
 * For v1 this is always the channel's default set — per-task
 * overrides (design §6.5 `TaskRecord.notifications`) are forward-
 * compatible plumbing: when Chunk K adds a DDB read, a caller can
 * pass `overrides` and enable/disable the channel or override its
 * event list. Today the value is always `undefined`, so every task
 * inherits the defaults.
 *
 * Resolution rules:
 *   - ``{ enabled: false }`` → empty set (channel opted out).
 *   - ``events`` absent      → channel default.
 *   - ``events: []``         → empty set (treated as opt-out with
 *                              a WARN, since an empty explicit list
 *                              is almost always a submission mistake —
 *                              we surface it rather than silently mute).
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
    // An empty explicit list silently muting a channel would be a
    // footgun once Chunk K exposes this at the submit-time API. Log
    // a WARN so operators see the mute; downstream validation should
    // catch this at submission, but defense-in-depth matters here
    // because the DDB path is cheap to bypass.
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

/** Stable channel iteration order, derived from ``CHANNEL_DEFAULTS``'s
 *  insertion order so adding a fourth channel (append to
 *  ``NotificationChannel`` + ``CHANNEL_DEFAULTS`` + ``DISPATCHERS``)
 *  does not require a matching edit here. */
const CHANNELS = Object.keys(CHANNEL_DEFAULTS) as readonly NotificationChannel[];

/** Union of every channel's currently-subscribed events. Used as the
 *  outer guard: events no channel cares about short-circuit before we
 *  spin up dispatchers, keeping the stream-processor narrow. */
function unionSubscribedTypes(overrides?: TaskNotificationsConfig): ReadonlySet<string> {
  const u = new Set<string>();
  for (const ch of CHANNELS) {
    for (const t of resolveChannelFilter(ch, overrides)) u.add(t);
  }
  return u;
}

/** Tight-loop suppression to bound spam per task for chatty agents. The
 *  hard cap is per Lambda invocation (not global) so a pathological
 *  agent can at worst emit `MAX_EVENTS_PER_TASK_PER_INVOCATION` events
 *  to each channel per stream poll (~1 s). A future follow-up can
 *  promote this to a DDB-backed rate limiter if needed. */
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
 * harness events) — let them fall out rather than crash the batch.
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

/**
 * Allowlist of ``agent_milestone`` names that are eligible to be
 * unwrapped into their effective routing type. Keeping this narrow is
 * a **structural** defense against naming drift: a future refactor
 * that accidentally renames an unrelated milestone (e.g.
 * ``task_cancelled_acknowledged`` → ``task_cancelled``) must not
 * silently start fanning out as a terminal. If a new milestone should
 * reach channels, add it here AND to the relevant channel default.
 *
 * The milestones the agent emits today (see
 * ``agent/src/progress_writer.py``, ``agent/src/pipeline.py``, and
 * ``agent/src/hooks.py``) are: ``pr_created``, ``nudge_acknowledged``,
 * ``repo_setup_complete``, ``agent_execution_complete``,
 * ``task_cancelled_acknowledged``, ``cancel_detected``,
 * ``trajectory_uploaded``, ``trace_truncated``. Only ``pr_created``
 * is currently in any channel's default filter (§6.2 Slack + GitHub).
 */
const ROUTABLE_MILESTONES: ReadonlySet<string> = new Set(['pr_created']);

/**
 * Unwrap ``agent_milestone`` events to their milestone name for
 * routing and rendering purposes.
 *
 * The agent writes named checkpoints (``pr_created``,
 * ``nudge_acknowledged``, ``repo_setup_complete``, …) as a single
 * ``agent_milestone`` event with ``metadata.milestone`` carrying the
 * name — see ``agent/src/progress_writer.py::write_agent_milestone``
 * and the design doc §4.2 event-types table. The watch CLI already
 * reads ``metadata.milestone`` when rendering those events.
 *
 * The fan-out filters are expressed against **effective** event types
 * (e.g. ``pr_created``, design §6.2 GitHub default set), so the
 * router must unwrap before matching — otherwise every milestone
 * routes as the string ``agent_milestone`` and gets dropped.
 *
 * Unwrap is restricted to ``ROUTABLE_MILESTONES`` so a future
 * milestone whose name happens to collide with a terminal / error
 * event type cannot silently fan out. Non-milestone events, bare
 * ``agent_milestone`` events without a well-formed milestone name,
 * and milestones outside the allowlist all keep their original
 * routing (i.e. match on the wrapper ``agent_milestone``).
 */
export function effectiveEventType(event: FanOutEvent): string {
  if (event.event_type !== 'agent_milestone') return event.event_type;
  const milestone = event.metadata?.milestone;
  if (typeof milestone !== 'string' || milestone.length === 0) return event.event_type;
  if (!ROUTABLE_MILESTONES.has(milestone)) return event.event_type;
  return milestone;
}

/** True if any subscribed channel wants this event. Used as the outer
 *  guard so events nobody cares about short-circuit before we spin
 *  dispatchers. Matches on the unwrapped effective event type so
 *  ``agent_milestone`` carriers route by their milestone name. */
export function shouldFanOut(event: FanOutEvent, overrides?: TaskNotificationsConfig): boolean {
  return unionSubscribedTypes(overrides).has(effectiveEventType(event));
}

/**
 * Per-channel dispatcher implementations. Slack and GitHub both talk to
 * real external APIs today; Email is still a log-only stub until SES
 * wiring lands.
 *
 * Dispatchers do NOT catch infra errors themselves. Error isolation
 * lives in ``routeEvent`` where ``Promise.allSettled`` records
 * per-channel outcomes and a single ``fanout.dispatcher.rejected`` warn
 * fires on rejection — keeping one error sink ensures batch telemetry
 * (`dispatched` count) reflects reality: a channel whose dispatcher
 * threw is NOT counted as dispatched. Slack swallows ``SlackApiError``
 * internally (the Slack API rejecting a message — e.g.
 * ``channel_not_found`` — is not recoverable by a Lambda retry).
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Slack dispatcher — hands the event to the in-module
 * ``handlers/slack-notify.ts`` helper (issue #64). The helper gates on
 * ``channel_source === 'slack'`` (so non-Slack tasks short-circuit after
 * a single DDB Get without any Slack API call) and preserves every
 * behaviour the old standalone ``SlackNotifyFn`` stream consumer had:
 * terminal-event dedup, threaded replies, emoji transitions, session
 * message cleanup. Slack-specific API failures are tagged with
 * ``SlackApiError`` so the router records a dispatcher-rejected warn
 * without escalating to the partial-batch retry path (a retry can't
 * fix ``channel_not_found``). Infra errors (DDB, Secrets Manager) are
 * rethrown unchanged so ``routeEvent``'s ``Promise.allSettled`` surfaces
 * them alongside any other dispatcher's rejection.
 */
async function dispatchToSlack(event: FanOutEvent): Promise<void> {
  // Pass the effective event type to the Slack dispatcher so
  // ``agent_milestone`` carriers (e.g. ``pr_created``) reach the
  // matching renderer. Without this rewrite, the dispatcher's
  // NOTIFIABLE_EVENTS gate would silently drop every milestone-wrapped
  // event the router subscribed Slack to, lying in
  // ``fanout.batch.complete`` telemetry (issue #64 review Cat 7).
  const effectiveType = effectiveEventType(event);
  const effectiveEvent = effectiveType === event.event_type
    ? event
    : { ...event, event_type: effectiveType };
  try {
    await dispatchSlackEvent(effectiveEvent, ddb);
  } catch (err) {
    // Match SlackApiError by class OR by ``name`` so a bundler that
    // duplicates the slack-notify module (rare with NodejsFunction
    // tree-shaking but possible if the module ever gets dual-bundled)
    // can't make ``instanceof`` silently fail and turn a
    // channel-terminal swallow into an infinite Lambda retry loop.
    // Mirrors how ``GitHubCommentError`` is duck-typed by name in
    // dispatchToGitHubComment (PR #79 review #7).
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

/**
 * Load the TaskRecord fields the GitHub dispatcher needs. Returns
 * ``null`` if the task vanished (race with TTL cleanup) or if the
 * TaskTable env var is missing in a broken deployment — the dispatcher
 * logs and skips instead of failing the batch.
 */
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

/**
 * Persist the ``github_comment_id`` on the TaskRecord after a
 * successful POST (either the first-ever dispatch or a 404 re-POST
 * fallback). Subsequent PATCHes are no-ops on the TaskRecord because
 * there is no additional state to carry — per-comment concurrency
 * relies on DDB Stream ordering, not on a stored ETag.
 *
 * The ConditionExpression guards two races:
 *   1. ``attribute_exists(task_id)`` — a concurrent TTL eviction would
 *      otherwise create a zombie record with only this field.
 *   2. Comment-id overwrite guard — the write is only allowed if (a)
 *      no comment has ever been persisted for this task, or (b) the
 *      stored id matches the one the caller thought was there. Without
 *      this clause, a 404 → POST fallback racing a concurrent fanout
 *      invocation could overwrite a sibling's freshly-posted comment id
 *      with our own new id, silently orphaning the sibling's comment.
 *      Under the normal single-writer flow the guard is a no-op.
 *
 * The caller (``dispatchToGitHubComment``) decides how to react to
 * each failure mode: ConditionalCheckFailedException (task evicted or
 * sibling-writer won the race) is benign; any other error is a real
 * persistence bug that risks a duplicate comment on the next event
 * (logged at ERROR with a dedicated ``FANOUT_GITHUB_PERSIST_FAILED``
 * error_id so operators can alarm).
 *
 * NOTE for new channels: prefer ``saveDispatchMarker`` (below), which owns
 * the shared never-throw / benign-CCF classification. This function predates
 * it and keeps its established log event names (``persist_benign_evicted``
 * / ``persist_failed``) because operators may filter on them.
 */
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
  if (previousCommentId === undefined) {
    // First-ever POST: require the field to be absent so a sibling
    // invocation that beat us cannot be silently overwritten.
    await ddb.send(new UpdateCommand({
      ...base,
      ExpressionAttributeValues: { ':cid': commentId },
      ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(github_comment_id)',
    }));
  } else {
    // 404 re-POST fallback: require the stored id to match the one we
    // thought was there before racing to overwrite it.
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

/** Name of the AWS SDK v3 conditional-failure error. Checking ``name``
 *  rather than ``instanceof`` keeps the check decoupled from the
 *  specific SDK client class the DocumentClient wraps. */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/**
 * Shared post-once / dedup marker writer for channel dispatchers. Both the
 * GitHub comment-id persistence and the Linear post-once marker share the
 * same load-bearing invariant: a successful external post must NEVER turn
 * into a batch retry because the marker write failed (the retry IS the
 * duplicate the marker exists to prevent). So this helper never throws —
 * it classifies the failure instead:
 *
 *   - ConditionalCheckFailedException → benign INFO (TTL eviction, or a
 *     sibling invocation won the race; its post is the surviving one).
 *   - anything else → ERROR with the channel's ``error_id`` so operators
 *     can alarm on "next event/retry may duplicate" distinctly.
 */
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

/**
 * Persist the post-once marker after a successful Linear final-status
 * comment (see ``dispatchToLinear``). Linear has no comment-edit API, so
 * the marker is what makes the post idempotent across partial-batch
 * retries.
 */
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

/**
 * Persist the post-once marker after a successful Jira final-status comment
 * (see ``dispatchToJira``). The Jira analogue of ``saveLinearCommentState`` —
 * Jira has no comment-edit API, so the marker is what makes the post
 * idempotent across partial-batch retries.
 */
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

/**
 * Resolve the GitHub comment target for this task. Prefers ``pr_number``
 * (the design-intent surface for pr_iteration / pr_review tasks) and
 * falls back to ``issue_number``. Returns ``null`` if the task has
 * neither — new_task tasks submitted via the API (no webhook) have no
 * upstream surface to comment on.
 */
function resolveCommentTarget(task: TaskRecord): number | null {
  return task.pr_number ?? task.issue_number ?? null;
}

/**
 * Resolve the GitHub token ARN for a task. Per-repo config wins; fall
 * back to the Lambda's platform default env var so freshly-onboarded
 * repos without an override still work.
 *
 * Error classification:
 *   - ``ResourceNotFoundException`` (RepoTable absent in dev) → fall
 *     back to the platform default silently.
 *   - ``AccessDeniedException`` → hard fail. An IAM misconfig means
 *     the dispatcher would use the wrong token for every repo, and
 *     silently falling back would mask the deployment bug.
 *   - Anything else (throttling, transient DDB errors, schema
 *     violations) → log at error and fall back so one flaky DDB
 *     invocation doesn't black-hole GitHub comments platform-wide.
 */
async function resolveTokenSecretArn(repo: string): Promise<string | null> {
  let repoConfig: Awaited<ReturnType<typeof loadRepoConfig>> = null;
  try {
    repoConfig = await loadRepoConfig(repo);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AccessDeniedException') {
      // Hard fail — IAM deny means every task in this deploy would
      // silently fall back to the platform default, hiding the bug.
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

  // A repo-less workflow (#248 Phase 3) has no GitHub repo to comment on —
  // skip the GitHub channel entirely. (resolveCommentTarget would also return
  // null below, but guarding on repo first narrows the type for upsertParams.)
  if (!task.repo) {
    logger.info('[fanout/github] repo-less task — skipping GitHub channel', {
      event: 'fanout.github.no_repo',
      task_id: event.task_id,
    });
    return;
  }

  const targetNumber = resolveCommentTarget(task);
  if (targetNumber === null) {
    // No issue / PR to comment on (API-submitted new_task with only a
    // task_description). Skip silently at debug level.
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

  // Render the effective event type so comment bodies read
  // ``pr_created`` / ``nudge_acknowledged`` rather than the wrapper
  // ``agent_milestone``. Matches the watch CLI's rendering of these
  // milestones (``cli/src/commands/watch.ts``).
  const renderedEventType = effectiveEventType(event);
  const body = renderCommentBody({
    taskId: task.task_id,
    status: task.status,
    repo: task.repo,
    latestEventType: renderedEventType,
    latestEventAt: event.timestamp,
    prUrl: task.pr_url ?? null,
    // DDB returns numeric attributes as strings at the Document-client
    // boundary (see ``shared/numeric.ts``). Without coercion
    // ``costUsd.toFixed(4)`` throws ``TypeError`` and the dispatcher
    // is rejected for every terminal event.
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
    // On 401 we treat the cached token as stale (rotation / expiry),
    // evict the cache, and retry exactly once. A cold token fetch is
    // cheap (one Secrets Manager call) and this self-heals the common
    // rotation case without operator intervention. Identify by duck-
    // typing on ``name`` + ``httpStatus`` rather than ``instanceof`` so
    // downstream callers (and tests that mock the module) can throw
    // a compatible shape without being the exact same class instance.
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
      result = await upsertTaskComment({ ...upsertParams, token: freshToken });
    } else if (
      isGhErr
      && typeof httpStatus === 'number'
      && httpStatus >= 400
      && httpStatus < 500
      // 403 (most often "API rate limit exceeded" on GitHub) and 429
      // ("Too Many Requests") are 4xx but **transient** — retrying
      // after the rate-limit window opens fixes them. Carving them
      // out here keeps a reconciliation wave from permanently
      // dropping every GitHub comment under the swallow path. The
      // batch retry pumps the backoff naturally; if it never clears,
      // the record DLQs after retryAttempts. Found in PR #79 review.
      && httpStatus !== 403
      && httpStatus !== 429
    ) {
      // Channel-terminal: a 4xx from GitHub (excluding the handled 401
      // rotation path, the 404 re-POST handled inside
      // ``upsertTaskComment``, and the 403/429 rate-limit carve-out
      // above) means the request itself is malformed or the resource
      // is gone — retrying will not change the outcome. Swallow the
      // rejection so the post-issue-#64 router does not push the
      // record into ``batchItemFailures`` and burn Lambda retries.
      // Log a dedicated warn so operators can alarm distinctly from
      // the retryable infra path.
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

  // Only the upserts that POSTed (either first-ever or 404 re-POST
  // fallback) have new state to persist. Steady-state PATCHes reuse
  // the same ``github_comment_id``, and we no longer track an ETag
  // since GitHub's PATCH endpoint doesn't honor ``If-Match``
  // (concurrency is handled upstream by DDB Stream ordering; see
  // ``shared/github-comment.ts`` file header).
  if (result.created) {
    try {
      await saveCommentState(task.task_id, result.commentId, task.github_comment_id);
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      if (errName === CONDITIONAL_CHECK_FAILED) {
        // Benign: either the task was TTL-evicted between our GetItem
        // and this UpdateItem (subsequent events for this task will
        // also GetItem-miss and skip), or a sibling fanout invocation
        // that raced us already wrote a comment id (our comment
        // survives as an orphan with the bgagent marker, safe to
        // reconcile offline). Either way no duplicate-comment-runaway
        // risk to chase here.
        logger.info('[fanout/github] saveCommentState condition failed — benign (eviction or sibling race)', {
          event: 'fanout.github.persist_benign_evicted',
          task_id: task.task_id,
        });
      } else {
        // Non-conditional failure (DDB throttling, IAM deny, etc.) is a
        // real persistence bug: the comment WAS posted but its id is
        // not on the TaskRecord. The next event will POST a second
        // comment instead of PATCHing. Log at ERROR with an error_id so
        // operators can alarm on persistent GitHub dispatch failures
        // distinctly from the generic dispatcher-rejected stream.
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

/**
 * Render the Linear final-status comment body. Inputs are already
 * coerced to native types by the caller; this function only formats.
 *
 * ``prUrl``, when present, renders on ALL frames — the ✅ success frame as much
 * as the ⚠️ shipped-but-stopped one. The completion comment is the terminal,
 * platform-owned surface, so it must carry the PR link authoritatively rather
 * than assume the agent's own "PR opened" comment did (the ABCA-584 case — see
 * the render note below). Only the framing/header flips on the outcome.
 *
 * The framing flips between three outcomes based on `(eventType, prUrl)`:
 *
 *   1. ``task_completed``                        → ✅ "Task completed"
 *   2. any non-completed terminal event WITH PR  → ⚠️ "Shipped a PR but stopped early"
 *      (the motivating ABCA-91 case is max-turns-with-PR, but the same
 *      framing applies to any terminal failure — budget cap, agent
 *      crash, etc. — that managed to ship a PR before stopping)
 *   3. any non-completed terminal event NO PR    → ❌ "Task <subtype>" + classifier title
 *
 * The ⚠️ frame appends the classifier title when one is available so the
 * requester sees both outcomes (the PR shipped, AND the reason it
 * stopped — "Hit max-turns cap" for ABCA-91).
 *
 * Cost / turns / duration appear as a subtitle line. Missing values
 * (e.g. failure before the agent emitted any tokens) render as `—`.
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
}): string {
  const isCompleted = args.eventType === 'task_completed';
  const shippedDespiteFailure = !isCompleted && args.prUrl != null;

  let header: string;
  if (isCompleted) {
    header = '✅ **Task completed**';
  } else if (shippedDespiteFailure) {
    // Append the classifier title (when known) so the requester sees
    // *why* the agent stopped, not just that it shipped a PR. For
    // ABCA-91 this renders "...stopped early — Hit max-turns cap".
    const reason = args.errorTitle ? ` — ${args.errorTitle}` : '';
    header = `⚠️ **Shipped a PR but stopped early${reason}** — review and decide if more work is needed`;
  } else {
    const reason = args.errorTitle ? `: ${args.errorTitle}` : '';
    header = `❌ **Task ${args.eventType.replace(/^task_/, '')}${reason}**`;
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
  // Render the PR URL whenever the task produced one — on BOTH the ✅ success and
  // the ⚠️ "shipped a PR but stopped early" paths. The prior code rendered it only
  // on ⚠️, on the assumption that "on ✅ the agent's own step-2 'PR opened' comment
  // reliably carries the link, so duplicating it is noise." That assumption FAILS
  // when the agent skips its PR-opened comment — live-caught on ABCA-584, where a
  // decompose→single task opened PR #395 (pr_url on the record) but posted no
  // PR-opened comment, so the ✅ completion comment omitted it and the link was
  // LOST entirely. The completion comment is the terminal, platform-owned surface;
  // rendering pr_url here guarantees the link is never lost, and a duplicate with
  // the agent's own comment is far cheaper than a missing PR. (Duplicate terminal
  // comments can't spam because the CALLER, `dispatchToLinear`, posts this body at
  // most once per task via the `linear_final_comment_event_id` idempotency marker
  // — this formatter is pure and enforces nothing; a future caller on a
  // non-idempotent path would need its own guard.)
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

/**
 * Linear dispatcher — posts a deterministic final-status comment when a
 * Linear-origin task reaches a terminal event. Mirrors Slack's structural
 * shape (channel_source gate, best-effort, single error-isolation point):
 *
 *   1. Load TaskRecord. Skip if missing (TTL eviction race).
 *   2. Gate on ``channel_source === 'linear'`` so non-Linear tasks
 *      short-circuit after one DDB Get.
 *   3. Read ``linear_issue_id`` + ``linear_workspace_id`` from
 *      ``channel_metadata``. Skip if either is missing — defensive,
 *      shouldn't happen for properly-admitted Linear tasks.
 *   4. Render the comment + post via the existing ``postIssueComment``
 *      helper, which never throws and classifies failures as
 *      retryable (network, timeout, 5xx/429) or terminal (auth,
 *      GraphQL errors, unresolvable token).
 *
 * Failure handling: terminal failures log-and-resolve — retrying won't
 * fix a revoked workspace or a bad issue id, and burning Lambda
 * retries on them would only delay sibling channels. Retryable
 * failures THROW so ``routeEvent`` records an infra rejection and the
 * record lands in ``batchItemFailures`` for a Lambda retry — without
 * this, a 30-second Linear blip permanently loses the final-status
 * comment, which for the agent-crash case (#239) is the user's only
 * completion signal. The retry is idempotent: the post-once marker
 * below is persisted only after a successful post, so a re-run either
 * posts the missing comment or short-circuits on the marker.
 */
async function dispatchToLinear(event: FanOutEvent): Promise<void> {
  const registryTableName = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    // WARN with error_id so this is alarmable. The Linear comment is
    // the *only* completion signal for the agent-crash case (#239), so a
    // misconfigured env var would silently drop every Linear-origin
    // task's metrics — exactly the gap this dispatcher was built to
    // close. The GitHub dispatcher uses the same WARN+error_id pattern
    // for its missing-env path.
    logger.warn('[fanout/linear] LINEAR_WORKSPACE_REGISTRY_TABLE_NAME not set — skipping', {
      event: 'fanout.linear.missing_env',
      error_id: 'FANOUT_LINEAR_MISSING_ENV',
      task_id: event.task_id,
    });
    return;
  }

  const task = await loadTaskForComment(event.task_id);
  if (!task) {
    logger.warn('[fanout/linear] task not found — skipping comment', {
      event: 'fanout.linear.task_missing',
      task_id: event.task_id,
    });
    return;
  }

  // channel_source gate — short-circuit non-Linear tasks. Same shape
  // Slack uses to keep the GitHub edit-in-place comment from racing
  // against the platform-side Linear comment when channel_source is
  // 'github'/'slack'/'api'.
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

  // Idempotency across partial-batch retries: Linear has no comment
  // edit API, so a re-run of this dispatcher (e.g. a sibling channel's
  // infra rejection pushed the whole stream record into
  // ``batchItemFailures``) would post a duplicate final-status comment.
  // The marker is persisted after the first successful post below.
  if (task.linear_final_comment_event_id) {
    logger.info('[fanout/linear] final comment already posted — skipping (idempotent retry)', {
      event: 'fanout.linear.already_posted',
      task_id: task.task_id,
      posted_event_id: task.linear_final_comment_event_id,
      event_id: event.event_id,
    });
    return;
  }

  // Derive an error title from `error_message` via the shared classifier.
  // Same data the API surfaces as `error_classification.title` —
  // "Hit max-turns cap", "Insufficient GitHub permissions", etc.
  //
  // Returns null only when error_message is empty/undefined (the
  // task_completed case). For any non-empty error_message that doesn't
  // match a known pattern, returns the UNKNOWN_CLASSIFICATION fallback
  // ("Unexpected error") — so a generic failure still gets a structured
  // title rather than nothing. See error-classifier.ts.
  const classification = classifyError(task.error_message);

  const body = renderLinearFinalStatusComment({
    eventType: event.event_type,
    prUrl: task.pr_url ?? null,
    // DDB returns numeric attributes as strings at the Document-client
    // boundary; coerce so toFixed/comparisons work. Same pattern the
    // GitHub dispatcher uses.
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
  });

  const postResult = await postIssueComment(
    { linearWorkspaceId: workspaceId, registryTableName },
    issueId,
    body,
  );

  // Split the success / failure path so post-failure can be alarmed
  // distinctly. The underlying linear-feedback.ts path already WARNs
  // on the specific failure reason (auth, network, etc.); this
  // backstop ensures a steady drip of post-failures shows up in the
  // dispatcher's own log channel for cross-channel alarms.
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
      // Escalate to routeEvent's Promise.allSettled so the record
      // enters batchItemFailures and Lambda retries. Safe because the
      // marker above was NOT persisted — the retry posts the missing
      // comment or, if a concurrent run won, short-circuits on the
      // marker. Terminal failures stay log-only: a retry cannot fix
      // them and would burn the event-source's bounded retryAttempts.
      throw new Error(
        `[fanout/linear] transient Linear post failure for task ${task.task_id} — escalating for batch retry`,
      );
    }
  }
}

/**
 * Render the Jira final-status comment as ADF paragraphs. Mirrors
 * ``renderLinearFinalStatusComment`` framing — the difference is the output
 * shape (ADF runs vs Markdown string), because Jira REST v3 comments require
 * Atlassian Document Format, not Markdown.
 *
 * Three outcomes based on ``(eventType, prUrl)``:
 *
 *   1. ``task_completed``                        → ✅ "Task completed"
 *   2. any non-completed terminal event WITH PR  → ⚠️ "Shipped a PR but stopped early"
 *   3. any non-completed terminal event NO PR    → ❌ "Task <subtype>" + classifier title
 *
 * The PR URL is rendered on the ✅ success path too — not just the ⚠️ path —
 * because the agent's own "PR opened" comment is not guaranteed to have fired
 * (a decompose→single task, or an agent that skipped that step), so the
 * platform comment must always carry the link or it can be lost entirely
 * (ABCA-584). The same fix lands for Linear in #601.
 *
 * Missing metric values render as ``—``. The result is a list of ADF
 * paragraphs (blank lines are empty paragraphs — ADF text nodes do not
 * honor ``\n``), fed to ``buildAdfDocument``.
 */
export function renderJiraFinalStatusComment(args: {
  eventType: string;
  prUrl: string | null;
  costUsd: number | null;
  turns: number | null;
  maxTurns: number | null;
  durationS: number | null;
  taskId: string;
  errorTitle: string | null;
}): ReadonlyArray<AdfParagraph> {
  const isCompleted = args.eventType === 'task_completed';
  const shippedDespiteFailure = !isCompleted && args.prUrl != null;

  // Header runs. Bold scope mirrors Linear's Markdown: the ⚠️ frame bolds
  // only through the reason and leaves the trailing "review and decide…"
  // advice unbolded, so it's a two-run paragraph. The ✅ / ❌ frames are a
  // single bold run.
  let headerRuns: AdfTextRun[];
  if (isCompleted) {
    headerRuns = [{ text: '✅ Task completed', strong: true }];
  } else if (shippedDespiteFailure) {
    const reason = args.errorTitle ? ` — ${args.errorTitle}` : '';
    headerRuns = [
      { text: `⚠️ Shipped a PR but stopped early${reason}`, strong: true },
      { text: ' — review and decide if more work is needed' },
    ];
  } else {
    // Humanize the event subtype for the header: strip the ``task_`` prefix
    // and turn underscores into spaces so ``task_timed_out`` reads "Task
    // timed out" rather than the raw "Task timed_out". Jira is the only
    // channel routing ``task_timed_out`` through this renderer, so this
    // multi-word subtype is a case the copied-from-Linear code never hit.
    const subtype = args.eventType.replace(/^task_/, '').replace(/_/g, ' ');
    const reason = args.errorTitle ? `: ${args.errorTitle}` : '';
    headerRuns = [{ text: `❌ Task ${subtype}${reason}`, strong: true }];
  }

  const costStr = args.costUsd != null ? `$${args.costUsd.toFixed(2)}` : '—';
  const turnsStr = args.turns != null
    ? `${args.turns}${args.maxTurns != null ? ` / ${args.maxTurns}` : ''}`
    : '—';
  const durationStr = args.durationS != null
    ? formatDuration(args.durationS)
    : '—';

  const paragraphs: AdfParagraph[] = [
    headerRuns,
    [{ text: `cost: ${costStr} • turns: ${turnsStr} • duration: ${durationStr}` }],
  ];
  // Render the PR link whenever one exists — on both the ✅ success path and
  // the ⚠️ shipped-but-stopped path — because the agent's own "PR opened"
  // comment may not have fired (ABCA-584), so this is the only guaranteed
  // PR-link surface. The URL run carries an ``href`` so it renders as a
  // clickable hyperlink — ADF does not auto-linkify a bare URL in a plain
  // text node the way Linear's Markdown does, so without this the requester
  // would have to copy-paste it.
  if (args.prUrl) {
    paragraphs.push([
      { text: 'PR: ' },
      { text: args.prUrl, href: args.prUrl },
    ]);
  }
  paragraphs.push([{ text: `task ${args.taskId}`, em: true }]);
  return paragraphs;
}

/**
 * Jira dispatcher — posts a deterministic final-status comment when a
 * Jira-origin task reaches a terminal event. The Jira analogue of
 * ``dispatchToLinear`` (issue #573); structurally identical:
 *
 *   1. Guard on ``JIRA_WORKSPACE_REGISTRY_TABLE_NAME`` (deploy-misconfig).
 *   2. Load TaskRecord. Skip if missing (TTL eviction race).
 *   3. Gate on ``channel_source === 'jira'`` so non-Jira tasks short-circuit
 *      after one DDB Get.
 *   4. Read ``jira_cloud_id`` + ``jira_issue_key`` from ``channel_metadata``.
 *      Skip if either is missing — defensive; shouldn't happen for a
 *      properly-admitted Jira task.
 *   5. Idempotency: skip if the ``jira_final_comment_event_id`` marker is set.
 *   6. Render ADF + post via ``postIssueCommentAdf`` (which owns the
 *      OAuth-refresh-and-retry-once behaviour), then persist the marker.
 *
 * Failure handling matches Linear: terminal failures log-and-resolve (a
 * retry cannot fix a revoked tenant or bad issue key); retryable failures
 * THROW so ``routeEvent`` records an infra rejection and the record lands
 * in ``batchItemFailures`` for a Lambda retry. The retry is idempotent —
 * the marker is persisted only after a successful post.
 */
async function dispatchToJira(event: FanOutEvent): Promise<void> {
  const registryTableName = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    // WARN with error_id so this is alarmable — same shape as the Linear
    // dispatcher. The final-status comment is the only completion signal
    // that survives an agent crash, so a misconfigured env var would
    // silently drop every Jira-origin task's metrics.
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

  // channel_source gate — short-circuit non-Jira tasks after one DDB Get.
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

  // Idempotency across partial-batch retries: Jira has no comment edit API,
  // so a re-run (e.g. a sibling channel's infra rejection pushed the whole
  // stream record into batchItemFailures) would post a duplicate. The
  // marker is persisted after the first successful post below.
  if (task.jira_final_comment_event_id) {
    logger.info('[fanout/jira] final comment already posted — skipping (idempotent retry)', {
      event: 'fanout.jira.already_posted',
      task_id: task.task_id,
      posted_event_id: task.jira_final_comment_event_id,
      event_id: event.event_id,
    });
    return;
  }

  // Same classifier the Linear dispatcher + API surface use — "Hit max-turns
  // cap", "Insufficient GitHub permissions", etc. Returns null only when
  // error_message is empty (the task_completed case).
  const classification = classifyError(task.error_message);

  const paragraphs = renderJiraFinalStatusComment({
    eventType: event.event_type,
    prUrl: task.pr_url ?? null,
    // DDB returns numeric attributes as strings at the Document-client
    // boundary; coerce so toFixed/comparisons work. Same pattern the
    // GitHub + Linear dispatchers use.
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
  });

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
      // Escalate to routeEvent's Promise.allSettled so the record enters
      // batchItemFailures and Lambda retries. Safe because the marker above
      // was NOT persisted — the retry posts the missing comment or, if a
      // concurrent run won, short-circuits on the marker. Terminal failures
      // stay log-only: a retry cannot fix them.
      throw new Error(
        `[fanout/jira] transient Jira post failure for task ${task.task_id} — escalating for batch retry`,
      );
    }
  }
}

/** Exposed for testing: the per-channel dispatcher callable by the
 *  handler. Each key's absence from the routing map disables its
 *  dispatcher; the signature is uniform so adding a channel is one
 *  entry. */
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
 * are swallowed inside the dispatcher itself and never appear here —
 * they are observable through ``fanout.<channel>.api_error`` warn lines.
 *
 * The handler reads ``infraRejections.length > 0`` to decide whether to
 * push the record into ``batchItemFailures`` so Lambda retries the
 * record with the partial-batch contract. This restores the retry
 * semantic that the standalone ``SlackNotifyFn`` had pre-issue-#64
 * (its handler rethrew non-``SlackApiError`` so Lambda retried the
 * batch). Without this distinction, a transient DDB throttle inside the
 * Slack dispatcher would be a permanent drop instead of a retry.
 */
export interface RouteOutcome {
  readonly dispatched: ReadonlyArray<NotificationChannel>;
  readonly infraRejections: ReadonlyArray<NotificationChannel>;
}

/**
 * Route an event to every subscribed channel. A dispatcher rejection
 * must NOT block sibling channels — we use ``Promise.allSettled`` so
 * one Slack outage can't drop a GitHub comment or vice-versa.
 *
 * Returns ``{ dispatched, infraRejections }``. A successful dispatch
 * lands in ``dispatched``; a rejection lands in ``infraRejections``
 * because the dispatcher itself is responsible for swallowing channel-
 * terminal errors (Slack ``channel_not_found``, etc.) before throwing.
 * Anything that reaches the router as a rejection is, by contract, a
 * retryable failure — and the handler will flag the record for
 * partial-batch retry.
 */
export async function routeEvent(
  ev: FanOutEvent,
  overrides?: TaskNotificationsConfig,
): Promise<RouteOutcome> {
  const attempted: NotificationChannel[] = [];
  const tasks: Promise<unknown>[] = [];
  // Match against the effective type so ``agent_milestone`` carriers
  // (``pr_created``, ``nudge_acknowledged``, …) reach the channels
  // subscribed to those milestone names.
  const effective = effectiveEventType(ev);
  for (const ch of CHANNELS) {
    const filter = resolveChannelFilter(ch, overrides);
    if (!filter.has(effective)) continue;
    attempted.push(ch);
    tasks.push(DISPATCHERS[ch](ev));
  }
  // Parallelism is bounded by the dispatcher list (5 channels:
  // slack/github/linear/jira/email), not by program input, so the
  // unbounded-parallelism lint does not apply.

  const results = await Promise.allSettled(tasks);

  const dispatched: NotificationChannel[] = [];
  const infraRejections: NotificationChannel[] = [];
  results.forEach((r, i) => {
    const ch = attempted[i];
    if (r.status === 'fulfilled') {
      dispatched.push(ch);
      return;
    }
    // The dispatcher rejected. By contract this is an *infra* error —
    // channel-terminal errors are swallowed inside the dispatcher
    // before reaching us. Mark for partial-batch retry and emit the
    // warn so operators can alert on the rate of retryable failures.
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
 * Returns a ``DynamoDBBatchResponse`` so the event-source-mapping's
 * ``reportBatchItemFailures: true`` setting (see
 * ``constructs/fanout-consumer.ts``) can honor partial-batch semantics.
 * Without a structured return, a single poisonous record would cause
 * Lambda to retry the **entire batch** from the stream checkpoint,
 * replaying every sibling event and defeating the per-task ordering
 * guarantee promised by ``ParallelizationFactor: 1`` upstream.
 *
 * Partial-failure surface (per-record try/catch below):
 *   - ``routeEvent`` wraps each dispatcher in ``Promise.allSettled``, so
 *     dispatcher rejections are already caught at the channel granularity
 *     and do not reach here. What DOES reach here is a throw BEFORE the
 *     ``allSettled`` — e.g. ``resolveTokenSecretArn`` throwing
 *     ``AccessDeniedException`` on an IAM misconfig (deliberate hard fail
 *     inside ``dispatchToGitHubComment``), a synchronous throw in
 *     ``loadTaskForComment`` on a broken DDB env, or any future writer
 *     that opens a non-``allSettled`` code path.
 *   - Parse / filter / rate-limit errors are defensive — today they
 *     cannot throw, but catching them keeps one stray ``throw`` in a
 *     future refactor (e.g. a stricter ``parseStreamRecord``) from
 *     crashing the whole batch.
 *
 * On any caught throw we push ``{ itemIdentifier: record.eventID }`` so
 * Lambda retries ONLY that record, isolating the poison pill per
 * design §6 + §8.9 expectations. Successful records are NOT in
 * ``batchItemFailures`` and advance the stream checkpoint normally.
 *
 * Refs: PR #52 findings #1 and #5 (the fanout
 * handler returned ``void`` despite ``reportBatchItemFailures: true``,
 * and a ``routeEvent`` throw from ``resolveTokenSecretArn`` could crash
 * the whole batch).
 */
// ``DynamoDBStreamHandler`` constrains the return to ``void | Promise<void>``,
// which blocks the ``DynamoDBBatchResponse`` we must return for
// ``reportBatchItemFailures: true`` to work (finding #1). Typing the
// handler as a plain 1-arg async function lets us return a structured
// response; Lambda's nodejs24.x runtime detects any 3-arg shape as
// callback-style and rejects it at init with
// ``Runtime.CallbackHandlerDeprecated`` (observed 2026-05-05 post-
// redeploy). Tests still invoke with trailing args — JS silently
// ignores extra params, so ``handler(event, ctx, cb)`` keeps working.
export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> => {
  const perTaskCounts = new Map<string, number>();
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  let processed = 0;
  let dispatched = 0;
  let dropped = 0;

  // v1: no per-task override; every event uses the channel defaults.
  // Chunk K wires a DDB read here to load ``TaskRecord.notifications``.
  const overrides: TaskNotificationsConfig | undefined = undefined;

  for (const record of event.Records) {
    processed++;
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
      // Per-channel infra rejections (DDB throttle, Secrets Manager
      // 5xx, transient Slack 5xx) escalate to the partial-batch retry
      // path. ``routeEvent`` already logged a warn per rejection; we
      // just need to make sure Lambda retries the record so the next
      // attempt has a chance to succeed. Without this push, a transient
      // failure would be silently dropped — the regression that
      // motivated this fix.
      if (outcome.infraRejections.length > 0 && record.eventID !== undefined) {
        batchItemFailures.push({ itemIdentifier: record.eventID });
      }
    } catch (err) {
      // Poison-pill isolation: one record's unhandled throw must not
      // crash the batch. See the handler doc block for the full list of
      // paths that can reach here (notably AccessDeniedException from
      // ``resolveTokenSecretArn``, finding #5).
      //
      // ``eventID`` is the stream-record identifier Lambda uses for the
      // retry cursor; on Kinesis-style event-source-mappings with
      // ``reportBatchItemFailures: true`` the service retries all
      // records at-or-after the lowest-sequence failure. Returning even
      // one failed itemIdentifier is enough to preserve ordering across
      // the whole batch for that task.
      const eventID = record.eventID;
      logger.warn('[fanout] record threw — flagging for partial-batch retry', {
        event: 'fanout.record.failed',
        event_id: eventID,
        error: err instanceof Error ? err.message : String(err),
        error_name: err instanceof Error ? err.name : undefined,
      });
      if (eventID !== undefined) {
        batchItemFailures.push({ itemIdentifier: eventID });
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
