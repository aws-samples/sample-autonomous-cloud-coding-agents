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

import * as crypto from 'crypto';

/**
 * Decide whether a `deployment_status.environment_url` is safe to navigate.
 *
 * Defense-in-depth — the path is HMAC-gated and AgentCore Browser runs
 * outside the Lambda VPC, so this isn't blocking an exploit on the
 * default config. But we publish whatever renders to a public-read
 * CloudFront URL, which amplifies any read; rejecting obviously-wrong
 * shapes at the boundary is cheap and matches the "fail-closed on risk"
 * tenet.
 *
 * Rejects:
 *   - Non-https schemes (http, file, data, javascript, ftp, …)
 *   - Literal-IP hosts (IPv4 and IPv6) — preview URLs use DNS names
 *   - localhost / *.localhost
 *   - link-local (169.254.x.x, fe80::/10)
 *   - private RFC1918 / loopback (10.x, 192.168.x, 172.16-31.x, 127.x)
 */
export function isAllowedScreenshotUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  // Node's URL keeps IPv6 literals wrapped in `[…]` on .hostname;
  // strip them so the IPv6 checks below match against the bare address.
  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

  // IPv6 loopback (::1) and link-local (fe80::/10).
  if (hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('fe80::')) {
    return false;
  }

  // IPv4 literals: reject any dotted-quad (preview URLs come from DNS).
  // Also reject IPv4-mapped IPv6 addresses (::ffff:10.0.0.1).
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) return false;
  if (hostname.includes('::ffff:') || hostname.includes('::ffff.')) return false;

  return true;
}

/**
 * Build an unguessable S3 key for the screenshot PNG.
 *
 * The bucket is private and CloudFront serves anonymously, but the URL
 * `https://<dist>.cloudfront.net/screenshots/<owner>_<repo>/<sha>.png`
 * is enumerable from a public PR (the SHA appears in the merge UI).
 * Preview deploys can render PII; we want guessing the URL to be hard.
 *
 * High-entropy suffix (16 hex chars = 64 bits) added between sha and
 * .png. Keeps the prefix structure so per-org/repo lifecycle policies
 * still work, and stays anonymous-cacheable.
 */
export function buildScreenshotKey(repo: string, sha: string, deploymentId?: number): string {
  const repoSlug = repo.replaceAll('/', '_');
  const id = deploymentId !== undefined ? `-${deploymentId}` : '';
  // 8 random bytes → 16 hex chars; 64 bits of entropy. crypto.randomBytes
  // is sync but cheap (< 1ms on Lambda) and avoids pulling in async
  // randomness machinery for one call per invocation.
  const suffix = crypto.randomBytes(8).toString('hex');
  return `screenshots/${repoSlug}/${sha}${id}-${suffix}.png`;
}
