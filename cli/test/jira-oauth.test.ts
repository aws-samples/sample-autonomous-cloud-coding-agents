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

import { exchangeAuthorizationCode, refreshAccessToken } from '../src/jira-oauth';

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('an Atlassian token response that is off contract', () => {
  const accessToken = 'atlassian-access-SUPER_SECRET_VALUE';
  const refreshToken = 'atlassian-refresh-ALSO_SECRET';
  const offContract = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: '3600',
    scope: 'read:jira-work offline_access',
  };

  test.each([
    [
      'the authorization-code exchange',
      (fetchImpl: typeof fetch) => exchangeAuthorizationCode({
        code: 'authcode',
        codeVerifier: 'verifier',
        redirectUri: 'http://localhost:8080/oauth/callback',
        clientId: 'cid',
        clientSecret: 'csec',
        fetchImpl,
      }),
    ],
    [
      'the refresh',
      (fetchImpl: typeof fetch) => refreshAccessToken({
        refreshToken: 'old-refresh',
        clientId: 'cid',
        clientSecret: 'csec',
        fetchImpl,
      }),
    ],
  ])('is reported by %s without the tokens it carried', async (_what, call) => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(200, offContract));

    const message = await call(fetchImpl as unknown as typeof fetch).then(
      () => 'resolved',
      (err: unknown) => String(err),
    );

    expect(message).toContain('Atlassian /oauth/token returned an unexpected shape');
    expect(message).not.toContain(accessToken);
    expect(message).not.toContain(refreshToken);
    expect(message).toContain('expires_in expected number, got string');
    expect(message).toContain('keys present: access_token, expires_in, refresh_token, scope, token_type');
  });
});
