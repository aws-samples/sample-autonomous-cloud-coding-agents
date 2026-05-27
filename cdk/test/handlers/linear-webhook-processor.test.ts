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

const reportIssueFailureMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const probeLinearIssueContextMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-issue-context-probe', () => {
  const actual = jest.requireActual('../../src/handlers/shared/linear-issue-context-probe');
  return {
    ...actual,
    probeLinearIssueContext: (...args: unknown[]) => probeLinearIssueContextMock(...args),
  };
});

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

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
      labels: [{ id: 'lbl-abca', name: 'abca' }],
    },
    ...overrides,
  };
}

describe('linear-webhook-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    resolveLinearOauthTokenMock.mockReset();
    // Default: workspace not in registry. Tests that need a token override.
    resolveLinearOauthTokenMock.mockResolvedValue(null);
    probeLinearIssueContextMock.mockReset();
    probeLinearIssueContextMock.mockResolvedValue({
      attachmentTitles: [],
      projectName: null,
      projectHasDocuments: false,
    });
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
      updatedFrom: { labelIds: ['lbl-abca', 'lbl-other'] },
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
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
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

  describe('user-visible feedback on silent-failure paths', () => {
    test('posts comment + ❌ when issue has no projectId', async () => {
      const payload = issue();
      const data = { ...(payload.data as Record<string, unknown>) };
      delete data.projectId;
      payload.data = data;

      await handler(eventWith(payload));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [ctx, issueId, message] = reportIssueFailureMock.mock.calls[0];
      // Phase 2.0b-O2: feedback context carries workspace id + registry table name
      // (the resolver does the secret lookup downstream).
      expect(ctx).toEqual({
        linearWorkspaceId: payload.organizationId,
        registryTableName: process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME,
      });
      expect(issueId).toBe('issue-1');
      expect(message).toContain("isn't in a project");
    });

    test('posts feedback when project is not onboarded', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [, issueId, message] = reportIssueFailureMock.mock.calls[0];
      expect(issueId).toBe('issue-1');
      expect(message).toContain("isn't onboarded");
      expect(message).toContain('bgagent linear onboard-project');
    });

    test('posts feedback when project mapping is removed', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'removed' } });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    });

    test('posts feedback when actor has no linked platform user', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: undefined });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [, , message] = reportIssueFailureMock.mock.calls[0];
      expect(message).toContain("isn't linked to a platform user");
      expect(message).toContain('multi-user OAuth');
    });

    test('skips feedback (no org → no workspace token) when webhook is missing organization', async () => {
      // Phase 2.0b-O2: feedback requires the workspace's OAuth token, which
      // is keyed on `organizationId`. If the webhook payload omits it, we
      // cannot resolve any token, so the feedback path skips with a WARN
      // instead of trying to post anonymously. The empty-org case is
      // pathological enough (Linear always sends organizationId) that
      // logging-only is acceptable.
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
      const payload = issue({ organizationId: '', actor: undefined });
      const data = { ...(payload.data as Record<string, unknown>) };
      delete data.creatorId;
      payload.data = data;

      await handler(eventWith(payload));

      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('surfaces guardrail block message on createTaskCore 400', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 400,
        body: JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Task description was blocked by content policy.',
            request_id: 'req-1',
          },
        }),
      });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [, , message] = reportIssueFailureMock.mock.calls[0];
      expect(message).toContain('blocked by content policy');
      expect(message).toContain("couldn't accept this task");
    });

    test('surfaces 503 retry message on createTaskCore service-unavailable', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 503,
        body: JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Content screening is temporarily unavailable. Please try again later.',
            request_id: 'req-1',
          },
        }),
      });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [, , message] = reportIssueFailureMock.mock.calls[0];
      expect(message).toContain('temporarily unavailable');
      expect(message).toContain('re-apply the trigger label');
    });

    test('does NOT post feedback on the happy 201 path', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('does NOT post feedback on filter-rejected events (e.g. label not present)', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
      const payload = issue();
      (payload.data as Record<string, unknown>).labels = [{ id: 'l2', name: 'other' }];

      await handler(eventWith(payload));

      // Filter rejection is intentional UX (not every Linear event triggers ABCA);
      // dropping a comment/❌ here would be noisy and misleading.
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('unlabeled issue in a NON-onboarded project is a silent no-op (regression: comment-spam)', async () => {
      // Workspace webhooks fire workspace-wide — issues in teams that ABCA
      // was never onboarded into still reach this Lambda. Previously, every
      // such event posted a "❌ project isn't onboarded" comment, producing
      // 47 identical comments in 5min on a single GRO issue. The label gate
      // now runs FIRST, so an unlabeled issue produces zero side effects no
      // matter what state the project mapping is in.
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      const payload = issue();
      (payload.data as Record<string, unknown>).labels = [{ id: 'l2', name: 'other' }];

      await handler(eventWith(payload));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('unlabeled issue with no projectId is a silent no-op', async () => {
      const payload = issue();
      const data = { ...(payload.data as Record<string, unknown>) };
      delete data.projectId;
      data.labels = [{ id: 'l2', name: 'other' }];
      payload.data = data;

      await handler(eventWith(payload));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('safeReportIssueFailure: synchronous throw from reportIssueFailure does not propagate', async () => {
      // Defends against a future signature refactor that breaks the helper's
      // never-throw contract. Today `Promise.allSettled` guarantees this; if
      // someone removes that, the surrounding catch keeps the Lambda from
      // failing and triggering SQS retries on a poison message.
      reportIssueFailureMock.mockImplementationOnce(() => {
        throw new Error('synthetic synchronous throw');
      });
      const payload = issue();
      const data = { ...(payload.data as Record<string, unknown>) };
      delete data.projectId;
      payload.data = data;

      await expect(handler(eventWith(payload))).resolves.toBeUndefined();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    });

    test('safeReportIssueFailure: async rejection from reportIssueFailure does not propagate', async () => {
      // The helper's internal `Promise.allSettled` already guarantees this,
      // but the orchestrator path's parallel catch motivated adding the same
      // belt-and-suspenders here. This test locks in the contract so a
      // refactor of either helper layer can't reintroduce the failure mode.
      reportIssueFailureMock.mockRejectedValueOnce(new Error('async failure'));
      const payload = issue();
      const data = { ...(payload.data as Record<string, unknown>) };
      delete data.projectId;
      payload.data = data;

      await expect(handler(eventWith(payload))).resolves.toBeUndefined();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Image URL extraction from issue description ─────────────────────────────

  describe('image URL attachment extraction', () => {
    beforeEach(() => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
    });

    test('extracts markdown image URLs from issue description', async () => {
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      data.description = 'See this bug:\n\n![screenshot](https://linear.app/uploads/img1.png)\n\nAnd also ![diagram](https://linear.app/uploads/arch.png)';

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(2);
      expect(reqBody.attachments[0]).toEqual({ type: 'url', url: 'https://linear.app/uploads/img1.png' });
      expect(reqBody.attachments[1]).toEqual({ type: 'url', url: 'https://linear.app/uploads/arch.png' });
    });

    test('does not extract HTTP (non-HTTPS) URLs', async () => {
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      data.description = '![unsafe](http://evil.com/img.png)';

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });

    test('caps image extraction at 10 URLs', async () => {
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      const lines = Array.from({ length: 15 }, (_, i) => `![img${i}](https://cdn.linear.app/img${i}.png)`);
      data.description = lines.join('\n');

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(10);
    });

    test('no attachments when description has no images', async () => {
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      data.description = 'Just text, no images here.';

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });

    test('no attachments when description is undefined', async () => {
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      delete data.description;

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });

    test('skips uploads.linear.app images so the unauthenticated URL resolver does not 401', async () => {
      // Linear's CDN requires the workspace OAuth token to fetch, which the
      // orchestrator's URL-resolver does NOT have. The agent picks these up
      // at runtime via mcp__linear-server__extract_images instead, per the
      // Linear-channel prompt addendum.
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      data.description = [
        '![paste](https://uploads.linear.app/15d12f61/090e5ce6/938f90d7)',
        '![public](https://i.imgur.com/abc.png)',
      ].join('\n');

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      // Only the public image survives the filter.
      expect(reqBody.attachments).toHaveLength(1);
      expect(reqBody.attachments[0].url).toBe('https://i.imgur.com/abc.png');
    });

    test('drops attachments entirely when only uploads.linear.app images are present', async () => {
      const payload = issue();
      const data = payload.data as Record<string, unknown>;
      data.description = '![only](https://uploads.linear.app/x/y/z)';

      await handler(eventWith(payload));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });
  });

  // ─── Linear issue context probe (paperclip attachments + project docs) ──────

  describe('linear issue context probe', () => {
    beforeEach(() => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      // Resolver must yield an access token for the probe to be called.
      resolveLinearOauthTokenMock.mockResolvedValue({
        accessToken: 'lin_oauth_token',
        scope: 'read,write,issues:create,comments:create',
        workspaceSlug: 'demo',
        oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:000:secret:bgagent-linear-oauth-demo-AbCdEf',
      });
    });

    test('probes Linear with the resolved access token and the issue id', async () => {
      await handler(eventWith(issue()));
      expect(probeLinearIssueContextMock).toHaveBeenCalledTimes(1);
      const [token, issueId] = probeLinearIssueContextMock.mock.calls[0];
      expect(token).toBe('lin_oauth_token');
      expect(issueId).toBe('issue-1');
    });

    test('prepends a hint listing paperclip attachment titles when present', async () => {
      probeLinearIssueContextMock.mockResolvedValueOnce({
        attachmentTitles: ['design-spec.pdf', 'crash-trace.txt'],
        projectName: 'Onboarding',
        projectHasDocuments: false,
      });

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toContain('Linear may have additional context');
      expect(reqBody.task_description).toContain('design-spec.pdf');
      expect(reqBody.task_description).toContain('crash-trace.txt');
      expect(reqBody.task_description).toContain('mcp__linear-server__get_attachment');
      // The original description must still be present, not replaced.
      expect(reqBody.task_description).toContain('Users cannot log in.');
    });

    test('prepends a hint about project documents when the project has wiki docs', async () => {
      probeLinearIssueContextMock.mockResolvedValueOnce({
        attachmentTitles: [],
        projectName: 'Onboarding',
        projectHasDocuments: true,
      });

      await handler(eventWith(issue()));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toContain('project "Onboarding"');
      expect(reqBody.task_description).toContain('wiki documents');
      expect(reqBody.task_description).toContain('mcp__linear-server__list_documents');
    });

    test('omits the hint when probe finds nothing', async () => {
      // Default mock already returns an empty probe.
      await handler(eventWith(issue()));
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).not.toContain('Linear may have additional context');
      // Sanity: original task description still in place.
      expect(reqBody.task_description).toContain('ABC-42: Fix the login bug');
    });
  });
});

// ─── Direct probe behavior — covers the GraphQL query shape ─────────────────

describe('probeLinearIssueContext', () => {
  // The mock above only intercepts the version imported by the handler under
  // test. To verify the actual GraphQL query and field selections we exercise
  // the real module against a stubbed fetch.
  const realModule = jest.requireActual('../../src/handlers/shared/linear-issue-context-probe') as {
    probeLinearIssueContext: (token: string, issueId: string) => Promise<unknown>;
  };

  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('GraphQL query includes attachments and project.documents fields', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            attachments: { nodes: [{ id: 'att1', title: 'spec.pdf' }] },
            project: { id: 'proj1', name: 'P1', documents: { nodes: [{ id: 'doc1' }] } },
          },
        },
      }),
    });

    const result = await realModule.probeLinearIssueContext('tok', 'issue-uuid-1') as {
      attachmentTitles: string[];
      projectName: string | null;
      projectHasDocuments: boolean;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as { query: string; variables: { id: string } };
    expect(body.variables.id).toBe('issue-uuid-1');
    expect(body.query).toContain('attachments');
    expect(body.query).toContain('project');
    expect(body.query).toContain('documents');
    expect(result).toEqual({
      attachmentTitles: ['spec.pdf'],
      projectName: 'P1',
      projectHasDocuments: true,
    });
  });

  test('returns empty probe on graphql errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: 'boom' }] }),
    });
    const result = await realModule.probeLinearIssueContext('tok', 'i') as {
      attachmentTitles: string[];
    };
    expect(result.attachmentTitles).toEqual([]);
  });

  test('returns empty probe on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const result = await realModule.probeLinearIssueContext('tok', 'i') as {
      projectHasDocuments: boolean;
    };
    expect(result.projectHasDocuments).toBe(false);
  });

  test('returns empty probe on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const result = await realModule.probeLinearIssueContext('tok', 'i') as {
      attachmentTitles: string[];
    };
    expect(result.attachmentTitles).toEqual([]);
  });
});
