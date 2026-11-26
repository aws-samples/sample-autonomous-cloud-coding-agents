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
import { resolveSoleActiveJiraTenant } from './shared/jira-tenant-registry';
import {
  isWebhookTimestampFresh,
  verifyJiraRequest,
  verifyJiraRequestForTenant,
} from './shared/jira-verify';
import { logger } from './shared/logger';
import { makeClient, makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const lambdaClient = makeClient(LambdaClient);

const WEBHOOK_SECRET_ARN = process.env.JIRA_WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.JIRA_WEBHOOK_DEDUP_TABLE_NAME!;
const PROCESSOR_FUNCTION_NAME = process.env.JIRA_WEBHOOK_PROCESSOR_FUNCTION_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;

const DEDUP_TTL_HOURS = 8;
const DEDUP_TTL_SECONDS = DEDUP_TTL_HOURS * 3600;

interface JiraWebhookEnvelope {
  readonly webhookEvent?: string;
  readonly timestamp?: number;
  readonly issue?: {
    readonly id?: string;
    readonly key?: string;
    readonly fields?: { readonly project?: { readonly id?: string; readonly key?: string } };
  };
  readonly comment?: {
    readonly id?: string;
  };
  readonly matchedWebhookIds?: number[];
  readonly user?: { readonly accountId?: string };
}

interface JiraEnvelopeWithCloud extends JiraWebhookEnvelope {
  // Atlassian does not always send `cloudId` at the top level: older delivery
  // payloads omit it, and self-hosted webhook configurations do not carry it.
  readonly cloudId?: string;
}

/**
 * POST /v1/jira/webhook — Jira Cloud webhook receiver.
 *
 * Verifies the `X-Hub-Signature` HMAC over the raw body, dedups on
 * issue events on `(issueKey, webhookEvent, timestamp)` and comment events on
 * `(issueKey, comment_created, commentId)` with an 8h TTL, then async-invokes
 * the processor Lambda.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    if (event.isBase64Encoded) {
      logger.error('Jira webhook delivered base64-encoded; expected raw JSON body');
      return jsonResponse(400, { error: 'Unexpected body encoding' });
    }

    const signature = event.headers['X-Hub-Signature'] ?? event.headers['x-hub-signature'] ?? '';
    if (!signature) {
      logger.warn('Jira webhook missing X-Hub-Signature header');
      return jsonResponse(401, { error: 'Missing signature' });
    }

    let payload: JiraEnvelopeWithCloud;
    try {
      payload = JSON.parse(event.body) as JiraEnvelopeWithCloud;
    } catch (err) {
      logger.warn('Jira webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }
    if (payload === null) {
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    let verified = false;
    let verifiedViaStackWide = false;
    const verificationCloudId = payload.cloudId
      ?? await resolveSoleActiveJiraTenant(ddb, WORKSPACE_REGISTRY_TABLE);
    if (WORKSPACE_REGISTRY_TABLE && verificationCloudId) {
      const result = await verifyJiraRequestForTenant(
        WORKSPACE_REGISTRY_TABLE,
        verificationCloudId,
        signature,
        event.body,
      );
      if (result === 'verified') {
        verified = true;
      } else if (result === 'mismatch') {
        logger.warn('Jira webhook signature mismatch against per-tenant secret', {
          jira_cloud_id: payload.cloudId,
          verified_jira_cloud_id: verificationCloudId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      } else if (result === 'revoked') {
        logger.warn('Jira webhook from revoked tenant — rejecting without stack-wide verification', {
          jira_cloud_id: payload.cloudId,
          verified_jira_cloud_id: verificationCloudId,
        });
        return jsonResponse(401, { error: 'Tenant not active' });
      }
    }

    if (!verified) {
      if (!await verifyJiraRequest(WEBHOOK_SECRET_ARN, signature, event.body)) {
        logger.warn('Invalid Jira webhook signature', {
          jira_cloud_id: payload.cloudId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      }
      verifiedViaStackWide = true;
      logger.info('Jira webhook verified via stack-wide secret', {
        jira_cloud_id: payload.cloudId,
        per_tenant_registry_configured: Boolean(WORKSPACE_REGISTRY_TABLE),
      });
    }

    if (payload.timestamp === undefined) {
      logger.warn('Jira webhook has no timestamp — replay-window check skipped', {
        jira_cloud_id: payload.cloudId,
      });
    } else if (!isWebhookTimestampFresh(payload.timestamp)) {
      logger.warn('Jira webhook timestamp outside replay window', {
        timestamp: payload.timestamp,
      });
      return jsonResponse(401, { error: 'Stale webhook timestamp' });
    }

    const webhookEvent = payload.webhookEvent;
    const isIssueEvent =
      webhookEvent === 'jira:issue_created' || webhookEvent === 'jira:issue_updated';
    const isCommentEvent = webhookEvent === 'comment_created';
    if (!isIssueEvent && !isCommentEvent) {
      logger.info('Ignoring unsupported Jira webhook', { webhookEvent });
      return jsonResponse(200, { ok: true });
    }

    const issue = payload.issue;
    const issueId = issue?.id;
    const issueKey = issue?.key;
    if (!issueId || !issueKey) {
      logger.warn('Jira webhook missing issue.id or issue.key', { webhookEvent });
      return jsonResponse(400, { error: 'Missing issue identifier' });
    }
    const commentId = payload.comment?.id;
    if (isCommentEvent && !commentId) {
      logger.warn('Jira comment webhook missing comment.id', { issue_key: issueKey });
      return jsonResponse(400, { error: 'Missing comment identifier' });
    }

    const dedupDiscriminator = isCommentEvent
      ? commentId!
      : payload.timestamp ?? 'unknown';
    const dedupKey = `${issueKey}#${webhookEvent}#${dedupDiscriminator}`;
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
        logger.info('Jira webhook dedup hit — skipping reprocess', { dedup_key: dedupKey });
        return jsonResponse(200, { ok: true, deduped: true });
      }
      throw err;
    }

    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: PROCESSOR_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(
          JSON.stringify({ raw_body: event.body, verified_via_stack_wide: verifiedViaStackWide }),
        ),
      }));
    } catch (invokeErr) {
      logger.error('Failed to invoke Jira webhook processor', {
        error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
        issue_id: issueId,
        issue_key: issueKey,
        webhookEvent,
      });
      try {
        await ddb.send(new DeleteCommand({
          TableName: DEDUP_TABLE_NAME,
          Key: { dedup_key: dedupKey },
        }));
      } catch (cleanupErr) {
        logger.warn('Failed to roll back Jira webhook dedup row after invoke failure', {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          dedup_key: dedupKey,
        });
      }
      return jsonResponse(500, { error: 'Dispatch failed' });
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    logger.error('Jira webhook handler failed', {
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
