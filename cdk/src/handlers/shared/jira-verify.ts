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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isUsableHmacSecret } from './hmac-secret';
import { getOauthSecretStrict, getRegistryRowStrict } from './jira-oauth-resolver';
import { logger } from './logger';

const sm = new SecretsManagerClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Prefix for Jira-related secrets in Secrets Manager. */
export const JIRA_SECRET_PREFIX = 'bgagent/jira/';

const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

/**
 * Maximum age of a Jira webhook event timestamp (ms) before it is rejected.
 *
 * Atlassian's webhook payloads include a top-level `timestamp` field (UNIX ms,
 * the moment the event was queued for delivery). Unlike Linear, Atlassian
 * doesn't sign over a timestamp header, so the value is only meaningful as an
 * advisory check after signature verification has already passed. We still
 * enforce it to bound replay windows for delivery jobs that get stuck and
 * surface much later — the dedup table handles the more likely retry case.
 *
 * 1h comfortably covers Atlassian's actual delivery-retry behavior while
 * keeping the replay window tight.
 */
export const MAX_WEBHOOK_EVENT_AGE_MS = 60 * 60 * 1000;

/**
 * Tolerance for a webhook timestamp that sits slightly in the future
 * relative to this Lambda's clock (sender/receiver skew). Beyond this, a
 * future-dated timestamp is rejected rather than accepted.
 */
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
    // Treat empty / whitespace-only SecretString as null — an empty secret
    // must never be used for HMAC, or HMAC('', body) becomes forgeable.
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
      return null; // nosemgrep: ts-silent-success-masking -- missing Jira signing secret means "cannot verify"; ResourceNotFound is expected before setup
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
 * `X-Hub-Signature: sha256=<hex>` — the `sha256=` prefix is part of the header
 * value and must be stripped before timing-safe comparison.
 */
export function verifyJiraSignature(
  webhookSecret: string,
  signature: string,
  body: string,
): boolean {
  // Defense-in-depth: getJiraSecret already filters empty secrets, but
  // callers like verifyJiraRequestForTenant pass secrets from other sources
  // (per-tenant OAuth bundles where the operator pastes the signing secret
  // by hand) — HMAC('') must always be rejected or an attacker can forge
  // signatures against a misconfigured empty/whitespace secret.
  if (!isUsableHmacSecret(webhookSecret)) {
    return false;
  }
  // Strip the algorithm prefix Atlassian (and most webhook providers using
  // X-Hub-Signature) prepend. Be tolerant of operators who paste just the
  // hex digest.
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
 * Check that a Jira webhook event timestamp is within the acceptable window.
 * Optional — the receiver only enforces this after signature verification
 * succeeds, as a guard against very old replays.
 */
export function isWebhookTimestampFresh(timestamp: number | undefined): boolean {
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) {
    return false;
  }
  // One-sided check: reject events older than the window. A small allowance
  // for clock skew lets a slightly-future timestamp through, but a far-future
  // value (crafted or badly skewed) is rejected rather than silently accepted
  // — `Math.abs` would have let any future timestamp pass.
  const age = Date.now() - timestamp;
  return age <= MAX_WEBHOOK_EVENT_AGE_MS && age >= -CLOCK_SKEW_ALLOWANCE_MS;
}

/**
 * Verify a Jira webhook request, transparently re-fetching the signing
 * secret once if the cached copy is rejected. Mirrors the Linear helper so
 * a rotated secret picks up within one webhook delivery rather than 5 min
 * of cache TTL.
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
 * alongside the tenant's OAuth bundle. The trust model and outcome
 * semantics mirror the Linear per-workspace flow:
 *
 * - `'verified'` — signature matches the per-tenant secret.
 * - `'mismatch'` — registry row + secret found, signature wrong. Reject;
 *   do NOT fall back to stack-wide.
 * - `'revoked'` — registry row exists but status is not `active`.
 *   Reject; do NOT fall back.
 * - `'no-per-tenant-secret'` — no registry row, OR the stored secret
 *   has no `webhook_signing_secret`. Caller should fall back to the
 *   stack-wide secret for back-compat with single-tenant installs.
 *
 * Strict lookups (throw on infra errors) are used so a transient DDB or
 * SM error doesn't silently downgrade a per-tenant-secured tenant to
 * stack-wide verification.
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
