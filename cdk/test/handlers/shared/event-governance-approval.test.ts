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

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ _type: 'Transact', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';

import { TaskStatus } from '../../../src/constructs/task-status';
import { createAsyncEventApproval } from '../../../src/handlers/shared/event-governance-approval';

describe('event-governance-approval', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const baseTask = {
    task_id: 't1',
    user_id: 'u1',
    status: TaskStatus.RUNNING,
  };

  const baseRule = {
    id: 'gate-pr',
    on: 'pr_created',
    action: 'require_approval' as const,
    mode: 'enforce' as const,
    evaluation: 'async' as const,
    reason: 'Review after PR',
  };

  test('RUNNING task uses TransactWrite to AWAITING_APPROVAL', async () => {
    mockSend.mockResolvedValueOnce({});
    const rid = await createAsyncEventApproval({
      task: baseTask as never,
      rule: baseRule,
      eventType: 'agent_milestone',
      metadata: { milestone: 'pr_created', pr_url: 'https://github.com/o/r/pull/1' },
    });
    expect(rid).toBe('REQ-ULID');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as { _type: string; input: unknown };
    expect(cmd._type).toBe('Transact');
  });

  test('terminal task only Put approval row (post-hoc gate)', async () => {
    mockSend.mockResolvedValueOnce({});
    const rid = await createAsyncEventApproval({
      task: { ...baseTask, status: TaskStatus.COMPLETED } as never,
      rule: baseRule,
      eventType: 'agent_milestone',
      metadata: { milestone: 'pr_created' },
    });
    expect(rid).toBe('REQ-ULID');
    const cmd = mockSend.mock.calls[0][0] as { _type: string };
    expect(cmd._type).toBe('Put');
  });
});
