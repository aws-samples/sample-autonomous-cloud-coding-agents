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
import { getOauthSecretStrict, getRegistryRowStrict } from './jira-oauth-resolver';
import { logger } from './logger';
import { makeClient, makeDocClient } from './ua';

const sm = makeClient(SecretsManagerClient);
const ddb = makeDocClient();

const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

/**
 * Maximum age of a Jira webhook event timestamp (ms) before it is rejected.
 *
 * Atlassian's webhook payloads include a top-level `timestamp` field (UNIX ms,
 * the moment the event was queued for delivery). Atlassian doesn't sign over a
 * timestamp header, so the value is only meaningful as an advisory check after
 * signature verification has already passed.
 */
export const MAX_WEBHOOK_EVENT_AGE_MS = 60 * 60 * 1000;

const CLOCK_SKEW_ALLOWANCE_MINUTES = 5;
export const CLOCK_SKEW_ALLOWANCE_MS = CLOCK_SKEW_ALLOWANCE_MINUTES * 60 * 1000;

/**
 * Fetch a secret from Secrets Manager with in-memory caching.
 */
export async function getJiraSecret(secretId: string, forceRefresh = false): Promise<string | null> {
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
      logger.error('Jira webhook secret is empty — refusing to use for HMAC', {
        secret_id: secretId,
      });
      secretCache.delete(secretId);
      return null;
    }
    secretCache.set(secretId, { secret: result.SecretString, expiresAt: now + CACHE_TTL_MS });
    return result.SecretString;
  } catch (err) {
    const errorName = (err as Error)?.name;
    if (errorName === 'ResourceNotFoundException') {
      logger.error('Jira secret not found in Secrets Manager', { secret_id: secretId });
      secretCache.delete(secretId);
      return null;
    }
    logger.error('Failed to fetch Jira secret from Secrets Manager', {
      secret_id: secretId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function invalidateJiraSecretCache(secretId: string): void {
  secretCache.delete(secretId);
}

/**
 * Verify a Jira generic-webhook signature.
 *
 * Atlassian's "Generic webhooks" (configured per-instance in the Jira admin UI)
 * sign each delivery with HMAC-SHA256 over the raw request body using the
 * instance-configured secret. The signature is delivered as
 * `X-Hub-Signature: sha256=<hex>`. A bare hex digest without the `sha256=`
 * prefix is accepted too.
 */
export function verifyJiraSignature(
  webhookSecret: string,
  signature: string,
  body: string,
): boolean {
  if (!isUsableHmacSecret(webhookSecret)) {
    return false;
  }
  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch (err) {
    logger.warn('Jira signature comparison failed', {
      error: err instanceof Error ? err.message : String(err),
      expected_length: expected.length,
      provided_length: provided.length,
    });
    return false;
  }
}

/**
 * Check that a Jira webhook event timestamp is within the acceptable window:
 * no older than {@link MAX_WEBHOOK_EVENT_AGE_MS} and no further in the future
 * than {@link CLOCK_SKEW_ALLOWANCE_MS}.
 */
export function isWebhookTimestampFresh(timestamp: number | undefined): boolean {
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) {
    return false;
  }
  const age = Date.now() - timestamp;
  return age <= MAX_WEBHOOK_EVENT_AGE_MS && age >= -CLOCK_SKEW_ALLOWANCE_MS;
}

/**
 * Verify a Jira webhook request, transparently re-fetching the signing
 * secret once if the cached copy is rejected.
 */
export async function verifyJiraRequest(
  secretId: string,
  signature: string,
  body: string,
): Promise<boolean> {
  const cached = await getJiraSecret(secretId);
  if (cached && verifyJiraSignature(cached, signature, body)) {
    return true;
  }

  invalidateJiraSecretCache(secretId);
  const fresh = await getJiraSecret(secretId, true);
  if (!fresh) return false;
  if (fresh === cached) return false;
  return verifyJiraSignature(fresh, signature, body);
}

/**
 * Verify a Jira webhook against the per-tenant signing secret stored
 * alongside the tenant's OAuth bundle.
 *
 * - `'verified'` — signature matches the per-tenant secret.
 * - `'mismatch'` — registry row + secret found, signature wrong. Reject;
 *   do NOT fall back to stack-wide.
 * - `'revoked'` — registry row exists but status is not `active`.
 *   Reject; do NOT fall back.
 * - `'no-per-tenant-secret'` — no registry row, OR the stored secret
 *   has no `webhook_signing_secret`. Caller should use the stack-wide
 *   verifier. This is also the normal path for admin-console payloads, which
 *   omit cloudId before tenant selection is possible.
 *
 * Throws on a DDB or SM error (strict lookups).
 */
export async function verifyJiraRequestForTenant(
  registryTableName: string,
  cloudId: string,
  signature: string,
  body: string,
): Promise<'verified' | 'mismatch' | 'revoked' | 'no-per-tenant-secret'> {
  const row = await getRegistryRowStrict(ddb, registryTableName, cloudId);
  if (!row) {
    return 'no-per-tenant-secret';
  }
  if (row.status !== 'active') {
    return 'revoked';
  }
  const stored = await getOauthSecretStrict(sm, row.oauth_secret_arn);
  if (!stored || !stored.webhook_signing_secret) {
    return 'no-per-tenant-secret';
  }
  return verifyJiraSignature(stored.webhook_signing_secret, signature, body)
    ? 'verified'
    : 'mismatch';
}
