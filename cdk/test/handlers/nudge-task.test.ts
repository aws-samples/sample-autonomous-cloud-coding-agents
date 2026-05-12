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
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  ApplyGuardrailCommand: jest.fn((input: unknown) => ({ _type: 'ApplyGuardrail', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.NUDGES_TABLE_NAME = 'Nudges';
process.env.NUDGE_RATE_LIMIT_PER_MINUTE = '10';
process.env.GUARDRAIL_ID = 'test-guardrail';
process.env.GUARDRAIL_VERSION = '1';

import { handler } from '../../src/handlers/nudge-task';

const RUNNING_TASK = {
  task_id: 'task-1',
  user_id: 'user-123',
  status: 'RUNNING',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'RUNNING#2025-03-15T10:30:00Z',
  created_at: '2025-03-15T10:30:00Z',
  updated_at: '2025-03-15T10:31:00Z',
};

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ message: 'please also add tests' }),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1/nudge',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}/nudge',
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
      path: '/v1/tasks/task-1/nudge',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks/{task_id}/nudge',
      stage: 'v1',
    },
    ...overrides,
  };
}

/**
 * Set up the happy-path mock sequence: Get (task) → Update (rate-limit) → Put (nudge).
 */
function primeHappyPath(task = RUNNING_TASK): void {
  mockSend.mockReset();
  mockSend
    .mockResolvedValueOnce({ Item: task }) // GetCommand (task)
    .mockResolvedValueOnce({}) // UpdateCommand (rate-limit counter)
    .mockResolvedValueOnce({}); // PutCommand (nudge record)
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockBedrockSend.mockResolvedValue({ action: 'NONE' });
  primeHappyPath();
});

describe('nudge-task handler — happy path', () => {
  test('submits a nudge and returns 202 with the nudge_id', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(202);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('task-1');
    expect(body.data.nudge_id).toBeDefined();
    expect(typeof body.data.nudge_id).toBe('string');
    expect(body.data.submitted_at).toBeDefined();
  });

  test('writes a NudgeRecord with consumed=false, user_id, message, ttl ~30 days out', async () => {
    const before = Math.floor(Date.now() / 1000);
    await handler(makeEvent());
    const after = Math.floor(Date.now() / 1000);

    // Third DDB call is the PutCommand for the nudge.
    const putCall = mockSend.mock.calls[2][0];
    expect(putCall._type).toBe('Put');
    expect(putCall.input.TableName).toBe('Nudges');

    const item = putCall.input.Item;
    expect(item.task_id).toBe('task-1');
    expect(item.user_id).toBe('user-123');
    expect(item.message).toBe('please also add tests');
    expect(item.consumed).toBe(false);
    expect(typeof item.nudge_id).toBe('string');
    expect(typeof item.created_at).toBe('string');
    expect(typeof item.ttl).toBe('number');

    const thirtyDays = 30 * 24 * 60 * 60;
    expect(item.ttl).toBeGreaterThanOrEqual(before + thirtyDays - 5);
    expect(item.ttl).toBeLessThanOrEqual(after + thirtyDays + 5);
  });

  test('increments the per-task per-minute rate-limit counter', async () => {
    await handler(makeEvent());

    const updateCall = mockSend.mock.calls[1][0];
    expect(updateCall._type).toBe('Update');
    expect(updateCall.input.TableName).toBe('Nudges');
    // Synthetic PK/SK
    expect(updateCall.input.Key.task_id).toBe('RATE#task-1');
    expect(updateCall.input.Key.nudge_id).toMatch(/^MINUTE#\d{12}$/);
    // Counter + TTL + conditional max
    expect(updateCall.input.UpdateExpression).toContain('ADD #count :one');
    expect(updateCall.input.UpdateExpression).toContain('SET #ttl = :ttl');
    expect(updateCall.input.ConditionExpression).toContain('#count < :max');
    expect(updateCall.input.ExpressionAttributeValues[':max']).toBe(10);
  });

  test('trims whitespace from message before storing', async () => {
    await handler(makeEvent({ body: JSON.stringify({ message: '   hello world   ' }) }));

    const putCall = mockSend.mock.calls[2][0];
    expect(putCall.input.Item.message).toBe('hello world');
  });

  test('screens message via Bedrock guardrail when configured', async () => {
    await handler(makeEvent());

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const cmd = mockBedrockSend.mock.calls[0][0];
    expect(cmd.input.guardrailIdentifier).toBe('test-guardrail');
    expect(cmd.input.guardrailVersion).toBe('1');
    expect(cmd.input.source).toBe('INPUT');
  });
});

describe('nudge-task handler — auth and validation errors', () => {
  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe('UNAUTHORIZED');
  });

  test('returns 400 when task_id path parameter is missing', async () => {
    const result = await handler(makeEvent({ pathParameters: null }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when body is missing', async () => {
    const result = await handler(makeEvent({ body: null }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when body is not valid JSON', async () => {
    const result = await handler(makeEvent({ body: '{not json' }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when message is missing', async () => {
    const result = await handler(makeEvent({ body: JSON.stringify({}) }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when message is not a string', async () => {
    const result = await handler(makeEvent({ body: JSON.stringify({ message: 42 }) }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when message is empty after trim', async () => {
    const result = await handler(makeEvent({ body: JSON.stringify({ message: '   ' }) }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when message exceeds 2000 chars after trim', async () => {
    const long = 'a'.repeat(2001);
    const result = await handler(makeEvent({ body: JSON.stringify({ message: long }) }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(JSON.parse(result.body).error.message).toContain('2000');
  });

  test('accepts message at exactly 2000 chars', async () => {
    const boundary = 'a'.repeat(2000);
    const result = await handler(makeEvent({ body: JSON.stringify({ message: boundary }) }));

    expect(result.statusCode).toBe(202);
  });
});

describe('nudge-task handler — task ownership and state', () => {
  test('returns 404 when task does not exist', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TASK_NOT_FOUND');
  });

  test('returns 403 when task belongs to another user', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, user_id: 'other-user' } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  test.each([
    ['COMPLETED'],
    ['FAILED'],
    ['CANCELLED'],
    ['TIMED_OUT'],
  ])('returns 409 when task is in terminal state %s', async (status) => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('TASK_ALREADY_TERMINAL');
  });

  test.each([
    ['SUBMITTED'],
    ['HYDRATING'],
    ['RUNNING'],
    ['FINALIZING'],
  ])('accepts a nudge for non-terminal state %s', async (status) => {
    primeHappyPath({ ...RUNNING_TASK, status });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(202);
  });
});

describe('nudge-task handler — rate limiting', () => {
  test('returns 429 when rate-limit ConditionalCheckFailedException fires', async () => {
    mockSend.mockReset();
    const condErr = new Error('Condition not met');
    condErr.name = 'ConditionalCheckFailedException';
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK }) // Get (task)
      .mockRejectedValueOnce(condErr); // Update (rate-limit) — fails

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(429);
    expect(JSON.parse(result.body).error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(JSON.parse(result.body).error.message).toContain('10');
    // Nudge must NOT have been persisted
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('returns 500 on unexpected rate-limit update error', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK })
      .mockRejectedValueOnce(new Error('DB failure'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('nudge-task handler — guardrail screening', () => {
  test('returns 400 when guardrail blocks the message', async () => {
    mockBedrockSend.mockReset();
    mockBedrockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contentPolicy: {
            filters: [{ type: 'PROMPT_ATTACK', confidence: 'HIGH', action: 'BLOCKED' }],
          },
        },
      ],
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message.toLowerCase()).toContain('content policy');
    // Nudge must NOT have been persisted
    const putCalls = mockSend.mock.calls.filter(c => c[0]._type === 'Put');
    expect(putCalls).toHaveLength(0);
    // Guardrail-blocked messages must NOT consume a rate-limit slot
    // (guardrail runs before rate-limit — see handler docstring).
    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'Update');
    expect(updateCalls).toHaveLength(0);
  });

  test('returns 503 when guardrail API call fails (fail-closed)', async () => {
    mockBedrockSend.mockReset();
    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock unavailable'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.parse(result.body).error.message.toLowerCase()).toContain('screening');
    const putCalls = mockSend.mock.calls.filter(c => c[0]._type === 'Put');
    expect(putCalls).toHaveLength(0);
  });
});

describe('nudge-task handler — error paths', () => {
  test('returns 500 on unexpected DynamoDB Get error', async () => {
    mockSend.mockReset();
    mockSend.mockRejectedValueOnce(new Error('DB failure'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
  });

  test('returns 500 on unexpected DynamoDB Put error', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK })
      .mockResolvedValueOnce({}) // rate-limit ok
      .mockRejectedValueOnce(new Error('Put failed'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
  });
});
