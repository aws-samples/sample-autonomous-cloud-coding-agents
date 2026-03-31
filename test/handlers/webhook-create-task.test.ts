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

// --- Mocks ---
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  ApplyGuardrailCommand: jest.fn((input: unknown) => ({ _type: 'ApplyGuardrail', input })),
}));

const mockSmSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSmSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';
process.env.GUARDRAIL_ID = 'test-guardrail-id';
process.env.GUARDRAIL_VERSION = '1';

import { handler } from '../../src/handlers/webhook-create-task';

const TEST_SECRET = 'my-webhook-secret';

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  const body = JSON.stringify({ repo: 'org/repo', task_description: 'Fix the bug' });
  return {
    body,
    headers: {
      'X-Webhook-Signature': sign(body, TEST_SECRET),
    },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/webhooks/tasks',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/webhooks/tasks',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { userId: 'user-abc', webhookId: 'wh-123' },
      httpMethod: 'POST',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'webhook-client/1.0',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      path: '/v1/webhooks/tasks',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/webhooks/tasks',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
  mockBedrockSend.mockResolvedValue({ action: 'NONE' });
  mockSmSend.mockResolvedValue({ SecretString: TEST_SECRET });
});

describe('webhook-create-task handler', () => {
  test('creates task successfully via webhook', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBeDefined();
    expect(body.data.status).toBe('SUBMITTED');
  });

  test('returns 401 when webhook context is missing', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns 401 when X-Webhook-Signature header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error.message).toContain('X-Webhook-Signature');
  });

  test('returns 401 for invalid signature', async () => {
    const event = makeEvent({
      headers: {
        'X-Webhook-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error.message).toContain('Invalid webhook signature');
  });

  test('returns 500 when Secrets Manager throws a transient error', async () => {
    mockSmSend.mockRejectedValueOnce(new Error('SM error'));
    // Use unique webhook ID to avoid secret cache
    const event = makeEvent();
    event.requestContext.authorizer = { userId: 'user-abc', webhookId: 'wh-transient' };
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });

  test('returns 500 when secret is not found in Secrets Manager', async () => {
    const notFound = new Error('Secret not found');
    notFound.name = 'ResourceNotFoundException';
    mockSmSend.mockRejectedValueOnce(notFound);
    const event = makeEvent();
    event.requestContext.authorizer = { userId: 'user-abc', webhookId: 'wh-deleted' };
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });

  test('returns 400 for missing body', async () => {
    const event = makeEvent({
      body: null,
      headers: { 'X-Webhook-Signature': 'sha256=abc' },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('Request body is required');
  });

  test('returns 400 for invalid repo', async () => {
    const invalidBody = JSON.stringify({ repo: 'invalid', task_description: 'Fix it' });
    const event = makeEvent({
      body: invalidBody,
      headers: { 'X-Webhook-Signature': sign(invalidBody, TEST_SECRET) },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('sets channel_source to webhook in event metadata', async () => {
    await handler(makeEvent());
    // Second DDB call is the event write
    const putCalls = mockSend.mock.calls;
    const eventPut = putCalls[1][0];
    expect(eventPut.input.Item.metadata.channel_source).toBe('webhook');
  });

  test('includes webhook_id in channel_metadata', async () => {
    await handler(makeEvent());
    // First DDB call is the task record write
    const putCalls = mockSend.mock.calls;
    const taskPut = putCalls[0][0];
    expect(taskPut.input.Item.channel_metadata.webhook_id).toBe('wh-123');
  });
});
