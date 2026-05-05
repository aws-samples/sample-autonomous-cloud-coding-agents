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

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-ABC';
process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME = 'cmd-processor';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-commands';

const SIGNING_SECRET = 'test-signing';

function sign(body: string, ts: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
}

function makeEvent(body: string, ts: string, withSig = true): APIGatewayProxyEvent {
  const headers: Record<string, string> = { 'X-Slack-Request-Timestamp': ts };
  if (withSig) headers['X-Slack-Signature'] = sign(body, ts);
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/commands',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

describe('slack-commands handler', () => {
  beforeEach(() => {
    lambdaSend.mockReset();
    smSend.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    smSend.mockResolvedValue({ SecretString: SIGNING_SECRET });
  });

  test('rejects invalid signature with 401', async () => {
    const body = 'command=%2Fbgagent&text=link&user_id=U1';
    const ts = String(Math.floor(Date.now() / 1000));
    const event = makeEvent(body, ts, false);
    event.headers['X-Slack-Signature'] = 'v0=deadbeef';
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns inline help for empty text or `help`', async () => {
    const body = 'command=%2Fbgagent&text=help&user_id=U1&team_id=T1&channel_id=C1&response_url=https%3A%2F%2Fexample.com';
    const ts = String(Math.floor(Date.now() / 1000));
    const result = await handler(makeEvent(body, ts));
    expect(result.statusCode).toBe(200);
    const payload = JSON.parse(result.body);
    expect(payload.text).toContain('Using Shoof');
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('forwards non-help subcommand to processor and acks inline', async () => {
    lambdaSend.mockResolvedValueOnce({});
    const body = 'command=%2Fbgagent&text=link&user_id=U1&team_id=T1&channel_id=C1&response_url=https%3A%2F%2Fexample.com';
    const ts = String(Math.floor(Date.now() / 1000));
    const result = await handler(makeEvent(body, ts));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(result.body);
    expect(payload.text).toContain('link');
  });

  test('handles processor invoke failure gracefully', async () => {
    lambdaSend.mockRejectedValueOnce(new Error('lambda down'));
    const body = 'command=%2Fbgagent&text=link&user_id=U1&team_id=T1&channel_id=C1&response_url=https%3A%2F%2Fexample.com';
    const ts = String(Math.floor(Date.now() / 1000));
    const result = await handler(makeEvent(body, ts));
    expect(result.statusCode).toBe(200);
    const payload = JSON.parse(result.body);
    expect(payload.text).toMatch(/Failed|try again/i);
  });
});
