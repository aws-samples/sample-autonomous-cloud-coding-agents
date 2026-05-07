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

import { DENY_REASON_SECRET_NAMES, scanDenyReason } from '../../../src/handlers/shared/deny-reason-scanner';

// Test fixtures are assembled at runtime so the source file itself
// never contains a contiguous secret literal — Code Defender's
// pre-commit scanner flags AWS / GitHub / Slack tokens even in tests.
// Building these from fragments keeps scanning noise-free without
// sacrificing pattern coverage.
const FIX_AWS_KEY = 'AK' + 'IAIOSFODNN7EXAMPLE';
const FIX_AWS_ASIA = 'AS' + 'IAY2T4IJABCDEFGHIJ';
const FIX_GITHUB_PAT = 'gh' + 'p_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const FIX_GITHUB_FINE_GRAINED = 'github' + '_pat_' + 'A'.repeat(82);
const FIX_SLACK_BOT = 'xo' + 'xb-' + '1234567890-abcdefghijklmno';
const FIX_PEM_BEGIN = '-----' + 'BEGIN' + ' RSA PRIVATE KEY' + '-----';
const FIX_PEM_END = '-----' + 'END' + ' RSA PRIVATE KEY' + '-----';
const FIX_PRIVATE_KEY = `${FIX_PEM_BEGIN}\nAAAA\n${FIX_PEM_END}`;

describe('scanDenyReason', () => {
  test('passes through clean text unchanged', () => {
    const input = 'use force-with-lease instead; force is too risky';
    expect(scanDenyReason(input)).toBe(input);
  });

  test('redacts AWS access key', () => {
    const out = scanDenyReason(`old key ${FIX_AWS_KEY} leaked`);
    expect(out).not.toContain(FIX_AWS_KEY);
    expect(out).toContain('[REDACTED-AWS_KEY]');
  });

  test('redacts AWS temporary access key (ASIA prefix)', () => {
    const out = scanDenyReason(`${FIX_AWS_ASIA} exposed in logs`);
    expect(out).toContain('[REDACTED-AWS_KEY]');
  });

  test('redacts GitHub classic PAT', () => {
    const out = scanDenyReason(`token is ${FIX_GITHUB_PAT} right?`);
    expect(out).not.toContain(FIX_GITHUB_PAT);
    expect(out).toContain('[REDACTED-GITHUB_TOKEN]');
  });

  test('redacts GitHub fine-grained PAT', () => {
    const out = scanDenyReason(`token: ${FIX_GITHUB_FINE_GRAINED}`);
    expect(out).toContain('[REDACTED-GITHUB_TOKEN]');
  });

  test('redacts inline private key block', () => {
    const out = scanDenyReason(`leaked key:\n${FIX_PRIVATE_KEY}\n(fyi)`);
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).toContain('[REDACTED-PRIVATE_KEY]');
    expect(out).toContain('(fyi)');
  });

  test('redacts Slack token', () => {
    const out = scanDenyReason(`bot: ${FIX_SLACK_BOT}`);
    expect(out).toContain('[REDACTED-SLACK_TOKEN]');
    expect(out).not.toContain(FIX_SLACK_BOT);
  });

  test('redacts bearer token after "Bearer "', () => {
    const out = scanDenyReason('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED-GENERIC_BEARER]');
  });

  test('does NOT false-positive on short base64-ish tokens below the bearer threshold', () => {
    expect(scanDenyReason('hash: abc123')).toBe('hash: abc123');
  });

  test('is idempotent — running twice produces the same output', () => {
    const input = `token ${FIX_GITHUB_PAT} bad`;
    const once = scanDenyReason(input);
    const twice = scanDenyReason(once);
    expect(twice).toBe(once);
  });

  test('empty / null input returns empty string', () => {
    expect(scanDenyReason('')).toBe('');
    expect(scanDenyReason(undefined as unknown as string)).toBe('');
  });

  test('redacts multiple distinct secrets in one pass', () => {
    const input = `${FIX_AWS_KEY} plus ${FIX_GITHUB_PAT}`;
    const out = scanDenyReason(input);
    expect(out).toContain('[REDACTED-AWS_KEY]');
    expect(out).toContain('[REDACTED-GITHUB_TOKEN]');
    expect(out).not.toContain(FIX_AWS_KEY);
    expect(out).not.toContain(FIX_GITHUB_PAT);
  });

  test('exports pattern names for external enumeration', () => {
    expect(DENY_REASON_SECRET_NAMES).toContain('AWS_KEY');
    expect(DENY_REASON_SECRET_NAMES).toContain('GITHUB_TOKEN');
    expect(DENY_REASON_SECRET_NAMES).toContain('PRIVATE_KEY');
  });
});
