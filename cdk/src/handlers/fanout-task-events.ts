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
 * Fan-out plane consumer (design §8.9 — last strict Phase 1b item).
 *
 * DynamoDB Streams on `TaskEventsTable` deliver NEW_IMAGE records to this
 * Lambda. We filter to the event types that non-interactive consumers
 * (Slack bots, GitHub PR comments, email/SMS, cron reporters) actually
 * want — milestones, errors, terminal transitions, and the
 * `pr_created` signal — then hand each filtered event to per-channel
 * dispatchers. Verbose text triads (TEXT_MESSAGE_START / CONTENT / END)
 * are dropped: those are for live watchers, not async delivery.
 *
 * This handler is a **skeleton**: the per-channel dispatcher stubs log
 * each would-be delivery to CloudWatch but don't actually call Slack /
 * GitHub / SES yet. The design explicitly allows this:
 *
 *   "the fan-out Lambda itself can ship later without any change to
 *    the agent or CLI"  — §8.9
 *
 * Enabling a real dispatcher is a per-channel PR: add the SDK client
 * (e.g. `@slack/web-api`), replace the `log-only` block, add an IAM
 * policy (or Secrets Manager grant) on the Lambda's execution role,
 * and add the channel's configuration (OAuth token ARN + channel ID,
 * GitHub App credentials, SES verified identity) to the construct's
 * props.
 */

import type { DynamoDBStreamEvent, DynamoDBStreamHandler, DynamoDBRecord } from 'aws-lambda';
import { logger } from './shared/logger';

/** Event types we fan out. Anything else is silently dropped — this is
 *  a stream-processor, not an event bus. Keep the set narrow so we don't
 *  spam downstream channels with every intermediate TEXT_MESSAGE frame. */
const FAN_OUT_EVENT_TYPES = new Set([
  'task_created',
  'task_failed',
  'task_completed',
  'task_cancelled',
  'task_stranded',
  'agent_milestone',
  'agent_error',
  'pr_created',
]);

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

/** True if this event type is interesting for async consumers. */
export function shouldFanOut(event: FanOutEvent): boolean {
  return FAN_OUT_EVENT_TYPES.has(event.event_type);
}

/**
 * Per-channel dispatcher stubs. Each currently just logs what it
 * WOULD have sent. Replace the body when a real integration lands —
 * the interface (one async call per event) stays the same.
 *
 * Dispatchers return `void` and MUST NOT throw for transient errors —
 * failing the Lambda would replay the whole batch against the DDB
 * Stream, duplicating deliveries to channels that already received
 * this event on an earlier try. Catch, log, and continue; wire a DLQ
 * on the event-source-mapping for persistent failures instead.
 */
async function dispatchToSlack(event: FanOutEvent): Promise<void> {
  try {
    logger.info('[fanout/slack] would dispatch', {
      event: 'fanout.slack.dispatch_stub',
      task_id: event.task_id,
      event_id: event.event_id,
      event_type: event.event_type,
    });
  } catch (err) {
    logger.warn('[fanout/slack] dispatch failed', {
      event: 'fanout.slack.dispatch_failed',
      task_id: event.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchToGitHubComment(event: FanOutEvent): Promise<void> {
  try {
    // Real integration: inspect `event.metadata.channel_source === 'webhook'`
    // and the task's `repo` + `issue_number` / `pr_number`; post via
    // the GitHub App REST API. For now, only log for terminal /
    // pr_created events to keep the log volume sane.
    if (!['pr_created', 'task_completed', 'task_failed'].includes(event.event_type)) return;
    logger.info('[fanout/github] would comment', {
      event: 'fanout.github.dispatch_stub',
      task_id: event.task_id,
      event_type: event.event_type,
    });
  } catch (err) {
    logger.warn('[fanout/github] dispatch failed', {
      event: 'fanout.github.dispatch_failed',
      task_id: event.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchToEmail(event: FanOutEvent): Promise<void> {
  try {
    // One-shot on completion / failure only; no intermediate noise.
    if (!['task_completed', 'task_failed', 'task_stranded'].includes(event.event_type)) return;
    logger.info('[fanout/email] would send', {
      event: 'fanout.email.dispatch_stub',
      task_id: event.task_id,
      event_type: event.event_type,
    });
  } catch (err) {
    logger.warn('[fanout/email] dispatch failed', {
      event: 'fanout.email.dispatch_failed',
      task_id: event.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

  for (const record of event.Records) {
    processed++;
    const ev = parseStreamRecord(record);
    if (!ev) {
      dropped++;
      continue;
    }
    if (!shouldFanOut(ev)) {
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

    // Run all dispatchers in parallel for this event. Each catches
    // its own errors so one channel's failure doesn't block the
    // others.
    await Promise.all([
      dispatchToSlack(ev),
      dispatchToGitHubComment(ev),
      dispatchToEmail(ev),
    ]);
    dispatched++;
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
