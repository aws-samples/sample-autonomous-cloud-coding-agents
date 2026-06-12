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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _t: 'Get', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...a: unknown[]) => createTaskCoreMock(...a),
}));

const findChildByBranchMock = jest.fn();
const loadOrchestrationMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-store', () => ({
  findOrchestrationChildByBranch: (...a: unknown[]) => findChildByBranchMock(...a),
  loadOrchestration: (...a: unknown[]) => loadOrchestrationMock(...a),
}));

const planRestackMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-restack', () => ({
  planRestack: (...a: unknown[]) => planRestackMock(...a),
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchTable';
process.env.ORCHESTRATION_CHILD_BRANCH_INDEX = 'ChildBranchIndex';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/orchestration-restack-processor';

function prEvent(action: string, ref: string, sha = 'sha123'): { raw_body: string } {
  return {
    raw_body: JSON.stringify({
      action,
      pull_request: { head: { ref, sha } },
      repository: { full_name: 'owner/repo' },
    }),
  };
}

const childRow = (sub: string, deps: string[] = []) => ({
  orchestration_id: 'orch_1', sub_issue_id: sub, depends_on: deps,
  child_status: 'released', child_task_id: `task-${sub}`, child_branch_name: `branch-${sub}`,
});

describe('orchestration-restack-processor', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    findChildByBranchMock.mockReset();
    loadOrchestrationMock.mockReset();
    planRestackMock.mockReset();
  });

  test('non-orchestration branch (no child) → no-op, no task created', async () => {
    findChildByBranchMock.mockResolvedValueOnce(null);
    await handler(prEvent('synchronize', 'feature/human-branch'));
    expect(loadOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('predecessor changed with no dependents → no task created', async () => {
    findChildByBranchMock.mockResolvedValueOnce(childRow('A'));
    loadOrchestrationMock.mockResolvedValueOnce({
      meta: { release_context: { platform_user_id: 'u1' } },
      children: [childRow('A')],
    });
    planRestackMock.mockReturnValueOnce([]);
    await handler(prEvent('synchronize', 'branch-A'));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('changed predecessor → creates a restack task per dependent with merge branches + pr_number', async () => {
    findChildByBranchMock.mockResolvedValueOnce(childRow('A'));
    loadOrchestrationMock.mockResolvedValueOnce({
      meta: { release_context: { platform_user_id: 'u1' } },
      children: [childRow('A'), childRow('B', ['A'])],
    });
    planRestackMock.mockReturnValueOnce([
      { child: childRow('B', ['A']), mergeBranches: ['branch-A'] },
    ]);
    // resolvePrNumber → GetCommand on TaskTable returns the dependent's PR#.
    ddbSend.mockResolvedValueOnce({ Item: { pr_number: 42 } });

    await handler(prEvent('synchronize', 'branch-A', 'shaABC'));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx, reqId] = createTaskCoreMock.mock.calls[0];
    expect(body).toMatchObject({ repo: 'owner/repo', workflow_ref: 'coding/restack-v1', pr_number: 42 });
    expect(ctx.channelSource).toBe('webhook');
    expect(ctx.channelMetadata.orchestration_merge_branches).toBe(JSON.stringify(['branch-A']));
    expect(ctx.channelMetadata.restack_predecessor_sub_issue_id).toBe('A');
    // idempotency key includes the predecessor head SHA (one re-stack per update)
    expect(ctx.idempotencyKey).toContain('shaABC');
    expect(reqId).toBe(ctx.idempotencyKey);
  });

  test('resolves PR number from pr_url when pr_number is null (orchestration child tasks)', async () => {
    findChildByBranchMock.mockResolvedValueOnce(childRow('A'));
    loadOrchestrationMock.mockResolvedValueOnce({
      meta: { release_context: { platform_user_id: 'u1' } },
      children: [childRow('A'), childRow('B', ['A'])],
    });
    planRestackMock.mockReturnValueOnce([{ child: childRow('B', ['A']), mergeBranches: ['branch-A'] }]);
    // pr_number null, but pr_url carries .../pull/113 — the fallback path.
    ddbSend.mockResolvedValueOnce({ Item: { pr_number: null, pr_url: 'https://github.com/o/r/pull/113' } });
    await handler(prEvent('synchronize', 'branch-A'));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(113);
  });

  test('dependent with neither pr_number nor pr_url → skipped (no task)', async () => {
    findChildByBranchMock.mockResolvedValueOnce(childRow('A'));
    loadOrchestrationMock.mockResolvedValueOnce({
      meta: { release_context: { platform_user_id: 'u1' } },
      children: [childRow('A'), childRow('B', ['A'])],
    });
    planRestackMock.mockReturnValueOnce([{ child: childRow('B', ['A']), mergeBranches: ['branch-A'] }]);
    ddbSend.mockResolvedValueOnce({ Item: {} }); // neither field
    await handler(prEvent('synchronize', 'branch-A'));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('missing branch/sha → no-op', async () => {
    await handler({ raw_body: JSON.stringify({ action: 'synchronize', pull_request: {} }) });
    expect(findChildByBranchMock).not.toHaveBeenCalled();
  });
});
