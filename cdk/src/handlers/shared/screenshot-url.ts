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

const SCREENSHOT_KEY_ENTROPY_BYTES = 8;

/**
 * Decide whether a `deployment_status.environment_url` is safe to navigate.
 *
 * Rejects:
 *   - Non-https schemes (http, file, data, javascript, ftp, …)
 *   - localhost / *.localhost
 *   - ANY IPv6 literal (bracketed host or a `:` in the host)
 *   - Any IPv4 dotted-quad literal (the WHATWG parser normalizes
 *     decimal/octal/hex integer forms to dotted-quad first, so those are
 *     caught too)
 */
export function isAllowedScreenshotUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  // Node's URL keeps IPv6 literals wrapped in `[…]` on .hostname.
  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

  if (rawHost.startsWith('[') || hostname.includes(':')) return false;

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) return false;

  return true;
}

/**
 * Build an unguessable S3 key for the screenshot PNG.
 *
 * High-entropy suffix (16 hex chars = 64 bits) added between sha and
 * .png.
 */
export function buildScreenshotKey(repo: string, sha: string, deploymentId?: number): string {
  const repoSlug = repo.replaceAll('/', '_');
  const id = deploymentId !== undefined ? `-${deploymentId}` : '';
  const suffix = crypto.randomBytes(SCREENSHOT_KEY_ENTROPY_BYTES).toString('hex');
  return `screenshots/${repoSlug}/${sha}${id}-${suffix}.png`;
}

/**
 * Percent-encode the parens in a URL before it's interpolated into a
 * markdown link/image target: the WHATWG URL parser preserves `(` and
 * `)` in the path/query, and a `)` closes the `](…)` of the markdown early.
 */
export function encodeMarkdownUrl(rawUrl: string): string {
  return rawUrl.replaceAll('(', '%28').replaceAll(')', '%29');
}

const MIN_ABCA_BRANCH_SEGMENTS = 3;

/**
 * Pull the ABCA ``taskId`` out of a deploy PR's head branch. ABCA names every
 * task branch ``bgagent/{taskId}/{slug}``. Returns null for any branch that
 * doesn't match the ABCA shape.
 */
export function extractTaskIdFromBranch(branchName: string | null | undefined): string | null {
  if (!branchName) return null;
  const parts = branchName.split('/');
  if (parts.length < MIN_ABCA_BRANCH_SEGMENTS || parts[0] !== 'bgagent') return null;
  const taskId = parts[1];
  return taskId && taskId.length > 0 ? taskId : null;
}
