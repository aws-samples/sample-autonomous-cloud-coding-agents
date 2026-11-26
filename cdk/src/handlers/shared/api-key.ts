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
import { API_KEY_SCOPES, type ApiKeyScope } from './types';

export const API_KEY_PREFIX = 'bgak';

const API_KEY_SECRET_BYTES = 32;

const KEY_PART_COUNT = 3;

/**
 * A minted key and the fields persisted for it. The `plaintext` is returned to
 * the caller exactly once; only `keyHash` is stored.
 */
export interface GeneratedApiKey {
  readonly keyId: string;
  readonly plaintext: string;
  readonly keyHash: string;
}

/** SHA-256 hex digest of the secret portion of a key. */
export function hashApiKeySecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Mint a new key for a given key_id. The wire format is
 * `bgak_<key_id>_<secret>`.
 * @param keyId - the ULID partition key for the record.
 * @returns the plaintext (return-once) and the hash to persist.
 */
export function generateApiKey(keyId: string): GeneratedApiKey {
  const secret = crypto.randomBytes(API_KEY_SECRET_BYTES).toString('hex');
  return {
    keyId,
    plaintext: `${API_KEY_PREFIX}_${keyId}_${secret}`,
    keyHash: hashApiKeySecret(secret),
  };
}

export interface ParsedApiKey {
  readonly keyId: string;
  readonly secret: string;
}

/**
 * Parse a presented `bgak_<key_id>_<secret>` value into its parts. Returns null
 * for any value that is not well-formed.
 * @param presented - the raw `X-API-Key` header value.
 * @returns the parsed key_id and secret, or null if malformed.
 */
export function parseApiKey(presented: string): ParsedApiKey | null {
  const parts = presented.split('_');
  if (parts.length !== KEY_PART_COUNT) return null;
  const [prefix, keyId, secret] = parts;
  if (prefix !== API_KEY_PREFIX) return null;
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

/**
 * Constant-time comparison of two hex-encoded hashes of equal length.
 * @param a - first hex digest.
 * @param b - second hex digest.
 * @returns true if the digests are byte-for-byte equal.
 */
export function timingSafeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Validate a requested scope list against the known vocabulary.
 * @param scopes - the raw scopes from a create request.
 * @returns the validated scopes, or null if any value is unrecognized.
 */
export function validateScopes(scopes: readonly string[]): ApiKeyScope[] | null {
  const known = new Set<string>(API_KEY_SCOPES);
  const out: ApiKeyScope[] = [];
  for (const s of scopes) {
    if (!known.has(s)) return null;
    out.push(s as ApiKeyScope);
  }
  return out;
}
