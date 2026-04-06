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

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

// Set env vars before importing handler
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';
process.env.GUARDRAIL_ID = 'test-guardrail-id';
process.env.GUARDRAIL_VERSION = '1';

import { handler } from '../../src/handlers/create-task';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ repo: 'org/repo', task_description: 'Fix the bug' }),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/tasks',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
      httpMethod: 'POST',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test/1.0',
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
      path: '/v1/tasks',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  // Default: PutCommand succeeds, no idempotency conflicts
  mockSend.mockResolvedValue({});
  // Default: orchestrator invocation succeeds
  mockLambdaSend.mockResolvedValue({});
  // Default: guardrail allows content
  mockBedrockSend.mockResolvedValue({ action: 'NONE' });
});

describe('create-task handler', () => {
  test('creates task successfully', async () => {
    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('ULID1');
    expect(body.data.status).toBe('SUBMITTED');
    expect(body.data.repo).toBe('org/repo');
    expect(body.data.task_description).toBe('Fix the bug');
    expect(body.data.branch_name).toContain('bgagent/ULID1/');
    expect(result.headers?.['X-Request-Id']).toBe('ULID0');

    // Two DynamoDB calls: PutCommand for task + PutCommand for event
    expect(mockSend).toHaveBeenCalledTimes(2);

    // Orchestrator invoked async
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 400 for missing body', async () => {
    const event = makeEvent({ body: null });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for invalid JSON body', async () => {
    const event = makeEvent({ body: 'not json' });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for missing repo', async () => {
    const event = makeEvent({ body: JSON.stringify({ task_description: 'Fix it' }) });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('repo');
  });

  test('returns 400 for invalid repo format', async () => {
    const event = makeEvent({ body: JSON.stringify({ repo: 'invalid', task_description: 'Fix it' }) });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when neither issue_number nor task_description provided', async () => {
    const event = makeEvent({ body: JSON.stringify({ repo: 'org/repo' }) });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('issue_number');
  });

  test('accepts issue_number without task_description', async () => {
    const event = makeEvent({ body: JSON.stringify({ repo: 'org/repo', issue_number: 42 }) });
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.issue_number).toBe(42);
  });

  test('returns 409 for duplicate idempotency key', async () => {
    // First call: QueryCommand returns existing task_id
    // Second call: GetCommand returns existing task
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing-task' }] })
      .mockResolvedValueOnce({ Item: { task_id: 'existing-task', user_id: 'user-123', status: 'SUBMITTED' } });

    const event = makeEvent({ headers: { 'Idempotency-Key': 'my-key-123' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('DUPLICATE_TASK');
  });

  test('returns 400 for invalid idempotency key format', async () => {
    const event = makeEvent({ headers: { 'Idempotency-Key': 'invalid key with spaces!' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('proceeds when idempotency key is not found', async () => {
    // QueryCommand returns no items
    mockSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const event = makeEvent({ headers: { 'Idempotency-Key': 'unique-key-1' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB error'));
    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  test('returns 201 even when orchestrator invocation fails', async () => {
    mockLambdaSend.mockRejectedValueOnce(new Error('Lambda error'));
    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  test('includes Content-Type and X-Request-Id headers', async () => {
    const event = makeEvent();
    const result = await handler(event);

    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['X-Request-Id']).toBeDefined();
  });

  test('returns 400 when guardrail blocks task description', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED' });
    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('content policy');
    // Should not write to DynamoDB
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('proceeds when guardrail allows task description', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'NONE' });
    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  test('skips guardrail when task uses issue_number only', async () => {
    const event = makeEvent({ body: JSON.stringify({ repo: 'org/repo', issue_number: 42 }) });
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    // Guardrail should not be called for issue-only tasks
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });
});
