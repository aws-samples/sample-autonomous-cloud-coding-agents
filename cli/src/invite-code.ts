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

/** Alphabet of invite codes; excludes ambiguous glyphs (0/O, 1/l/I). */
export const INVITE_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const INVITE_CODE_LENGTH = 8;

const BYTE_RANGE = 256;

const REJECTION_CEILING = Math.floor(BYTE_RANGE / INVITE_CODE_ALPHABET.length) * INVITE_CODE_ALPHABET.length;

/**
 * Generate an invite code for the teammate-invite flow: the `link-` prefix
 * and 8 random chars from a 31-char alphabet (~40 bits of entropy).
 */
export function generateInviteCode(): string {
  let out = 'link-';
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
