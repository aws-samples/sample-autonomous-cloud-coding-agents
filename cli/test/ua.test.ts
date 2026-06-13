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
import * as os from 'os';
import * as path from 'path';
import { saveConfig } from '../src/config';
import {
  SOLUTION_ID,
  sanitizeUaValue,
  abcaUserAgent,
  setAbcaTrace,
  getAbcaTrace,
  withAbcaTrace,
} from '../src/ua';

let tmpDir: string;

function writeConfig(stackName?: string): void {
  saveConfig({
    api_url: 'https://api.example.com',
    region: 'us-east-1',
    user_pool_id: 'us-east-1_abc',
    client_id: 'client123',
    ...(stackName !== undefined ? { stack_name: stackName } : {}),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-ua-test-'));
  process.env.BGAGENT_CONFIG_DIR = tmpDir;
  setAbcaTrace(undefined);
});

afterEach(() => {
  delete process.env.BGAGENT_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sanitizeUaValue', () => {
  // Vectors mirror cdk/test/handlers/shared/ua.test.ts and
  // agent/tests/test_ua.py — all three implementations must agree.
  test('passes through UA-token-safe characters', () => {
    expect(sanitizeUaValue('backgroundagent-dev')).toBe('backgroundagent-dev');
    expect(sanitizeUaValue("A1!$%&'*+-.^_`|~z")).toBe("A1!$%&'*+-.^_`|~z");
  });

  test('replaces structural separators, non-ASCII, whitespace', () => {
    expect(sanitizeUaValue('a/b#c')).toBe('a-b-c');
    expect(sanitizeUaValue('stäck')).toBe('st-ck');
    expect(sanitizeUaValue('a b\tc')).toBe('a-b-c');
  });
});

describe('abcaUserAgent', () => {
  test('without configured stack name emits only the md pair', () => {
    writeConfig();
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [[`md/${SOLUTION_ID}`, 'cli']],
    });
  });

  test('with no config file at all still emits the md pair', () => {
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [[`md/${SOLUTION_ID}`, 'cli']],
    });
  });

  test('with stack name emits the app segment first', () => {
    writeConfig('backgroundagent-dev');
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [
        [`app/${SOLUTION_ID}/backgroundagent-dev`],
        [`md/${SOLUTION_ID}`, 'cli'],
      ],
    });
  });

  test('stack name sanitized first, then clipped to 34 (value <= 50)', () => {
    writeConfig('my/stack#nämé' + 'x'.repeat(40));
    const [appPair] = abcaUserAgent().customUserAgent;
    const appValue = appPair[0].replace(/^app\//, '');
    expect(appValue.startsWith(`${SOLUTION_ID}/my-stack-n-m-`)).toBe(true);
    expect(appValue.length).toBeLessThanOrEqual(50);
    expect(appValue.slice(`${SOLUTION_ID}/`.length)).toHaveLength(34);
  });
});

describe('trace state', () => {
  test('set, get, sanitize, clear', () => {
    expect(getAbcaTrace()).toBeUndefined();
    setAbcaTrace('12345');
    expect(getAbcaTrace()).toBe('12345');
    setAbcaTrace('bad/pid#1');
    expect(getAbcaTrace()).toBe('bad-pid-1');
    setAbcaTrace(undefined);
    expect(getAbcaTrace()).toBeUndefined();
  });
});

describe('withAbcaTrace', () => {
  test('no-ops on a bare object (jest constructor-mock shape)', () => {
    const fake = {};
    expect(withAbcaTrace(fake)).toBe(fake);
  });
});

describe('wire capture', () => {
  // Real Cognito client + stub requestHandler: the full middleware stack
  // runs, the handler records the final headers — no network.
  interface CapturedRequest {
    headers: Record<string, string>;
  }

  test('both segments intact; same client emits per-request traces', async () => {
    writeConfig('backgroundagent-dev');
    const {
      CognitoIdentityProviderClient,
      GetUserCommand,
    } = jest.requireActual('@aws-sdk/client-cognito-identity-provider');

    const captured: CapturedRequest[] = [];
    const client = withAbcaTrace(
      new CognitoIdentityProviderClient({
        region: 'us-east-1',
        credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
        ...abcaUserAgent(),
        requestHandler: {
          handle: async (request: CapturedRequest) => {
            captured.push(request);
            return {
              response: {
                statusCode: 200,
                headers: { 'content-type': 'application/x-amz-json-1.1' },
                body: Uint8Array.from(
                  Buffer.from(JSON.stringify({ Username: 'u', UserAttributes: [] })),
                ),
              },
            };
          },
        },
      }),
    );

    setAbcaTrace('4242');
    await client.send(new GetUserCommand({ AccessToken: 'token' }));
    setAbcaTrace('9999');
    await client.send(new GetUserCommand({ AccessToken: 'token' }));
    setAbcaTrace(undefined);
    await client.send(new GetUserCommand({ AccessToken: 'token' }));

    const ua0 = captured[0].headers['user-agent'];
    // Literal '/' survived — raw customUserAgent path, not the app-id field.
    expect(ua0).toContain(`app/${SOLUTION_ID}/backgroundagent-dev`);
    expect(ua0).toContain(`md/${SOLUTION_ID}#cli#4242`);
    expect(captured[1].headers['user-agent']).toContain(`md/${SOLUTION_ID}#cli#9999`);
    // Trace-absent: segment ends at the component label, no trailing '#'.
    expect(captured[2].headers['user-agent']).toContain(`md/${SOLUTION_ID}#cli`);
    expect(captured[2].headers['user-agent']).not.toContain(`md/${SOLUTION_ID}#cli#`);
  });
});
