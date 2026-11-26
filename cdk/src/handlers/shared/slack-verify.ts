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

import { logger } from './logger';
import { cachedSecrets, hmacSha256Equals, verifyWithRefetch } from './webhook-hmac';

/** Prefix for Slack-related secrets in Secrets Manager. */
export const SLACK_SECRET_PREFIX = 'bgagent/slack/';

// In-memory secret cache with 5-minute TTL (same pattern as webhook handler).
const secretCache = cachedSecrets(
  {
    empty: 'Slack signing secret is empty — refusing to use for HMAC',
    notFound: 'Slack secret not found in Secrets Manager',
    fetchFailed: 'Failed to fetch Slack secret from Secrets Manager',
  },
  // A bot token that is scheduled for deletion (its workspace removed the
  // app) cannot be read until its recovery window ends: it is as absent as
  // one that does not exist. Bot tokens are the secrets read by name under
  // SLACK_SECRET_PREFIX. Any other secret in that state stays an error (the
  // signing secret and the OAuth credentials are read by ARN), so that a
  // signing secret never looks "not populated yet" to its callers.
  (err, secretId) => err?.name === 'InvalidRequestException'
    && secretId.startsWith(SLACK_SECRET_PREFIX)
    && String(err.message).includes('marked for deletion'),
);

/** Maximum age of a Slack request timestamp before it is rejected (replay protection). */
const MAX_TIMESTAMP_AGE_MINUTES = 5;
const MAX_TIMESTAMP_AGE_S = MAX_TIMESTAMP_AGE_MINUTES * 60;

/**
 * Fetch a secret from Secrets Manager with in-memory caching.
 * @param secretId - the full Secrets Manager secret ID or ARN.
 * @param forceRefresh - bypass the cache and re-fetch from Secrets Manager.
 * @returns the secret string, or null if not found (for a bot token also
 *   while it is scheduled for deletion).
 */
export const getSlackSecret = secretCache.get;

/**
 * Explicitly drop a cached secret. Called when rotation is suspected —
 * e.g. signature verification fails with an otherwise valid-looking request.
 * @param secretId - the Secrets Manager secret ID or ARN to evict.
 */
export const invalidateSlackSecretCache = secretCache.invalidate;

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
  return hmacSha256Equals('Slack', signingSecret, `v0:${timestamp}:${body}`, signature, 'v0=');
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
  return verifyWithRefetch(secretCache, secretId, (secret) => verifySlackSignature(secret, signature, timestamp, body));
}
