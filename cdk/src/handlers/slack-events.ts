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

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { slackFetch } from './shared/slack-api';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';
import { makeClient, makeDocClient } from './shared/ua';
import type { MentionEvent, SlackFileRef } from './slack-command-processor';

const ddb = makeDocClient();
const sm = makeClient(SecretsManagerClient);
const lambdaClient = makeClient(LambdaClient);

const TABLE_NAME = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const PROCESSOR_FUNCTION_NAME = process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME;

const SECRET_RECOVERY_DAYS = 7;

interface SlackEventPayload {
  readonly type: string;
  readonly challenge?: string;
  readonly token?: string;
  readonly team_id?: string;
  readonly event?: {
    readonly type: string;
    readonly user?: string;
    readonly text?: string;
    readonly channel?: string;
    readonly ts?: string;
    readonly thread_ts?: string;
    readonly [key: string]: unknown;
  };
}

const RETRY_ALLOWED_EVENT_TYPES = new Set(['app_uninstalled', 'tokens_revoked']);

/**
 * `X-Slack-Retry-Reason` values that say the previous delivery failed outright:
 * Slack got an error status, or no connection at all
 * (https://docs.slack.dev/apis/events-api/#retries). `http_timeout` and
 * `unknown_error` are left out on purpose: a delivery that was only too slow for
 * Slack may have been processed.
 */
const FAILED_DELIVERY_RETRY_REASONS = new Set(['http_error', 'connection_failed', 'ssl_error', 'too_many_redirects']);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);

    if (!signingSecret) {
      logger.warn('Slack signing secret not populated — bypassing verification for url_verification only');
      const payload: SlackEventPayload = JSON.parse(event.body);
      if (payload.type === 'url_verification' && payload.challenge) {
        return jsonResponse(200, { challenge: payload.challenge });
      }
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    if (!await verifySlackRequest(SIGNING_SECRET_ARN, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack event signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    const payload: SlackEventPayload = JSON.parse(event.body);

    if (payload.type === 'url_verification' && payload.challenge) {
      return jsonResponse(200, { challenge: payload.challenge });
    }

    const retryNum = event.headers['X-Slack-Retry-Num'] ?? event.headers['x-slack-retry-num'];
    const retryReason = event.headers['X-Slack-Retry-Reason'] ?? event.headers['x-slack-retry-reason'];
    const firstDeliveryFailed = retryNum === '1' && FAILED_DELIVERY_RETRY_REASONS.has(retryReason ?? '');
    const eventType = payload.type === 'event_callback' ? payload.event?.type : undefined;
    if (retryNum && !firstDeliveryFailed && !(eventType && RETRY_ALLOWED_EVENT_TYPES.has(eventType))) {
      logger.info('Acknowledging Slack retry without reprocessing', { retry_num: retryNum, retry_reason: retryReason, event_type: eventType });
      return jsonResponse(200, { ok: true });
    }

    if (payload.type === 'event_callback' && payload.event) {
      const teamId = payload.team_id;

      if ((eventType === 'app_uninstalled' || eventType === 'tokens_revoked') && teamId) {
        await revokeInstallation(teamId);
      } else if (eventType === 'app_mention' && teamId) {
        await handleAppMention(payload.event, teamId);
      } else if (eventType === 'message' && teamId && payload.event.channel_type === 'im') {
        if (!payload.event.bot_id) {
          await handleAppMention(payload.event, teamId);
        }
      } else {
        logger.info('Unhandled Slack event type', { event_type: eventType, team_id: teamId });
      }
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    logger.error('Slack event handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

async function handleAppMention(
  event: NonNullable<SlackEventPayload['event']>,
  teamId: string,
): Promise<void> {
  if (!PROCESSOR_FUNCTION_NAME) {
    logger.warn('SLACK_COMMAND_PROCESSOR_FUNCTION_NAME not set, ignoring app_mention');
    return;
  }

  const userId = event.user;
  const channelId = event.channel;
  const rawText = event.text ?? '';
  const messageTs = event.ts;
  const threadTs = event.thread_ts;

  if (!userId || !channelId) {
    logger.warn('app_mention missing user or channel', { event });
    return;
  }

  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) {
    logger.info('app_mention with empty text after stripping mention, ignoring');
    return;
  }

  const commandText = `submit ${text}`;

  const rawFiles = Array.isArray(event.files) ? event.files as Array<Record<string, unknown>> : [];
  const files: SlackFileRef[] = rawFiles
    .filter(f => typeof f.url_private_download === 'string' && typeof f.name === 'string')
    .map(f => ({
      id: String(f.id ?? ''),
      name: String(f.name),
      mimetype: String(f.mimetype ?? 'application/octet-stream'),
      size: typeof f.size === 'number' ? f.size : 0,
      url_private_download: String(f.url_private_download),
    }));

  const mentionTs = messageTs ?? threadTs;
  const mentionPayload: MentionEvent = {
    text: commandText,
    user_id: userId,
    team_id: teamId,
    channel_id: channelId,
    source: 'mention',
    mention_thread_ts: threadTs ?? messageTs,
    mention_message_ts: mentionTs,
    ...(files.length > 0 && { files }),
  };

  if (mentionTs) {
    const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
    if (botToken) {
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: mentionTs, name: 'eyes' });
    }
  }

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: PROCESSOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(mentionPayload)),
    }));
    logger.info('app_mention forwarded to command processor', {
      team_id: teamId,
      user_id: userId,
      channel_id: channelId,
      text_length: text.length,
    });
  } catch (err) {
    logger.error('Failed to invoke command processor for app_mention', {
      error: err instanceof Error ? err.message : String(err),
    });
    const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
    if (botToken && mentionTs) {
      await slackFetch(botToken, 'reactions.remove', { channel: channelId, timestamp: mentionTs, name: 'eyes' });
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: mentionTs, name: 'x' });
      await slackFetch(botToken, 'chat.postMessage', {
        channel: channelId,
        thread_ts: threadTs ?? mentionTs,
        text: ':x: Something went wrong forwarding your request. Please try again.',
      });
    }
  }
}

async function revokeInstallation(teamId: string): Promise<void> {
  const now = new Date().toISOString();

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { team_id: teamId },
      UpdateExpression: 'SET #s = :revoked, updated_at = :now, revoked_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now },
    }));
  } catch (err) {
    logger.error('Failed to mark Slack installation revoked — bot token left in place for retry', {
      team_id: teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    await sm.send(new DeleteSecretCommand({
      SecretId: `${SLACK_SECRET_PREFIX}${teamId}`,
      RecoveryWindowInDays: SECRET_RECOVERY_DAYS,
    }));
    logger.info('Slack installation revoked', { team_id: teamId });
  } catch (err) {
    logger.warn('Failed to delete Slack bot token secret', {
      team_id: teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
