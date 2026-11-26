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

/** Prefix for Slack-related secrets in Secrets Manager. */
export const SLACK_SECRET_PREFIX = 'bgagent/slack/';

const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

const MAX_TIMESTAMP_AGE_MINUTES = 5;
const MAX_TIMESTAMP_AGE_S = MAX_TIMESTAMP_AGE_MINUTES * 60;

/**
 * Fetch a secret from Secrets Manager with in-memory caching.
 * @param secretId - the full Secrets Manager secret ID or ARN.
 * @param forceRefresh - bypass the cache and re-fetch from Secrets Manager.
 * @returns the secret string, or null if not found (for a bot token also
 *   while it is scheduled for deletion).
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
    if (!isUsableHmacSecret(result.SecretString)) {
      logger.error('Slack signing secret is empty — refusing to use for HMAC', {
        secret_id: secretId,
      });
      secretCache.delete(secretId);
      return null;
    }
    secretCache.set(secretId, { secret: result.SecretString, expiresAt: now + CACHE_TTL_MS });
    return result.SecretString;
  } catch (err) {
    const errorName = (err as Error)?.name;
    // Secrets Manager refuses to read a secret that is scheduled for deletion until
    // its recovery window ends: InvalidRequestException, "marked for deletion".
    const pendingDeletion = errorName === 'InvalidRequestException'
      && secretId.startsWith(SLACK_SECRET_PREFIX)
      && String((err as Error).message).includes('marked for deletion');
    if (errorName === 'ResourceNotFoundException' || pendingDeletion) {
      logger.error('Slack secret not found in Secrets Manager', { secret_id: secretId, pending_deletion: pendingDeletion });
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

export function invalidateSlackSecretCache(secretId: string): void {
  secretCache.delete(secretId);
}

/**
 * Verify a Slack request signature.
 *
 * Slack signs every request with HMAC-SHA256 using the app signing secret.
 * Signature format: `v0={hex}` where the HMAC input is `v0:{timestamp}:{body}`.
 *
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
  if (!isUsableHmacSecret(signingSecret)) {
    return false;
  }
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
 * if the cached copy is rejected.
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

  invalidateSlackSecretCache(secretId);
  const fresh = await getSlackSecret(secretId, true);
  if (!fresh) return false;
  if (fresh === cached) return false;
  return verifySlackSignature(fresh, signature, timestamp, body);
}
