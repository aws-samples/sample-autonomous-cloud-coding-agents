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
import { approvalDecisionConfigFromEnv, processApprovalDecision } from './shared/approval-decision';
import { logger } from './shared/logger';
import { SLACK_APPROVABLE_SEVERITIES } from './shared/slack-blocks';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;
const TASK_APPROVALS_TABLE = process.env.TASK_APPROVALS_TABLE_NAME;

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
 * - `approve_action:{task_id}:{request_id}` / `deny_action:{task_id}:{request_id}`
 *   — Cedar HITL approval decisions via Slack buttons (issue #112). The
 *   Slack identity is mapped to a platform user via `SlackUserMappingTable`
 *   (user-initiated linking — §11.2 finding #4), the gate's severity is
 *   re-checked server-side (low/medium only; high is CLI-only), and the
 *   decision goes through the same `processApprovalDecision` core as the
 *   HTTP approve/deny handlers — including the ownership condition, so a
 *   linked-but-wrong user's click is rejected by the transaction itself.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // Verify Slack signing secret (re-fetches if the cached value was rotated out).
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);
    if (!signingSecret) {
      logger.error('Slack signing secret not found');
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';

    if (!await verifySlackRequest(SIGNING_SECRET_ARN, signature, timestamp, event.body)) {
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
        } else if (
          action.action_id.startsWith('approve_action:')
          || action.action_id.startsWith('deny_action:')
        ) {
          await handleApprovalAction(payload, action.action_id);
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
  const CANCELLABLE_STATUSES = ['PENDING_UPLOADS', 'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'];
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :cancelled, updated_at = :now',
      ConditionExpression: '#s IN (:s1, :s2, :s3, :s4, :s5, :s6)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':now': new Date().toISOString(),
        ':s1': CANCELLABLE_STATUSES[0],
        ':s2': CANCELLABLE_STATUSES[1],
        ':s3': CANCELLABLE_STATUSES[2],
        ':s4': CANCELLABLE_STATUSES[3],
        ':s5': CANCELLABLE_STATUSES[4],
        ':s6': CANCELLABLE_STATUSES[5],
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

/**
 * Handle `approve_action:{task_id}:{request_id}` / `deny_action:…`
 * Block Kit clicks (issue #112).
 *
 * Trust chain:
 *   1. The interaction payload is Slack-signature-verified by the
 *      handler before we get here.
 *   2. The Slack identity (`team_id#user_id`) maps to a platform user
 *      via `SlackUserMappingTable` — rows are user-initiated
 *      (`bgagent slack link`), never admin-written (§11.2 finding #4).
 *   3. Severity is re-checked SERVER-SIDE from the approvals row —
 *      the absence of buttons on high-severity messages is UX, not
 *      enforcement; a forged action_id must still fail here.
 *   4. `processApprovalDecision` enforces ownership
 *      (`user_id = :caller`) inside the transaction — a linked but
 *      non-owning user's click fails the condition and reads as
 *      "not found or not yours".
 *
 * All outcomes are reported as ephemeral `response_url` messages so
 * only the clicker sees them.
 */
async function handleApprovalAction(payload: SlackInteractionPayload, actionId: string): Promise<void> {
  const [verb, taskId, approvalRequestId] = actionId.split(':');
  const decision = verb === 'approve_action' ? 'approve' as const : 'deny' as const;
  if (!taskId || !approvalRequestId) {
    logger.warn('Slack approval action_id malformed', { action_id: actionId });
    await postToResponseUrl(payload.response_url, ':warning: Malformed approval action — please use the CLI.');
    return;
  }

  if (!TASK_APPROVALS_TABLE) {
    logger.error('TASK_APPROVALS_TABLE_NAME not set — Slack approvals disabled');
    await postToResponseUrl(payload.response_url,
      ':warning: Slack approvals are not configured on this stack. Use `bgagent approve`/`deny` from the CLI.');
    return;
  }

  // 1. Slack identity → platform user (user-initiated mapping only).
  const teamId = payload.user.team_id;
  const slackUserId = payload.user.id;
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${slackUserId}` },
  }));
  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url,
      ':link: Your Slack account is not linked. Run `bgagent slack link` first, then re-click.');
    return;
  }
  const platformUserId = mappingResult.Item.platform_user_id as string;

  // 2. Server-side severity gate (§11.2 finding #4). The buttons only
  // render on low/medium gates, but the message is advisory — re-read
  // the approvals row and refuse high severity regardless of what the
  // action_id claims. Missing row falls through to the decision core,
  // which collapses it into the no-oracle "not found" outcome.
  const approvalRow = await ddb.send(new GetCommand({
    TableName: TASK_APPROVALS_TABLE,
    Key: { task_id: taskId, request_id: approvalRequestId },
  }));
  const severity = approvalRow.Item?.severity as string | undefined;
  if (severity && !SLACK_APPROVABLE_SEVERITIES.has(severity)) {
    logger.warn('Slack approval rejected: severity not Slack-approvable', {
      task_id: taskId,
      request_id: approvalRequestId,
      severity,
      slack_identity: `${teamId}#${slackUserId}`,
    });
    await postToResponseUrl(payload.response_url,
      `:shield: This is a *${severity}*-severity gate — it can only be decided from the CLI with a fresh login: `
      + `\`bgagent ${decision} ${taskId} ${approvalRequestId}\``);
    return;
  }

  // 3. Shared decision core — identical invariants to the HTTP path.
  const outcome = await processApprovalDecision(ddb, approvalDecisionConfigFromEnv(), {
    taskId,
    requestId: approvalRequestId,
    callerUserId: platformUserId,
    decision,
    ...(decision === 'approve' ? { scope: 'this_call' as const } : { sanitizedReason: 'Denied via Slack' }),
  });

  switch (outcome.kind) {
    case 'ok': {
      logger.info('Slack approval decision recorded', {
        task_id: taskId,
        request_id: approvalRequestId,
        decision,
        platform_user_id: platformUserId,
        slack_identity: `${teamId}#${slackUserId}`,
      });
      const emoji = decision === 'approve' ? ':white_check_mark:' : ':no_entry:';
      const label = decision === 'approve' ? 'Approved' : 'Denied';
      await postToResponseUrl(payload.response_url,
        `${emoji} ${label} — the agent will pick the decision up on its next poll.`);
      return;
    }
    case 'rate_limited':
      await postToResponseUrl(payload.response_url,
        `:hourglass: Rate limit exceeded (${outcome.limit} decisions/minute). Try again shortly.`);
      return;
    case 'not_found':
      // Includes "owned by someone else" — same no-oracle collapse as
      // the HTTP handlers (§7.1 finding #6).
      await postToResponseUrl(payload.response_url,
        ':mag: Approval request not found, already decided, or not yours to decide.');
      return;
    case 'not_awaiting':
      await postToResponseUrl(payload.response_url,
        ':warning: The task is no longer awaiting this approval (it may have timed out).');
      return;
    case 'transaction_unknown':
      await postToResponseUrl(payload.response_url,
        ':warning: Could not record the decision — please retry or use the CLI.');
      return;
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
