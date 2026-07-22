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

import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  timingSafeHashEqual,
  validateScopes,
} from '../../../src/handlers/shared/api-key';

describe('generateApiKey', () => {
  test('produces a bgak_<key_id>_<secret> plaintext and a matching hash', () => {
    const gen = generateApiKey('KEYID1');
    expect(gen.plaintext.startsWith(`${API_KEY_PREFIX}_KEYID1_`)).toBe(true);
    const parsed = parseApiKey(gen.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe('KEYID1');
    expect(hashApiKeySecret(parsed!.secret)).toBe(gen.keyHash);
  });

  test('mints a distinct secret each time', () => {
    const a = generateApiKey('K');
    const b = generateApiKey('K');
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  test('the secret is 32 bytes of hex (64 chars)', () => {
    const gen = generateApiKey('K');
    expect(parseApiKey(gen.plaintext)!.secret).toHaveLength(64);
  });
});

describe('parseApiKey', () => {
  test('parses a well-formed key', () => {
    expect(parseApiKey('bgak_abc_def')).toEqual({ keyId: 'abc', secret: 'def' });
  });

  test.each([
    ['wrong prefix', 'xxxx_abc_def'],
    ['too few parts', 'bgak_abc'],
    ['too many parts', 'bgak_abc_def_ghi'],
    ['empty key_id', 'bgak__def'],
    ['empty secret', 'bgak_abc_'],
    ['empty string', ''],
  ])('returns null for %s', (_label, input) => {
    expect(parseApiKey(input)).toBeNull();
  });
});

describe('timingSafeHashEqual', () => {
  test('true for identical digests', () => {
    const h = hashApiKeySecret('x');
    expect(timingSafeHashEqual(h, h)).toBe(true);
  });

  test('false for different digests', () => {
    expect(timingSafeHashEqual(hashApiKeySecret('a'), hashApiKeySecret('b'))).toBe(false);
  });

  test('false (no throw) for length mismatch', () => {
    expect(timingSafeHashEqual('abc', 'abcd')).toBe(false);
  });
});

describe('validateScopes', () => {
  test('accepts all known scopes', () => {
    expect(validateScopes(['webhooks:manage', 'tasks:read'])).toEqual(['webhooks:manage', 'tasks:read']);
  });

  test('returns null when any scope is unknown', () => {
    expect(validateScopes(['webhooks:manage', 'nope'])).toBeNull();
  });

  test('accepts an empty list (caller decides emptiness policy)', () => {
    expect(validateScopes([])).toEqual([]);
  });
});
