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

import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { abcaUserAgent, sanitizeUaValue } from '../../../src/handlers/shared/ua';

// `abcaUserAgent` / `componentLabel` read process.env at call time, so a plain
// import suffices — no module reload needed. The wire-capture cases likewise
// rely on the SDK reading AWS_SDK_UA_APP_ID at client construction.

describe('sanitizeUaValue', () => {
  test.each([
    ['api', 'api'],
    ['a/b', 'a-b'],
    ['a#b', 'a-b'],
    ['héllo', 'h-llo'],
    ['a b', 'a-b'],
    ['ok-_.~!', 'ok-_.~!'],
  ])('sanitizes %p -> %p', (raw, expected) => {
    expect(sanitizeUaValue(raw)).toBe(expected);
  });
});

describe('abcaUserAgent', () => {
  const prev = process.env.ABCA_COMPONENT;
  afterEach(() => {
    if (prev === undefined) delete process.env.ABCA_COMPONENT;
    else process.env.ABCA_COMPONENT = prev;
  });

  test('uses ABCA_COMPONENT when set', () => {
    process.env.ABCA_COMPONENT = 'orchestr';
    expect(abcaUserAgent()).toEqual({ customUserAgent: [['md/uksb-wt64nei4u6', 'orchestr']] });
  });

  test('defaults to api when env unset', () => {
    delete process.env.ABCA_COMPONENT;
    expect(abcaUserAgent()).toEqual({ customUserAgent: [['md/uksb-wt64nei4u6', 'api']] });
  });

  test('sanitizes a hostile component label', () => {
    process.env.ABCA_COMPONENT = 'evil#injected';
    expect(abcaUserAgent()).toEqual({ customUserAgent: [['md/uksb-wt64nei4u6', 'evil-injected']] });
  });
});

describe('wire-capture: emitted User-Agent header', () => {
  /**
   * Drive a real DynamoDBClient through its full middleware stack with a stub
   * requestHandler that records the outbound `user-agent` header and returns a
   * minimal response — no network. The header is captured before the (invalid)
   * response is returned, so the later deserialization error is irrelevant.
   * Asserts the md/ segment (from customUserAgent) and the app/ segment (from
   * native AWS_SDK_UA_APP_ID).
   */
  async function captureUserAgent(appId?: string): Promise<string> {
    const prevAppId = process.env.AWS_SDK_UA_APP_ID;
    if (appId === undefined) delete process.env.AWS_SDK_UA_APP_ID;
    else process.env.AWS_SDK_UA_APP_ID = appId;

    let captured = '';
    const client = new DynamoDBClient({
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
      await client.send(new ListTablesCommand({}));
    } catch {
      // The stub body is not a valid protocol response; we only need the header.
    } finally {
      if (prevAppId === undefined) delete process.env.AWS_SDK_UA_APP_ID;
      else process.env.AWS_SDK_UA_APP_ID = prevAppId;
    }
    return captured;
  }

  test('carries both app/ and md/ segments when AWS_SDK_UA_APP_ID set', async () => {
    const ua = await captureUserAgent('uksb-wt64nei4u6#backgroundagent-dev');
    expect(ua).toContain('app/uksb-wt64nei4u6#backgroundagent-dev');
    expect(ua).toContain('md/uksb-wt64nei4u6#api');
  });

  test('omits app/ when AWS_SDK_UA_APP_ID unset, keeps md/', async () => {
    const ua = await captureUserAgent(undefined);
    expect(ua).not.toContain('app/uksb-wt64nei4u6');
    expect(ua).toContain('md/uksb-wt64nei4u6#api');
  });

  test('omits app/ when AWS_SDK_UA_APP_ID empty (opt-out), keeps md/', async () => {
    const ua = await captureUserAgent('');
    expect(ua).not.toContain('app/uksb-wt64nei4u6');
    expect(ua).toContain('md/uksb-wt64nei4u6#api');
  });
});
