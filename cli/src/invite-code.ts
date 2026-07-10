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

/** Number of random bytes drawn per code (one alphabet char each). */
const INVITE_CODE_RANDOM_BYTES = 8;

/**
 * Generate a short, human-typeable invite code for the teammate-invite
 * flow. `link-` prefix makes it grep-friendly when an operator pastes it
 * into chat alongside the command. 8 random chars from a 31-char alphabet
 * = ~40 bits of entropy — over a 24h TTL window with ~10 codes
 * outstanding, collision probability is negligible.
 *
 * Uses the Web Crypto `crypto.getRandomValues` global (available in
 * Node 18+) so no `require('crypto')` / eslint-disable is needed.
 */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  let out = 'link-';
  for (const b of bytes) {
    out += INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length];
  }
  return out;
}
