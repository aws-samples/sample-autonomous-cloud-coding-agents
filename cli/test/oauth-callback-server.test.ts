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

import * as fs from 'fs';
import * as https from 'https';
import {
  awaitOauthCallback,
  CALLBACK_PORT,
  CALLBACK_URL,
  generateSelfSignedCert,
} from '../src/oauth-callback-server';

/**
 * Make a self-signed-cert-tolerant HTTPS GET request to localhost.
 * Returns the response status + body. Closes the connection cleanly so
 * the server can finish settling without hanging the test.
 */
function localGet(urlSuffix: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: 'localhost',
      port: CALLBACK_PORT,
      path: urlSuffix,
      // We're testing our own self-signed cert, so accept it.
      rejectUnauthorized: false,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('generateSelfSignedCert', () => {
  test('produces readable cert + key files and a working cleanup', () => {
    const cert = generateSelfSignedCert();
    expect(fs.existsSync(cert.certPath)).toBe(true);
    expect(fs.existsSync(cert.keyPath)).toBe(true);
    // Cert PEM has the standard header — quick sanity check.
    expect(fs.readFileSync(cert.certPath, 'utf-8')).toContain('-----BEGIN CERTIFICATE-----');
    expect(fs.readFileSync(cert.keyPath, 'utf-8')).toContain('-----BEGIN PRIVATE KEY-----');
    cert.cleanup();
    expect(fs.existsSync(cert.certPath)).toBe(false);
    expect(fs.existsSync(cert.keyPath)).toBe(false);
  });
});

describe('awaitOauthCallback', () => {
  // The real OAuth flow waits on Linear/AWS — to avoid binding port 8443 in
  // CI (which may be in use), these tests run sequentially via Jest's default
  // test isolation per file. The 8443 port must be free for these tests; if
  // a developer has another bgagent setup running locally, expect EADDRINUSE.

  test('captures session_id from the first valid request and resolves', async () => {
    // Fire the server + the request in parallel; the server resolves once it
    // sees the request, then closes.
    const expectedSessionId = 'urn:ietf:params:oauth:request_uri:test-uuid';
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
    // Tiny delay so the server has time to bind before we make the request.
    await new Promise((r) => setTimeout(r, 100));
    const requestPromise = localGet(`/oauth/callback?session_id=${encodeURIComponent(expectedSessionId)}`);

    const [callbackResult, response] = await Promise.all([callbackPromise, requestPromise]);
    expect(callbackResult.sessionId).toBe(expectedSessionId);
    expect(response.status).toBe(200);
    expect(response.body).toContain('Linear authorized');
  });

  test('rejects when the redirect arrives without session_id', async () => {
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 100));
    const responsePromise = localGet('/oauth/callback');

    // Both promises settle together: the response carries the 400 + failure
    // page, the callback promise rejects with the no-session_id error.
    // Capture both outcomes via allSettled so neither hangs the other.
    const [callbackOutcome, responseOutcome] = await Promise.allSettled([
      callbackPromise,
      responsePromise,
    ]);

    expect(callbackOutcome.status).toBe('rejected');
    if (callbackOutcome.status === 'rejected') {
      expect(String(callbackOutcome.reason.message)).toMatch(/without session_id/);
    }
    expect(responseOutcome.status).toBe('fulfilled');
    if (responseOutcome.status === 'fulfilled') {
      expect(responseOutcome.value.status).toBe(400);
      expect(responseOutcome.value.body).toContain('Authorization not captured');
    }
  });

  test('rejects on timeout when no callback arrives', async () => {
    // Short timeout so the test doesn't drag.
    const startedAt = Date.now();
    await expect(awaitOauthCallback({ timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  test('CALLBACK_URL constant matches the documented localhost URL', () => {
    // Regression-lock: the URL is also baked into the CDK construct's
    // allowlist (cdk/src/constructs/cli-workload-identity.ts default).
    // Drift here = silent OAuth failure at runtime ("redirect_uri not allowlisted").
    expect(CALLBACK_URL).toBe('https://localhost:8443/oauth/callback');
  });
});
