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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';

import { assembleBundle, handler, MAX_REPLAY_EVENTS, MAX_REPLAY_EVENT_BYTES } from '../../src/handlers/get-task-replay';
import type { EventRecord, ReplayBundle, TaskRecord } from '../../src/handlers/shared/types';

const TASK_RECORD = {
  task_id: 'task-1',
  user_id: 'user-123',
  status: 'COMPLETED',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'COMPLETED#2025-03-15T10:30:00Z',
  created_at: '2025-03-15T10:30:00Z',
  updated_at: '2025-03-15T10:31:00Z',
  workflow_ref: 'coding/new-task-v1',
  resolved_workflow: { id: 'coding/new-task-v1', version: '1' },
  prompt_version: 'coding/new-task-v1@1',
  cost_usd: '0.1234',
  build_passed: true,
  lint_passed: false,
  otel_trace_id: 'abcdef0123456789abcdef0123456789',
  session_id: 'sess-1',
  trace_s3_uri: 's3://trace-bucket/traces/user-123/task-1.jsonl.gz',
};

const EVENTS = [
  { task_id: 'task-1', event_id: '01A', event_type: 'task_started', timestamp: '2025-03-15T10:30:00Z' },
  { task_id: 'task-1', event_id: '01B', event_type: 'agent_turn', timestamp: '2025-03-15T10:30:30Z' },
];

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1/replay',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}/replay',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
      httpMethod: 'GET',
      identity: {} as never,
      path: '/v1/tasks/task-1/replay',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks/{task_id}/replay',
      stage: 'v1',
    },
    ...overrides,
  };
}

function wireHappyPath(): void {
  mockSend.mockImplementation((cmd: { _type: string }) => {
    if (cmd._type === 'Get') return Promise.resolve({ Item: TASK_RECORD });
    return Promise.resolve({ Items: EVENTS, LastEvaluatedKey: undefined });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('get-task-replay handler', () => {
  test('returns an aggregated replay bundle', async () => {
    wireHappyPath();
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const { data } = JSON.parse(result.body);
    expect(data.task_id).toBe('task-1');
    expect(data.workflow_ref).toBe('coding/new-task-v1');
    expect(data.resolved_workflow).toEqual({ id: 'coding/new-task-v1', version: '1' });
    expect(data.prompt_version).toBe('coding/new-task-v1@1');
    expect(data.cost_usd).toBe(0.1234);
    expect(data.otel_trace_id).toBe('abcdef0123456789abcdef0123456789');
    expect(data.session_id).toBe('sess-1');
    expect(data.trace_uri).toBe('s3://trace-bucket/traces/user-123/task-1.jsonl.gz');
    expect(data.verification).toEqual({ build_passed: true, lint_passed: false });
    expect(data.events).toHaveLength(2);
    expect(data.events[0].event_type).toBe('task_started');
    expect(data.events_truncation).toBeNull();
    expect(typeof data.collected_at).toBe('string');
  });

  test('events are queried chronologically (ScanIndexForward true)', async () => {
    wireHappyPath();
    await handler(makeEvent());
    const queryCall = mockSend.mock.calls.find(c => c[0]._type === 'Query');
    expect(queryCall[0].input.ScanIndexForward).toBe(true);
    expect(queryCall[0].input.TableName).toBe('TaskEvents');
  });

  test('gracefully handles a task with no trace (trace_uri null)', async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'Get') {
        const { trace_s3_uri, ...noTrace } = TASK_RECORD;
        return Promise.resolve({ Item: noTrace });
      }
      return Promise.resolve({ Items: [], LastEvaluatedKey: undefined });
    });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const { data } = JSON.parse(result.body);
    expect(data.trace_uri).toBeNull();
    expect(data.events).toEqual([]);
  });

  test('verification is null when neither gate result was persisted', async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'Get') {
        const { build_passed, lint_passed, ...noVerdict } = TASK_RECORD;
        return Promise.resolve({ Item: noVerdict });
      }
      return Promise.resolve({ Items: [], LastEvaluatedKey: undefined });
    });
    const result = await handler(makeEvent());
    expect(JSON.parse(result.body).data.verification).toBeNull();
  });

  test('pages across DynamoDB boundaries to collect all events', async () => {
    let call = 0;
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'Get') return Promise.resolve({ Item: TASK_RECORD });
      call += 1;
      if (call === 1) return Promise.resolve({ Items: [EVENTS[0]], LastEvaluatedKey: { k: 1 } });
      return Promise.resolve({ Items: [EVENTS[1]], LastEvaluatedKey: undefined });
    });
    const result = await handler(makeEvent());
    expect(JSON.parse(result.body).data.events).toHaveLength(2);
  });

  test('caps events at MAX_REPLAY_EVENTS and stops paging despite more pages', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const limits: number[] = [];
    mockSend.mockImplementation((cmd: { _type: string; input?: { Limit?: number } }) => {
      if (cmd._type === 'Get') return Promise.resolve({ Item: TASK_RECORD });
      const limit = cmd.input?.Limit ?? 0;
      limits.push(limit);
      const items = Array.from({ length: limit }, (_, i) => ({
        task_id: 'task-1', event_id: `e${i}`, event_type: 'x', timestamp: 't',
      }));
      return Promise.resolve({ Items: items, LastEvaluatedKey: { k: 1 } });
    });

    const result = await handler(makeEvent());
    const { data } = JSON.parse(result.body);

    expect(data.events).toHaveLength(MAX_REPLAY_EVENTS);
    expect(limits[0]).toBe(MAX_REPLAY_EVENTS);
    expect(data.events_truncation).toEqual({ reason: 'max_events', returned_events: MAX_REPLAY_EVENTS });
    const warned = stdoutSpy.mock.calls.some(c => String(c[0]).includes('truncated'));
    stdoutSpy.mockRestore();
    expect(warned).toBe(true);
  });

  test('caps events at MAX_REPLAY_EVENT_BYTES before the count cap (6 MB Lambda limit)', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const bigPreview = 'x'.repeat(9000);
    mockSend.mockImplementation((cmd: { _type: string; input?: { Limit?: number } }) => {
      if (cmd._type === 'Get') return Promise.resolve({ Item: TASK_RECORD });
      const limit = cmd.input?.Limit ?? 0;
      const items = Array.from({ length: limit }, (_, i) => ({
        task_id: 'task-1',
        event_id: `e${i}`,
        event_type: 'agent_turn',
        timestamp: 't',
        metadata: { preview: bigPreview },
      }));
      return Promise.resolve({ Items: items, LastEvaluatedKey: { k: 1 } });
    });

    const result = await handler(makeEvent());
    const { data } = JSON.parse(result.body);

    expect(data.events.length).toBeLessThan(MAX_REPLAY_EVENTS);
    const bytes = Buffer.byteLength(JSON.stringify(data.events), 'utf8');
    expect(bytes).toBeGreaterThan(MAX_REPLAY_EVENT_BYTES - 20000);
    expect(bytes).toBeLessThan(MAX_REPLAY_EVENT_BYTES + 20000);
    expect(data.events_truncation).toEqual({ reason: 'max_bytes', returned_events: data.events.length });
    const warned = stdoutSpy.mock.calls.some(c => String(c[0]).includes('truncated'));
    stdoutSpy.mockRestore();
    expect(warned).toBe(true);
  });

  test('keeps the Lambda response under 6 MB when the previews are JSON (quotes escaped once more)', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const jsonPreview = '"'.repeat(4000);
    mockSend.mockImplementation((cmd: { _type: string; input?: { Limit?: number } }) => {
      if (cmd._type === 'Get') return Promise.resolve({ Item: TASK_RECORD });
      const items = Array.from({ length: cmd.input?.Limit ?? 0 }, (_, i) => ({
        task_id: 'task-1',
        event_id: `e${i}`,
        event_type: 'agent_turn',
        timestamp: 't',
        metadata: { preview: jsonPreview },
      }));
      return Promise.resolve({ Items: items, LastEvaluatedKey: { k: 1 } });
    });

    const result = await handler(makeEvent());
    stdoutSpy.mockRestore();

    // Lambda's limit applies to the proxy result as the runtime serializes it, where `body` is a string.
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(6 * 1024 * 1024);
    expect(JSON.parse(result.body).data.events_truncation.reason).toBe('max_bytes');
  });

  test('returns 401 when unauthenticated', async () => {
    wireHappyPath();
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe('UNAUTHORIZED');
  });

  test('returns 400 when task_id missing', async () => {
    wireHappyPath();
    const result = await handler(makeEvent({ pathParameters: null }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 when task not found', async () => {
    mockSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'Get' ? Promise.resolve({ Item: undefined }) : Promise.resolve({ Items: [] }));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TASK_NOT_FOUND');
  });

  test('returns 403 when the task belongs to another user (matches task-read auth)', async () => {
    mockSend.mockImplementation((cmd: { _type: string }) =>
      cmd._type === 'Get'
        ? Promise.resolve({ Item: { ...TASK_RECORD, user_id: 'other' } })
        : Promise.resolve({ Items: [] }));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
    expect(mockSend.mock.calls.some(c => c[0]._type === 'Query')).toBe(false);
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DB failure'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('assembleBundle', () => {
  test('coerces a string cost_usd and treats NaN as null', () => {
    const base = { task_id: 't', user_id: 'u' } as unknown as TaskRecord;
    expect(assembleBundle({ ...base, cost_usd: '1.5' } as unknown as TaskRecord, []).cost_usd).toBe(1.5);
    expect(assembleBundle({ ...base, cost_usd: 'oops' } as unknown as TaskRecord, []).cost_usd).toBeNull();
    expect(assembleBundle(base, []).cost_usd).toBeNull();
  });

  test('MAX_REPLAY_EVENTS is a sane positive bound', () => {
    expect(MAX_REPLAY_EVENTS).toBeGreaterThan(0);
  });

  test('normalizes events to the /events feed shape (strip task_id/ttl, default metadata)', () => {
    const base = { task_id: 't', user_id: 'u' } as unknown as TaskRecord;
    const evs = [
      { task_id: 't', event_id: '01A', event_type: 'task_started', timestamp: 'ts', ttl: 123 },
      { task_id: 't', event_id: '01B', event_type: 'agent_turn', timestamp: 'ts2', metadata: { turn: 1 } },
    ] as unknown as EventRecord[];
    expect(assembleBundle(base, evs).events).toEqual([
      { event_id: '01A', event_type: 'task_started', timestamp: 'ts', metadata: {} },
      { event_id: '01B', event_type: 'agent_turn', timestamp: 'ts2', metadata: { turn: 1 } },
    ]);
  });

  test('passes through the correlation envelope (#245) per-event, omitting absent fields', () => {
    const base = { task_id: 't', user_id: 'u' } as unknown as TaskRecord;
    const evs = [
      { task_id: 't', event_id: '01A', event_type: 'task_created', timestamp: 'ts' },
      {
        task_id: 't',
        event_id: '01B',
        event_type: 'agent_turn',
        timestamp: 'ts2',
        metadata: { turn: 1 },
        user_id: 'u',
        repo: 'org/repo',
        trace_id: 'a'.repeat(32),
      },
    ] as unknown as EventRecord[];
    const out = assembleBundle(base, evs).events;
    expect(out[0]).not.toHaveProperty('user_id');
    expect(out[0]).not.toHaveProperty('trace_id');
    expect(out[1]).toMatchObject({ user_id: 'u', repo: 'org/repo', trace_id: 'a'.repeat(32) });
  });
});

describe('replay-bundle.example.json fixture (#515 AC: example fixture in cdk/test/)', () => {
  test('conforms to the ReplayBundle shape', () => {
    const raw = readFileSync(join(__dirname, '../fixtures/replay-bundle.example.json'), 'utf8');
    const bundle: ReplayBundle = JSON.parse(raw) as ReplayBundle;
    expect(bundle.task_id).toBeTruthy();
    expect(Array.isArray(bundle.events)).toBe(true);
    expect(bundle.verification).toEqual({ build_passed: true, lint_passed: true });
    expect(bundle.otel_trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof bundle.collected_at).toBe('string');
  });
});
