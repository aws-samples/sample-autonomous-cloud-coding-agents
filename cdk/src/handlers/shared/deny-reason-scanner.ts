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

/**
 * Secret-redaction for user-supplied deny reasons (design §7.2, §12.6).
 *
 * Mirrors the Python agent's `output_scanner` patterns so a reason that
 * contains an AWS key / GitHub PAT / API token comes out redacted no
 * matter which side consumed the text. The agent reads the sanitized
 * reason from DDB and only ever sees the already-scanned form; this
 * scanner is the boundary between user input and the agent's context.
 *
 * The scanner is conservative: false-positive redactions of regular
 * text that happens to look like a token are acceptable because the
 * alternative — leaking a credential in an audit log or agent prompt —
 * is much worse.
 *
 * Keep the pattern set in sync with `agent/src/output_scanner.py`; the
 * agent-side scanner is the canonical source for PostToolUse output
 * redaction, and this module is the REST-side port for the deny-reason
 * path only. If the agent-side patterns change, update here too.
 */

interface SecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

// Ordered most-specific → most-generic so a narrower replacement
// cannot be consumed by a broader one.
const PATTERNS: readonly SecretPattern[] = [
  {
    name: 'PRIVATE_KEY',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'AWS_KEY',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'AWS_SECRET',
    // AWS secret-access-key: 40 base64-ish chars with optional
    // ``aws_secret_access_key=`` / ``AWS_SECRET_ACCESS_KEY`` prefix.
    regex: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+]{40}\b/g,
  },
  {
    name: 'GITHUB_TOKEN',
    // Matches classic + fine-grained GitHub tokens (`ghp_`, `gho_`,
    // `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{80,}\b/g,
  },
  {
    name: 'SLACK_TOKEN',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'GENERIC_BEARER',
    regex: /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g,
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

/**
 * Public for testing: the pattern names, in declaration order.
 */
export const DENY_REASON_SECRET_NAMES: readonly string[] =
  PATTERNS.map((p) => p.name);
