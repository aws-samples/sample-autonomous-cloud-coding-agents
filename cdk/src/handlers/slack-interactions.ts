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
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackSignature } from './shared/slack-verify';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;

interface SlackInteractionPayload {
  readonly type: string;
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  readonly actions?: ReadonlyArray<{
    readonly action_id: string;
    readonly block_id: string;
    readonly value?: string;
  }>;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly channel?: { readonly id: string };
}

/**
 * POST /v1/slack/interactions — Handle Slack Block Kit interactive actions.
 *
 * Slack sends interaction payloads as a URL-encoded `payload` field in the body.
 * Currently handles:
 * - `cancel_task:{task_id}` — Cancel a running task via the "Cancel Task" button.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // Verify Slack signing secret.
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);
    if (!signingSecret) {
      logger.error('Slack signing secret not found');
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';

    if (!verifySlackSignature(signingSecret, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack interaction signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    // Parse the payload — Slack sends it as URL-encoded `payload=<json>`.
    const params = new URLSearchParams(event.body);
    const payloadStr = params.get('payload');
    if (!payloadStr) {
      return jsonResponse(400, { error: 'Missing payload' });
    }

    const payload: SlackInteractionPayload = JSON.parse(payloadStr);

    if (payload.type === 'block_actions' && payload.actions) {
      for (const action of payload.actions) {
        if (action.action_id.startsWith('cancel_task:')) {
          await handleCancelAction(payload, action.action_id);
        }
      }
    }

    // Slack expects a 200 response within 3 seconds.
    return jsonResponse(200, {});
  } catch (err) {
    logger.error('Slack interaction handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(200, {}); // Still return 200 to avoid Slack retries.
  }
}

async function handleCancelAction(payload: SlackInteractionPayload, actionId: string): Promise<void> {
  const taskId = actionId.replace('cancel_task:', '');
  const teamId = payload.user.team_id;
  const userId = payload.user.id;

  // Look up platform user.
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${userId}` },
  }));

  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url, ':link: Your Slack account is not linked.');
    return;
  }

  const platformUserId = mappingResult.Item.platform_user_id as string;

  // Load the task.
  const taskResult = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  if (!taskResult.Item) {
    await postToResponseUrl(payload.response_url, `:mag: Task \`${taskId}\` not found.`);
    return;
  }

  if (taskResult.Item.user_id !== platformUserId) {
    await postToResponseUrl(payload.response_url, ':no_entry: You can only cancel your own tasks.');
    return;
  }

  // Attempt to cancel.
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

    // Instant feedback: replace the Cancel button message with "Cancelling..."
    // then clean up all intermediate messages.
    const channelMeta = taskResult.Item.channel_metadata as Record<string, string> | undefined;
    const channelId = payload.channel?.id ?? channelMeta?.slack_channel_id;
    if (channelMeta && channelId) {
      const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
      if (botToken) {
        if (channelMeta.slack_session_msg_ts) {
          await updateSlackMessage(botToken, channelId, channelMeta.slack_session_msg_ts,
            ':hourglass_flowing_sand: Cancelling...', channelMeta.slack_thread_ts);
        }
        const toDelete = [channelMeta.slack_created_msg_ts].filter(Boolean);
        for (const ts of toDelete) {
          await deleteSlackMessage(botToken, channelId, ts!);
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'ConditionalCheckFailedException') {
      await postToResponseUrl(payload.response_url, ':warning: Task is already in a terminal state.');
    } else {
      throw err;
    }
  }
}

async function updateSlackMessage(botToken: string, channel: string, ts: string, text: string, threadTs?: string): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      channel,
      ts,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    };
    if (threadTs) payload.thread_ts = threadTs;
    const response = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to update Slack message', { error: result.error, ts });
    }
  } catch (err) {
    logger.warn('Error updating Slack message', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function deleteSlackMessage(botToken: string, channel: string, ts: string): Promise<void> {
  try {
    const response = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, ts }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to delete Slack message', { error: result.error, ts });
    }
  } catch (err) {
    logger.warn('Error deleting Slack message', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function postToResponseUrl(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text, replace_original: false }),
    });
  } catch (err) {
    logger.warn('Failed to post to interaction response_url', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
