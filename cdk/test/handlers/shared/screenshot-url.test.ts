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

import { buildScreenshotKey, encodeMarkdownUrl, isAllowedScreenshotUrl } from '../../../src/handlers/shared/screenshot-url';

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

  test.each([
    ['https://[::1]/', 'IPv6 loopback ::1'],
    ['https://[fe80::1]/', 'IPv6 link-local fe80::/10'],
    ['https://[fc00::1]/', 'IPv6 unique-local fc00::/7'],
    ['https://[fd12:3456:789a::1]/', 'IPv6 unique-local fd00::/8'],
    ['https://[64:ff9b::1.2.3.4]/', 'NAT64 well-known prefix'],
    ['https://[::ffff:10.0.0.1]/', 'IPv4-mapped IPv6'],
    ['https://[2001:db8::1]:8443/path', 'global IPv6 with port + path'],
  ])('rejects every IPv6 literal %s (%s)', (url) => {
    // krokoko PR-241 round-3 finding 2: enumerating ranges missed
    // fc00::/7 and NAT64. Preview URLs are always DNS names, so any
    // IPv6 literal is rejected wholesale.
    expect(isAllowedScreenshotUrl(url)).toBe(false);
  });

  test.each([
    ['https://2130706433', 'decimal integer form of 127.0.0.1'],
    ['https://0x7f000001', 'hex integer form of 127.0.0.1'],
  ])('rejects integer-encoded IPv4 %s (%s) — WHATWG normalizes to dotted-quad', (url) => {
    expect(isAllowedScreenshotUrl(url)).toBe(false);
  });
});

describe('encodeMarkdownUrl', () => {
  test('percent-encodes parens so a crafted path cannot break out of a markdown link', () => {
    // krokoko PR-241 round-3 finding 1: the WHATWG URL parser keeps `)`
    // in the path, so a clean-hostname URL can still close the `](…)`
    // early and inject content into a comment posted under ABCA's token.
    const attack = 'https://preview.vercel.app/x)](https://evil/a.png)';
    const encoded = encodeMarkdownUrl(attack);
    expect(encoded).not.toContain('(');
    expect(encoded).not.toContain(')');
    // No `](` delimiter survives → cannot break out of `[text](url)`.
    expect(encoded).not.toContain('](');
    // Interpolated into the link, the body stays a single link.
    const body = `[![preview](https://cdn/x.png)](${encoded})`;
    expect(body.match(/\]\(/g)).toHaveLength(2); // image + link, nothing extra
  });

  test('leaves a normal preview URL functionally unchanged (browser decodes %28/%29)', () => {
    const url = 'https://deploy-preview-12.netlify.app/path?x=1';
    expect(encodeMarkdownUrl(url)).toBe(url);
  });

  test('encodes every paren, not just the first', () => {
    expect(encodeMarkdownUrl('https://h/a(b)c(d)')).toBe('https://h/a%28b%29c%28d%29');
  });
});
