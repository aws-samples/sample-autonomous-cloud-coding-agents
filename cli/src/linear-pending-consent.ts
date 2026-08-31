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

// Short-lived state for a consent that spans TWO CLI invocations.
//
// The localhost flow keeps everything in one process: the CLI generates a PKCE
// verifier, starts a listener, and exchanges the code it catches. On a cloud
// desktop, SSH box, or container that does not work — the browser cannot reach the
// CLI's localhost — so consent has to be completed by pasting the code back into a
// SECOND `bgagent linear setup` invocation.
//
// The authorization code is useless without the PKCE `code_verifier` from the FIRST
// invocation, and `state` must still be checked to prevent CSRF. Both are held here
// between the two runs.
//
// SECURITY. The verifier is a one-time secret: with it plus a stolen code an
// attacker could complete the exchange. So the file is `0600` in the CLI's own
// config dir, is deleted as soon as it is consumed, and is rejected once expired
// (Linear's codes are short-lived; a stale verifier lingering on disk is a liability
// with no upside).
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir, SECRET_FILE_MODE } from './config';
import { CliError } from './errors';

/**
 * Consent must be completed within this window. Linear's authorization codes are
 * short-lived, so a verifier older than this is dead weight on disk — and a
 * one-time secret with no remaining use is a liability, not a convenience.
 */
const PENDING_CONSENT_TTL_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const PENDING_CONSENT_TTL_MS = PENDING_CONSENT_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

export interface PendingConsent {
  readonly slug: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** ISO-8601; entries older than the TTL are refused. */
  readonly createdAt: string;
}

/**
 * Linear `urlKey` shape. Enforced HERE rather than trusted from the caller: this
 * value is interpolated into a filename, so a slug containing path separators or
 * `..` would let it escape the config directory — and what it would clobber or
 * expose is a file holding a live PKCE verifier. Callers do validate, but a
 * security-relevant store should not depend on being called correctly.
 */
const SAFE_SLUG = /^[a-zA-Z0-9_-]{1,64}$/;

function pendingPath(slug: string): string {
  if (!SAFE_SLUG.test(slug)) {
    throw new CliError(
      `Refusing to use '${slug}' as a workspace slug: it must be Linear's urlKey shape `
      + '(letters, digits, underscore, hyphen). Anything else could escape the config directory.',
    );
  }
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- slug is checked against SAFE_SLUG immediately above, which admits no separators and no dots, so it cannot escape getConfigDir()
  return path.join(getConfigDir(), `linear-pending-consent-${slug}.json`);
}

/** Persist the state a paste-back exchange will need. Overwrites any prior attempt. */
export function savePendingConsent(pending: PendingConsent): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = pendingPath(pending.slug);
  fs.writeFileSync(p, JSON.stringify(pending, null, 2) + '\n', { mode: SECRET_FILE_MODE });
  // writeFileSync only honours `mode` when CREATING the file; an overwrite leaves
  // pre-existing loose bits untouched. Same reason config.ts chmods explicitly.
  fs.chmodSync(p, SECRET_FILE_MODE);
}

/**
 * Load and CONSUME the pending consent for a slug. The file is deleted whether or
 * not it turns out to be usable, so a verifier is never left on disk after one
 * attempt and cannot be replayed.
 */
export function takePendingConsent(slug: string): PendingConsent {
  const p = pendingPath(slug);
  if (!fs.existsSync(p)) {
    throw new CliError(
      `No pending consent for workspace '${slug}'. Start one with:\n`
      + `  bgagent linear setup ${slug} --hosted\n`
      + 'then re-run with --code once the browser shows it.',
    );
  }
  let parsed: PendingConsent;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as PendingConsent;
  } catch (err) {
    fs.rmSync(p, { force: true });
    throw new CliError(
      `Pending consent for '${slug}' is unreadable (${err instanceof Error ? err.message : String(err)}). `
      + `It has been discarded — re-run \`bgagent linear setup ${slug} --hosted\`.`,
    );
  } finally {
    // Consume on read: one verifier, one attempt.
    fs.rmSync(p, { force: true });
  }

  const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
  if (Number.isNaN(ageMs) || ageMs > PENDING_CONSENT_TTL_MS) {
    throw new CliError(
      `The pending consent for '${slug}' has expired (authorization codes are short-lived). `
      + `Re-run \`bgagent linear setup ${slug} --hosted\` to start a fresh one.`,
    );
  }
  return parsed;
}

/** Discard a pending consent without consuming it for an exchange. */
export function clearPendingConsent(slug: string): void {
  fs.rmSync(pendingPath(slug), { force: true });
}
