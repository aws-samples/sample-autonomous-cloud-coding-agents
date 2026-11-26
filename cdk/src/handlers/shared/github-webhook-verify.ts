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
import { isUsableHmacSecret } from './hmac-secret';
import { logger } from './logger';
import { makeClient } from './ua';

const sm = makeClient(SecretsManagerClient);

const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

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
    const value = result.SecretString;
    if (!isUsableHmacSecret(value)) {
      logger.error('GitHub webhook secret is empty — refusing to use for HMAC', {
        secret_id: secretId,
      });
      secretCache.delete(secretId);
      return null;
    }
    secretCache.set(secretId, { secret: value, expiresAt: now + CACHE_TTL_MS });
    return value;
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
 *
 * @param webhookSecret - the per-webhook signing secret.
 * @param header - the `X-Hub-Signature-256` header value (with `sha256=` prefix).
 * @param body - the raw request body string.
 * @returns true if the signature matches.
 */
export function verifyGitHubSignature(webhookSecret: string, header: string, body: string): boolean {
  if (!isUsableHmacSecret(webhookSecret)) {
    return false;
  }
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
 * Verify a GitHub webhook request, re-fetching the secret once when the
 * cached one does not verify.
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
