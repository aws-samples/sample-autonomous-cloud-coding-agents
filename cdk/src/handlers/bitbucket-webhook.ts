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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { makeClient, makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const lambdaClient = makeClient(LambdaClient);
const secretsClient = makeClient(SecretsManagerClient);

const WEBHOOK_SECRET_ARN = process.env.BITBUCKET_WEBHOOK_SECRET_ARN ?? '';
const DEDUP_TABLE_NAME = process.env.BITBUCKET_WEBHOOK_DEDUP_TABLE_NAME ?? '';
const PROCESSOR_FUNCTION_NAME = process.env.BITBUCKET_WEBHOOK_PROCESSOR_FUNCTION_NAME ?? '';

const DEDUP_TTL_SECONDS = 60 * 60;

let cachedWebhookSecret: string | undefined;

async function resolveWebhookSecret(): Promise<string | undefined> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  if (!WEBHOOK_SECRET_ARN) return undefined;
  try {
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN }));
    cachedWebhookSecret = result.SecretString;
    return cachedWebhookSecret;
  } catch (err) {
    logger.error('Failed to resolve Bitbucket webhook secret', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined; // nosemgrep: ts-silent-success-masking -- caller treats undefined as "no secret configured" and skips signature verification gracefully
  }
}

const SHA256_PREFIX = 'sha256=';

function verifyHmacSignature(secret: string, signature: string, body: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const sig = signature.startsWith(SHA256_PREFIX) ? signature.slice(SHA256_PREFIX.length) : signature;
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}

interface BitbucketPrCommentPayload {
  readonly pullrequest?: {
    readonly id?: number;
    readonly title?: string;
    readonly source?: { readonly branch?: { readonly name?: string } };
    readonly destination?: { readonly branch?: { readonly name?: string } };
  };
  readonly comment?: {
    readonly id?: number;
    readonly content?: { readonly raw?: string };
  };
  readonly repository?: {
    readonly full_name?: string;
  };
  readonly actor?: {
    readonly display_name?: string;
    readonly uuid?: string;
  };
}

/**
 * POST /v1/bitbucket/webhook — Bitbucket webhook receiver.
 *
 * Validates the webhook signature (when a secret is configured), filters
 * to `pullrequest:comment_created` events containing `@bgagent` mentions,
 * deduplicates, and async-invokes the processor Lambda.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    const webhookSecret = await resolveWebhookSecret();
    if (webhookSecret) {
      const signature = event.headers['X-Hub-Signature'] ?? event.headers['x-hub-signature'] ?? '';
      if (!signature) {
        logger.warn('Bitbucket webhook missing signature header');
        return jsonResponse(401, { error: 'Missing signature' });
      }
      if (!verifyHmacSignature(webhookSecret, signature, event.body)) {
        logger.warn('Invalid Bitbucket webhook signature');
        return jsonResponse(401, { error: 'Invalid signature' });
      }
    }

    const eventType = event.headers['X-Event-Key'] ?? event.headers['x-event-key'] ?? '';
    const hookUuid = event.headers['X-Hook-UUID'] ?? event.headers['x-hook-uuid'] ?? '';

    if (!eventType) {
      logger.warn('Bitbucket webhook missing X-Event-Key header');
      return jsonResponse(400, { error: 'Missing event key' });
    }

    if (eventType === 'diagnostics:ping') {
      return jsonResponse(200, { ok: true, ping: true });
    }

    if (eventType !== 'pullrequest:comment_created') {
      logger.info('Ignoring non-comment Bitbucket webhook', { event_type: eventType });
      return jsonResponse(200, { ok: true });
    }

    let payload: BitbucketPrCommentPayload;
    try {
      payload = JSON.parse(event.body) as BitbucketPrCommentPayload;
    } catch (err) {
      logger.warn('Bitbucket webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    const commentBody = payload.comment?.content?.raw ?? '';
    if (!commentBody.includes('@bgagent')) {
      return jsonResponse(200, { ok: true, skipped: 'no @bgagent mention' });
    }

    const repo = payload.repository?.full_name;
    const commentId = payload.comment?.id;
    const prId = payload.pullrequest?.id;

    if (!repo || !commentId || !prId) {
      logger.warn('Bitbucket webhook missing required fields', { repo, commentId, prId });
      return jsonResponse(400, { error: 'Missing required fields' });
    }

    const dedupKey = `bb#${repo}#pr${prId}#comment${commentId}`;
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (DEDUP_TABLE_NAME) {
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
          logger.info('Bitbucket webhook dedup hit', { dedup_key: dedupKey });
          return jsonResponse(200, { ok: true, deduped: true });
        }
        throw err;
      }
    }

    if (PROCESSOR_FUNCTION_NAME) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: PROCESSOR_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify({
            raw_body: event.body,
            hook_uuid: hookUuid,
            event_type: eventType,
          })),
        }));
      } catch (invokeErr) {
        logger.error('Failed to invoke Bitbucket webhook processor', {
          error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
          repo,
          pr_id: prId,
          comment_id: commentId,
        });
        return jsonResponse(500, { error: 'Internal error dispatching event' });
      }
    }

    logger.info('Bitbucket webhook dispatched', { repo, pr_id: prId, comment_id: commentId });
    return jsonResponse(200, { ok: true, dispatched: true });
  } catch (err) {
    logger.error('Unhandled error in Bitbucket webhook handler', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal error' });
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
