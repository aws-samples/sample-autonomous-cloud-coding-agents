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

// The sweep's eligibility + body rendering are covered by the pure planner's own
// tests; these cover the handler's I/O wiring — that a plan reaches the channel
// as the right issue/parent/reply triple, and that failures stay non-fatal.

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: ddbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

// Mock at the per-surface helper, NOT the channel: the real Linear adapter runs,
// so the test exercises the actual channel-op → surface-call mapping.
const upsertThreadedReplyMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  upsertThreadedReply: (...args: unknown[]) => upsertThreadedReplyMock(...args),
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const REGISTRY = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = REGISTRY;

// The sweep compares each task's created_at against the wall clock, so pin now.
const NOW = Date.parse('2026-06-29T13:30:00Z');

// Imported after the env + mocks above: the handler reads them at module load.
import { handler } from '../../src/handlers/iteration-heartbeat-sweep';

/** A RUNNING iteration task image, as the StatusIndex projects it. */
function runningTask(overrides: { taskId?: string; createdAt?: string } = {}) {
  return {
    task_id: { S: overrides.taskId ?? 'task-1' },
    status: { S: 'RUNNING' },
    created_at: { S: overrides.createdAt ?? '2026-06-29T13:20:00Z' }, // 10 min in
    channel_source: { S: 'linear' },
    pr_number: { N: '42' },
    channel_metadata: {
      M: {
        linear_workspace_id: { S: 'ws-1' },
        iteration_reply_comment_id: { S: 'reply-1' },
        trigger_comment_id: { S: 'cmt-1' },
        trigger_comment_issue_id: { S: 'issue-1' },
        orchestration_iteration: { S: 'true' },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  upsertThreadedReplyMock.mockResolvedValue('reply-1');
  ddbSend.mockResolvedValue({ Items: [runningTask()] });
});

afterEach(() => jest.restoreAllMocks());

describe('iteration heartbeat sweep', () => {
  test('edits the maturing reply through the channel, preserving a landed preview link', async () => {
    await handler();

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, parentCommentId, body, existingReplyId, options] = upsertThreadedReplyMock.mock.calls[0];
    // The channel builds the per-workspace context from the task's own workspace.
    expect(ctx).toEqual({ linearWorkspaceId: 'ws-1', registryTableName: REGISTRY });
    // The reply is addressed to the issue the trigger comment lives on, threaded
    // under that comment, editing the reply captured at trigger time.
    expect(issueId).toBe('issue-1');
    expect(parentCommentId).toBe('cmt-1');
    expect(existingReplyId).toBe('reply-1');
    expect(body).toContain('🔄 Working');
    // A separate writer appends the deploy preview to this same reply, so the
    // heartbeat must carry it over rather than overwrite it — AND, as the least
    // important writer of the three, it must yield entirely once the reply has
    // settled rather than re-render "working" over an outcome.
    // A liveness tick is progress, never an outcome, so it never asks for the
    // terminal writer's restore-if-overwritten behaviour.
    expect(options).toEqual({ preservePreview: true, skipIfSettled: true, repairIfOverwritten: false });
  });

  test('a task with no reply to mature is skipped, not edited', async () => {
    const noReply = runningTask();
    delete (noReply.channel_metadata.M as Record<string, unknown>).iteration_reply_comment_id;
    ddbSend.mockResolvedValue({ Items: [noReply] });

    await handler();
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });

  test('one task\'s edit failure does not stop the rest of the sweep', async () => {
    ddbSend.mockResolvedValue({
      Items: [runningTask({ taskId: 'task-1' }), runningTask({ taskId: 'task-2' })],
    });
    upsertThreadedReplyMock.mockRejectedValueOnce(new Error('surface hiccup'));

    await expect(handler()).resolves.toBeUndefined();
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
  });

  test('a query failure is swallowed — a cosmetic sweep never throws', async () => {
    ddbSend.mockRejectedValue(new Error('throttled'));
    await expect(handler()).resolves.toBeUndefined();
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });
});
