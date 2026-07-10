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

/**
 * Shared teammate-invite code generation for the Jira and Linear
 * `invite-user` → `link <code>` handshakes. Both integrations mint the
 * same code shape and write a `pending#<code>` row consumed by their
 * respective `link` handlers, so the generator lives here rather than
 * being duplicated per command file.
 *
 * Alphabet excludes ambiguous glyphs (0/O, 1/l/I) so codes copy-pasted
 * across fonts don't get mistyped. Exposed so tests can assert that
 * generated codes only use these characters.
 */
export const INVITE_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Number of alphabet characters drawn per code. */
const INVITE_CODE_LENGTH = 8;

/** Number of distinct values a single random byte can take. */
const BYTE_RANGE = 256;

/**
 * Largest multiple of the alphabet length that fits in a byte (248 for a
 * 31-char alphabet). Bytes at or above this are rejected so the modulo
 * maps uniformly — otherwise indices 0–7 would be favored (9/256 vs
 * 8/256), skewing generated codes toward the front of the alphabet.
 */
const REJECTION_CEILING = Math.floor(BYTE_RANGE / INVITE_CODE_ALPHABET.length) * INVITE_CODE_ALPHABET.length;

/**
 * Generate a short, human-typeable invite code for the teammate-invite
 * flow. `link-` prefix makes it grep-friendly when an operator pastes it
 * into chat alongside the command. 8 random chars from a 31-char alphabet
 * = ~40 bits of entropy — over a 24h TTL window with ~10 codes
 * outstanding, collision probability is negligible.
 *
 * Uses the Web Crypto `crypto.getRandomValues` global (available in
 * Node 18+) so no `require('crypto')` / eslint-disable is needed, with
 * rejection sampling to keep the character distribution unbiased.
 */
export function generateInviteCode(): string {
  let out = 'link-';
  // Draw random bytes in batches, rejecting any that would bias the modulo.
  // A batch of INVITE_CODE_LENGTH bytes usually suffices; the loop tops up
  // if enough bytes land in the rejection tail (rare — ~3% per byte).
  const buf = new Uint8Array(INVITE_CODE_LENGTH);
  while (out.length < 'link-'.length + INVITE_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (out.length >= 'link-'.length + INVITE_CODE_LENGTH) break;
      if (b >= REJECTION_CEILING) continue;
      out += INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length];
    }
  }
  return out;
}
