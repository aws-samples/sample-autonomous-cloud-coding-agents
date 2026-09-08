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
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isUsableHmacSecret } from './hmac-secret';
import { getOauthSecretStrict, getRegistryRowStrict } from './linear-oauth-resolver';
import { logger } from './logger';
import { makeClient, makeDocClient } from './ua';

const sm = makeClient(SecretsManagerClient);
const ddb = makeDocClient();

// In-memory secret cache with 5-minute TTL (same pattern as slack-verify.ts).
const secretCache = new Map<string, { secret: string; expiresAt: number }>();
const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

/** Maximum age of a Linear webhookTimestamp (ms) before it is rejected (replay protection). */
export const MAX_WEBHOOK_TIMESTAMP_AGE_MS = 60 * 1000;

/**
 * Cached count of active workspaces, capped at 2.
 *
 * Capped because nothing needs the true total — every decision that reads it only asks
 * "is there more than one tenant on this stack", so the Scan can stop at the second hit.
 *
 * Cached separately from `secretCache` because it is not keyed by anything: it is one
 * table-wide fact, re-derived by a Scan that would otherwise run on every delivery.
 * A short TTL is the tradeoff — onboarding a second workspace takes up to this long to
 * start being enforced, which is acceptable because the CLI refuses to create the
 * shared-secret state in the first place.
 */
let activeWorkspaceCountCache: { count: number; expiresAt: number } | undefined;

/**
 * How many active Linear workspaces this stack has, saturating at 2.
 *
 * The distinction that matters is one tenant versus more than one. With a single
 * workspace a secret that is not bound to a tenant still identifies the only tenant
 * there is, so neither the stack-wide fallback nor a shared secret can cross a
 * boundary. With two or more, both can.
 *
 * Returns 1 when the registry cannot be read, and says so in the log. That is the
 * permissive answer, chosen deliberately: a DynamoDB throttle must not start rejecting
 * every delivery on a healthy single-workspace install. The callers that act on this
 * are hardening an already-verified signature, not standing in for one.
 */
export async function countActiveLinearWorkspaces(registryTableName: string | undefined): Promise<number> {
  if (!registryTableName) return 1;
  const now = Date.now();
  if (activeWorkspaceCountCache && activeWorkspaceCountCache.expiresAt > now) {
    return activeWorkspaceCountCache.count;
  }

  try {
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: registryTableName,
        ProjectionExpression: 'linear_workspace_id, #s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExclusiveStartKey: lastKey,
      }));
      for (const item of page.Items ?? []) {
        if (item.status === 'active') count += 1;
      }
      lastKey = page.LastEvaluatedKey;
      if (count > 1) break;
    } while (lastKey);

    activeWorkspaceCountCache = { count, expiresAt: now + CACHE_TTL_MS };
    return count;
  } catch (err) {
    logger.warn('Could not count active Linear workspaces — assuming a single-workspace stack', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }
}

/** Drop the cached workspace count. Exported for tests. */
export function _resetActiveWorkspaceCountCache(): void {
  activeWorkspaceCountCache = undefined;
}

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
    // Treat empty / whitespace-only SecretString as null — an empty secret
    // must never be used for HMAC, or HMAC('', body) becomes forgeable.
    if (!isUsableHmacSecret(result.SecretString)) {
      logger.error('Linear webhook secret is empty — refusing to use for HMAC', {
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
      logger.error('Linear secret not found in Secrets Manager', { secret_id: secretId });
      secretCache.delete(secretId);
      return null; // nosemgrep: ts-silent-success-masking -- missing Linear signing secret means "cannot verify"; ResourceNotFound is expected before setup
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
  // Defense-in-depth: getLinearSecret already filters empty secrets, but
  // callers like verifyLinearRequestForWorkspace pass secrets from other
  // sources (per-workspace OAuth bundles) — HMAC('') must always be
  // rejected or an attacker can forge signatures against a misconfigured
  // empty secret.
  if (!isUsableHmacSecret(webhookSecret)) {
    return false;
  }
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

/**
 * Verify a Linear webhook request against the **per-workspace** signing
 * secret stored alongside the workspace's OAuth token bundle.
 *
 * Linear generates a fresh signing secret per webhook subscription, and
 * webhook subscriptions are workspace-scoped — so a stack-wide signing
 * secret cannot verify events from multiple workspaces. This path:
 *
 *   1. Looks up the registry row keyed on `linear_workspace_id` (the
 *      orgId from the webhook payload — claimed, not yet trusted).
 *   2. Reads the per-workspace OAuth secret to extract
 *      `webhook_signing_secret`.
 *   3. Verifies the HMAC signature against that secret.
 *
 * The orgId is untrusted input from the webhook body; an attacker can
 * claim any orgId. But it only **selects which secret to verify
 * against** — they still need the correct signing secret to forge a
 * valid signature, which they don't have. The trust model is
 * preserved.
 *
 * Returns:
 * - `'verified'` — signature matches the per-workspace secret. Caller
 *   trusts the body.
 * - `'mismatch'` — registry row + secret were found, but the signature
 *   doesn't match. Caller MUST reject (do not fall back to stack-wide;
 *   that would let an attacker bypass the per-workspace secret by
 *   tricking us into re-checking against the stack-wide one).
 * - `'revoked'` — registry row exists but its status is not `active`.
 *   Treated like `mismatch` by the receiver: 401, no fallback. Without
 *   this distinct outcome a revoked workspace would collapse to
 *   `no-per-workspace-secret` and the stack-wide fallback would
 *   re-grant access (since `setup` mirrors the first workspace's
 *   secret into the stack-wide one and revocation never clears it).
 * - `'no-per-workspace-secret'` — no registry row at all, secret JSON
 *   has no `webhook_signing_secret` field. Caller should fall back to
 *   the stack-wide secret for back-compat with single-workspace
 *   installs predating per-workspace secrets.
 *
 * Uses strict lookups (`getRegistryRowStrict`, `getOauthSecretStrict`)
 * that throw on infra error rather than returning null. A DDB throttle
 * during a webhook burst must NOT silently downgrade a per-workspace-
 * secured workspace to stack-wide verification — let the error bubble,
 * the receiver's outer try/catch returns 500, and Linear retries.
 *
 * @param registryTableName - DynamoDB table for `LinearWorkspaceRegistryTable`.
 * @param linearWorkspaceId - the claimed `organizationId` from the body.
 * @param signature - the `Linear-Signature` header value.
 * @param body - the raw request body string.
 */
export async function verifyLinearRequestForWorkspace(
  registryTableName: string,
  linearWorkspaceId: string,
  signature: string,
  body: string,
): Promise<'verified' | 'mismatch' | 'revoked' | 'no-per-workspace-secret' | 'shared-secret'> {
  const row = await getRegistryRowStrict(ddb, registryTableName, linearWorkspaceId);
  if (!row) {
    return 'no-per-workspace-secret';
  }
  if (row.status !== 'active') {
    return 'revoked';
  }
  const stored = await getOauthSecretStrict(sm, row.oauth_secret_arn);
  if (!stored || !stored.webhook_signing_secret) {
    return 'no-per-workspace-secret';
  }
  if (!verifyLinearSignature(stored.webhook_signing_secret, signature, body)) {
    return 'mismatch';
  }

  // The signature matched — but matching a secret this workspace does not exclusively
  // hold proves only that the sender knows a secret SOME workspace on this stack holds.
  // A workspace onboarded by an older release can be carrying a copy of the first
  // workspace's secret, and the routing values in the body are read from whichever
  // workspace the sender names. Checked only when another tenant exists to impersonate,
  // so a single-workspace install — where the same secret cannot cross a boundary and
  // where an unrecorded provenance is the normal state — is untouched.
  if (row.webhook_secret_owned !== true && await countActiveLinearWorkspaces(registryTableName) > 1) {
    return 'shared-secret';
  }
  return 'verified';
}
