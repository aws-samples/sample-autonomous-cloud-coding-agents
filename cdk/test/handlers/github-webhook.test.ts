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

import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
class FakeConditionalCheckFailedException extends Error {
  constructor() {
    super('ConditionalCheckFailed');
    this.name = 'ConditionalCheckFailedException';
  }
}
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  ConditionalCheckFailedException: FakeConditionalCheckFailedException,
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const verifyMock = jest.fn();
jest.mock('../../src/handlers/shared/github-webhook-verify', () => ({
  verifyGitHubRequest: (...args: unknown[]) => verifyMock(...args),
}));

process.env.GITHUB_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-webhook';
process.env.GITHUB_WEBHOOK_DEDUP_TABLE_NAME = 'GhWebhookDedup';
process.env.GITHUB_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'gh-webhook-processor';

import { handler } from '../../src/handlers/github-webhook';

function event(body: string | null, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    body,
    headers: {
      'X-Hub-Signature-256': 'sha256=ignored',
      'X-GitHub-Event': 'deployment_status',
      ...headers,
    },
  } as unknown as APIGatewayProxyEvent;
}

function deploymentStatusBody(overrides: {
  state?: string;
  environment?: string;
  environmentUrl?: string | null;
  deploymentId?: number | null;
  statusId?: number | null;
  repo?: string | null;
} = {}): string {
  // `??` only short-circuits on undefined/null — so for fields where we
  // want to keep an explicit null in the payload (to test missing-field
  // behaviour), distinguish on `=== undefined`.
  return JSON.stringify({
    deployment_status: {
      id: overrides.statusId === undefined ? 99 : overrides.statusId,
      state: overrides.state ?? 'success',
      environment_url: overrides.environmentUrl === undefined ? 'https://preview-foo.vercel.app' : overrides.environmentUrl,
    },
    deployment: {
      id: overrides.deploymentId === undefined ? 42 : overrides.deploymentId,
      sha: 'abc1234',
      environment: overrides.environment ?? 'Preview',
    },
    repository: { full_name: overrides.repo === undefined ? 'owner/repo' : overrides.repo },
  });
}

describe('github-webhook receiver', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    lambdaSend.mockReset();
    verifyMock.mockReset();
    verifyMock.mockResolvedValue(true);
  });

  test('400 when body is missing', async () => {
    const res = await handler(event(null));
    expect(res.statusCode).toBe(400);
  });

  test('401 when signature header missing', async () => {
    const res = await handler(event('{}', { 'X-Hub-Signature-256': '' }));
    expect(res.statusCode).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test('401 when verification fails', async () => {
    verifyMock.mockResolvedValueOnce(false);
    const res = await handler(event('{}'));
    expect(res.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('200 ok on ping event', async () => {
    const res = await handler(event('{}', { 'X-GitHub-Event': 'ping' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, ping: true });
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('200 silently ignores non-deployment_status events', async () => {
    const res = await handler(event('{}', { 'X-GitHub-Event': 'pull_request' }));
    expect(res.statusCode).toBe(200);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('400 when body is not JSON', async () => {
    const res = await handler(event('not-json{'));
    expect(res.statusCode).toBe(400);
  });

  test('200 skipped when deployment_status.state is not success', async () => {
    const res = await handler(event(deploymentStatusBody({ state: 'failure' })));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).skipped_state).toBe('failure');
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('200 skipped when environment does not match SCREENSHOT_TARGET_ENVIRONMENT', async () => {
    const res = await handler(event(deploymentStatusBody({ environment: 'Production' })));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).skipped_environment).toBe('Production');
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('SCREENSHOT_TARGET_ENVIRONMENT override accepts non-Preview names', async () => {
    process.env.SCREENSHOT_TARGET_ENVIRONMENT = 'Production';
    try {
      ddbSend.mockResolvedValueOnce({});
      lambdaSend.mockResolvedValueOnce({});
      const res = await handler(event(deploymentStatusBody({ environment: 'Production' })));
      expect(res.statusCode).toBe(200);
      expect(lambdaSend).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.SCREENSHOT_TARGET_ENVIRONMENT;
    }
  });

  test('400 when payload missing repo / deployment id / status id', async () => {
    const res = await handler(event(deploymentStatusBody({ deploymentId: null })));
    expect(res.statusCode).toBe(400);
  });

  test('200 skipped when environment_url is missing', async () => {
    const res = await handler(event(deploymentStatusBody({ environmentUrl: null })));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).skipped_no_url).toBe(true);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('200 deduped when dedup row already exists', async () => {
    ddbSend.mockRejectedValueOnce(new FakeConditionalCheckFailedException());
    const res = await handler(event(deploymentStatusBody()));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deduped).toBe(true);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('200 ok on the happy path: dedup put, processor invoked', async () => {
    ddbSend.mockResolvedValueOnce({});
    lambdaSend.mockResolvedValueOnce({});
    const res = await handler(event(deploymentStatusBody()));
    expect(res.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    // Forwarded payload preserves the raw body verbatim.
    const invokeArg = (lambdaSend.mock.calls[0][0] as { input: { Payload: Uint8Array } }).input;
    const decoded = JSON.parse(new TextDecoder().decode(invokeArg.Payload));
    expect(decoded.raw_body).toBeDefined();
  });

  test('rolls back the dedup row when processor invoke fails', async () => {
    ddbSend
      .mockResolvedValueOnce({}) // PutCommand
      .mockResolvedValueOnce({}); // DeleteCommand cleanup
    lambdaSend.mockRejectedValueOnce(new Error('lambda throttled'));
    const res = await handler(event(deploymentStatusBody()));
    expect(res.statusCode).toBe(500);
    // Two ddb calls: put then delete-rollback.
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const second = (ddbSend.mock.calls[1][0] as { _type: string }) ;
    expect(second._type).toBe('Delete');
  });

  test('returns 500 if dedup put throws a non-ConditionalCheck error', async () => {
    ddbSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    const res = await handler(event(deploymentStatusBody()));
    expect(res.statusCode).toBe(500);
  });
});
