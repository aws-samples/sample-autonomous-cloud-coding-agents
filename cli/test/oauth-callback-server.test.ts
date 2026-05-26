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

import * as http from 'http';
import {
  awaitOauthCallback,
  CALLBACK_PORT,
  CALLBACK_URL,
} from '../src/oauth-callback-server';

/**
 * Make a plain HTTP GET request to localhost. Returns the response
 * status + body. Closes the connection cleanly so the server can
 * finish settling without hanging the test.
 */
function localGet(urlSuffix: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: 'localhost',
      port: CALLBACK_PORT,
      path: urlSuffix,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('awaitOauthCallback', () => {
  // The real OAuth flow waits on Linear — to avoid binding the callback port
  // (8080) in CI when it might be in use, these tests run sequentially via
  // Jest's default test isolation per file. If a developer has another
  // bgagent setup running locally, expect EADDRINUSE.

  test('captures session_id from the first valid request and resolves with kind=agentcore', async () => {
    // Fire the server + the request in parallel; the server resolves once it
    // sees the request, then closes.
    const expectedSessionId = 'urn:ietf:params:oauth:request_uri:test-uuid';
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
    // Tiny delay so the server has time to bind before we make the request.
    await new Promise((r) => setTimeout(r, 100));
    const requestPromise = localGet(`/oauth/callback?session_id=${encodeURIComponent(expectedSessionId)}`);

    const [callbackResult, response] = await Promise.all([callbackPromise, requestPromise]);
    expect(callbackResult.kind).toBe('agentcore');
    if (callbackResult.kind === 'agentcore') {
      expect(callbackResult.sessionId).toBe(expectedSessionId);
    }
    expect(response.status).toBe(200);
    expect(response.body).toContain('Linear authorized');
  });

  test('captures code+state from a direct Linear OAuth redirect with kind=direct-oauth', async () => {
    // Phase 2.0b Option 2 path: Linear redirects with `code` + `state`
    // (no AgentCore proxy in the middle).
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 100));
    const requestPromise = localGet(
      '/oauth/callback?code=lin_authcode_abc&state=stateuuid',
    );

    const [callbackResult, response] = await Promise.all([callbackPromise, requestPromise]);
    expect(callbackResult.kind).toBe('direct-oauth');
    if (callbackResult.kind === 'direct-oauth') {
      expect(callbackResult.code).toBe('lin_authcode_abc');
      expect(callbackResult.state).toBe('stateuuid');
    }
    expect(response.status).toBe(200);
  });

  test('rejects with Linear`s error_description when redirect has ?error=', async () => {
    // Linear surfaces `?error=access_denied` if the user clicks Cancel on
    // the consent screen. Distinguish that from a missing-params failure
    // so the caller can present a clearer message.
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 100));
    const responsePromise = localGet(
      '/oauth/callback?error=access_denied&error_description=user+cancelled',
    );

    const [callbackOutcome, responseOutcome] = await Promise.allSettled([
      callbackPromise,
      responsePromise,
    ]);
    expect(callbackOutcome.status).toBe('rejected');
    if (callbackOutcome.status === 'rejected') {
      expect(String(callbackOutcome.reason.message)).toMatch(/access_denied.*user cancelled/);
    }
    if (responseOutcome.status === 'fulfilled') {
      expect(responseOutcome.value.status).toBe(400);
    }
  });

  test('rejects when the redirect has neither session_id nor code+state', async () => {
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 100));
    const responsePromise = localGet('/oauth/callback');

    // Both promises settle together: the response carries the 400 + failure
    // page, the callback promise rejects with the missing-params error.
    // Capture both outcomes via allSettled so neither hangs the other.
    const [callbackOutcome, responseOutcome] = await Promise.allSettled([
      callbackPromise,
      responsePromise,
    ]);

    expect(callbackOutcome.status).toBe('rejected');
    if (callbackOutcome.status === 'rejected') {
      expect(String(callbackOutcome.reason.message)).toMatch(/without session_id or code\/state/);
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
    // RFC 8252 §7.3: http://localhost is the right shape for native-app OAuth
    // callbacks (no TLS required, no cert warnings). Port 8080 is conventional.
    expect(CALLBACK_URL).toBe('http://localhost:8080/oauth/callback');
  });
});
