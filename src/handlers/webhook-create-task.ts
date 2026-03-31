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
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { createTaskCore } from './shared/create-task-core';
import { buildWebhookChannelMetadata, extractWebhookContext } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse } from './shared/response';
import type { CreateTaskRequest } from './shared/types';
import { parseBody } from './shared/validation';

const sm = new SecretsManagerClient({});
const SECRET_PREFIX = 'bgagent/webhook/';

// In-memory secret cache with 5-minute TTL
const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getSecret(webhookId: string): Promise<string | null> {
  const now = Date.now();
  const cached = secretCache.get(webhookId);
  if (cached && cached.expiresAt > now) {
    return cached.secret;
  }

  try {
    const result = await sm.send(new GetSecretValueCommand({
      SecretId: `${SECRET_PREFIX}${webhookId}`,
    }));
    if (!result.SecretString) return null;
    secretCache.set(webhookId, { secret: result.SecretString, expiresAt: now + CACHE_TTL_MS });
    return result.SecretString;
  } catch (err) {
    const errorName = (err as Error)?.name;
    if (errorName === 'ResourceNotFoundException') {
      logger.error('Webhook secret not found in Secrets Manager', { webhook_id: webhookId });
      return null;
    }
    logger.error('Failed to fetch webhook secret from Secrets Manager', {
      webhook_id: webhookId,
      error: String(err),
      error_name: errorName,
    });
    throw err;
  }
}

function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const providedHex = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(providedHex, 'hex'),
    );
  } catch (err) {
    logger.warn('Signature comparison failed', {
      error: String(err),
      expected_length: expected.length,
      provided_length: providedHex.length,
    });
    return false;
  }
}

/**
 * POST /v1/webhooks/tasks — Create a new task via webhook.
 *
 * The REQUEST authorizer verifies the webhook exists and is active.
 * This handler performs HMAC-SHA256 signature verification (the authorizer
 * cannot do this because API Gateway REST API v1 does not pass the request
 * body to REQUEST authorizers).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract webhook auth context (injected by REQUEST authorizer)
    const webhookCtx = extractWebhookContext(event);
    if (!webhookCtx) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid webhook authentication.', requestId);
    }

    // 2. Verify HMAC-SHA256 signature
    const signature = event.headers['X-Webhook-Signature'] ?? event.headers['x-webhook-signature'];
    if (!signature) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing X-Webhook-Signature header.', requestId);
    }

    if (!event.body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body is required.', requestId);
    }

    const secret = await getSecret(webhookCtx.webhookId);
    if (!secret) {
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
    }

    if (!verifySignature(event.body, secret, signature)) {
      logger.warn('Invalid webhook signature', { webhook_id: webhookCtx.webhookId, request_id: requestId });
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Invalid webhook signature.', requestId);
    }

    // 3. Parse request body
    const body = parseBody<CreateTaskRequest>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    // 4. Extract idempotency key
    const idempotencyKey = event.headers['Idempotency-Key'] ?? event.headers['idempotency-key'];

    // 5. Delegate to shared core
    return await createTaskCore(body, {
      userId: webhookCtx.userId,
      channelSource: 'webhook',
      channelMetadata: buildWebhookChannelMetadata(event, webhookCtx.webhookId),
      idempotencyKey: idempotencyKey ?? undefined,
    }, requestId);
  } catch (err) {
    logger.error('Failed to create task via webhook', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
