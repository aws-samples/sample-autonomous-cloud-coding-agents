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

import { type DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { FanOutEvent } from './fanout-task-events';
import { logger } from './shared/logger';
import { renderSlackBlocks } from './shared/slack-blocks';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';
import type { TaskRecord } from './shared/types';

const TERMINAL_EVENTS = new Set<string>([
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_timed_out',
  'task_stranded',
]);

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

const SLACK_POSTED_MSG_ATTRIBUTE: Record<string, string | undefined> = {
  task_created: 'slack_created_msg_ts',
  session_started: 'slack_session_msg_ts',
};

/** Event types this dispatcher renders. Must stay in sync with the
 *  Slack entries in ``CHANNEL_DEFAULTS`` (see fanout-task-events.ts). */
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

const TERMINAL_SLACK_API_ERRORS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'message_not_found',
  'not_authed',
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'missing_scope',
  'restricted_action',
  'ekm_access_denied',
  'team_access_not_granted',
  'posting_to_general_channel_denied',
  'as_user_not_supported',
  'invalid_blocks',
  'invalid_blocks_format',
  'invalid_arguments',
  'msg_too_long',
  'too_many_attachments',
]);

function classifySlackError(slackErrorCode: string): 'terminal' | 'retryable' {
  return TERMINAL_SLACK_API_ERRORS.has(slackErrorCode) ? 'terminal' : 'retryable';
}

/** Dispatch a single task event to Slack. Throws on infra problems. */
export async function dispatchSlackEvent(
  event: SlackDispatchEvent,
  ddb: DynamoDBDocumentClient,
): Promise<void> {
  const { task_id: taskId, event_type: eventType } = event;
  if (!NOTIFIABLE_EVENTS.has(eventType)) return;

  const tableName = process.env.TASK_TABLE_NAME;
  if (!tableName) {
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

  const eventMetadata = event.metadata;

  const message = renderSlackBlocks(eventType, task, eventMetadata);

  const threadTs = channelMeta.slack_thread_ts;

  // DM channels use the user id so ``chat.postMessage`` opens the DM automatically.
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

  const result = await postOnce(event, ddb, tableName, channelMeta, botToken, slackPayload);
  if (!result) return;

  const reactionChannel = channelMeta.slack_channel_id;
  const reactionTarget = channelMeta.slack_message_ts ?? threadTs ?? result.ts;
  if (reactionTarget) {
    await updateReaction(botToken, reactionChannel, reactionTarget, eventType);
  }

  if (result.ts) {
    if (eventType === 'task_created') {
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
          logger.info('[fanout/slack] task_created persist condition failed (sibling retry) — deleting duplicate', {
            event: 'fanout.slack.task_created_dup_delete',
            task_id: taskId,
            duplicate_ts: result.ts,
          });
          const deleted = await deleteMessage(botToken, channel, result.ts);
          if (!deleted) {
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
    let latestChannelMeta: TaskRecord['channel_metadata'] = channelMeta;
    try {
      const refreshed = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { task_id: taskId },
      }));
      const refreshedTask = refreshed.Item as TaskRecord | undefined;
      latestChannelMeta = refreshedTask?.channel_metadata ?? channelMeta;
    } catch (err) {
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

async function postOnce(
  event: SlackDispatchEvent,
  ddb: DynamoDBDocumentClient,
  tableName: string,
  channelMeta: Record<string, string>,
  botToken: string,
  payload: Record<string, unknown>,
): Promise<{ ts?: string } | null> {
  const { task_id: taskId, event_type: eventType } = event;

  const postedAttr = SLACK_POSTED_MSG_ATTRIBUTE[eventType];
  if (postedAttr && channelMeta[postedAttr]) {
    logger.info('[fanout/slack] notification already sent, skipping duplicate', {
      event: 'fanout.slack.dedup_hit',
      task_id: taskId,
      event_type: eventType,
      dedup_attr: postedAttr,
    });
    return null;
  }

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
        return null;
      }
      throw err;
    }
  }

  try {
    return await postMessage(botToken, payload, taskId, eventType);
  } catch (err) {
    if (dedupAttr && !(err instanceof SlackApiError)) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { task_id: taskId },
          UpdateExpression: `REMOVE channel_metadata.${dedupAttr}`,
        }));
      } catch (releaseErr) {
        logger.error('[fanout/slack] dedup claim not released — the retry will be skipped and the message lost', {
          event: 'fanout.slack.dedup_release_failed',
          error_id: 'FANOUT_SLACK_DEDUP_RELEASE_FAILED',
          task_id: taskId,
          event_type: eventType,
          dedup_attr: dedupAttr,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
    }
    throw err;
  }
}

async function postMessage(
  botToken: string,
  payload: Record<string, unknown>,
  taskId: string,
  eventType: string,
): Promise<{ ts?: string }> {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${botToken}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json() as { ok: boolean; ts?: string; error?: string };
  if (!result.ok) {
    const errorCode = result.error ?? 'unknown';
    const failureMessage = `slack chat.postMessage failed: ${errorCode} (task_id=${taskId} event_type=${eventType})`;
    if (classifySlackError(errorCode) === 'retryable') {
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
  return result;
}

const EVENT_REACTIONS: Record<string, string> = {
  task_created: 'eyes',
  session_started: 'hourglass_flowing_sand',
  task_completed: 'white_check_mark',
  task_failed: 'x',
  task_cancelled: 'no_entry_sign',
  task_timed_out: 'hourglass',
  task_stranded: 'x',
};

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
      logger.warn('[fanout/slack] failed to add reaction', {
        event: 'fanout.slack.reaction_add_api_error',
        emoji,
        error: result.error,
      });
    }
  } catch (err) {
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
