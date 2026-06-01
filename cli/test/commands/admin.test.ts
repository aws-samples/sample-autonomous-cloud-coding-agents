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

import { decodeBundle, encodeBundle, generateTempPassword } from '../../src/commands/admin';
import { CliError } from '../../src/errors';
import { CliConfig } from '../../src/types';

describe('admin bundle helpers', () => {
  const sampleConfig: CliConfig = {
    api_url: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
    region: 'us-east-1',
    user_pool_id: 'us-east-1_AbCdEfGhI',
    client_id: '1a2b3c4d5e6f7g8h9i0j1k2l3m',
  };

  test('encode → decode round-trips a config', () => {
    const bundle = encodeBundle(sampleConfig);
    const decoded = decodeBundle(bundle);
    expect(decoded).toEqual(sampleConfig);
  });

  test('encoded bundle is plain base64 (no whitespace, no padding mangling)', () => {
    const bundle = encodeBundle(sampleConfig);
    expect(bundle).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test('decode trims surrounding whitespace from a pasted bundle', () => {
    const bundle = encodeBundle(sampleConfig);
    expect(decodeBundle(`  ${bundle}  \n`)).toEqual(sampleConfig);
  });

  test('decode rejects non-base64 input', () => {
    expect(() => decodeBundle('not base64 !!!')).toThrow(CliError);
  });

  test('decode rejects base64 that does not contain JSON', () => {
    const bogus = Buffer.from('not json at all', 'utf-8').toString('base64');
    expect(() => decodeBundle(bogus)).toThrow(/not JSON/);
  });

  test('decode rejects bundle missing required fields', () => {
    const partial = Buffer.from(JSON.stringify({ api_url: 'x', region: 'y' })).toString('base64');
    expect(() => decodeBundle(partial)).toThrow(/missing or empty fields user_pool_id, client_id/);
  });

  test('decode rejects bundle with empty-string fields', () => {
    const empty = Buffer.from(JSON.stringify({
      api_url: '',
      region: 'us-east-1',
      user_pool_id: 'pool',
      client_id: 'client',
    })).toString('base64');
    expect(() => decodeBundle(empty)).toThrow(/missing or empty fields api_url/);
  });
});

describe('generateTempPassword', () => {
  // Cognito's default policy: min 12 chars, with at least one upper, lower,
  // digit, and symbol. The CLI relies on satisfying this by construction —
  // these tests guard against a regression that would silently produce
  // passwords Cognito rejects with "InvalidPasswordException" only at
  // `admin-create-user` time.
  const upper = /[A-Z]/;
  const lower = /[a-z]/;
  const digit = /[0-9]/;
  const symbol = /[!@#$%^&*()\-_=+\[\]{}<>?]/;

  test('produces a password ≥ 18 chars', () => {
    const pwd = generateTempPassword();
    expect(pwd.length).toBeGreaterThanOrEqual(18);
  });

  test('contains at least one upper, lower, digit, and symbol', () => {
    // Sample many passwords — the random shuffle should never strip a class.
    for (let i = 0; i < 50; i += 1) {
      const pwd = generateTempPassword();
      expect(pwd).toMatch(upper);
      expect(pwd).toMatch(lower);
      expect(pwd).toMatch(digit);
      expect(pwd).toMatch(symbol);
    }
  });

  test('produces distinct passwords on repeated calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seen.add(generateTempPassword());
    }
    // Allow at most one collision in 20 draws (effectively 0 with crypto rand).
    expect(seen.size).toBeGreaterThanOrEqual(19);
  });
});
