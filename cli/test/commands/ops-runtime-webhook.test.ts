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

import { parseAgentRuntimeArn } from '../../src/runtime-status';
import {
  buildSampleWebhookPayload,
  fetchWebhookSecret,
  sendWebhookTestRequest,
  signWebhookBody,
} from '../../src/webhook-test';

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input) => ({ input })),
}));

describe('parseAgentRuntimeArn', () => {
  test('parses runtime id from ARN', () => {
    expect(parseAgentRuntimeArn(
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-runtime-abc1234567',
    )).toEqual({ agentRuntimeId: 'my-runtime-abc1234567' });
  });

  test('parses optional version suffix', () => {
    expect(parseAgentRuntimeArn(
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test/version/3',
    )).toEqual({ agentRuntimeId: 'test', agentRuntimeVersion: '3' });
  });

  test('throws on unrecognized ARN', () => {
    expect(() => parseAgentRuntimeArn('arn:aws:bedrock-agentcore:us-east-1:123:bad')).toThrow();
  });
});

describe('signWebhookBody', () => {
  test('returns sha256= prefixed hex digest', () => {
    const body = '{"repo":"acme/a","task_description":"hi"}';
    const sig = signWebhookBody('secret', body);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

describe('buildSampleWebhookPayload', () => {
  test('includes repo and workflow_ref', () => {
    expect(buildSampleWebhookPayload('acme/a')).toEqual({
      repo: 'acme/a',
      task_description: expect.stringContaining('Webhook connectivity test'),
      workflow_ref: 'coding/new-task-v1',
    });
  });
});

describe('fetchWebhookSecret', () => {
  test('reads secret from Secrets Manager', async () => {
    smSend.mockResolvedValueOnce({ SecretString: 'abc123' });
    await expect(fetchWebhookSecret('us-east-1', 'wh-1')).resolves.toBe('abc123');
  });

  test('throws when secret is empty', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '' });
    await expect(fetchWebhookSecret('us-east-1', 'wh-1')).rejects.toThrow('empty');
  });

  test('throws an actionable error when the secret does not exist', async () => {
    smSend.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }),
    );
    await expect(fetchWebhookSecret('us-east-1', 'wh-1'))
      .rejects.toThrow(/No webhook secret found/);
  });
});

describe('sendWebhookTestRequest', () => {
  test('posts signed payload and returns task id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { task_id: 'task-1', status: 'SUBMITTED' } }),
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await sendWebhookTestRequest(
      'https://api.example/v1',
      'wh-1',
      'secret',
      buildSampleWebhookPayload('acme/a'),
    );

    expect(result.task_id).toBe('task-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/v1/webhooks/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Webhook-Id': 'wh-1',
          'X-Webhook-Signature': expect.stringMatching(/^sha256=/),
        }),
      }),
    );
  });

  test('throws ApiError on failed response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'bad sig', request_id: 'r1' } }),
    }) as typeof fetch;

    await expect(sendWebhookTestRequest(
      'https://api.example/v1',
      'wh-1',
      'secret',
      buildSampleWebhookPayload('acme/a'),
    )).rejects.toMatchObject({ statusCode: 401, errorCode: 'UNAUTHORIZED' });
  });

  test('throws ApiError when response body is not JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); },
    }) as typeof fetch;

    await expect(sendWebhookTestRequest(
      'https://api.example/v1',
      'wh-1',
      'secret',
      buildSampleWebhookPayload('acme/a'),
    )).rejects.toMatchObject({ statusCode: 500, errorCode: 'WEBHOOK_TEST_FAILED' });
  });

  test('throws when a 2xx response has a malformed (non-JSON) body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    }) as typeof fetch;

    await expect(sendWebhookTestRequest(
      'https://api.example/v1',
      'wh-1',
      'secret',
      buildSampleWebhookPayload('acme/a'),
    )).rejects.toMatchObject({ statusCode: 200, errorCode: 'WEBHOOK_TEST_MALFORMED_RESPONSE' });
  });
});
