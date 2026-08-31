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
 * Tests for the pending-consent store, which carries a PKCE verifier between the
 * two `bgagent linear setup --hosted` invocations.
 *
 * The verifier is a ONE-TIME SECRET: with it plus a stolen authorization code an
 * attacker could complete the exchange. So the properties under test are security
 * properties, not conveniences — consume-on-read, expiry, and 0600 permissions.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearPendingConsent,
  savePendingConsent,
  takePendingConsent,
  type PendingConsent,
} from '../src/linear-pending-consent';

let tmpDir: string;

function entry(overrides: Partial<PendingConsent> = {}): PendingConsent {
  return {
    slug: 'acme',
    state: 'st-123',
    codeVerifier: 'verifier-abc',
    clientId: 'cid',
    redirectUri: 'https://d1.cloudfront.net/',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-pending-'));
  process.env.BGAGENT_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.BGAGENT_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pending consent round-trip', () => {
  test('saves and returns the verifier + state the exchange needs', () => {
    savePendingConsent(entry());
    const got = takePendingConsent('acme');
    expect(got.codeVerifier).toBe('verifier-abc');
    expect(got.state).toBe('st-123');
    expect(got.redirectUri).toBe('https://d1.cloudfront.net/');
  });

  test('is CONSUMED on read — a verifier cannot be replayed', () => {
    // One verifier, one attempt. Leaving it on disk after use would keep a live
    // one-time secret around for no benefit.
    savePendingConsent(entry());
    takePendingConsent('acme');
    expect(() => takePendingConsent('acme')).toThrow(/No pending consent/);
  });

  test('the file is written 0600, not world-readable', () => {
    savePendingConsent(entry());
    const p = path.join(tmpDir, 'linear-pending-consent-acme.json');
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  test('re-running --hosted overwrites the previous attempt rather than accumulating', () => {
    savePendingConsent(entry({ codeVerifier: 'first' }));
    savePendingConsent(entry({ codeVerifier: 'second' }));
    expect(takePendingConsent('acme').codeVerifier).toBe('second');
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes('pending-consent'))).toEqual([]);
  });
});

describe('pending consent refusals', () => {
  test('an expired entry is refused AND removed, pointing at how to restart', () => {
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString(); // TTL is 15 min
    savePendingConsent(entry({ createdAt: old }));
    expect(() => takePendingConsent('acme')).toThrow(/expired/);
    // Consumed even on refusal: a dead one-time secret must not linger.
    expect(fs.existsSync(path.join(tmpDir, 'linear-pending-consent-acme.json'))).toBe(false);
  });

  test('a corrupt entry is discarded with an actionable message, not a raw parse error', () => {
    const p = path.join(tmpDir, 'linear-pending-consent-acme.json');
    fs.writeFileSync(p, '{not json');
    expect(() => takePendingConsent('acme')).toThrow(/unreadable|discarded/);
    expect(fs.existsSync(p)).toBe(false);
  });

  test('a malformed createdAt is treated as expired rather than trusted', () => {
    savePendingConsent(entry({ createdAt: 'not-a-date' }));
    expect(() => takePendingConsent('acme')).toThrow(/expired/);
  });

  test('a slug with path separators is REFUSED, not interpolated into a path', () => {
    // The slug becomes part of a filename, and the file holds a live PKCE verifier.
    // Callers do validate, but a security-relevant store must not depend on being
    // called correctly — so the check lives here too.
    for (const bad of ['../../etc/passwd', 'a/b', '..', './x', 'a\\b', '']) {
      expect(() => takePendingConsent(bad)).toThrow(/Refusing to use|No pending consent/);
      expect(() => savePendingConsent(entry({ slug: bad }))).toThrow(/Refusing to use/);
    }
  });

  test('missing entry names the command that starts one', () => {
    expect(() => takePendingConsent('nope')).toThrow(/setup nope --hosted/);
  });

  test('entries are per-workspace, so two onboardings do not clobber each other', () => {
    savePendingConsent(entry({ slug: 'acme', codeVerifier: 'v-acme' }));
    savePendingConsent(entry({ slug: 'other', codeVerifier: 'v-other' }));
    expect(takePendingConsent('other').codeVerifier).toBe('v-other');
    expect(takePendingConsent('acme').codeVerifier).toBe('v-acme');
  });

  test('clearPendingConsent discards without an exchange, and is safe when absent', () => {
    savePendingConsent(entry());
    clearPendingConsent('acme');
    expect(() => takePendingConsent('acme')).toThrow(/No pending consent/);
    expect(() => clearPendingConsent('acme')).not.toThrow();
  });
});
