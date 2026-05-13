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

/** Prefix for Slack-related secrets in Secrets Manager. */
export const SLACK_SECRET_PREFIX = 'bgagent/slack/';

// In-memory secret cache with 5-minute TTL (same pattern as webhook handler).
const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum age of a Slack request timestamp before it is rejected (replay protection). */
const MAX_TIMESTAMP_AGE_S = 5 * 60;

/**
 * Fetch a secret from Secrets Manager with in-memory caching.
 * @param secretId - the full Secrets Manager secret ID or ARN.
 * @param forceRefresh - bypass the cache and re-fetch from Secrets Manager.
 * @returns the secret string, or null if not found.
 */
export async function getSlackSecret(secretId: string, forceRefresh = false): Promise<string | null> {
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
      logger.error('Slack secret not found in Secrets Manager', { secret_id: secretId });
      secretCache.delete(secretId);
      return null;
    }
    logger.error('Failed to fetch Slack secret from Secrets Manager', {
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
export function invalidateSlackSecretCache(secretId: string): void {
  secretCache.delete(secretId);
}

/**
 * Verify a Slack request signature.
 *
 * Slack signs every request with HMAC-SHA256 using the app signing secret.
 * Signature format: `v0={hex}` where the HMAC input is `v0:{timestamp}:{body}`.
 *
 * @param signingSecret - the Slack app signing secret.
 * @param signature - the `X-Slack-Signature` header value.
 * @param timestamp - the `X-Slack-Request-Timestamp` header value.
 * @param body - the raw request body string.
 * @returns true if the signature is valid and the timestamp is recent.
 */
export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  // Reject requests with stale timestamps (replay protection).
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    logger.warn('Invalid Slack request timestamp', { timestamp });
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_S) {
    logger.warn('Slack request timestamp too old', { timestamp, now: String(now) });
    return false;
  }

  // Compute expected signature: v0=HMAC-SHA256(signing_secret, "v0:{ts}:{body}")
  const sigBasestring = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (err) {
    logger.warn('Slack signature comparison failed', {
      error: err instanceof Error ? err.message : String(err),
      expected_length: expected.length,
      provided_length: signature.length,
    });
    return false;
  }
}

/**
 * Verify a Slack request, transparently re-fetching the signing secret once
 * if the cached copy is rejected. After rotation, warm Lambdas keep the old
 * cached secret until their 5-minute TTL elapses — this forces an early refresh.
 *
 * @param secretId - Secrets Manager ARN/ID for the signing secret.
 * @param signature - the `X-Slack-Signature` header value.
 * @param timestamp - the `X-Slack-Request-Timestamp` header value.
 * @param body - the raw request body string.
 * @returns true if the request is authentic (after at most one refresh retry).
 */
export async function verifySlackRequest(
  secretId: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const cached = await getSlackSecret(secretId);
  if (cached && verifySlackSignature(cached, signature, timestamp, body)) {
    return true;
  }

  // Cache might be stale after a signing-secret rotation — evict and try once more.
  invalidateSlackSecretCache(secretId);
  const fresh = await getSlackSecret(secretId, true);
  if (!fresh) return false;
  if (fresh === cached) return false; // Same secret, still invalid — don't double-log.
  return verifySlackSignature(fresh, signature, timestamp, body);
}
