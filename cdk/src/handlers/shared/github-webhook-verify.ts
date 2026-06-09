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

/**
 * In-memory secret cache (5-minute TTL). Same pattern as `linear-verify.ts`
 * — webhook secrets rotate infrequently, and skipping a Secrets Manager
 * round-trip on every webhook keeps the receiver well under GitHub's 10s
 * timeout. After rotation, the verifier transparently re-fetches once.
 */
const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch a GitHub webhook secret from Secrets Manager with caching.
 * @param secretId - the Secrets Manager secret ID or ARN.
 * @param forceRefresh - bypass cache and re-fetch.
 * @returns the secret string, or null if not found.
 */
export async function getGitHubWebhookSecret(secretId: string, forceRefresh = false): Promise<string | null> {
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
      logger.error('GitHub webhook secret not found', { secret_id: secretId });
      secretCache.delete(secretId);
      return null;
    }
    logger.error('Failed to fetch GitHub webhook secret', {
      secret_id: secretId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Drop a cached webhook secret — used on suspected rotation. */
export function invalidateGitHubWebhookSecretCache(secretId: string): void {
  secretCache.delete(secretId);
}

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
  const provided = header.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch (err) {
    logger.warn('GitHub signature comparison failed', {
      error: err instanceof Error ? err.message : String(err),
      expected_length: expected.length,
      provided_length: provided.length,
    });
    return false;
  }
}

/**
 * Verify a GitHub webhook request, with one transparent re-fetch on
 * cache miss. Same UX as `verifyLinearRequest` so warm Lambdas don't
 * silently reject post-rotation deliveries for up to 5 minutes.
 */
export async function verifyGitHubRequest(secretId: string, header: string, body: string): Promise<boolean> {
  const cached = await getGitHubWebhookSecret(secretId);
  if (cached && verifyGitHubSignature(cached, header, body)) {
    return true;
  }

  invalidateGitHubWebhookSecretCache(secretId);
  const fresh = await getGitHubWebhookSecret(secretId, true);
  if (!fresh) return false;
  if (fresh === cached) return false;
  return verifyGitHubSignature(fresh, header, body);
}
