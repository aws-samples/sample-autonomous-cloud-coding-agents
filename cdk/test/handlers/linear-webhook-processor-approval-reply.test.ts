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

/**
 * Routing of Linear approval replies (#1001) in the webhook processor: a
 * Comment is offered to the approval-reply handler BEFORE the `@bgagent`
 * comment-trigger path, and a handled reply stops there. The reply handler's
 * own consent/owner checks are covered in linear-approval-reply.test.ts.
 */

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: jest.fn(),
  fetchRecentComments: jest.fn(),
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
  resolveSoleActiveLinearWorkspace: jest.fn(),
}));

const handleLinearApprovalReplyMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-approval-reply', () => ({
  handleLinearApprovalReply: (...args: unknown[]) => handleLinearApprovalReplyMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.ORCHESTRATION_TABLE_NAME = 'Orchestrations';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';

import { handler } from '../../src/handlers/linear-webhook-processor';

function comment(body: string): { raw_body: string } {
  return {
    raw_body: JSON.stringify({
      action: 'create',
      type: 'Comment',
      organizationId: 'org-1',
      actor: { id: 'linear-user-1', type: 'user' },
      data: { id: 'c-reply', body, issueId: 'issue-1', parentId: 'c-notice', userId: 'linear-user-1' },
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveLinearOauthTokenMock.mockResolvedValue(null);
});

describe('linear-webhook-processor approval reply routing (#1001)', () => {
  test('offers the comment to the approval-reply handler with the approvals, task and registry tables', async () => {
    handleLinearApprovalReplyMock.mockResolvedValue(true);
    await handler(comment('approve'));
    expect(handleLinearApprovalReplyMock).toHaveBeenCalledTimes(1);
    const [payload, deps] = handleLinearApprovalReplyMock.mock.calls[0];
    expect(payload).toMatchObject({ type: 'Comment', data: { id: 'c-reply', body: 'approve' } });
    expect(deps).toMatchObject({
      approvalsTable: 'Approvals',
      taskTable: 'Tasks',
      registryTable: 'LinearWorkspaceRegistry',
    });
    expect(typeof deps.lookupUser).toBe('function');
  });

  test('a handled reply stops before the @bgagent comment-trigger path', async () => {
    handleLinearApprovalReplyMock.mockResolvedValue(true);
    await handler(comment('@bgagent approve'));
    expect(resolveLinearOauthTokenMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an unhandled comment falls through to the @bgagent comment-trigger path', async () => {
    handleLinearApprovalReplyMock.mockResolvedValue(false);
    await handler(comment('@bgagent please address the review'));
    expect(handleLinearApprovalReplyMock).toHaveBeenCalledTimes(1);
    expect(resolveLinearOauthTokenMock).toHaveBeenCalledWith('org-1', 'LinearWorkspaceRegistry');
  });

  test('Issue events never reach the approval-reply handler', async () => {
    await handler({ raw_body: JSON.stringify({ action: 'create', type: 'Issue', organizationId: 'org-1', data: { id: 'issue-1' } }) });
    expect(handleLinearApprovalReplyMock).not.toHaveBeenCalled();
  });
});
