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
  verifyJiraRequest,
  verifyJiraRequestForTenant,
} from './shared/jira-verify';
import { logger } from './shared/logger';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const WEBHOOK_SECRET_ARN = process.env.JIRA_WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.JIRA_WEBHOOK_DEDUP_TABLE_NAME!;
const PROCESSOR_FUNCTION_NAME = process.env.JIRA_WEBHOOK_PROCESSOR_FUNCTION_NAME!;
/** Optional. When unset, the per-tenant signing-secret path is skipped
 *  and only the stack-wide secret is consulted (back-compat). */
const WORKSPACE_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;

/**
 * Dedup window (seconds). Atlassian retries failed deliveries far less
 * aggressively than Linear, but we keep an 8-hour window to cover
 * delayed retries on transient outages and clock skew.
 */
const DEDUP_TTL_HOURS = 8;
const DEDUP_TTL_SECONDS = DEDUP_TTL_HOURS * 3600;

/**
 * Top-level shape of the Jira webhook envelope we care about for dedup +
 * routing. Other fields are forwarded to the processor as part of the raw
 * body — the processor parses its own copy.
 */
interface JiraWebhookEnvelope {
  readonly webhookEvent?: string;
  readonly timestamp?: number;
  readonly issue?: {
    readonly id?: string;
    readonly key?: string;
    readonly fields?: { readonly project?: { readonly id?: string; readonly key?: string } };
  };
  /** `cloudId` is delivered as a top-level field on Atlassian Cloud webhooks. */
  readonly matchedWebhookIds?: number[];
  readonly user?: { readonly accountId?: string };
}

/**
 * Atlassian's webhook payload doesn't always include `cloudId` at the top
 * level — older delivery payloads omit it, and self-hosted webhook
 * configurations don't carry it. We require it for tenant-scoped
 * verification; the receiver passes whatever it can extract through to
 * the processor and lets that step report a clear error if absent.
 */
interface JiraEnvelopeWithCloud extends JiraWebhookEnvelope {
  readonly cloudId?: string;
}

/**
 * POST /v1/jira/webhook — Jira Cloud webhook receiver.
 *
 * Verifies the `X-Hub-Signature` HMAC over the raw body, dedups on
 * `(issueKey, webhookEvent, timestamp)` with an 8h TTL, and async-invokes
 * the processor Lambda so we can ack quickly. Atlassian sends the
 * algorithm prefix (`sha256=…`) — `verifyJiraSignature` strips it before
 * comparison.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // HMAC is computed over the raw `event.body` string. If API Gateway is
    // ever configured with binary media types it can deliver the body
    // base64-encoded (`isBase64Encoded: true`), in which case both the JSON
    // parse and the signature comparison would be over the wrong bytes. We
    // assume a UTF-8 JSON body (Atlassian sends `application/json`); reject
    // loudly rather than silently failing verification on the encoded form.
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

    // Per-tenant verification first. Falls through to stack-wide if (a) registry
    // table not configured, (b) no cloudId in body, (c) tenant not in registry,
    // or (d) tenant's stored secret lacks `webhook_signing_secret`.
    // Per-tenant MISMATCH and REVOKED are fatal — no fallback.
    //
    // `verifiedViaStackWide` is propagated to the processor: a per-tenant
    // signature proves the sender knows *that* tenant's secret (so the
    // body-supplied `cloudId` is trustworthy for routing), whereas the
    // stack-wide secret is not bound to any tenant. The processor refuses
    // to route a stack-wide-verified delivery to a body-chosen `cloudId`,
    // binding it to the sole active tenant instead.
    let verified = false;
    let verifiedViaStackWide = false;
    if (WORKSPACE_REGISTRY_TABLE && payload.cloudId) {
      const result = await verifyJiraRequestForTenant(
        WORKSPACE_REGISTRY_TABLE,
        payload.cloudId,
        signature,
        event.body,
      );
      if (result === 'verified') {
        verified = true;
      } else if (result === 'mismatch') {
        logger.warn('Jira webhook signature mismatch against per-tenant secret', {
          jira_cloud_id: payload.cloudId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      } else if (result === 'revoked') {
        logger.warn('Jira webhook from revoked tenant — rejecting without stack-wide fallback', {
          jira_cloud_id: payload.cloudId,
        });
        return jsonResponse(401, { error: 'Tenant not active' });
      }
      // 'no-per-tenant-secret' falls through to stack-wide.
    }

    if (!verified) {
      if (!await verifyJiraRequest(WEBHOOK_SECRET_ARN, signature, event.body)) {
        logger.warn('Invalid Jira webhook signature', {
          jira_cloud_id: payload.cloudId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      }
      verifiedViaStackWide = true;
      logger.info('Jira webhook verified via stack-wide fallback secret', {
        jira_cloud_id: payload.cloudId,
        per_tenant_registry_configured: Boolean(WORKSPACE_REGISTRY_TABLE),
      });
    }

    // Advisory replay window. The dedup table catches the common retry case;
    // this guards against very old replays. Atlassian's `timestamp` is only
    // advisory (it isn't part of the signed material), so a missing value
    // can't be rejected — but we log it so the skipped check is observable
    // rather than a silent fail-open.
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
    if (webhookEvent !== 'jira:issue_created' && webhookEvent !== 'jira:issue_updated') {
      // Silent 200 so Atlassian doesn't retry — every non-issue event is acked.
      logger.info('Ignoring non-Issue Jira webhook', { webhookEvent });
      return jsonResponse(200, { ok: true });
    }

    const issue = payload.issue;
    const issueId = issue?.id;
    const issueKey = issue?.key;
    if (!issueId || !issueKey) {
      logger.warn('Jira Issue webhook missing issue.id or issue.key', { webhookEvent });
      return jsonResponse(400, { error: 'Missing issue identifier' });
    }

    // Dedup via conditional PutItem.
    //
    // Atlassian doesn't expose a per-delivery message ID we can rely on. The
    // payload's top-level `timestamp` (UNIX ms) is set when the event was
    // queued and remains stable across retries of the same delivery.
    // Composing `${issueKey}#${webhookEvent}#${timestamp}` collapses retries
    // (same timestamp) without merging distinct events.
    const dedupKey = `${issueKey}#${webhookEvent}#${payload.timestamp ?? 'unknown'}`;
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
      // Roll back the dedup row so a future Atlassian retry can dispatch.
      // Without this, all retries hit the dedup TTL and silently drop.
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
