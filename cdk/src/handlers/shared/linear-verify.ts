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
import { logger } from './logger';

const sm = new SecretsManagerClient({});

/** Prefix for Linear-related secrets in Secrets Manager. */
export const LINEAR_SECRET_PREFIX = 'bgagent/linear/';

// In-memory secret cache with 5-minute TTL (same pattern as slack-verify.ts).
const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum age of a Linear webhookTimestamp (ms) before it is rejected (replay protection). */
export const MAX_WEBHOOK_TIMESTAMP_AGE_MS = 60 * 1000;

/**
 * Fetch a secret from Secrets Manager with in-memory caching.
 * @param secretId - the full Secrets Manager secret ID or ARN.
 * @param forceRefresh - bypass the cache and re-fetch from Secrets Manager.
 * @returns the secret string, or null if not found.
 */
export async function getLinearSecret(secretId: string, forceRefresh = false): Promise<string | null> {
  const now = Date.now();
  if (!forceRefresh) {
    const cached = secretCache.get(secretId);
    if (cached && cached.expiresAt > now) {
      return cached.secret;
    }
  }

  try {
    const result = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) {
      secretCache.delete(secretId);
      return null;
    }
    secretCache.set(secretId, { secret: result.SecretString, expiresAt: now + CACHE_TTL_MS });
    return result.SecretString;
  } catch (err) {
    const errorName = (err as Error)?.name;
    if (errorName === 'ResourceNotFoundException') {
      logger.error('Linear secret not found in Secrets Manager', { secret_id: secretId });
      secretCache.delete(secretId);
      return null;
    }
    logger.error('Failed to fetch Linear secret from Secrets Manager', {
      secret_id: secretId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Explicitly drop a cached secret. Called when rotation is suspected —
 * e.g. signature verification fails with an otherwise valid-looking request.
 * @param secretId - the Secrets Manager secret ID or ARN to evict.
 */
export function invalidateLinearSecretCache(secretId: string): void {
  secretCache.delete(secretId);
}

/**
 * Verify a Linear webhook signature.
 *
 * Linear signs each webhook with HMAC-SHA256 over the raw request body, hex-encoded,
 * delivered in the `Linear-Signature` header. Replay protection uses the
 * `webhookTimestamp` field (UNIX milliseconds) inside the JSON payload, not a header.
 *
 * @param webhookSecret - the per-webhook signing secret.
 * @param signature - the `Linear-Signature` header value.
 * @param body - the raw request body string.
 * @returns true if the signature matches.
 */
export function verifyLinearSignature(
  webhookSecret: string,
  signature: string,
  body: string,
): boolean {
  const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (err) {
    logger.warn('Linear signature comparison failed', {
      error: err instanceof Error ? err.message : String(err),
      expected_length: expected.length,
      provided_length: signature.length,
    });
    return false;
  }
}

/**
 * Check that a Linear `webhookTimestamp` (ms since epoch, embedded in the payload)
 * is within the acceptable replay window.
 * @param webhookTimestamp - numeric timestamp from the parsed payload.
 * @returns true if the timestamp is within MAX_WEBHOOK_TIMESTAMP_AGE_MS of now.
 */
export function isWebhookTimestampFresh(webhookTimestamp: number | undefined): boolean {
  if (typeof webhookTimestamp !== 'number' || !isFinite(webhookTimestamp)) {
    return false;
  }
  const age = Math.abs(Date.now() - webhookTimestamp);
  return age <= MAX_WEBHOOK_TIMESTAMP_AGE_MS;
}

/**
 * Verify a Linear webhook request, transparently re-fetching the signing secret once
 * if the cached copy is rejected. After rotation, warm Lambdas keep the old
 * cached secret until their 5-minute TTL elapses — this forces an early refresh.
 *
 * @param secretId - Secrets Manager ARN/ID for the webhook secret.
 * @param signature - the `Linear-Signature` header value.
 * @param body - the raw request body string.
 * @returns true if the signature is authentic (after at most one refresh retry).
 */
export async function verifyLinearRequest(
  secretId: string,
  signature: string,
  body: string,
): Promise<boolean> {
  const cached = await getLinearSecret(secretId);
  if (cached && verifyLinearSignature(cached, signature, body)) {
    return true;
  }

  invalidateLinearSecretCache(secretId);
  const fresh = await getLinearSecret(secretId, true);
  if (!fresh) return false;
  if (fresh === cached) return false;
  return verifyLinearSignature(fresh, signature, body);
}
