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

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { AGENT_SESSION_EVENT_TYPE, isHandledAgentSessionAction, isLinearAgentSessionsEnabled } from './shared/linear-agent-session-event';
import {
  countActiveLinearWorkspaces,
  isWebhookTimestampFresh,
  verifyLinearRequest,
  verifyLinearRequestForWorkspace,
} from './shared/linear-verify';
import { logger } from './shared/logger';
import { makeClient, makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const lambdaClient = makeClient(LambdaClient);

const WEBHOOK_SECRET_ARN = process.env.LINEAR_WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME!;
const PROCESSOR_FUNCTION_NAME = process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

// Linear retries a failed delivery at +1m, +1h and +6h: about 7h after the first attempt.
const DEDUP_TTL_HOURS = 8;
const DEDUP_TTL_SECONDS = DEDUP_TTL_HOURS * 3600;

interface LinearWebhookEnvelope {
  readonly action?: string;
  readonly type?: string;
  readonly webhookTimestamp?: number;
  readonly webhookId?: string;
  readonly organizationId?: string;
  readonly data?: {
    readonly id?: string;
    readonly [key: string]: unknown;
  };
  readonly agentSession?: {
    readonly id?: string;
  };
}

function logIgnoredWebhookType(
  payload: { type?: string; action?: string; organizationId?: string },
  agentSessionsEnabled: boolean,
): void {
  const AGENT_MODE_TYPES = ['AppUserNotification', 'AgentSession', 'AgentSessionEvent', 'AgentActivity'];
  if (!agentSessionsEnabled && payload.type !== undefined && AGENT_MODE_TYPES.includes(payload.type)) {
    logger.warn(
      'Ignoring Linear agent-mode webhook — the OAuth app appears configured as a Linear agent '
      + '(agent/app events enabled). ABCA uses plain comment threads; agent mode makes @mentions render '
      + 'as interactive agent activity instead of comments. Disable agent/app events on the Linear app '
      + '(keep only Issue + Comment webhook events).',
      {
        type: payload.type,
        action: payload.action,
        linear_workspace_id: payload.organizationId,
        alternative: 'deploy with --context enableLinearAgentSessions=true to answer agent sessions natively',
      },
    );
    return;
  }
  logger.info('Ignoring non-Issue/Comment Linear webhook', { type: payload.type, action: payload.action });
}

/**
 * POST /v1/linear/webhook — Linear webhook receiver.
 *
 * Verifies the `Linear-Signature` HMAC over the raw body, rejects stale
 * `webhookTimestamp` values (replay protection), dedups on
 * `(data.id, action, webhookTimestamp)` with an 8h TTL, and async-invokes the processor
 * Lambda so we can ack within Linear's 5s timeout.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    const signature = event.headers['Linear-Signature'] ?? event.headers['linear-signature'] ?? '';
    if (!signature) {
      logger.warn('Linear webhook missing Linear-Signature header');
      return jsonResponse(401, { error: 'Missing signature' });
    }

    let payload: LinearWebhookEnvelope;
    try {
      payload = JSON.parse(event.body) as LinearWebhookEnvelope;
    } catch (err) {
      logger.warn('Linear webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }
    if (payload === null) {
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    let verified = false;
    if (WORKSPACE_REGISTRY_TABLE && typeof payload.organizationId === 'string' && payload.organizationId) {
      const result = await verifyLinearRequestForWorkspace(
        WORKSPACE_REGISTRY_TABLE,
        payload.organizationId,
        signature,
        event.body,
      );
      if (result === 'verified') {
        verified = true;
      } else if (result === 'mismatch') {
        logger.warn('Linear webhook signature mismatch against per-workspace secret', {
          linear_workspace_id: payload.organizationId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      } else if (result === 'revoked') {
        logger.warn('Linear webhook from revoked workspace — rejecting without stack-wide fallback', {
          linear_workspace_id: payload.organizationId,
        });
        return jsonResponse(401, { error: 'Workspace not active' });
      } else if (result === 'shared-secret') {
        logger.warn('Linear webhook verified against a secret shared with another workspace — rejecting', {
          linear_workspace_id: payload.organizationId,
          remedy: 'bgagent linear update-webhook-secret <slug>',
        });
        return jsonResponse(401, { error: 'Workspace signing secret is not its own' });
      }
    }

    let verifiedViaStackWide = false;

    if (!verified) {
      const activeWorkspaces = await countActiveLinearWorkspaces(WORKSPACE_REGISTRY_TABLE);
      if (activeWorkspaces > 1) {
        logger.warn('Refusing the stack-wide fallback on a multi-workspace stack', {
          linear_workspace_id: payload.organizationId,
          active_workspace_count: activeWorkspaces,
          remedy: 'bgagent linear update-webhook-secret <slug>',
        });
        return jsonResponse(401, { error: 'Per-workspace signing secret required' });
      }

      if (!await verifyLinearRequest(WEBHOOK_SECRET_ARN, signature, event.body)) {
        logger.warn('Invalid Linear webhook signature', {
          linear_workspace_id: payload.organizationId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      }
      verifiedViaStackWide = true;
      logger.info('Linear webhook verified via stack-wide fallback secret', {
        linear_workspace_id: payload.organizationId,
        per_workspace_registry_configured: Boolean(WORKSPACE_REGISTRY_TABLE),
      });
    }

    if (!isWebhookTimestampFresh(payload.webhookTimestamp)) {
      logger.warn('Linear webhook timestamp outside replay window', {
        webhook_timestamp: payload.webhookTimestamp,
        webhook_id: payload.webhookId,
      });
      return jsonResponse(401, { error: 'Stale webhook timestamp' });
    }

    const agentSessionsEnabled = isLinearAgentSessionsEnabled();
    const isAgentSessionDelivery = agentSessionsEnabled && payload.type === AGENT_SESSION_EVENT_TYPE;
    if (payload.type !== 'Issue' && payload.type !== 'Comment' && !isAgentSessionDelivery) {
      logIgnoredWebhookType(payload, agentSessionsEnabled);
      return jsonResponse(200, { ok: true });
    }

    const { id: dataId, missingMessage } = isAgentSessionDelivery
      ? { id: payload.agentSession?.id, missingMessage: 'Linear webhook missing agentSession.id' }
      : { id: payload.data?.id, missingMessage: 'Linear webhook missing data.id' };
    const action = payload.action ?? 'unknown';
    if (!dataId) {
      logger.warn(missingMessage, { type: payload.type, action });
      return jsonResponse(400, { error: 'Missing data id' });
    }
    if (isAgentSessionDelivery && !isHandledAgentSessionAction(action)) {
      logger.info('Ignoring unhandled AgentSessionEvent action', { action });
      return jsonResponse(200, { ok: true });
    }
    if (payload.type === 'Comment' && action !== 'create') {
      logger.info('Ignoring non-create Comment webhook', { action });
      return jsonResponse(200, { ok: true });
    }
    const issueId = dataId;

    // Linear's `webhookId` identifies the webhook configuration: it is the same on every delivery.
    // `webhookTimestamp` (UNIX ms) is unique per delivery, and Linear reuses it when it retries that delivery.
    const dedupKey = `${issueId}#${action}#${payload.webhookTimestamp}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(new PutCommand({
        TableName: DEDUP_TABLE_NAME,
        Item: {
          dedup_key: dedupKey,
          created_at: new Date().toISOString(),
          ttl: nowSeconds + DEDUP_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(dedup_key)',
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        logger.info('Linear webhook dedup hit — skipping reprocess', {
          dedup_key: dedupKey,
          webhook_id: payload.webhookId,
        });
        return jsonResponse(200, { ok: true, deduped: true });
      }
      throw err;
    }

    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: PROCESSOR_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({
          raw_body: event.body,
          verified_via_stack_wide: verifiedViaStackWide,
        })),
      }));
    } catch (invokeErr) {
      logger.error('Failed to invoke Linear webhook processor', {
        error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
        issue_id: issueId,
        action,
      });
      try {
        await ddb.send(new DeleteCommand({
          TableName: DEDUP_TABLE_NAME,
          Key: { dedup_key: dedupKey },
        }));
      } catch (cleanupErr) {
        logger.warn('Failed to roll back Linear webhook dedup row after invoke failure', {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          dedup_key: dedupKey,
        });
      }
      return jsonResponse(500, { error: 'Dispatch failed' });
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    logger.error('Linear webhook handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
