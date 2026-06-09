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

import type { DynamoDBRecord } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';

import { handler, parseTerminalTaskRecord } from '../../src/handlers/orchestration-reconciler';

/** Build a TaskTable stream MODIFY record. */
function taskRecord(fields: {
  task_id?: string;
  status?: string;
  build_passed?: boolean;
  orchestration_id?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
}): DynamoDBRecord {
  const img: Record<string, unknown> = {};
  if (fields.task_id) img.task_id = { S: fields.task_id };
  if (fields.status) img.status = { S: fields.status };
  if (fields.build_passed !== undefined) img.build_passed = { BOOL: fields.build_passed };
  if (fields.orchestration_id) img.orchestration_id = { S: fields.orchestration_id };
  return {
    eventName: fields.eventName ?? 'MODIFY',
    dynamodb: { NewImage: img as never },
  } as DynamoDBRecord;
}

describe('parseTerminalTaskRecord', () => {
  test('extracts a terminal orchestration child event', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', build_passed: true, orchestration_id: 'orch_1',
    }));
    expect(evt).toEqual({ taskId: 'T1', status: 'COMPLETED', buildPassed: true, orchestrationId: 'orch_1' });
  });

  test('skips non-terminal status', () => {
    expect(parseTerminalTaskRecord(taskRecord({ task_id: 'T1', status: 'RUNNING', orchestration_id: 'orch_1' }))).toBeNull();
  });

  test('skips tasks with no orchestration_id (non-orchestration tasks)', () => {
    expect(parseTerminalTaskRecord(taskRecord({ task_id: 'T1', status: 'COMPLETED' }))).toBeNull();
  });

  test('skips REMOVE events', () => {
    expect(parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', orchestration_id: 'orch_1', eventName: 'REMOVE',
    }))).toBeNull();
  });

  test('skips records with no NewImage', () => {
    expect(parseTerminalTaskRecord({ eventName: 'MODIFY', dynamodb: {} } as DynamoDBRecord)).toBeNull();
  });
});

/** Mock the GSI lookup + loadOrchestration Query for a child set. */
function mockOrchestration(opts: {
  subIssueId: string;
  children: Array<{ sub_issue_id: string; depends_on?: string[]; child_status: string }>;
}): void {
  // 1: ChildTaskIndex GSI query → row with sub_issue_id
  ddbSend.mockResolvedValueOnce({ Items: [{ sub_issue_id: opts.subIssueId }] });
  // 2: loadOrchestration Query → meta + child rows
  ddbSend.mockResolvedValueOnce({
    Items: [
      {
        sub_issue_id: '#meta',
        orchestration_id: 'orch_1',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
        repo: 'o/r',
        child_count: opts.children.length,
        platform_user_id: 'user-1',
      },
      ...opts.children.map((c) => ({
        orchestration_id: 'orch_1',
        sub_issue_id: c.sub_issue_id,
        depends_on: c.depends_on ?? [],
        child_status: c.child_status,
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
      })),
    ],
  });
}

describe('orchestration-reconciler handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child-task' } }) });
  });

  test('A succeeds → releases blocked dependent B', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    // remaining ddb.send calls: status update for A (succeeded), then
    // releaseChild's conditional update for B. Resolve all.
    ddbSend.mockResolvedValue({});

    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);

    // B released via createTaskCore.
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const ctx = createTaskCoreMock.mock.calls[0][1];
    expect(ctx.idempotencyKey).toBe('orch_1#B');
  });

  test('A fails → no release, B skipped (createTaskCore not called)', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    ddbSend.mockResolvedValue({});

    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })] } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('COMPLETED with build_passed=false → treated as failure, B not released', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    ddbSend.mockResolvedValue({});

    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', build_passed: false, orchestration_id: 'orch_1' })],
    } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('non-orchestration / non-terminal records are skipped entirely', async () => {
    await handler({
      Records: [
        taskRecord({ task_id: 'T1', status: 'RUNNING', orchestration_id: 'orch_1' }),
        taskRecord({ task_id: 'T2', status: 'COMPLETED' }), // no orchestration_id
      ],
    } as never);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('unresolvable sub_issue_id (GSI miss) → skip, no throw', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] }); // GSI miss
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });
});
