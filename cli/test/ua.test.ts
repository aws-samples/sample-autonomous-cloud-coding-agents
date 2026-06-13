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

import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { abcaUserAgent, applyDefaultAppId, APP_ID_ENV, sanitizeUaValue, SOLUTION_ID } from '../src/ua';

describe('sanitizeUaValue', () => {
  test.each([
    ['cli', 'cli'],
    ['a/b', 'a-b'],
    ['a#b', 'a-b'],
    ['héllo', 'h-llo'],
  ])('sanitizes %p -> %p', (raw, expected) => {
    expect(sanitizeUaValue(raw)).toBe(expected);
  });
});

describe('abcaUserAgent', () => {
  test('emits the static cli md/ segment', () => {
    expect(abcaUserAgent()).toEqual({ customUserAgent: [['md/uksb-wt64nei4u6', 'cli']] });
  });
});

describe('applyDefaultAppId', () => {
  const prev = process.env[APP_ID_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[APP_ID_ENV];
    else process.env[APP_ID_ENV] = prev;
  });

  test('sets the solution id when env unset', () => {
    delete process.env[APP_ID_ENV];
    applyDefaultAppId();
    expect(process.env[APP_ID_ENV]).toBe(SOLUTION_ID);
  });

  test('never overrides an existing value', () => {
    process.env[APP_ID_ENV] = 'customer-value';
    applyDefaultAppId();
    expect(process.env[APP_ID_ENV]).toBe('customer-value');
  });

  test('respects an explicit empty-string opt-out', () => {
    process.env[APP_ID_ENV] = '';
    applyDefaultAppId();
    expect(process.env[APP_ID_ENV]).toBe('');
  });
});

describe('wire-capture: emitted User-Agent header', () => {
  async function captureUserAgent(appId?: string): Promise<string> {
    const prevAppId = process.env[APP_ID_ENV];
    if (appId === undefined) delete process.env[APP_ID_ENV];
    else process.env[APP_ID_ENV] = appId;

    let captured = '';
    const client = new CognitoIdentityProviderClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      ...abcaUserAgent(),
      requestHandler: {
        async handle(request: { headers: Record<string, string> }) {
          captured = request.headers['user-agent'] ?? request.headers['User-Agent'] ?? '';
          return { response: { statusCode: 200, headers: {}, body: undefined } };
        },
        updateHttpClientConfig() {},
        httpHandlerConfigs() {
          return {};
        },
      } as never,
    });

    try {
      // Drives the middleware stack; the stub captures the header before the
      // (invalid) response triggers a deserialization error we ignore.
      await client.send(new ListUsersCommand({ UserPoolId: 'x' }));
    } catch {
      // stub body is not a valid protocol response — we only want the header
    } finally {
      if (prevAppId === undefined) delete process.env[APP_ID_ENV];
      else process.env[APP_ID_ENV] = prevAppId;
    }
    return captured;
  }

  test('carries both app/ and md/ segments when AWS_SDK_UA_APP_ID set', async () => {
    const ua = await captureUserAgent('uksb-wt64nei4u6');
    expect(ua).toContain('app/uksb-wt64nei4u6');
    expect(ua).toContain('md/uksb-wt64nei4u6#cli');
  });

  test('omits app/ when AWS_SDK_UA_APP_ID empty, keeps md/', async () => {
    const ua = await captureUserAgent('');
    expect(ua).not.toContain('app/uksb-wt64nei4u6');
    expect(ua).toContain('md/uksb-wt64nei4u6#cli');
  });
});
