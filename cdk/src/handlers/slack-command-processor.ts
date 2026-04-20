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

import * as crypto from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';
import type { SlackCommandPayload } from './slack-commands';

/** Extended payload for mention-sourced commands (no response_url available). */
interface MentionPayload extends SlackCommandPayload {
  readonly source?: 'mention';
  readonly mention_thread_ts?: string;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;
const INSTALLATION_TABLE = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;

/** Link code length and TTL. */
const LINK_CODE_LENGTH = 6;
const LINK_CODE_TTL_S = 10 * 60; // 10 minutes

/**
 * Async processor for Slack slash commands and @mention triggers.
 *
 * Invoked asynchronously by the slash command acknowledger or the events handler.
 * Posts results back to Slack via `response_url` (slash commands) or
 * `chat.postMessage` (@mentions).
 */
export async function handler(event: MentionPayload): Promise<void> {
  const text = (event.text ?? '').trim();
  const parts = text.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? '';

  // Build a reply function that handles both response_url and mention modes.
  const reply = event.source === 'mention'
    ? buildMentionReply(event)
    : (msg: string) => postToSlack(event.response_url, msg);

  try {
    switch (subcommand) {
      case 'submit':
        // Submit is only used via @mentions — slash commands show usage guidance.
        if (event.source === 'mention') {
          await handleSubmit(event, parts.slice(1), reply);
        } else {
          await reply('Use `@Shoof` to submit tasks — e.g. `@Shoof fix the bug in org/repo#42`\nFor private submissions, DM Shoof directly.');
        }
        break;
      case 'link':
        await handleLink(event, reply);
        break;
      case 'help':
        await reply(
          '*Using Shoof*\n\n'
          + '*Submit a task:* Mention `@Shoof` in any channel:\n'
          + '> `@Shoof fix the login bug in org/repo#42`\n'
          + '> `@Shoof update the README in org/repo`\n\n'
          + '*Private submissions:* DM Shoof directly.\n\n'
          + '*Cancel a task:* Use the Cancel button in the thread.\n\n'
          + '*Link your account:* `/bgagent link` — one-time setup.\n\n'
          + 'Reactions on your message show progress: :eyes: → :hourglass_flowing_sand: → :white_check_mark:',
        );
        break;
      default:
        await reply('Use `@Shoof` to submit tasks, or `/bgagent link` to link your account.\nTry `/bgagent help` for more info.');
    }
  } catch (err) {
    logger.error('Slack command processing failed', {
      subcommand,
      error: err instanceof Error ? err.message : String(err),
      team_id: event.team_id,
      user_id: event.user_id,
    });
    await reply(':warning: Something went wrong. Please try again.');
  }
}

type ReplyFn = (text: string) => Promise<void>;

/** Build a reply function that posts in-thread via chat.postMessage for @mentions. */
function buildMentionReply(event: MentionPayload): ReplyFn {
  return async (text: string) => {
    const botToken = await getBotToken(event.team_id);
    if (!botToken) {
      logger.warn('Cannot reply to mention: bot token not found', { team_id: event.team_id });
      return;
    }
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: event.channel_id,
        text,
        thread_ts: event.mention_thread_ts,
      }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to post mention reply', { error: result.error, channel: event.channel_id });
    }
  };
}

// ─── Submit ───────────────────────────────────────────────────────────────────

async function handleSubmit(event: MentionPayload, args: string[], reply: ReplyFn): Promise<void> {
  if (args.length === 0) {
    await reply('Usage: `/bgagent submit org/repo#42 description`');
    return;
  }

  // Resolve platform user.
  const platformUserId = await lookupPlatformUser(event.team_id, event.user_id);
  if (!platformUserId) {
    await reply(':link: Your Slack account is not linked. Run `/bgagent link` first.');
    if (event.source === 'mention' && event.mention_thread_ts) {
      await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
    }
    return;
  }

  // Parse repo and optional issue number from first arg: "org/repo#42" or "org/repo".
  const repoArg = args[0];
  const { repo, issueNumber } = parseRepoArg(repoArg);
  if (!repo) {
    await reply(`Invalid repo format: \`${repoArg}\`. Expected \`org/repo\` or \`org/repo#42\`.`);
    if (event.source === 'mention' && event.mention_thread_ts) {
      await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
    }
    return;
  }

  // Check if the bot can post to this channel (private channels need an invite).
  const channelCheck = await checkChannelAccess(event.team_id, event.channel_id);
  if (!channelCheck.ok) {
    await reply(channelCheck.error!);
    return;
  }

  // Remaining args are the task description.
  const description = args.slice(1).join(' ') || undefined;

  // For @mentions, include the thread_ts so notifications thread under the mention.
  const channelMetadata: Record<string, string> = {
    slack_team_id: event.team_id,
    slack_channel_id: event.channel_id,
    slack_user_id: event.user_id,
    slack_response_url: event.response_url,
  };
  if (event.source === 'mention' && event.mention_thread_ts) {
    channelMetadata.slack_thread_ts = event.mention_thread_ts;
  }

  // Create the task through the shared core.
  const result = await createTaskCore(
    {
      repo,
      issue_number: issueNumber,
      task_description: description,
    },
    {
      userId: platformUserId,
      channelSource: 'slack',
      channelMetadata,
    },
    crypto.randomUUID(),
  );

  // Extract task info from the response.
  const body = JSON.parse(result.body);
  if (result.statusCode === 201 && body.data) {
    // For @mentions, the notify handler posts the task_created message in-thread —
    // don't duplicate it here. Only reply for slash commands (which have a response_url).
    if (event.source !== 'mention') {
      const task = body.data;
      await reply(
        `:white_check_mark: Task created!\n*ID:* \`${task.task_id}\`\n*Repo:* \`${task.repo}\`\n*Status:* ${task.status}`,
      );
    }
  } else {
    const errMsg = body.error?.message ?? 'Unknown error';
    await reply(`:x: Failed to create task: ${errMsg}`);
    // Swap reaction to :x: on the mention message.
    if (event.source === 'mention' && event.mention_thread_ts) {
      await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
    }
  }
}

function parseRepoArg(arg: string): { repo: string | null; issueNumber?: number } {
  // Match "org/repo#42" or "org/repo"
  const match = arg.match(/^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)(?:#(\d+))?$/);
  if (!match) return { repo: null };
  return {
    repo: match[1],
    issueNumber: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function handleStatus(event: MentionPayload, taskId: string | undefined, reply: ReplyFn): Promise<void> {
  if (!taskId) {
    await reply('Usage: `/bgagent status <task_id>`');
    return;
  }

  const result = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  if (!result.Item) {
    await reply(`:mag: Task \`${taskId}\` not found.`);
    return;
  }

  const task = result.Item;
  const lines = [
    ':clipboard: *Task Status*',
    `*ID:* \`${task.task_id}\``,
    `*Repo:* \`${task.repo}\``,
    `*Status:* ${statusEmoji(task.status as string)} ${task.status}`,
  ];
  if (task.task_description) lines.push(`*Description:* ${truncate(task.task_description as string, 200)}`);
  if (task.pr_url) lines.push(`*PR:* <${task.pr_url}|Pull Request>`);
  if (task.error_message) lines.push(`*Error:* ${truncate(task.error_message as string, 200)}`);
  if (task.duration_s != null) lines.push(`*Duration:* ${formatDuration(Number(task.duration_s))}`);
  if (task.cost_usd != null) lines.push(`*Cost:* $${Number(task.cost_usd).toFixed(2)}`);

  await reply(lines.join('\n'));
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

async function handleCancel(event: MentionPayload, taskId: string | undefined, reply: ReplyFn): Promise<void> {
  if (!taskId) {
    await reply('Usage: `/bgagent cancel <task_id>`');
    return;
  }

  const platformUserId = await lookupPlatformUser(event.team_id, event.user_id);
  if (!platformUserId) {
    await reply(':link: Your Slack account is not linked. Run `/bgagent link` first.');
    return;
  }

  // Load the task to verify ownership.
  const result = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  if (!result.Item) {
    await reply(`:mag: Task \`${taskId}\` not found.`);
    return;
  }

  if (result.Item.user_id !== platformUserId) {
    await reply(':no_entry: You can only cancel your own tasks.');
    return;
  }

  // Attempt to mark as cancelled via conditional update.
  const ACTIVE_STATUSES = ['SUBMITTED', 'HYDRATING', 'RUNNING', 'FINALIZING'];
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :cancelled, updated_at = :now',
      ConditionExpression: '#s IN (:s1, :s2, :s3, :s4)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':now': new Date().toISOString(),
        ':s1': ACTIVE_STATUSES[0],
        ':s2': ACTIVE_STATUSES[1],
        ':s3': ACTIVE_STATUSES[2],
        ':s4': ACTIVE_STATUSES[3],
      },
    }));
    await reply(`:no_entry_sign: Task \`${taskId}\` has been cancelled.`);
  } catch (err) {
    const errorName = (err as Error)?.name;
    if (errorName === 'ConditionalCheckFailedException') {
      await reply(`:warning: Task \`${taskId}\` is already in a terminal state.`);
    } else {
      throw err;
    }
  }
}

// ─── Link ─────────────────────────────────────────────────────────────────────

async function handleLink(event: MentionPayload, reply: ReplyFn): Promise<void> {
  // Generate a 6-character alphanumeric code.
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + LINK_CODE_TTL_S;

  // Store the pending link record.
  await ddb.send(new PutCommand({
    TableName: USER_MAPPING_TABLE,
    Item: {
      slack_identity: `pending#${code}`,
      slack_team_id: event.team_id,
      slack_user_id: event.user_id,
      link_method: 'slash_command',
      linked_at: now,
      status: 'pending',
      ttl,
    },
  }));

  await reply(
    `:link: *Link your account*\n\nRun this command in your terminal:\n\`\`\`bgagent slack link ${code}\`\`\`\n_This code expires in 10 minutes._`,
  );
}

// ─── Channel Access ──────────────────────────────────────────────────────────

async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await ddb.send(new GetCommand({
    TableName: INSTALLATION_TABLE,
    Key: { team_id: teamId },
  }));
  if (!installation.Item || installation.Item.status !== 'active') return null;
  return getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
}

async function checkChannelAccess(teamId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
  // DM channels always work — notifications fall back to user ID.
  if (channelId.startsWith('D')) return { ok: true };

  const botToken = await getBotToken(teamId);
  if (!botToken) return { ok: true }; // Can't check, allow and let notify handle errors.

  try {
    const response = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const result = await response.json() as { ok: boolean; channel?: { is_private: boolean; is_member: boolean }; error?: string };

    if (!result.ok) {
      // channel_not_found means the bot can't see it — private channel, not invited.
      if (result.error === 'channel_not_found') {
        return { ok: false, error: ':lock: This is a private channel and the bot is not a member. Invite the bot first with `/invite @bgagent`, or submit from a public channel or DM.' };
      }
      return { ok: true }; // Unknown error, allow and let notify handle it.
    }

    if (result.channel?.is_private && !result.channel?.is_member) {
      return { ok: false, error: ':lock: This is a private channel and the bot is not a member. Invite the bot first with `/invite @bgagent`, or submit from a public channel or DM.' };
    }

    return { ok: true };
  } catch (err) {
    logger.warn('Channel access check failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: true }; // Fail open — don't block submit on a check failure.
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function lookupPlatformUser(teamId: string, userId: string): Promise<string | null> {
  const key = `${teamId}#${userId}`;
  logger.info('Looking up platform user', { slack_identity: key, table: USER_MAPPING_TABLE });
  const result = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: key },
  }));

  if (!result.Item) {
    logger.warn('No user mapping found', { slack_identity: key });
    return null;
  }
  if (result.Item.status === 'pending') {
    logger.warn('User mapping is pending', { slack_identity: key });
    return null;
  }
  logger.info('Found platform user', { slack_identity: key, platform_user_id: result.Item.platform_user_id });
  return (result.Item.platform_user_id as string) ?? null;
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
  logger.info('Posting to Slack response_url', {
    response_url: responseUrl.substring(0, 80),
    text_length: text.length,
  });
  try {
    const response = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('Failed to post to Slack response_url', {
        status: response.status,
        response_url: responseUrl.substring(0, 80),
        body,
      });
    } else {
      logger.info('Slack response_url post succeeded', { status: response.status });
    }
  } catch (err) {
    logger.warn('Error posting to Slack response_url', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'SUBMITTED': return ':inbox_tray:';
    case 'HYDRATING': return ':droplet:';
    case 'RUNNING': return ':gear:';
    case 'FINALIZING': return ':hourglass:';
    case 'COMPLETED': return ':white_check_mark:';
    case 'FAILED': return ':x:';
    case 'CANCELLED': return ':no_entry_sign:';
    case 'TIMED_OUT': return ':hourglass:';
    default: return ':grey_question:';
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remainM = m % 60;
  return remainM > 0 ? `${h}h ${remainM}m` : `${h}h`;
}

async function swapReaction(teamId: string, channelId: string, messageTs: string, remove: string, add: string): Promise<void> {
  const botToken = await getBotToken(teamId);
  if (!botToken) return;
  await fetch('https://slack.com/api/reactions.remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${botToken}` },
    body: JSON.stringify({ channel: channelId, timestamp: messageTs, name: remove }),
  }).catch(() => {});
  await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${botToken}` },
    body: JSON.stringify({ channel: channelId, timestamp: messageTs, name: add }),
  }).catch(() => {});
}
