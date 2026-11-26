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
  openBrowser,
  randomState,
} from '../src/oauth-callback-server';

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

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
  test('captures session_id from the first valid request and resolves with kind=agentcore', async () => {
    const expectedSessionId = 'urn:ietf:params:oauth:request_uri:test-uuid';
    const callbackPromise = awaitOauthCallback({ timeoutMs: 5_000 });
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
    const startedAt = Date.now();
    await expect(awaitOauthCallback({ timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  test('CALLBACK_URL constant matches the documented localhost URL', () => {
    expect(CALLBACK_URL).toBe('http://localhost:8080/oauth/callback');
  });
});

describe('openBrowser', () => {
  beforeEach(() => execFileMock.mockReset());

  test('resolves true when the OS opener succeeds', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    await expect(openBrowser('https://example.test')).resolves.toBe(true);
  });

  test('resolves false when the OS opener errors', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(new Error('no opener')));
    await expect(openBrowser('https://example.test')).resolves.toBe(false);
  });

  test.each([
    ['darwin', 'open', ['https://example.test']],
    ['win32', 'cmd', ['/c', 'start', '""', 'https://example.test']],
    ['linux', 'xdg-open', ['https://example.test']],
  ] as const)('on %s, runs `%s` with the URL', async (platform, expectedCmd, expectedArgs) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    try {
      await openBrowser('https://example.test');
      expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual([expectedCmd, expectedArgs]);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('randomState', () => {
  test('is 32 random bytes in base64url, new on every call', () => {
    const first = randomState();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomState()).not.toBe(first);
  });
});
