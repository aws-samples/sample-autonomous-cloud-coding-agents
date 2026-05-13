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

const mockCheckRepoOnboarded = jest.fn();
jest.mock('../../../src/handlers/shared/repo-config', () => ({
  checkRepoOnboarded: mockCheckRepoOnboarded,
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.TASK_RETENTION_DAYS = '90';
process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';
process.env.GUARDRAIL_ID = 'test-guardrail-id';
process.env.GUARDRAIL_VERSION = '1';
process.env.REPO_TABLE_NAME = 'RepoConfig';

import { createTaskCore, type TaskCreationContext } from '../../../src/handlers/shared/create-task-core';

function makeContext(overrides: Partial<TaskCreationContext> = {}): TaskCreationContext {
  return {
    userId: 'user-123',
    channelSource: 'api',
    channelMetadata: { source_ip: '1.2.3.4' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
  mockBedrockSend.mockResolvedValue({ action: 'NONE' });
  mockCheckRepoOnboarded.mockResolvedValue({ onboarded: true });
});

describe('createTaskCore', () => {
  test('creates task successfully', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBeDefined();
    expect(body.data.status).toBe('SUBMITTED');
    expect(body.data.repo).toBe('org/repo');
    expect(mockSend).toHaveBeenCalledTimes(2); // task + event
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for invalid repo', async () => {
    const result = await createTaskCore({ repo: 'invalid' } as any, makeContext(), 'req-1');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when no task spec', async () => {
    const result = await createTaskCore({ repo: 'org/repo' }, makeContext(), 'req-1');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when guardrail blocks description', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED' });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'bad content' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('content policy');
  });

  test('returns 503 when guardrail service fails (fail-closed)', async () => {
    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock service unavailable'));
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body).error.message).toContain('Content screening is temporarily unavailable');
  });

  test('returns 200 with existing task for same-user idempotency replay', async () => {
    const existingItem = {
      task_id: 'existing',
      user_id: 'user-123',
      status: 'SUBMITTED',
      repo: 'org/repo',
      task_type: 'new_task',
      task_description: 'Original work',
      branch_name: 'bgagent/existing/slug',
      channel_source: 'api',
      channel_metadata: { source_ip: '1.2.3.4' },
      status_created_at: 'SUBMITTED#2020-01-01T00:00:00.000Z',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      idempotency_key: 'my-key',
    };
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({ Item: existingItem });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Idempotent-Replay']).toBe('true');
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('existing');
    expect(body.data.task_description).toBe('Original work');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('returns 409 when idempotency key belongs to another user', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({
        Item: {
          task_id: 'existing',
          user_id: 'other-user',
          status: 'SUBMITTED',
          repo: 'org/repo',
          task_type: 'new_task',
          branch_name: 'bgagent/existing/slug',
          channel_source: 'api',
          status_created_at: 'SUBMITTED#2020-01-01T00:00:00.000Z',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        },
      });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('DUPLICATE_TASK');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('returns 500 when idempotent replay record is incomplete', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({
        Item: {
          task_id: 'existing',
          user_id: 'user-123',
          // missing status, repo, branch_name, channel_source, created_at, updated_at
        },
      });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('returns 500 when idempotent replay record has no user_id (fail-closed)', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({
        Item: {
          task_id: 'existing',
          // user_id missing entirely — must deny, not match
          status: 'SUBMITTED',
          repo: 'org/repo',
          branch_name: 'bgagent/existing/slug',
          channel_source: 'api',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        },
      });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    // Missing user_id → incomplete record → 500 (fail-closed)
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('creates new task when GSI matches but base-table item is gone (TTL race)', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'gone-task' }] })
      .mockResolvedValueOnce({ Item: undefined }) // GetCommand returns nothing
      .mockResolvedValueOnce({}) // PutCommand for new task
      .mockResolvedValueOnce({}); // PutCommand for event

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBeDefined();
    expect(body.data.task_id).not.toBe('gone-task');
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for invalid idempotency key', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'key with spaces!' }),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
  });

  test('sets channelSource to webhook when specified', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ channelSource: 'webhook', channelMetadata: { webhook_id: 'wh-1' } }),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    // The event metadata should include channel_source: 'webhook'
    const putCalls = mockSend.mock.calls;
    const eventPut = putCalls[1][0];
    expect(eventPut.input.Item.metadata.channel_source).toBe('webhook');
  });

  test('includes ttl on task_created event', async () => {
    await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    const putCalls = mockSend.mock.calls;
    const eventPut = putCalls[1][0]; // second DDB call is the event
    expect(eventPut.input.Item.ttl).toBeDefined();
    expect(typeof eventPut.input.Item.ttl).toBe('number');
    expect(eventPut.input.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('returns 201 even when orchestrator fails', async () => {
    mockLambdaSend.mockRejectedValueOnce(new Error('Lambda error'));
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('returns 201 even when event write fails', async () => {
    // First call succeeds (task record), second call fails (event write)
    mockSend
      .mockResolvedValueOnce({}) // PutCommand for task record
      .mockRejectedValueOnce(new Error('Event write error'));
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('omits max_turns from record when not specified (computed at orchestration time)', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.max_turns).toBeNull();
  });

  test('includes user-specified max_turns', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug', max_turns: 50 },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.max_turns).toBe(50);
  });

  test('returns 400 for max_turns of 0', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', max_turns: 0 } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('max_turns');
  });

  test('returns 400 for max_turns of 501', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', max_turns: 501 } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('max_turns');
  });

  test('returns 400 for non-integer max_turns', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', max_turns: 1.5 } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('max_turns');
  });

  test('returns 400 when task_description exceeds length limit', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'a'.repeat(2001) },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('exceeds maximum length');
  });

  test('accepts task_description at exactly the length limit', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'a'.repeat(2000) },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('returns 422 when repo is not onboarded', async () => {
    mockCheckRepoOnboarded.mockResolvedValueOnce({ onboarded: false });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(422);
    expect(JSON.parse(result.body).error.code).toBe('REPO_NOT_ONBOARDED');
  });

  test('creates task successfully when repo is onboarded', async () => {
    mockCheckRepoOnboarded.mockResolvedValueOnce({ onboarded: true });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('creates pr_iteration task with pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_type: 'pr_iteration', pr_number: 42 },
      makeContext(),
      'req-pr-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_type).toBe('pr_iteration');
    expect(body.data.pr_number).toBe(42);
    expect(body.data.branch_name).toBe('pending:pr_resolution');
  });

  test('returns 400 for pr_iteration without pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_type: 'pr_iteration', task_description: 'Fix it' },
      makeContext(),
      'req-pr-2',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number is required');
  });

  test('returns 400 for pr_number without pr_iteration task_type', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', pr_number: 42 } as any,
      makeContext(),
      'req-pr-3',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number is only allowed');
  });

  test('returns 400 for invalid task_type', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', task_type: 'invalid' as any },
      makeContext(),
      'req-pr-4',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('Invalid task_type');
  });

  test('creates pr_review task with pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_type: 'pr_review', pr_number: 99 },
      makeContext(),
      'req-review-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_type).toBe('pr_review');
    expect(body.data.pr_number).toBe(99);
    expect(body.data.branch_name).toBe('pending:pr_resolution');
  });

  test('returns 400 for pr_review without pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_type: 'pr_review', task_description: 'Review it' },
      makeContext(),
      'req-review-2',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number is required');
  });

  test('returns 400 for pr_number with new_task', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', pr_number: 42 } as any,
      makeContext(),
      'req-review-3',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number is only allowed');
  });

  // -- trace flag (design §10.1) --------------------------------------

  test('trace: true persists on the task record and surfaces in the response', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'deep debug', trace: true },
      makeContext(),
      'req-trace-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.trace).toBe(true);

    // Verify the PutCommand carried trace on the record.
    const putCall = mockSend.mock.calls.find(
      c => (c[0] as { _type?: string; input?: { Item?: { trace?: unknown } } })._type === 'Put'
        && (c[0] as { input?: { Item?: unknown } }).input?.Item !== undefined,
    );
    expect(putCall).toBeDefined();
    const item = (putCall![0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(item.trace).toBe(true);
  });

  test('trace omitted or false does NOT persist a trace field (slim wire payload)', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'normal' },
      makeContext(),
      'req-trace-2',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.trace).toBe(false);

    const putCall = mockSend.mock.calls.find(
      c => (c[0] as { _type?: string })._type === 'Put'
        && (c[0] as { input?: { Item?: unknown } }).input?.Item !== undefined,
    );
    const item = (putCall![0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(item).not.toHaveProperty('trace');
  });

  test('trace with non-boolean type returns 400 (strict boolean validation)', async () => {
    // Prevents a misbehaving client from accidentally enabling trace
    // with ``"trace": "false"`` (truthy string).
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x', trace: 'true' } as any,
      makeContext(),
      'req-trace-3',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('trace');
  });

  test.each([
    ['"false"', 'false'],
    ['numeric 0', 0],
    ['numeric 1', 1],
    ['null', null],
    ['empty object', {}],
  ])('trace as %s is rejected with 400', async (_label, value) => {
    // Adversarial inputs: the strict ``typeof === 'boolean'`` check
    // must reject every non-boolean shape, not just the obvious string
    // case. A future refactor that switches to a truthy test would
    // pass the single "'true'" test above but break on these.
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x', trace: value } as any,
      makeContext(),
      `req-trace-adv-${String(value)}`,
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('trace');
  });
});
