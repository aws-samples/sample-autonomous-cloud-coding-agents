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

// Where the password of a URL would stand: not a placeholder and nothing
// else. The placeholders are {name} and ${NAME}, also with doubled braces,
// %s, %v, %(name)s and <name>. A name is letters, "_" and "."; in <name>
// it is small letters or capitals, not both, "_" and "-". A digit is taken
// only as a positional argument, {0}. That keeps out a password that
// somebody left the brackets of a placeholder around (MongoDB Atlas hands
// out "<password>"): it usually holds a digit or mixes small letters and
// capitals. A URL with a placeholder for a password is a template in
// source code or documentation, not a credential, and is left as it is,
// as the agent's scanner leaves it (the agent reads files through that
// one, and a marker in place of such a line would keep it from editing the
// line). Forms that a real password can have are not among them ($NAME,
// [name], a plain word), and a password that only begins or ends with a
// placeholder is replaced as before.
const NOT_ONLY_A_PLACEHOLDER = String.raw`(?!(?:\$?(?:\{[A-Za-z_.]*\}|\{[0-9]{1,2}\}|\{\{[A-Za-z_.]*\}\})|%[sv]|%\([A-Za-z_.]+\)s|<[a-z_-]+>|<[A-Z_-]+>)@)`;

// Ordered most-specific → most-generic so a narrower replacement
// cannot be consumed by a broader one.
const PATTERNS: readonly SecretPattern[] = [
  {
    name: 'PRIVATE_KEY',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'AWS_KEY',
    // A secret access key that follows the id after a colon goes with it
    // (<id>:<secret>, in a URL or not). CONNECTION_STRING counts on this
    // pattern running before it.
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b(?::[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))?/g,
  },
  {
    name: 'AWS_SECRET',
    // AWS secret-access-key: 40 base64-ish chars after the key's name
    // (env var, INI or the JSON ``SecretAccessKey``), quoted or not.
    regex: /(?:aws_secret_access_key|SecretAccessKey|AWS_SECRET_ACCESS_KEY)[\s=:"']+[A-Za-z0-9/+=]{40}/gi,
  },
  {
    name: 'GITHUB_TOKEN',
    // Matches classic + fine-grained GitHub tokens (`ghp_`, `gho_`,
    // `ghu_`, `ghs_`, `ghr_`, `github_pat_`). The length varies across
    // token generations, so there is a minimum and no maximum.
    regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
  },
  {
    name: 'GITHUB_URL_TOKEN',
    // Credentials embedded in a git remote URL
    // (https://x-access-token:TOKEN@github.com/...). A token holds no ":"
    // and has no length limit (GitHub App tokens are about 520 characters
    // since 2026, and vary). Any other text before the "@" counts up to
    // 512 characters: unlimited, a text that repeats "x-access-token:" is
    // scanned from each one to the end of the run, which is quadratic.
    // The u flag makes the limit count characters, not UTF-16 units.
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
    // scheme://user:password@host. The user and the password hold no
    // whitespace and no quote, so a plain URL is not matched up to a ":"
    // and an "@" that merely follow it in the text. The user holds no "/",
    // may hold an "@" (an e-mail address as login) and may be empty
    // (redis://:<password>@host); the password holds no "@". The password
    // has three alternatives: text without "/", text without ":" (base64
    // text holds "/" and no ":"), and any other text of up to 256
    // characters: without that bound, a text that repeats "x://" is
    // scanned from each one to the end of the run, which is quadratic. The
    // look-ahead in front of the last two keeps a URL without a password
    // as it is when its host has a port and the first "@" behind the port
    // begins a path segment (https://host:8443/@scope/package): there the
    // ":" stands between the host and the port (1 to 5 digits, also behind
    // the rest of an IPv6 address, "]:"). It reads from the port to that
    // segment only while no further ":" comes, which keeps the scan linear
    // as well.
    // Second form: the user ends in the marker that AWS_KEY has put there.
    // What follows up to the "@" (the rest of a password, or ":" and a
    // password or session token) may have any length while it holds no
    // further ":" and no "["; any other text counts up to 256 characters.
    // Without this form the rest of such a URL, with any secret in it,
    // would stay readable. The limit, and the stop at "[" (where the next
    // marker would begin), keep the scan linear. The u flag makes the
    // limits count characters, as the agent's scanner does.
    // contracts/secret-scan-vectors.json holds the cases that the tests of
    // this scanner and of the agent's run.
    regex: new RegExp(String.raw`[a-zA-Z][a-zA-Z0-9+.-]{0,20}://(?:[^\s:/"']*:${NOT_ONLY_A_PLACEHOLDER}(?:[^\s@/"']+|(?!(?:[^\s@/"']*\]:)?[0-9]{1,5}/(?:[^\s@:"']*/)?@)(?:[^\s@:"']+|[^\s@"']{1,256}))|[^\s:/"']*\[REDACTED-AWS_KEY\](?::?[^\s@:"'[]*|[^\s@"']{0,256}))@[^\s"']+`, 'gu'),
  },
  {
    name: 'GITHUB_APP_TOKEN',
    // GitHub App installation tokens of the stateless format that GitHub
    // issues since 2026: ghs_<app id>_<JWT>, about 520 characters. The JWT
    // is known by its first characters, "eyJ"; its three base64url parts
    // and the dots between them are taken as one run, which keeps the scan
    // linear. Behind the patterns above, against the order of this list,
    // on purpose: they meet the text they met before this one was added,
    // so what they replace (such a token after "Bearer", in a git URL or
    // as the password of a URL) stays as it was, and this one takes the
    // tokens they leave. A token runs on through a marker: its signature
    // is random text, and where that holds by chance what a pattern above
    // replaces (36 letters and digits behind "ghp_", say), the marker of
    // that pattern stands inside the token, with the rest of the token
    // behind it.
    regex: /ghs_[0-9]+_eyJ(?:[A-Za-z0-9._-]+|\[REDACTED-[A-Z_]+\])+/g,
  },
  {
    name: 'GENERIC_BEARER',
    // The rest of a bearer token. What stands behind "Bearer" ends in
    // random text as well (the signature of a JWT). Where a pattern above
    // has put its marker inside such a token, the Bearer pattern stopped
    // at that marker. This entry takes the Bearer marker, each marker that
    // follows it directly and the characters of a bearer token behind it,
    // and leaves the one Bearer marker, which is why it has that pattern's
    // name. Last, so that each pattern above meets the text it met before.
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

/**
 * Public for testing: the pattern names, in declaration order.
 */
export const DENY_REASON_SECRET_NAMES: readonly string[] =
  PATTERNS.map((p) => p.name);
