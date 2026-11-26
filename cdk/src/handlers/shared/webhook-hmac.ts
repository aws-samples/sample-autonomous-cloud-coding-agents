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

const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

/**
 * A reader of Secrets Manager secrets with its own in-memory cache. An entry lives five
 * minutes, so a warm Lambda does not read the secret on every delivery.
 *
 * @param texts - the caller's log messages: the value is empty, the secret does not exist, the read failed.
 * @param isAbsent - one more error that counts as "the secret does not exist".
 * @returns `get`, which answers null for a secret that does not exist or whose value is
 *   empty and throws on any other error, and `invalidate`, which drops one cached entry.
 */
export function cachedSecrets(
  texts: { readonly empty: string; readonly notFound: string; readonly fetchFailed: string },
  isAbsent?: (err: Error, secretId: string) => boolean,
) {
  const cache = new Map<string, { secret: string; expiresAt: number }>();

  async function get(secretId: string, forceRefresh = false): Promise<string | null> {
    const now = Date.now();
    if (!forceRefresh) {
      const cached = cache.get(secretId);
      if (cached && cached.expiresAt > now) {
        return cached.secret;
      }
    }

    try {
      const result = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
      // An empty or whitespace-only value must never be used for HMAC: anyone can compute HMAC('', body).
      if (!isUsableHmacSecret(result.SecretString)) {
        logger.error(texts.empty, { secret_id: secretId });
        cache.delete(secretId);
        return null;
      }
      cache.set(secretId, { secret: result.SecretString, expiresAt: now + CACHE_TTL_MS });
      return result.SecretString;
    } catch (err) {
      const pendingDeletion = isAbsent?.(err as Error, secretId);
      if ((err as Error)?.name === 'ResourceNotFoundException' || pendingDeletion) {
        logger.error(texts.notFound, { secret_id: secretId, ...(isAbsent && { pending_deletion: pendingDeletion }) });
        cache.delete(secretId);
        return null; // a missing secret means "cannot verify"; that is expected before setup
      }
      logger.error(texts.fetchFailed, {
        secret_id: secretId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  function invalidate(secretId: string): void {
    cache.delete(secretId);
  }

  return { get, invalidate };
}

/**
 * Compare a signature with the hex HMAC-SHA256 of the signed text, in constant time.
 *
 * @param label - the surface, named in the log line of a comparison that could not be made.
 * @param secret - the signing secret; an empty or whitespace-only one verifies nothing.
 * @param signedText - the text the sender signed.
 * @param provided - the signature to compare.
 * @param prefix - put in front of the expected digest when `provided` carries its scheme prefix.
 * @returns true if the signature matches.
 */
export function hmacSha256Equals(label: string, secret: string, signedText: string, provided: string, prefix = ''): boolean {
  // Checked here as well as on the read: callers also pass secrets from other sources
  // (a per-workspace OAuth bundle).
  if (!isUsableHmacSecret(secret)) {
    return false;
  }
  const expected = prefix + crypto.createHmac('sha256', secret).update(signedText).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch (err) {
    logger.warn(`${label} signature comparison failed`, {
      error: err instanceof Error ? err.message : String(err),
      expected_length: expected.length,
      provided_length: provided.length,
    });
    return false;
  }
}

/**
 * Verify with the cached secret and, on a mismatch, once more with a fresh read. After a
 * rotation a warm Lambda holds the old secret until its cache entry expires; this picks
 * the new one up within one delivery.
 *
 * @param secrets - the caller's secret cache.
 * @param secretId - the Secrets Manager secret ID or ARN.
 * @param check - whether the request verifies against the given secret.
 * @returns true if the request verifies (after at most one fresh read).
 */
export async function verifyWithRefetch(
  secrets: ReturnType<typeof cachedSecrets>,
  secretId: string,
  check: (secret: string) => boolean,
): Promise<boolean> {
  const cached = await secrets.get(secretId);
  if (cached && check(cached)) {
    return true;
  }

  secrets.invalidate(secretId);
  const fresh = await secrets.get(secretId, true);
  if (!fresh) return false;
  if (fresh === cached) return false;
  return check(fresh);
}
