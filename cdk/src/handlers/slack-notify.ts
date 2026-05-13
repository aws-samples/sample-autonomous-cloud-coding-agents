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
 * Slack dispatcher for the FanOutConsumer (§8.9 fan-out plane).
 *
 * Before issue #64 this module was a standalone DynamoDB Streams consumer
 * that read ``TaskEventsTable`` directly. That put the platform at **two**
 * concurrent readers per shard on that stream (``SlackNotifyFn`` plus
 * ``FanOutConsumer``), which is the hard DynamoDB Streams limit — any
 * additional channel reader would start being throttled. The Slack
 * delivery logic now lives behind the fan-out router as a per-channel
 * dispatcher, leaving ``TaskEventsTable`` with a single stream consumer.
 *
 * Behaviour preserved from the old handler bit-for-bit (the fan-out
 * router does not change any semantics — it just removes the second
 * event-source mapping):
 *   - ``channel_source === 'slack'`` gate.
 *   - Terminal-event dedup via a conditional ``UpdateItem`` on
 *     ``channel_metadata.slack_notified_terminal``.
 *   - Threaded replies under the original ``@mention`` / ``task_created``
 *     message via ``slack_thread_ts``.
 *   - DM channel-id → user-id rewrite for ``D``-prefixed channels.
 *   - Emoji reaction swaps on the root message per event type.
 *   - Intermediate message cleanup (``slack_session_msg_ts`` +
 *     ``slack_created_msg_ts``) on terminal events.
 *   - Slack API errors are logged and swallowed at the router boundary;
 *     infra errors (DDB, Secrets Manager) propagate so the record lands
 *     in the FanOutConsumer's partial-batch retry path.
 */

import { type DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
// Type-only import of ``FanOutEvent`` — values flow only one way at
// runtime (fanout-task-events imports + calls ``dispatchSlackEvent``),
// so importing the type back creates no runtime cycle. ``import type``
// is erased after compile, so the bundler sees a one-way dep.
import type { FanOutEvent } from './fanout-task-events';
import { logger } from './shared/logger';
import { renderSlackBlocks } from './shared/slack-blocks';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';
import type { TaskRecord } from './shared/types';

/** Terminal event types the Slack dispatcher dedups on. Stored in
 *  ``channel_metadata.slack_notified_terminal`` via a conditional write
 *  so a retry can never double-post the final outcome. */
const TERMINAL_EVENTS = new Set<string>([
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_timed_out',
  'task_stranded',
]);

/**
 * Map an event type to the ``channel_metadata`` attribute that should
 * guard against double-posting on a partial-batch retry. PR #79 review
 * #4 surfaced the gap: when GitHub or Email rate-limits and the record
 * is replayed, every Slack-subscribed event for that record runs again.
 * Terminals were already dedup-protected by ``slack_notified_terminal``
 * but ``agent_error`` was not — operators would page twice on a single
 * agent failure if a sibling channel happened to fail.
 *
 * Each entry is an attribute name; ``null`` means the event type is
 * intentionally NOT deduped (lifecycle events ``task_created`` /
 * ``session_started`` use the per-event ``slack_*_msg_ts`` conditional
 * persists instead, which is the right shape since they need to store
 * a value, not just a presence marker).
 */
const SLACK_DEDUP_ATTRIBUTE: Record<string, string | null> = {
  task_completed: 'slack_notified_terminal',
  task_failed: 'slack_notified_terminal',
  task_cancelled: 'slack_notified_terminal',
  task_timed_out: 'slack_notified_terminal',
  task_stranded: 'slack_notified_terminal',
  agent_error: 'slack_dispatched_agent_error',
  task_created: null,
  session_started: null,
};

/** Event types this dispatcher renders. Must stay in sync with the
 *  Slack entries in ``CHANNEL_DEFAULTS`` (see fanout-task-events.ts) —
 *  drift means the router subscribes Slack to events that the
 *  dispatcher silently ignores, which lies in batch telemetry
 *  (issue #64 review Cat 7). Forward-compat ``approval_required`` and
 *  ``status_response`` are deliberately absent until their emitters
 *  ship; until then they fall through and are dropped at this gate.
 *  ``pr_created`` is intentionally omitted from Slack — the
 *  ``task_completed`` block already carries the View PR button, so a
 *  separate "PR opened" message just produces visible duplication
 *  (verified during issue #64 dev-stack tests). Exported for the
 *  cross-file consistency test. */
export const NOTIFIABLE_EVENTS = new Set<string>([
  'task_created',
  'session_started',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_timed_out',
  'task_stranded',
  'agent_error',
]);

/**
 * Minimal event shape the dispatcher needs. Defined as a type alias of
 * ``FanOutEvent`` so the contract between the router and the dispatcher
 * cannot silently drift if either side adds a field — TypeScript will
 * propagate the change automatically (PR #79 review #10). Originally a
 * standalone interface, but the structural duplication was a footgun.
 */
export type SlackDispatchEvent = FanOutEvent;

/**
 * Thrown when the Slack API returns a **terminal** error — one that
 * cannot be fixed by a Lambda retry (e.g. ``channel_not_found``,
 * ``not_authed``, ``invalid_blocks``). The router catches this class
 * specifically and swallows it; the record advances past the cursor
 * without tripping the partial-batch retry path.
 *
 * Retryable Slack errors (``ratelimited``, ``service_unavailable``,
 * ``internal_error``) are NOT wrapped in ``SlackApiError`` — they
 * propagate as plain ``Error`` so the router classifies them as infra
 * rejections and Lambda replays the record.
 */
export class SlackApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/**
 * Slack API error codes that are terminal — retrying the same request
 * yields the same failure. Sourced from the Slack ``chat.postMessage``
 * + ``reactions.add`` documented errors. Codes outside this set are
 * treated as retryable so a transient ``ratelimited`` /
 * ``service_unavailable`` doesn't get permanently dropped.
 */
const TERMINAL_SLACK_API_ERRORS: ReadonlySet<string> = new Set([
  // Channel-shape failures.
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'message_not_found',
  // Auth failures.
  'not_authed',
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
  // Permission / scope failures (PR #79 review #8): each of these
  // means a configuration fix is required before any retry can
  // succeed, so swallow them as terminal and let operators alert on
  // the dedicated ``fanout.slack.api_error`` warn rate.
  'no_permission',
  'missing_scope',
  'restricted_action',
  'ekm_access_denied',
  'team_access_not_granted',
  'posting_to_general_channel_denied',
  'as_user_not_supported',
  // Payload-shape failures.
  'invalid_blocks',
  'invalid_blocks_format',
  'invalid_arguments',
  'msg_too_long',
  'too_many_attachments',
]);

/** Tag a Slack ``!result.ok`` error as terminal vs retryable so the
 *  router can route it to the right outcome. */
function classifySlackError(slackErrorCode: string): 'terminal' | 'retryable' {
  return TERMINAL_SLACK_API_ERRORS.has(slackErrorCode) ? 'terminal' : 'retryable';
}

/**
 * Dispatch a single task event to Slack.
 *
 * The caller is the fan-out router (``handlers/fanout-task-events.ts``).
 * The router already filters by ``CHANNEL_DEFAULTS.slack`` and isolates
 * rejections via ``Promise.allSettled``, so this function can throw
 * freely on infra problems — the router will log the rejection through
 * its standard ``fanout.dispatcher.rejected`` channel without failing
 * the batch.
 */
export async function dispatchSlackEvent(
  event: SlackDispatchEvent,
  ddb: DynamoDBDocumentClient,
): Promise<void> {
  const { task_id: taskId, event_type: eventType } = event;
  if (!NOTIFIABLE_EVENTS.has(eventType)) return;

  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) {
    // Throw rather than return — a missing env var on a Slack-
    // subscribed event is a deployment misconfiguration, not a per-
    // record problem. Returning silently used to count as "successful
    // dispatch" in batch telemetry, so a broken stack would drop
    // every Slack notification indefinitely with only a warn line.
    // Throwing routes the rejection through the router's
    // ``infraRejections`` path so Lambda retries (until DLQ) and the
    // ``fanout.dispatcher.rejected`` metric alarms operators
    // (PR #79 review #3).
    logger.error('[fanout/slack] TASK_TABLE_NAME not set — cannot dispatch', {
      event: 'fanout.slack.missing_env',
      error_id: 'FANOUT_SLACK_MISSING_TASK_TABLE',
      task_id: taskId,
    });
    throw new Error(
      `[fanout/slack] TASK_TABLE_NAME env var not set; Slack dispatcher cannot run (task_id=${taskId})`,
    );
  }

  const taskResult = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { task_id: taskId },
  }));
  const task = taskResult.Item as TaskRecord | undefined;
  if (!task || task.channel_source !== 'slack') return;

  // Dedup any event that should only ever post once per task even
  // under partial-batch retry (terminals, agent_error). The orchestrator
  // can also write multiple events of the same kind (retries,
  // reconciler), so the ``ADD`` on the ``channel_metadata.<attr>``
  // marker claims the right to post for the whole event class.
  // ``slack_notified_terminal`` covers all 5 terminals collectively;
  // ``slack_dispatched_agent_error`` covers agent_error separately so
  // the operator gets the first agent_error but not duplicates from
  // sibling-channel-failure retries (PR #79 review #4).
  const dedupAttr = SLACK_DEDUP_ATTRIBUTE[eventType];
  if (dedupAttr) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { task_id: taskId },
        UpdateExpression: `SET channel_metadata.${dedupAttr} = :t`,
        ConditionExpression: `attribute_not_exists(channel_metadata.${dedupAttr})`,
        ExpressionAttributeValues: { ':t': true },
      }));
    } catch (err) {
      if ((err as Error)?.name === 'ConditionalCheckFailedException') {
        logger.info('[fanout/slack] notification already sent, skipping duplicate', {
          event: 'fanout.slack.dedup_hit',
          task_id: taskId,
          event_type: eventType,
          dedup_attr: dedupAttr,
        });
        return;
      }
      throw err;
    }
  }

  const channelMeta = task.channel_metadata;
  if (!channelMeta?.slack_team_id || !channelMeta?.slack_channel_id) {
    logger.warn('[fanout/slack] Slack task missing channel metadata', {
      event: 'fanout.slack.missing_metadata',
      task_id: taskId,
    });
    return;
  }

  const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${channelMeta.slack_team_id}`);
  if (!botToken) {
    logger.warn('[fanout/slack] bot token not found for Slack workspace', {
      event: 'fanout.slack.no_bot_token',
      team_id: channelMeta.slack_team_id,
      task_id: taskId,
    });
    return;
  }

  // The fan-out router already parsed ``metadata`` into a JS map, so no
  // JSON re-parse is required here — the old handler had to parse the
  // ``metadata: { S: ... }`` shape itself from the raw stream record.
  const eventMetadata = event.metadata;

  const message = renderSlackBlocks(eventType, task, eventMetadata);

  const threadTs = channelMeta.slack_thread_ts;

  // DM channels use the user id so ``chat.postMessage`` opens the DM
  // automatically — the ephemeral channel id Slack hands out in slash
  // command payloads can 404 otherwise.
  const channel = channelMeta.slack_channel_id.startsWith('D') && channelMeta.slack_user_id
    ? channelMeta.slack_user_id
    : channelMeta.slack_channel_id;

  const slackPayload: Record<string, unknown> = {
    channel,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
  };
  if (threadTs) {
    slackPayload.thread_ts = threadTs;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${botToken}`,
    },
    body: JSON.stringify(slackPayload),
  });
  const result = await response.json() as { ok: boolean; ts?: string; error?: string };
  if (!result.ok) {
    const errorCode = result.error ?? 'unknown';
    const failureMessage = `slack chat.postMessage failed: ${errorCode} (task_id=${taskId} event_type=${eventType})`;
    // Retryable codes (``ratelimited``, ``service_unavailable``,
    // ``internal_error``) propagate as a plain Error so the router
    // classifies them as infra rejections and Lambda retries the
    // record. Terminal codes (``channel_not_found``, ``not_authed``,
    // ``invalid_blocks``) are wrapped in SlackApiError so the router
    // swallows them — retrying ``channel_not_found`` won't help.
    if (classifySlackError(errorCode) === 'retryable') {
      // Surface ``Retry-After`` (Slack's rate-limit header, in seconds)
      // so operators reading CloudWatch can see when the next retry
      // should succeed rather than guessing from sustained warn rate
      // (PR #79 review #4 mitigation). Header is a string per fetch
      // Headers spec; coerce defensively for the log.
      const retryAfter = response.headers.get('retry-after');
      logger.warn('[fanout/slack] retryable Slack API error', {
        event: 'fanout.slack.retryable_api_error',
        task_id: taskId,
        event_type: eventType,
        slack_error_code: errorCode,
        retry_after_seconds: retryAfter ?? undefined,
      });
      throw new Error(failureMessage);
    }
    throw new SlackApiError(failureMessage);
  }

  // Reactions always use the real channel id even for DMs.
  const reactionChannel = channelMeta.slack_channel_id;
  const reactionTarget = threadTs ?? result.ts;
  if (reactionTarget) {
    await updateReaction(botToken, reactionChannel, reactionTarget, eventType);
  }

  if (result.ts) {
    if (eventType === 'task_created') {
      // Conditional persist guards against the post-issue-#64 retry
      // hazard: under the new ``infraRejections`` escalation path, a
      // batch can be replayed after the Slack POST succeeded but the
      // UpdateItem failed transiently. Without ``attribute_not_exists``
      // the retry would post a second root, overwrite ``slack_thread_ts``,
      // and orphan every threaded reply that had threaded under the
      // first ts. The conditional refuses the second write so the
      // dedup-by-task is per-attribute, not just per-channel.
      const updates: string[] = ['channel_metadata.slack_created_msg_ts = :created_ts'];
      const values: Record<string, string> = { ':created_ts': result.ts };
      const conditions: string[] = ['attribute_not_exists(channel_metadata.slack_created_msg_ts)'];
      if (!threadTs) {
        updates.push('channel_metadata.slack_thread_ts = :created_ts');
        conditions.push('attribute_not_exists(channel_metadata.slack_thread_ts)');
      }
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { task_id: taskId },
          UpdateExpression: `SET ${updates.join(', ')}`,
          ExpressionAttributeValues: values,
          ConditionExpression: conditions.join(' AND '),
        }));
      } catch (err) {
        if ((err as Error)?.name === 'ConditionalCheckFailedException') {
          // Sibling retry won the race or the previous attempt's
          // UpdateItem succeeded after we returned. Either way the
          // stored ts is authoritative; this attempt's ts is a
          // duplicate Slack message that should be deleted to avoid a
          // hanging extra root in the channel. Best-effort delete; if
          // it fails we log and accept the duplicate.
          logger.info('[fanout/slack] task_created persist condition failed (sibling retry) — deleting duplicate', {
            event: 'fanout.slack.task_created_dup_delete',
            task_id: taskId,
            duplicate_ts: result.ts,
          });
          const deleted = await deleteMessage(botToken, channel, result.ts);
          if (!deleted) {
            // The duplicate Slack root is now permanently in the
            // thread. Dedicated event key + error_id so operators can
            // alarm on the rate of ghost task_created messages
            // (PR #79 review #6).
            logger.error('[fanout/slack] dup-delete failed — ghost task_created message stays in thread', {
              event: 'fanout.slack.dup_delete_failed',
              error_id: 'FANOUT_SLACK_DUP_DELETE_FAILED',
              task_id: taskId,
              event_type: eventType,
              duplicate_ts: result.ts,
            });
          }
          return;
        }
        logger.warn('[fanout/slack] failed to store task_created message ts', {
          event: 'fanout.slack.persist_created_ts_failed',
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (eventType === 'session_started') {
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { task_id: taskId },
          UpdateExpression: 'SET channel_metadata.slack_session_msg_ts = :ts',
          ExpressionAttributeValues: { ':ts': result.ts },
          // Same retry-hazard guard as task_created above: refuse to
          // overwrite a previously-persisted ts so a duplicate
          // session message can't leak past terminal cleanup.
          ConditionExpression: 'attribute_not_exists(channel_metadata.slack_session_msg_ts)',
        }));
      } catch (err) {
        if ((err as Error)?.name === 'ConditionalCheckFailedException') {
          logger.info('[fanout/slack] session_started persist condition failed (sibling retry) — deleting duplicate', {
            event: 'fanout.slack.session_dup_delete',
            task_id: taskId,
            duplicate_ts: result.ts,
          });
          const deleted = await deleteMessage(botToken, channel, result.ts);
          if (!deleted) {
            logger.error('[fanout/slack] dup-delete failed — ghost session_started message stays in thread', {
              event: 'fanout.slack.dup_delete_failed',
              error_id: 'FANOUT_SLACK_DUP_DELETE_FAILED',
              task_id: taskId,
              event_type: eventType,
              duplicate_ts: result.ts,
            });
          }
          return;
        }
        logger.warn('[fanout/slack] failed to store session message ts', {
          event: 'fanout.slack.persist_session_ts_failed',
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (TERMINAL_EVENTS.has(eventType)) {
    // Re-read the task record before terminal cleanup. The
    // ``channelMeta`` snapshot above was captured at dispatch entry —
    // by the time we reach a terminal event, the orchestrator-emitted
    // ``task_created`` and ``session_started`` events have run on
    // earlier stream batches and persisted their ``slack_*_msg_ts``
    // attributes through conditional UpdateItems. On fast tasks
    // (~30s) the terminal event can land **before** those persists
    // have propagated to a new GetItem, so the initial read sees a
    // stale channel_metadata with no msg_ts attributes — and the
    // cleanup below silently does nothing, leaving the 🚀 task_created
    // message orphaned in the thread (observed in PR #79 dev-stack
    // verification). The fresh read closes that window: by the time
    // we get here, the dedup write above (which lands in the same
    // table) has linearized our view, so any prior persists are now
    // visible.
    let latestChannelMeta: TaskRecord['channel_metadata'] = channelMeta;
    try {
      const refreshed = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { task_id: taskId },
      }));
      const refreshedTask = refreshed.Item as TaskRecord | undefined;
      latestChannelMeta = refreshedTask?.channel_metadata ?? channelMeta;
    } catch (err) {
      // Best-effort: a GetItem failure here means we fall back to
      // the original snapshot. Log so operators can see the
      // refresh-rate vs cleanup-skip-rate gap.
      logger.warn('[fanout/slack] terminal cleanup re-read failed — falling back to dispatch-entry snapshot', {
        event: 'fanout.slack.cleanup_reread_failed',
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (latestChannelMeta?.slack_session_msg_ts) {
      await deleteMessage(botToken, channel, latestChannelMeta.slack_session_msg_ts);
    }
    if (latestChannelMeta?.slack_created_msg_ts) {
      await deleteMessage(botToken, channel, latestChannelMeta.slack_created_msg_ts);
    }
  }

  logger.info('[fanout/slack] notification sent', {
    event: 'fanout.slack.dispatched',
    task_id: taskId,
    event_type: eventType,
    team_id: channelMeta.slack_team_id,
    channel_id: channelMeta.slack_channel_id,
  });
}

/** Map event types to the emoji reaction that should be on the original
 *  message. ``task_stranded`` reuses ``x`` — operators see a stranded
 *  task as a failure mode with the same visual weight. ``agent_error``
 *  is a non-terminal alert: keep the watching ``eyes`` reaction so the
 *  user sees the warning but knows the agent is still working.
 *  ``pr_created`` is a non-terminal milestone: leave reactions alone
 *  (no entry → updateReaction returns immediately). */
const EVENT_REACTIONS: Record<string, string> = {
  task_created: 'eyes',
  session_started: 'hourglass_flowing_sand',
  task_completed: 'white_check_mark',
  task_failed: 'x',
  task_cancelled: 'no_entry_sign',
  task_timed_out: 'hourglass',
  task_stranded: 'x',
};

/** Reactions to remove when transitioning to a new state. */
const STALE_REACTIONS = ['eyes', 'hourglass_flowing_sand'];

async function addReaction(botToken: string, channel: string, timestamp: string, emoji: string): Promise<void> {
  try {
    const response = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, timestamp, name: emoji }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok && result.error !== 'already_reacted') {
      // API-level rejection: per-message UX problem (channel locked,
      // emoji unknown). Stays at warn — operators don't page.
      logger.warn('[fanout/slack] failed to add reaction', {
        event: 'fanout.slack.reaction_add_api_error',
        emoji,
        error: result.error,
      });
    }
  } catch (err) {
    // Network / DNS / TLS / timeout / SyntaxError — infra class.
    // Promote to error with a dedicated event key so the rate of
    // network failures has its own alarmable signal, distinct from
    // API-level rejections (PR #79 review #5). User-visible symptom
    // when this fires unnoticed: stale ⏳ emoji never swaps to ✅.
    logger.error('[fanout/slack] network error adding reaction', {
      event: 'fanout.slack.reaction_add_network_error',
      error_id: 'FANOUT_SLACK_REACTION_NETWORK',
      emoji,
      error_name: err instanceof Error ? err.name : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function removeReaction(botToken: string, channel: string, timestamp: string, emoji: string): Promise<void> {
  try {
    const response = await fetch('https://slack.com/api/reactions.remove', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, timestamp, name: emoji }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok && result.error !== 'no_reaction') {
      logger.warn('[fanout/slack] failed to remove reaction', {
        event: 'fanout.slack.reaction_remove_api_error',
        emoji,
        error: result.error,
      });
    }
  } catch (err) {
    // See addReaction — network failures get their own ``error_id``
    // so operators can alarm on stale-emoji rate distinctly from
    // Slack API rejections.
    logger.error('[fanout/slack] network error removing reaction', {
      event: 'fanout.slack.reaction_remove_network_error',
      error_id: 'FANOUT_SLACK_REACTION_NETWORK',
      emoji,
      error_name: err instanceof Error ? err.name : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function updateReaction(botToken: string, channel: string, threadTs: string, eventType: string): Promise<void> {
  const newEmoji = EVENT_REACTIONS[eventType];
  if (!newEmoji) return;
  for (const stale of STALE_REACTIONS) {
    if (stale !== newEmoji) {
      await removeReaction(botToken, channel, threadTs, stale);
    }
  }
  await addReaction(botToken, channel, threadTs, newEmoji);
}

/** Returns ``true`` iff the message was successfully deleted (or was
 *  already gone — ``message_not_found`` is benign). Callers that care
 *  about the outcome (the conditional-persist dup-delete path) can
 *  emit a ``fanout.slack.dup_delete_failed`` event so operators can
 *  alarm on accumulating ghost messages (PR #79 review #6). */
async function deleteMessage(botToken: string, channel: string, messageTs: string): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, ts: messageTs }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      // ``message_not_found`` is benign (message already gone) and is
      // treated as a successful delete by the caller's perspective.
      // Anything else (e.g. ``cant_delete_message``) leaves an orphan
      // in the thread.
      if (result.error === 'message_not_found') {
        return true;
      }
      logger.warn('[fanout/slack] failed to delete intermediate message', {
        event: 'fanout.slack.message_delete_api_error',
        error: result.error,
        message_ts: messageTs,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Network failure → orphan message stays in the thread silently.
    // Promote to error so operators can alarm on the orphan rate
    // (PR #79 review #5).
    logger.error('[fanout/slack] network error deleting intermediate message', {
      event: 'fanout.slack.message_delete_network_error',
      error_id: 'FANOUT_SLACK_DELETE_NETWORK',
      message_ts: messageTs,
      error_name: err instanceof Error ? err.name : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
