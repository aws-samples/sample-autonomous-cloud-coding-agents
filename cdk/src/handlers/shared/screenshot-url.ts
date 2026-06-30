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

/** Random bytes for screenshot object-key suffix (→ 16 hex chars / 64 bits). */
const SCREENSHOT_KEY_ENTROPY_BYTES = 8;

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
 *   - localhost / *.localhost
 *   - ANY IPv6 literal (bracketed host or a `:` in the host) — covers
 *     loopback `::1`, link-local `fe80::/10`, unique-local `fc00::/7`,
 *     NAT64, and IPv4-mapped forms in one rule, since preview URLs are
 *     always DNS names
 *   - Any IPv4 dotted-quad literal (the WHATWG parser normalizes
 *     decimal/octal/hex integer forms to dotted-quad first, so those are
 *     caught too) — covers RFC1918, loopback, and link-local 169.254.x.x
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
  // strip them so the checks below match against the bare address.
  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

  // Reject ANY IPv6 literal rather than enumerate ranges. Preview URLs
  // always use DNS names, so a bracketed host (or any host containing a
  // `:`) is never a legitimate target — and enumerating ranges missed
  // unique-local `fc00::/7` (e.g. `[fc00::1]`), NAT64, and IPv4-mapped
  // forms. A colon is the unambiguous IPv6 signal: DNS hostnames can't
  // contain one, and the port has already been split off onto
  // Enumerating ranges missed by naive host checks. (screenshot URL hardening)
  if (rawHost.startsWith('[') || hostname.includes(':')) return false;

  // IPv4 literals: reject any dotted-quad (preview URLs come from DNS).
  // Decimal/octal/hex integer forms (e.g. `2130706433`) are already
  // normalized to dotted-quad by the WHATWG URL parser, so this catches
  // them too.
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) return false;

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
  const suffix = crypto.randomBytes(SCREENSHOT_KEY_ENTROPY_BYTES).toString('hex');
  return `screenshots/${repoSlug}/${sha}${id}-${suffix}.png`;
}

/**
 * Percent-encode the parens in a URL before it's interpolated into a
 * markdown link/image target.
 *
 * `environment_url` comes from the webhook payload. Its hostname passes
 * `isAllowedScreenshotUrl`, but the WHATWG URL parser preserves `(` and
 * `)` in the path/query — so a value like
 * `https://preview.vercel.app/x)](https://evil/a.png)` stays "allowed"
 * yet closes the `](…)` of the comment markdown early, injecting
 * attacker-chosen content into a comment posted under ABCA's token. In
 * fork-PR configs the preview path can be author-influenced without the
 * webhook secret, so this is reachable.
 *
 * `(` → `%28`, `)` → `%29` are valid percent-escapes the browser decodes
 * back, so the rendered link still resolves to the real preview URL —
 * it just can't break out of the markdown delimiters.
 */
export function encodeMarkdownUrl(rawUrl: string): string {
  return rawUrl.replaceAll('(', '%28').replaceAll(')', '%29');
}
