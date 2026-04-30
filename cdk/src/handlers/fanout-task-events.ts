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
 * This handler is a **skeleton**: per-channel dispatcher stubs log
 * each would-be delivery to CloudWatch but don't call Slack / GitHub /
 * SES yet. The design explicitly allows this:
 *
 *   "the fan-out Lambda itself can ship later without any change to
 *    the agent or CLI"  — §8.9
 *
 * Enabling a real dispatcher is a per-channel PR: add the SDK client
 * (e.g. `@slack/web-api`), replace the `log-only` block, add an IAM
 * policy (or Secrets Manager grant) on the Lambda's execution role,
 * and add the channel's configuration (OAuth token ARN + channel ID,
 * GitHub App credentials, SES verified identity) to the construct's
 * props. Chunk J ships the first real dispatcher (GitHub edit-in-place).
 */

import type { DynamoDBStreamEvent, DynamoDBStreamHandler, DynamoDBRecord } from 'aws-lambda';
import { logger } from './shared/logger';
import type { ChannelConfig, TaskNotificationsConfig } from './shared/types';

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
 * Per-channel default event-type subscriptions (design §6.2).
 *
 * Channels do NOT share a single filter — Slack wants interactive
 * signals (errors, approvals, status responses) while Email stays
 * minimal (terminal + approval only) and GitHub edits-in-place on
 * `pr_created` + terminal. Routing this per-channel up-front means
 * one user's chatty Slack settings can't spam their email, and
 * vice-versa, without any per-task config writer.
 *
 * Phase 2 event types (`status_response`) and Phase 3 event types
 * (`approval_required`) are listed here so when those writers ship,
 * routing is already correct. No current writer emits them — the
 * entries are no-ops today.
 */
export type NotificationChannel = 'slack' | 'email' | 'github';

export const CHANNEL_DEFAULTS: Record<NotificationChannel, ReadonlySet<string>> = {
  // Slack is the "on-call" channel per §6.2 — all terminal outcomes
  // (including cancellations and strands) plus agent_error and the
  // Phase 2/3 interactive signals.
  slack: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'pr_created',
    'agent_error',
    'approval_required', // Phase 3 (not yet emitted)
    'status_response', // Phase 2 (not yet emitted)
  ]),
  // Email is deliberately minimal per §6.2: only task_completed,
  // task_failed, and approval_required. Cancellations and strands are
  // intentionally NOT delivered — the user already knows they cancelled
  // the task, and strands are an operator signal. Keep these in sync
  // with the design doc's per-channel defaults table.
  email: new Set<string>([
    'task_completed',
    'task_failed',
    'approval_required', // Phase 3 (not yet emitted)
  ]),
  // GitHub edits a single issue comment in place (§6.4) covering
  // pr_created + terminal — including cancellations and strands so
  // the comment reflects the task's final outcome.
  github: new Set<string>([
    ...TERMINAL_EVENT_TYPES,
    'pr_created',
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

/** True if any subscribed channel wants this event. Used as the outer
 *  guard so events nobody cares about short-circuit before we spin
 *  dispatchers. */
export function shouldFanOut(event: FanOutEvent, overrides?: TaskNotificationsConfig): boolean {
  return unionSubscribedTypes(overrides).has(event.event_type);
}

/**
 * Per-channel dispatcher stubs. Each currently just logs what it
 * WOULD have sent. Replace the body when a real integration lands —
 * the interface stays the same.
 *
 * Dispatchers do NOT catch their own errors. Error isolation lives in
 * ``routeEvent`` where ``Promise.allSettled`` records per-channel
 * outcomes and a single ``fanout.dispatcher.rejected`` warn fires on
 * rejection. Keeping one error sink ensures batch telemetry
 * (`dispatched` count) reflects reality: a channel whose dispatcher
 * threw is NOT counted as dispatched.
 */
async function dispatchToSlack(event: FanOutEvent): Promise<void> {
  logger.info('[fanout/slack] would dispatch', {
    event: 'fanout.slack.dispatch_stub',
    task_id: event.task_id,
    event_id: event.event_id,
    event_type: event.event_type,
  });
}

async function dispatchToGitHubComment(event: FanOutEvent): Promise<void> {
  // Real integration (Chunk J): inspect `event.metadata.channel_source === 'webhook'`
  // and the task's `repo` + `issue_number` / `pr_number`; edit a single
  // issue comment in place via the GitHub App REST API with If-Match
  // ETag concurrency.
  logger.info('[fanout/github] would comment', {
    event: 'fanout.github.dispatch_stub',
    task_id: event.task_id,
    event_type: event.event_type,
  });
}

async function dispatchToEmail(event: FanOutEvent): Promise<void> {
  logger.info('[fanout/email] would send', {
    event: 'fanout.email.dispatch_stub',
    task_id: event.task_id,
    event_type: event.event_type,
  });
}

/** Exposed for testing: the per-channel dispatcher callable by the
 *  handler. Each key's absence from the routing map disables its
 *  dispatcher; the signature is uniform so adding a channel is one
 *  entry. */
const DISPATCHERS: Record<NotificationChannel, (ev: FanOutEvent) => Promise<void>> = {
  slack: dispatchToSlack,
  github: dispatchToGitHubComment,
  email: dispatchToEmail,
};

/**
 * Route an event to every subscribed channel. A dispatcher that
 * rejects must NOT fail the whole batch: we swallow per-channel
 * rejections so one Slack outage can't block GitHub comment delivery
 * or drop an email notification.
 *
 * Returns the list of channels that **successfully** dispatched — a
 * channel whose dispatcher rejected is omitted so batch telemetry
 * (`dispatched` count in the handler) reflects reality. A rejected
 * dispatcher is still logged with a ``fanout.dispatcher.rejected``
 * warn line that operators can alert on.
 */
export async function routeEvent(
  ev: FanOutEvent,
  overrides?: TaskNotificationsConfig,
): Promise<NotificationChannel[]> {
  const attempted: NotificationChannel[] = [];
  const tasks: Promise<unknown>[] = [];
  for (const ch of CHANNELS) {
    const filter = resolveChannelFilter(ch, overrides);
    if (!filter.has(ev.event_type)) continue;
    attempted.push(ch);
    tasks.push(DISPATCHERS[ch](ev));
  }
  // Parallelism is bounded by the dispatcher list (at most 3 channels),
  // not by program input, so the unbounded-parallelism lint does not apply.
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  const results = await Promise.allSettled(tasks);

  const dispatched: NotificationChannel[] = [];
  results.forEach((r, i) => {
    const ch = attempted[i];
    if (r.status === 'fulfilled') {
      dispatched.push(ch);
      return;
    }
    // Belt-and-braces — the dispatcher stubs catch inside their own
    // try/catch so this branch only fires if a future refactor drops
    // the inner catch or if the dispatcher throws synchronously before
    // entering its try. Record at warn so the signal isn't lost.
    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
    logger.warn('[fanout] dispatcher rejected — continuing batch', {
      event: 'fanout.dispatcher.rejected',
      channel: ch,
      task_id: ev.task_id,
      event_id: ev.event_id,
      error: reason,
    });
  });
  return dispatched;
}

/**
 * Lambda entry point. Invoked by the DynamoDB Streams event source
 * mapping with batches of NEW_IMAGE records from `TaskEventsTable`.
 */
export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  const perTaskCounts = new Map<string, number>();
  let processed = 0;
  let dispatched = 0;
  let dropped = 0;

  // v1: no per-task override; every event uses the channel defaults.
  // Chunk K wires a DDB read here to load ``TaskRecord.notifications``.
  const overrides: TaskNotificationsConfig | undefined = undefined;

  for (const record of event.Records) {
    processed++;
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
        cap: MAX_EVENTS_PER_TASK_PER_INVOCATION,
      });
      dropped++;
      continue;
    }
    perTaskCounts.set(ev.task_id, seen + 1);

    const channels = await routeEvent(ev, overrides);
    if (channels.length > 0) dispatched++;
  }

  logger.info('[fanout] batch complete', {
    event: 'fanout.batch.complete',
    records: event.Records.length,
    processed,
    dispatched,
    dropped,
    unique_tasks: perTaskCounts.size,
  });
};
