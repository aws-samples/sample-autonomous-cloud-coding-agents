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

import { buildScreenshotKey, isAllowedScreenshotUrl } from '../../../src/handlers/shared/screenshot-url';

describe('buildScreenshotKey', () => {
  test('produces a screenshots/<owner>_<repo>/<sha>-<id>-<suffix>.png shape', () => {
    const key = buildScreenshotKey('owner/repo', 'abc1234', 42);
    expect(key).toMatch(/^screenshots\/owner_repo\/abc1234-42-[0-9a-f]{16}\.png$/);
  });

  test('omits deployment id segment when not provided', () => {
    const key = buildScreenshotKey('owner/repo', 'abc1234');
    // No `-<digit>` between sha and the random suffix.
    expect(key).toMatch(/^screenshots\/owner_repo\/abc1234-[0-9a-f]{16}\.png$/);
    expect(key).not.toMatch(/abc1234-\d+-[0-9a-f]{16}/);
  });

  test('replaces ALL slashes in the repo slug, not just the first', () => {
    // Defensive: GitHub repo names are owner/name (one slash), but
    // `replace('/', '_')` would silently leave a second slash through.
    // (theagenticguy PR-241 review nit.)
    const key = buildScreenshotKey('owner/sub/repo', 'abc1234');
    expect(key.split('/')[0]).toBe('screenshots');
    expect(key.split('/')[1]).toBe('owner_sub_repo');
  });

  test('high-entropy suffix differs across calls (URL is not enumerable)', () => {
    // theagenticguy PR-241 review: keys without a random suffix are
    // guessable from the public PR (org+repo+sha all visible).
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(buildScreenshotKey('owner/repo', 'abc1234'));
    }
    expect(seen.size).toBe(100);
  });

  test('suffix is 16 hex chars (64 bits of entropy)', () => {
    const key = buildScreenshotKey('owner/repo', 'abc1234');
    const suffix = key.match(/-([0-9a-f]+)\.png$/)?.[1];
    expect(suffix).toHaveLength(16);
  });
});

describe('isAllowedScreenshotUrl', () => {
  test.each([
    ['https://preview.vercel.app', true],
    ['https://abc-123.amplifyapp.com', true],
    ['https://deploy-preview-12.netlify.app', true],
    ['https://isadeks.github.io/repo/', true],
    ['https://example.com:8443/path', true],
  ])('accepts public https hostname %s', (url, expected) => {
    expect(isAllowedScreenshotUrl(url)).toBe(expected);
  });

  test.each([
    ['http://example.com', 'http scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['data:text/html,<h1>x</h1>', 'data scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['ftp://ftp.example.com', 'ftp scheme'],
  ])('rejects %s (%s)', (url) => {
    expect(isAllowedScreenshotUrl(url)).toBe(false);
  });

  test('rejects malformed URLs', () => {
    expect(isAllowedScreenshotUrl('not a url')).toBe(false);
    expect(isAllowedScreenshotUrl('')).toBe(false);
  });

  test.each([
    ['https://localhost', 'localhost'],
    ['https://localhost:3000', 'localhost with port'],
    ['https://app.localhost', 'subdomain of localhost'],
  ])('rejects %s (%s)', (url) => {
    expect(isAllowedScreenshotUrl(url)).toBe(false);
  });

  test.each([
    ['https://127.0.0.1', 'IPv4 loopback'],
    ['https://10.0.0.1', 'RFC1918 10/8'],
    ['https://192.168.1.1', 'RFC1918 192.168/16'],
    ['https://172.16.0.1', 'RFC1918 172.16/12'],
    ['https://169.254.169.254', 'IMDS / link-local'],
    ['https://1.2.3.4', 'arbitrary IPv4 literal'],
  ])('rejects literal IPv4 %s (%s)', (url) => {
    expect(isAllowedScreenshotUrl(url)).toBe(false);
  });

  test('rejects IPv6 loopback ::1', () => {
    expect(isAllowedScreenshotUrl('https://[::1]/')).toBe(false);
  });

  test('rejects IPv6 link-local fe80::', () => {
    expect(isAllowedScreenshotUrl('https://[fe80::1]/')).toBe(false);
  });
});
