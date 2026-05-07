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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { logger } from './shared/logger';
import { renderSlackBlocks } from './shared/slack-blocks';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';
import type { TaskRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TASK_TABLE = process.env.TASK_TABLE_NAME!;

const TERMINAL_EVENTS = new Set(['task_completed', 'task_failed', 'task_cancelled', 'task_timed_out']);

/** Event types that trigger Slack notifications. */
const NOTIFIABLE_EVENTS = new Set([
  'task_created',
  'session_started',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_timed_out',
]);

/**
 * Slack notification handler triggered by DynamoDB Streams on TaskEventsTable.
 *
 * For each task event:
 * 1. Load the task record to check channel_source and channel_metadata.
 * 2. If channel_source is 'slack', render a Block Kit message and post to Slack.
 * 3. Thread replies under the initial message using stored slack_thread_ts.
 *
 * Infrastructure errors (DynamoDB, Secrets Manager) are rethrown so Lambda's
 * configured retry/bisect behavior can do its job. Slack API errors are
 * treated as delivery failures and logged but never fail the batch.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      // Slack delivery errors are terminal — swallow after logging so the batch
      // isn't retried for something a retry can't fix.
      if (err instanceof SlackApiError) {
        logger.warn('Slack delivery failed', {
          error: err.message,
          event_id: record.eventID,
        });
        continue;
      }
      // Infrastructure errors (DynamoDB throttling, Secrets Manager outage, etc.)
      // rethrow so Lambda retries the batch per the configured retryAttempts +
      // bisectBatchOnError behavior.
      logger.error('Infrastructure error processing Slack notification', {
        error: err instanceof Error ? err.message : String(err),
        event_id: record.eventID,
      });
      throw err;
    }
  }
}

/**
 * Thrown when the Slack API returns an error after a successful HTTP call.
 * Tagged so the batch handler can swallow it without retrying — Slack errors
 * are not recoverable by retrying the stream record.
 */
class SlackApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackApiError';
  }
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) return;

  const newImage = record.dynamodb.NewImage;
  const eventType = newImage.event_type?.S;
  const taskId = newImage.task_id?.S;

  if (!eventType || !taskId || !NOTIFIABLE_EVENTS.has(eventType)) return;

  // Load the task record first so we can skip non-Slack tasks before touching
  // their DynamoDB row with dedup writes.
  const taskResult = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  const task = taskResult.Item as TaskRecord | undefined;
  if (!task || task.channel_source !== 'slack') return;

  // Deduplicate terminal notifications — the orchestrator may write multiple
  // failure/completion events (retries). Use a conditional update to claim
  // the right to send the terminal notification.
  if (TERMINAL_EVENTS.has(eventType)) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TASK_TABLE,
        Key: { task_id: taskId },
        UpdateExpression: 'SET channel_metadata.slack_notified_terminal = :t',
        ConditionExpression: 'attribute_not_exists(channel_metadata.slack_notified_terminal)',
        ExpressionAttributeValues: { ':t': true },
      }));
    } catch (err) {
      if ((err as Error)?.name === 'ConditionalCheckFailedException') {
        logger.info('Terminal notification already sent, skipping duplicate', { task_id: taskId, event_type: eventType });
        return;
      }
      throw err;
    }
  }

  const channelMeta = task.channel_metadata;
  if (!channelMeta?.slack_team_id || !channelMeta?.slack_channel_id) {
    logger.warn('Slack task missing channel metadata', { task_id: taskId });
    return;
  }

  // Fetch the bot token for this workspace.
  const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${channelMeta.slack_team_id}`);
  if (!botToken) {
    logger.warn('Bot token not found for Slack workspace', {
      team_id: channelMeta.slack_team_id,
      task_id: taskId,
    });
    return;
  }

  // Parse event metadata if present. Failures are logged and treated as "no metadata" —
  // the surfaced fallback reason is "Unknown error" which is user-hostile without a log.
  const eventMetadata = newImage.metadata?.S
    ? safeJsonParse(newImage.metadata.S, { task_id: taskId, event_type: eventType })
    : undefined;

  // Render the Slack message.
  const message = renderSlackBlocks(eventType, task, eventMetadata ?? undefined);

  // For task_created, post a new message. For subsequent events, reply in thread.
  const threadTs = channelMeta.slack_thread_ts;

  // For DM channels (prefix 'D'), post to the user ID instead — chat.postMessage
  // opens a DM automatically when given a user ID, which avoids the channel_not_found
  // error that occurs with ephemeral DM channel IDs from slash commands.
  const channel = channelMeta.slack_channel_id.startsWith('D') && channelMeta.slack_user_id
    ? channelMeta.slack_user_id
    : channelMeta.slack_channel_id;

  const slackPayload: Record<string, unknown> = {
    channel,
    text: message.text,
    blocks: message.blocks,
  };

  // Thread all messages under the original. For @mentions, threadTs is set to the
  // user's mention message by the command processor. For slash commands, threadTs
  // is set to the task_created message after it's posted (see below).
  if (threadTs) {
    slackPayload.thread_ts = threadTs;
  }

  // Suppress link unfurls — the View PR button is the clean way to access it.
  slackPayload.unfurl_links = false;

  // Post to Slack.
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
    // Slack API errors are not retryable via the Lambda batch (re-processing the
    // stream record won't make Slack start accepting the message), so throw a
    // tagged error and let the batch handler swallow it after logging.
    throw new SlackApiError(`slack chat.postMessage failed: ${result.error ?? 'unknown'} (task_id=${taskId} event_type=${eventType})`);
  }

  // Emoji reaction on the root message — the user's @mention or the task_created message.
  // Reactions always use the real channel ID (not user ID), even for DMs.
  const reactionChannel = channelMeta.slack_channel_id;
  const reactionTarget = threadTs ?? result.ts;
  if (reactionTarget) {
    await updateReaction(botToken, reactionChannel, reactionTarget, eventType);
  }

  // Store message timestamps for later updates.
  if (result.ts) {
    if (eventType === 'task_created') {
      const updates: string[] = ['channel_metadata.slack_created_msg_ts = :created_ts'];
      const values: Record<string, string> = { ':created_ts': result.ts };
      if (!threadTs) {
        // Slash commands: also store thread_ts (mentions already have it).
        updates.push('channel_metadata.slack_thread_ts = :created_ts');
      }
      try {
        await ddb.send(new UpdateCommand({
          TableName: TASK_TABLE,
          Key: { task_id: taskId },
          UpdateExpression: `SET ${updates.join(', ')}`,
          ExpressionAttributeValues: values,
        }));
      } catch (err) {
        logger.warn('Failed to store task_created message ts', {
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (eventType === 'session_started') {
      try {
        await ddb.send(new UpdateCommand({
          TableName: TASK_TABLE,
          Key: { task_id: taskId },
          UpdateExpression: 'SET channel_metadata.slack_session_msg_ts = :ts',
          ExpressionAttributeValues: { ':ts': result.ts },
        }));
      } catch (err) {
        logger.warn('Failed to store session message ts', {
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // On terminal events, clean up intermediate messages — only the final
  // result message stays in the thread.
  if (TERMINAL_EVENTS.has(eventType)) {
    if (channelMeta.slack_session_msg_ts) {
      await deleteMessage(botToken, channel, channelMeta.slack_session_msg_ts);
    }
    if (channelMeta.slack_created_msg_ts) {
      await deleteMessage(botToken, channel, channelMeta.slack_created_msg_ts);
    }
  }

  logger.info('Slack notification sent', {
    task_id: taskId,
    event_type: eventType,
    team_id: channelMeta.slack_team_id,
    channel_id: channelMeta.slack_channel_id,
  });
}

/** Map event types to the emoji reaction that should be on the original message. */
const EVENT_REACTIONS: Record<string, string> = {
  task_created: 'eyes',
  session_started: 'hourglass_flowing_sand',
  task_completed: 'white_check_mark',
  task_failed: 'x',
  task_cancelled: 'no_entry_sign',
  task_timed_out: 'hourglass',
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
      logger.warn('Failed to add Slack reaction', { emoji, error: result.error });
    }
  } catch (err) {
    logger.warn('Error adding Slack reaction', { emoji, error: err instanceof Error ? err.message : String(err) });
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
      logger.warn('Failed to remove Slack reaction', { emoji, error: result.error });
    }
  } catch (err) {
    logger.warn('Error removing Slack reaction', { emoji, error: err instanceof Error ? err.message : String(err) });
  }
}

async function updateReaction(botToken: string, channel: string, threadTs: string, eventType: string): Promise<void> {
  const newEmoji = EVENT_REACTIONS[eventType];
  if (!newEmoji) return;

  // Remove stale reactions first, then add the new one.
  for (const stale of STALE_REACTIONS) {
    if (stale !== newEmoji) {
      await removeReaction(botToken, channel, threadTs, stale);
    }
  }
  await addReaction(botToken, channel, threadTs, newEmoji);
}

async function deleteMessage(botToken: string, channel: string, messageTs: string): Promise<void> {
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
      logger.warn('Failed to delete session message', { error: result.error });
    }
  } catch (err) {
    logger.warn('Error deleting session message', { error: err instanceof Error ? err.message : String(err) });
  }
}

function safeJsonParse(text: string, context?: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.warn('Failed to parse event metadata JSON', {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      preview: text.length > 200 ? `${text.slice(0, 200)}...` : text,
    });
    return null;
  }
}
