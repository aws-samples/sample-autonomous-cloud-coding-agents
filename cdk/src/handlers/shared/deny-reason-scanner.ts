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

interface SecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

const NOT_ONLY_A_PLACEHOLDER = String.raw`(?!(?:\$?(?:\{[A-Za-z_.]*\}|\{[0-9]{1,2}\}|\{\{[A-Za-z_.]*\}\})|%[sv]|%\([A-Za-z_.]+\)s|<[a-z_-]+>|<[A-Z_-]+>)@)`;

const PATTERNS: readonly SecretPattern[] = [
  {
    name: 'PRIVATE_KEY',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'AWS_KEY',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b(?::[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))?/g,
  },
  {
    name: 'AWS_SECRET',
    regex: /(?:aws_secret_access_key|SecretAccessKey|AWS_SECRET_ACCESS_KEY)[\s=:"']+[A-Za-z0-9/+=]{40}/gi,
  },
  {
    name: 'GITHUB_TOKEN',
    // The length of a GitHub token varies across token generations.
    regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
  },
  {
    name: 'GITHUB_URL_TOKEN',
    // GitHub App tokens are about 520 characters since 2026, and vary.
    regex: new RegExp(String.raw`x-access-token:${NOT_ONLY_A_PLACEHOLDER}(?:[^\s@:"']+|[^\s@"']{1,512})@`, 'gu'),
  },
  {
    name: 'SLACK_TOKEN',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'GENERIC_BEARER',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  },
  {
    name: 'CONNECTION_STRING',
    regex: new RegExp(String.raw`[a-zA-Z][a-zA-Z0-9+.-]{0,20}://(?:[^\s:/"']*:${NOT_ONLY_A_PLACEHOLDER}(?:[^\s@/"']+|(?!(?:[^\s@/"']*\]:)?[0-9]{1,5}/(?:[^\s@:"']*/)?@)(?:[^\s@:"']+|[^\s@"']{1,256}))|[^\s:/"']*\[REDACTED-AWS_KEY\](?::?[^\s@:"'[]*|[^\s@"']{0,256}))@[^\s"']+`, 'gu'),
  },
  {
    name: 'GITHUB_APP_TOKEN',
    // GitHub App installation tokens of the stateless format that GitHub
    // issues since 2026: ghs_<app id>_<JWT>, about 520 characters.
    regex: /ghs_[0-9]+_eyJ(?:[A-Za-z0-9._-]+|\[REDACTED-[A-Z_]+\])+/g,
  },
  {
    name: 'GENERIC_BEARER',
    regex: /\[REDACTED-GENERIC_BEARER\](?:\[REDACTED-[A-Z_]+\][A-Za-z0-9._~+/=-]*)+/g,
  },
];

/**
 * Replace known secret shapes in ``text`` with ``[REDACTED-<NAME>]``.
 *
 * Idempotent: running it on already-redacted text is a no-op.
 * Deterministic: same input → same output (no randomness, no rule
 * reordering).
 *
 * @param text - the caller-supplied deny reason, or any string.
 * @returns the sanitized text with known secrets replaced.
 */
export function scanDenyReason(text: string): string {
  if (!text) {
    return text || '';
  }
  let out = text;
  for (const { name, regex } of PATTERNS) {
    out = out.replace(regex, `[REDACTED-${name}]`);
  }
  return out;
}

/** The pattern names, in declaration order. */
export const DENY_REASON_SECRET_NAMES: readonly string[] =
  PATTERNS.map((p) => p.name);
