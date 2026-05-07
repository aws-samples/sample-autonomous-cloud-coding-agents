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
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';

import { handler } from '../../src/handlers/linear-webhook-processor';

function eventWith(payload: Record<string, unknown>): { raw_body: string } {
  return { raw_body: JSON.stringify(payload) };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'create',
    type: 'Issue',
    organizationId: 'org-1',
    actor: { id: 'user-1' },
    data: {
      id: 'issue-1',
      identifier: 'ABC-42',
      title: 'Fix the login bug',
      description: 'Users cannot log in.',
      projectId: 'project-1',
      teamId: 'team-1',
      labels: [{ id: 'lbl-bg', name: 'bgagent' }],
    },
    ...overrides,
  };
}

describe('linear-webhook-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
  });

  test('skips missing raw_body', async () => {
    await handler({ raw_body: '' });
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips malformed JSON', async () => {
    await handler({ raw_body: 'not-json-{' });
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips non-Issue payloads', async () => {
    await handler(eventWith({ type: 'Comment', data: { id: 'c-1' } }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when projectId is missing', async () => {
    const payload = issue();
    const data = { ...(payload.data as Record<string, unknown>) };
    delete data.projectId;
    payload.data = data;
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when project is not onboarded', async () => {
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    await handler(eventWith(issue()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when project mapping is removed', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'removed' } });
    await handler(eventWith(issue()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when trigger label is absent on create', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
    const payload = issue();
    (payload.data as Record<string, unknown>).labels = [{ id: 'l2', name: 'other' }];
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips update when labelIds did not change', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
    const payload = issue({ action: 'update', updatedFrom: { title: 'old' } });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips update when label was previously already present', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
    const payload = issue({
      action: 'update',
      updatedFrom: { labelIds: ['lbl-bg', 'lbl-other'] },
    });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when actor has no linked platform user', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: undefined });
    await handler(eventWith(issue()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('creates task with channel_source=linear and linear_* metadata', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({
        Item: {
          linear_identity: 'org-1#user-1',
          platform_user_id: 'cognito-user-1',
          status: 'active',
        },
      });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue()));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.task_description).toContain('ABC-42: Fix the login bug');
    expect(reqBody.task_description).toContain('Users cannot log in.');
    expect(ctx.userId).toBe('cognito-user-1');
    expect(ctx.channelSource).toBe('linear');
    expect(ctx.channelMetadata).toMatchObject({
      linear_issue_id: 'issue-1',
      linear_issue_identifier: 'ABC-42',
      linear_workspace_id: 'org-1',
      linear_project_id: 'project-1',
      linear_team_id: 'team-1',
    });
  });

  test('fires on update when labelIds newly include the trigger label', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue({
      action: 'update',
      updatedFrom: { labelIds: ['lbl-other'] },
    })));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('honors a custom label_filter set on the project mapping', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'triage' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    const payload = issue();
    (payload.data as Record<string, unknown>).labels = [{ id: 'lbl-t', name: 'Triage' }];
    await handler(eventWith(payload));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });
});
