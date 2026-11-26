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

import { generateInviteCode, INVITE_CODE_ALPHABET } from '../src/invite-code';

describe('generateInviteCode', () => {
  test('emits "link-" prefix followed by exactly 8 alphabet characters', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^link-[a-z0-9]{8}$/);
    expect(code).toHaveLength(13);
  });

  test('only uses characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const chars = generateInviteCode().slice('link-'.length);
      for (const c of chars) {
        expect(INVITE_CODE_ALPHABET).toContain(c);
      }
    }
  });

  test('rejects biased bytes (>=248) and tops up from the next batch', () => {
    const spy = jest.spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementationOnce((arr) => {
        (arr as Uint8Array).fill(255);
        return arr;
      })
      .mockImplementation((arr) => {
        (arr as Uint8Array).fill(0);
        return arr;
      });
    try {
      const code = generateInviteCode();
      expect(code).toBe(`link-${INVITE_CODE_ALPHABET[0].repeat(8)}`);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('distribution is not skewed toward the front of the alphabet', () => {
    const counts = new Array(INVITE_CODE_ALPHABET.length).fill(0);
    const SAMPLES = 5000;
    for (let i = 0; i < SAMPLES; i++) {
      for (const c of generateInviteCode().slice('link-'.length)) {
        counts[INVITE_CODE_ALPHABET.indexOf(c)]++;
      }
    }
    const total = SAMPLES * 8;
    const expectedPerChar = total / INVITE_CODE_ALPHABET.length;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expectedPerChar * 0.75);
      expect(count).toBeLessThan(expectedPerChar * 1.25);
    }
  });
});
