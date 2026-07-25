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

import { classifyAuthState, isExpired } from '../src/linear-auth-health';

const NOW = new Date('2026-07-25T13:00:00.000Z');
const FUTURE = '2026-07-25T14:00:00.000Z';
const PAST = '2026-07-25T12:00:00.000Z';

describe('isExpired', () => {
  test('a future expiry is not expired', () => {
    expect(isExpired(FUTURE, NOW)).toBe(false);
  });

  test('a past expiry is expired', () => {
    expect(isExpired(PAST, NOW)).toBe(true);
  });

  test('absent or unparseable expiry counts as expired', () => {
    // Matches the platform resolver: prefer an unnecessary refresh over
    // assuming a token nobody can date is still good.
    expect(isExpired(undefined, NOW)).toBe(true);
    expect(isExpired('not-a-date', NOW)).toBe(true);
  });
});

describe('classifyAuthState — expired vs revoked is the point of this check', () => {
  test('an accepted token is active', () => {
    expect(classifyAuthState('accepted', { hasRefreshToken: true, expiresAt: FUTURE }, NOW)).toBe('active');
  });

  test('rejected + already expired + a refresh token = probably-refreshing, not asserted an outage', () => {
    // The common idle-workspace case: nothing has driven a refresh, so the
    // access token aged out. The next event refreshes it. Reporting this as a
    // failure would cry wolf on every quiet workspace.
    expect(classifyAuthState('rejected', { hasRefreshToken: true, expiresAt: PAST }, NOW))
      .toBe('expired_untested');
  });

  test('rejected while NOT expired = the authorization itself is gone', () => {
    // A token that the surface refuses even though it should still be valid
    // means the grant was revoked upstream — every event is being dropped.
    expect(classifyAuthState('rejected', { hasRefreshToken: true, expiresAt: FUTURE }, NOW))
      .toBe('revoked');
  });

  test('rejected with NO refresh token = revoked, since nothing can recover it', () => {
    // Even if it merely expired, without a refresh token there is no path back
    // without a human, so it must not be reported as self-healing.
    expect(classifyAuthState('rejected', { hasRefreshToken: false, expiresAt: PAST }, NOW))
      .toBe('revoked');
  });

  test('a probe that could not complete is unknown, never a verdict', () => {
    // A network blip must not be reported as a revoked authorization — that
    // would send an operator to re-authorize a healthy workspace.
    expect(classifyAuthState('error', { hasRefreshToken: true, expiresAt: FUTURE }, NOW)).toBe('unknown');
    expect(classifyAuthState('error', { hasRefreshToken: false, expiresAt: PAST }, NOW)).toBe('unknown');
  });

  test('the live 2026-07-25 incident classifies as revoked', () => {
    // Real shape from the maguireb workspace: refresh token present and only
    // ~25h old, access token expired 48 minutes earlier, and the surface
    // rejected BOTH. Expiry alone would have said "refreshable" — what makes it
    // revoked is that the refresh was rejected too, which the caller models by
    // probing after a failed refresh. Here we pin the no-refresh-token variant,
    // the state the resolver lands in once it has given up on the chain.
    expect(classifyAuthState('rejected', { hasRefreshToken: false, expiresAt: '2026-07-25T12:12:48.012Z' }, NOW))
      .toBe('revoked');
  });
});
