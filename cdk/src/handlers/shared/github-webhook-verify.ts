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

import { cachedSecrets, hmacSha256Equals, verifyWithRefetch } from './webhook-hmac';

/**
 * In-memory secret cache (5-minute TTL). Same pattern as `linear-verify.ts`
 * — webhook secrets rotate infrequently, and skipping a Secrets Manager
 * round-trip on every webhook keeps the receiver well under GitHub's 10s
 * timeout. After rotation, the verifier transparently re-fetches once.
 */
const secretCache = cachedSecrets({
  empty: 'GitHub webhook secret is empty — refusing to use for HMAC',
  notFound: 'GitHub webhook secret not found',
  fetchFailed: 'Failed to fetch GitHub webhook secret',
});

/**
 * Fetch a GitHub webhook secret from Secrets Manager with caching.
 * @param secretId - the Secrets Manager secret ID or ARN.
 * @param forceRefresh - bypass cache and re-fetch.
 * @returns the secret string, or null if not found.
 */
export const getGitHubWebhookSecret = secretCache.get;

export const invalidateGitHubWebhookSecretCache = secretCache.invalidate;

/**
 * Verify a GitHub webhook signature.
 *
 * GitHub signs with HMAC-SHA256 over the raw body, hex-encoded, prefixed
 * with the literal `sha256=` and delivered in the `X-Hub-Signature-256`
 * header (per
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
 * The legacy `X-Hub-Signature` (SHA1) header is not validated — GitHub
 * always sends both, but SHA256 is the secure one.
 *
 * @param webhookSecret - the per-webhook signing secret.
 * @param header - the `X-Hub-Signature-256` header value (with `sha256=` prefix).
 * @param body - the raw request body string.
 * @returns true if the signature matches.
 */
export function verifyGitHubSignature(webhookSecret: string, header: string, body: string): boolean {
  if (!header.startsWith('sha256=')) {
    return false;
  }
  return hmacSha256Equals('GitHub', webhookSecret, body, header.slice('sha256='.length));
}

/**
 * Verify a GitHub webhook request, with one transparent re-fetch on
 * cache miss. Same UX as `verifyLinearRequest` so warm Lambdas don't
 * silently reject post-rotation deliveries for up to 5 minutes.
 */
export async function verifyGitHubRequest(secretId: string, header: string, body: string): Promise<boolean> {
  return verifyWithRefetch(secretCache, secretId, (secret) => verifyGitHubSignature(secret, header, body));
}
