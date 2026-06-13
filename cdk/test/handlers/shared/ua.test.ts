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
import {
  SOLUTION_ID,
  COMPONENT_ENV,
  STACK_NAME_ENV,
  sanitizeUaValue,
  abcaUserAgent,
  setAbcaTrace,
  getAbcaTrace,
  withAbcaTrace,
} from '../../../src/handlers/shared/ua';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env[COMPONENT_ENV];
  delete process.env[STACK_NAME_ENV];
  setAbcaTrace(undefined);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('sanitizeUaValue', () => {
  // Vectors mirror agent/tests/test_ua.py — the two implementations must
  // agree character-for-character.
  test('passes through UA-token-safe characters', () => {
    expect(sanitizeUaValue('backgroundagent-dev')).toBe('backgroundagent-dev');
    expect(sanitizeUaValue("A1!$%&'*+-.^_`|~z")).toBe("A1!$%&'*+-.^_`|~z");
  });

  test('replaces structural separators / and #', () => {
    expect(sanitizeUaValue('a/b#c')).toBe('a-b-c');
  });

  test('replaces non-ASCII characters', () => {
    expect(sanitizeUaValue('stäck')).toBe('st-ck');
    expect(sanitizeUaValue('名前')).toBe('--');
  });

  test('replaces whitespace and controls', () => {
    expect(sanitizeUaValue('a b\tc\nd')).toBe('a-b-c-d');
  });

  test('empty string', () => {
    expect(sanitizeUaValue('')).toBe('');
  });
});

describe('abcaUserAgent', () => {
  test('without stack name emits only the md pair with default component', () => {
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [[`md/${SOLUTION_ID}`, 'api']],
    });
  });

  test('component label from ABCA_COMPONENT', () => {
    process.env[COMPONENT_ENV] = 'orchestr';
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [[`md/${SOLUTION_ID}`, 'orchestr']],
    });
  });

  test('with stack name emits the app segment first', () => {
    process.env[STACK_NAME_ENV] = 'backgroundagent-dev';
    expect(abcaUserAgent()).toEqual({
      customUserAgent: [
        [`app/${SOLUTION_ID}/backgroundagent-dev`],
        [`md/${SOLUTION_ID}`, 'api'],
      ],
    });
  });

  test('stack name sanitized first, then clipped to 34 (value <= 50)', () => {
    process.env[STACK_NAME_ENV] = 'my/stack#nämé' + 'x'.repeat(40);
    const [appPair] = abcaUserAgent().customUserAgent;
    const appValue = appPair[0].replace(/^app\//, '');
    expect(appValue.startsWith(`${SOLUTION_ID}/my-stack-n-m-`)).toBe(true);
    expect(appValue.length).toBeLessThanOrEqual(50);
    const stackPart = appValue.slice(`${SOLUTION_ID}/`.length);
    expect(stackPart).toHaveLength(34);
    expect(stackPart).not.toMatch(/[/#]/);
  });

  test('longest realistic stack name stays exactly at the 50 budget', () => {
    process.env[STACK_NAME_ENV] = 'a'.repeat(128);
    const [appPair] = abcaUserAgent().customUserAgent;
    expect(appPair[0].replace(/^app\//, '')).toHaveLength(50);
  });

  test('blank stack name omits the app segment', () => {
    process.env[STACK_NAME_ENV] = '   ';
    expect(abcaUserAgent().customUserAgent).toHaveLength(1);
  });

  test('hostile component label is sanitized', () => {
    process.env[COMPONENT_ENV] = 'or/ch#str';
    expect(abcaUserAgent().customUserAgent[0]).toEqual([`md/${SOLUTION_ID}`, 'or-ch-str']);
  });
});

describe('trace state', () => {
  test('defaults to undefined', () => {
    expect(getAbcaTrace()).toBeUndefined();
  });

  test('set and get', () => {
    setAbcaTrace('01KTVYABCDEF');
    expect(getAbcaTrace()).toBe('01KTVYABCDEF');
  });

  test('sanitized on read', () => {
    setAbcaTrace('trace/with#bad chars');
    expect(getAbcaTrace()).toBe('trace-with-bad-chars');
  });

  test('empty string clears', () => {
    setAbcaTrace('x');
    setAbcaTrace('');
    expect(getAbcaTrace()).toBeUndefined();
  });
});

describe('withAbcaTrace on mock clients', () => {
  test('no-ops on a bare object (jest constructor-mock shape)', () => {
    const fake = {};
    expect(withAbcaTrace(fake)).toBe(fake);
  });
});

describe('wire capture', () => {
  // A real DynamoDBClient with a stub requestHandler: the full middleware
  // stack (including the SDK's user-agent middleware and ours) runs, the
  // handler records the final headers and returns a canned 200 — no network.

  interface CapturedRequest {
    headers: Record<string, string>;
  }

  function makeClient(captured: CapturedRequest[]) {
    const client = new DynamoDBClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
      ...abcaUserAgent(),
      requestHandler: {
        handle: async (request: CapturedRequest) => {
          captured.push(request);
          return {
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/x-amz-json-1.0' },
              body: Uint8Array.from(Buffer.from(JSON.stringify({ TableNames: [] }))),
            },
          };
        },
      },
    });
    return withAbcaTrace(client);
  }

  test('both segments intact in the emitted header; literal slash survives', async () => {
    process.env[STACK_NAME_ENV] = 'backgroundagent-dev';
    process.env[COMPONENT_ENV] = 'api';
    const captured: CapturedRequest[] = [];
    const client = makeClient(captured);

    await client.send(new ListTablesCommand({}));

    const ua = captured[0].headers['user-agent'];
    // The '/' separator survived: the segment rode the raw customUserAgent
    // path, NOT the sanitizing app-id config field (which would emit '-').
    expect(ua).toContain(`app/${SOLUTION_ID}/backgroundagent-dev`);
    expect(ua).toContain(`md/${SOLUTION_ID}#api`);
    // Trace-absent: no trailing '#' after the component label.
    expect(ua).not.toContain(`md/${SOLUTION_ID}#api#`);
    // customUserAgent also lands in x-amz-user-agent on node.
    expect(captured[0].headers['x-amz-user-agent']).toContain(`md/${SOLUTION_ID}#api`);
  });

  test('same cached client emits different traces per request', async () => {
    process.env[COMPONENT_ENV] = 'api';
    const captured: CapturedRequest[] = [];
    const client = makeClient(captured);

    setAbcaTrace('01KTVYTRACE1');
    await client.send(new ListTablesCommand({}));
    setAbcaTrace('01KTVYTRACE2');
    await client.send(new ListTablesCommand({}));
    setAbcaTrace(undefined);
    await client.send(new ListTablesCommand({}));

    expect(captured[0].headers['user-agent']).toContain(`md/${SOLUTION_ID}#api#01KTVYTRACE1`);
    expect(captured[1].headers['user-agent']).toContain(`md/${SOLUTION_ID}#api#01KTVYTRACE2`);
    expect(captured[2].headers['user-agent']).toContain(`md/${SOLUTION_ID}#api`);
    expect(captured[2].headers['user-agent']).not.toContain(`md/${SOLUTION_ID}#api#`);
  });

  test('trace is sanitized at the wire', async () => {
    process.env[COMPONENT_ENV] = 'api';
    const captured: CapturedRequest[] = [];
    const client = makeClient(captured);

    setAbcaTrace('evil/trace#☃ value');
    await client.send(new ListTablesCommand({}));

    expect(captured[0].headers['user-agent']).toContain(
      `md/${SOLUTION_ID}#api#evil-trace---value`,
    );
  });
});
