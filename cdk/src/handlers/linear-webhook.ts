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

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  isWebhookTimestampFresh,
  verifyLinearRequest,
  verifyLinearRequestForWorkspace,
} from './shared/linear-verify';
import { logger } from './shared/logger';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const WEBHOOK_SECRET_ARN = process.env.LINEAR_WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME!;
const PROCESSOR_FUNCTION_NAME = process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME!;
/** Optional. When unset, the per-workspace signing-secret path is skipped
 *  and only the stack-wide secret is consulted (back-compat for installs
 *  predating per-workspace secrets). */
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

/**
 * Dedup window (seconds). Must exceed Linear's full retry horizon: first
 * retry is +1m, then +1h, then +6h (~7h total from the initial delivery).
 * A window shorter than this lets the +1h / +6h retries land after the
 * dedup row has TTL'd out, which would double-create the task when an
 * ack was lost. 8h is comfortably over the horizon with slack for clock
 * skew, without making stale rows live meaningfully longer (DDB TTL is
 * async best-effort anyway).
 */
const DEDUP_TTL_SECONDS = 8 * 60 * 60;

/**
 * Shape of the top-level Linear webhook payload we care about for dedup + routing.
 * Full payload is forwarded to the processor without re-serialization risk —
 * the processor parses its own copy from the raw body.
 */
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
}

/**
 * POST /v1/linear/webhook — Linear webhook receiver.
 *
 * Verifies the `Linear-Signature` HMAC over the raw body, rejects stale
 * `webhookTimestamp` values (replay protection), dedups on
 * `(issue_id, action)` with a 60s TTL, and async-invokes the processor
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

    // Parse body ONCE — we peek at the orgId before signature verification
    // so we can pick the right per-workspace signing secret. The orgId is
    // untrusted at this point; it only selects WHICH secret to verify
    // against. An attacker can claim any orgId but still needs the
    // matching signing secret to forge a valid signature.
    let payload: LinearWebhookEnvelope;
    try {
      payload = JSON.parse(event.body) as LinearWebhookEnvelope;
    } catch (err) {
      logger.warn('Linear webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    // Try the per-workspace secret first. Falls through to the stack-wide
    // path if (a) registry table not configured, (b) no orgId in body,
    // (c) workspace not in registry, or (d) workspace's stored secret
    // lacks `webhook_signing_secret`. Per-workspace MISMATCH is fatal —
    // do NOT fall back, that would let an attacker bypass per-workspace
    // signatures by also matching the stack-wide one.
    let verified = false;
    if (WORKSPACE_REGISTRY_TABLE && payload.organizationId) {
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
      }
      // 'no-per-workspace-secret' falls through to the stack-wide path
      // below — back-compat for installs predating per-workspace secrets.
    }

    if (!verified && !await verifyLinearRequest(WEBHOOK_SECRET_ARN, signature, event.body)) {
      logger.warn('Invalid Linear webhook signature', {
        linear_workspace_id: payload.organizationId,
      });
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    if (!isWebhookTimestampFresh(payload.webhookTimestamp)) {
      logger.warn('Linear webhook timestamp outside replay window', {
        webhook_timestamp: payload.webhookTimestamp,
        webhook_id: payload.webhookId,
      });
      return jsonResponse(401, { error: 'Stale webhook timestamp' });
    }

    // Only Issue events flow through to task creation. Every other type is
    // acknowledged silently so Linear stops retrying.
    if (payload.type !== 'Issue') {
      logger.info('Ignoring non-Issue Linear webhook', { type: payload.type, action: payload.action });
      return jsonResponse(200, { ok: true });
    }

    const issueId = payload.data?.id;
    const action = payload.action ?? 'unknown';
    if (!issueId) {
      logger.warn('Linear Issue webhook missing data.id', { action });
      return jsonResponse(400, { error: 'Missing issue id' });
    }

    // Dedup via conditional PutItem.
    //
    // Linear's `webhookId` in the payload body is the *webhook configuration*
    // ID — reused on every delivery, not per-delivery. `webhookTimestamp`
    // (UNIX ms) is unique per delivery; Linear reuses it for retries of a
    // single delivery. Compose `${issueId}#${action}#${webhookTimestamp}` so
    // retries of the same event collapse (same timestamp) while distinct
    // events do not. A missing timestamp would have already failed the replay
    // check above, so treat its presence as a precondition.
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

    // Async-invoke the processor with the raw body so it can re-parse safely.
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: PROCESSOR_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({ raw_body: event.body })),
      }));
    } catch (invokeErr) {
      logger.error('Failed to invoke Linear webhook processor', {
        error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
        issue_id: issueId,
        action,
      });
      // Roll back the dedup row so Linear's next retry (+1m / +1h / +6h) can
      // try dispatch again. Without this, all retries would hit the dedup TTL
      // (8h) and silently drop the task forever.
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
