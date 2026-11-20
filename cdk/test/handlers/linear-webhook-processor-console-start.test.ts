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
 * A trigger label added from the operator console arrives with ABCA's own Linear app
 * as the actor (no linked ABCA user). The console leaves a start claim; the processor
 * uses it only when the actor is unlinked, and releases it only once the task exists.
 */

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));
const reportIssueFailureMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
  fetchRecentComments: jest.fn(async () => []),
}));
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: jest.fn(async () => ({ accessToken: 'lin_at', scope: 'read write', workspaceSlug: 'acme', oauthSecretArn: 'arn' })),
  resolveSoleActiveLinearWorkspace: jest.fn(),
}));
jest.mock('../../src/handlers/shared/linear-issue-context-probe', () => {
  const actual = jest.requireActual('../../src/handlers/shared/linear-issue-context-probe');
  return { ...actual, probeLinearIssueContext: jest.fn(async () => ({ attachmentTitles: [], attachments: [], projectName: null, projectHasDocuments: false })) };
});
const readStartClaimMock = jest.fn();
const releaseStartClaimMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-console', () => ({
  readStartClaim: (...args: unknown[]) => readStartClaimMock(...args),
  releaseStartClaim: (...args: unknown[]) => releaseStartClaimMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = 'LinearDedup';

import { handler } from '../../src/handlers/linear-webhook-processor';

const labeled = (actorId: string) => ({
  raw_body: JSON.stringify({
    action: 'create',
    type: 'Issue',
    organizationId: 'org-1',
    actor: { id: actorId },
    data: { id: 'issue-1', identifier: 'ABC-42', title: 'Pause menu', description: '', projectId: 'project-1', teamId: 'team-1', labels: [{ id: 'lbl', name: 'bgagent' }] },
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  reportIssueFailureMock.mockResolvedValue(undefined);
  createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
  releaseStartClaimMock.mockResolvedValue(true);
});

/** Project mapping found; the app actor has no linked ABCA user. */
function unlinkedAppActor() {
  ddbSend
    .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
    .mockResolvedValueOnce({ Item: undefined });
}

test('a console start: unlinked app actor + claim -> task for the user who clicked Start, then the claim is released', async () => {
  unlinkedAppActor();
  readStartClaimMock.mockResolvedValue('cognito-user-7');
  await handler(labeled('linear-app-actor'));
  expect(readStartClaimMock).toHaveBeenCalledWith(expect.anything(), 'LinearDedup', 'issue-1', 'org-1');
  expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  expect(createTaskCoreMock.mock.calls[0][1]).toMatchObject({ userId: 'cognito-user-7' });
  expect(releaseStartClaimMock).toHaveBeenCalledWith(expect.anything(), 'LinearDedup', 'issue-1', 'cognito-user-7');
  expect(releaseStartClaimMock.mock.invocationCallOrder[0]).toBeGreaterThan(createTaskCoreMock.mock.invocationCallOrder[0]);
  expect(reportIssueFailureMock).not.toHaveBeenCalled();
});

test('a failure creating the task keeps the claim, so the retried delivery is still attributed', async () => {
  unlinkedAppActor();
  readStartClaimMock.mockResolvedValue('cognito-user-7');
  createTaskCoreMock.mockRejectedValueOnce(new Error('transient DynamoDB error'));
  await expect(handler(labeled('linear-app-actor'))).rejects.toThrow('transient DynamoDB error');
  expect(releaseStartClaimMock).not.toHaveBeenCalled();

  // Lambda retries the same delivery: the claim is still there and attributes the task.
  unlinkedAppActor();
  await handler(labeled('linear-app-actor'));
  expect(createTaskCoreMock).toHaveBeenCalledTimes(2);
  expect(createTaskCoreMock.mock.calls[1][1]).toMatchObject({ userId: 'cognito-user-7' });
  expect(releaseStartClaimMock).toHaveBeenCalledTimes(1);
});

test('a task the platform refuses keeps the claim until it expires', async () => {
  unlinkedAppActor();
  readStartClaimMock.mockResolvedValue('cognito-user-7');
  createTaskCoreMock.mockResolvedValueOnce({ statusCode: 503, body: JSON.stringify({ error: { message: 'busy' } }) });
  await handler(labeled('linear-app-actor'));
  expect(releaseStartClaimMock).not.toHaveBeenCalled();
});

test('a failed release does not fail a task that was already created', async () => {
  unlinkedAppActor();
  readStartClaimMock.mockResolvedValue('cognito-user-7');
  releaseStartClaimMock.mockRejectedValueOnce(new Error('throttled'));
  await expect(handler(labeled('linear-app-actor'))).resolves.toBeUndefined();
  expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
});

test('a linked person adding the label is attributed to themselves, and no claim is read or released', async () => {
  ddbSend
    .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
    .mockResolvedValueOnce({ Item: { linear_identity: 'org-1#user-1', platform_user_id: 'cognito-user-1', status: 'active' } });
  await handler(labeled('user-1'));
  expect(readStartClaimMock).not.toHaveBeenCalled();
  expect(releaseStartClaimMock).not.toHaveBeenCalled();
  expect(createTaskCoreMock.mock.calls[0][1]).toMatchObject({ userId: 'cognito-user-1' });
});

test('an unlinked actor without a claim still gets the "not linked" reply', async () => {
  ddbSend
    .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
    .mockResolvedValueOnce({ Item: undefined });
  readStartClaimMock.mockResolvedValue(null);
  await handler(labeled('stranger'));
  expect(createTaskCoreMock).not.toHaveBeenCalled();
  expect(reportIssueFailureMock.mock.calls[0][2]).toContain("isn't linked to a platform user");
});

test('a claim lookup failure falls back to the "not linked" reply instead of crashing', async () => {
  ddbSend
    .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
    .mockResolvedValueOnce({ Item: undefined });
  readStartClaimMock.mockRejectedValue(new Error('throttled'));
  await handler(labeled('linear-app-actor'));
  expect(createTaskCoreMock).not.toHaveBeenCalled();
  expect(reportIssueFailureMock).toHaveBeenCalled();
});
