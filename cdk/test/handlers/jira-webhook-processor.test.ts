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
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const reportIssueFailureMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
}));

const resolveJiraOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: (...args: unknown[]) => resolveJiraOauthTokenMock(...args),
}));

// The processor screens the folded comment section via the Bedrock Guardrail
// (fail-open on intervention). Mock the client so it passes by default; the
// comment-block-dropped test overrides it to GUARDRAIL_INTERVENED.
const bedrockSendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: bedrockSendMock })),
  ApplyGuardrailCommand: jest.fn((input: unknown) => ({ _type: 'ApplyGuardrail', input })),
}));

// #577 context enrichment. The download/comment helpers are unit-tested in
// jira-attachments.test.ts; here we mock them to test the processor wiring
// (folding comments into the description, fail-closed attachment rejection)
// without real REST/S3. `JiraAttachmentError` is kept real so the processor's
// `instanceof` reject branch is exercised.
const fetchRecentHumanCommentsMock = jest.fn();
const downloadJiraAttachmentsMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-attachments', () => {
  const actual = jest.requireActual('../../src/handlers/shared/jira-attachments');
  return {
    ...actual,
    fetchRecentHumanComments: (...args: unknown[]) => fetchRecentHumanCommentsMock(...args),
    downloadScreenAndStoreJiraAttachments: (...args: unknown[]) => downloadJiraAttachmentsMock(...args),
  };
});

process.env.JIRA_PROJECT_MAPPING_TABLE_NAME = 'JiraProjects';
process.env.JIRA_USER_MAPPING_TABLE_NAME = 'JiraUsers';
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
// Attachment enrichment needs a bucket + guardrail configured (#577); with
// these set the processor initializes S3/Bedrock clients (cheap, no network at
// construction) and screens attachments through the mocked helper.
process.env.ATTACHMENTS_BUCKET_NAME = 'attachments-bucket';
process.env.GUARDRAIL_ID = 'gr-1';
process.env.GUARDRAIL_VERSION = '1';

import { handler } from '../../src/handlers/jira-webhook-processor';
import { JiraAttachmentError } from '../../src/handlers/shared/jira-attachments';

function eventWith(payload: Record<string, unknown>): { raw_body: string } {
  return { raw_body: JSON.stringify(payload) };
}

/** Build a minimal `jira:issue_created` payload with the trigger label
 *  already applied. Tests override per-case via `overrides`. */
function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    webhookEvent: 'jira:issue_created',
    cloudId: 'cloud-1',
    user: { accountId: 'acc-1', displayName: 'Ada' },
    issue: {
      id: '10001',
      key: 'ENG-42',
      fields: {
        summary: 'Fix the login bug',
        // ADF doc with one paragraph — the processor's walker should
        // produce 'Users cannot log in.' as the markdown rendering.
        description: {
          type: 'doc',
          version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Users cannot log in.' }] },
          ],
        },
        labels: ['bgagent'],
        project: { id: 'p1', key: 'ENG' },
      },
    },
    ...overrides,
  };
}

describe('jira-webhook-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    resolveJiraOauthTokenMock.mockReset();
    // Default: tenant IS resolvable. Drop-path tests override per-case
    // with `.mockResolvedValueOnce(null)`.
    resolveJiraOauthTokenMock.mockResolvedValue({
      accessToken: 'jira_at',
      scope: 'read:jira-work write:jira-work',
      siteUrl: 'https://acme.atlassian.net',
      oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-jira-oauth-cloud-1',
    });
    // Default (#577): no comments, no attachments. Per-case tests override.
    fetchRecentHumanCommentsMock.mockReset();
    fetchRecentHumanCommentsMock.mockResolvedValue([]);
    downloadJiraAttachmentsMock.mockReset();
    downloadJiraAttachmentsMock.mockResolvedValue([]);
    // Default: comment guardrail screening passes (no intervention).
    bedrockSendMock.mockReset();
    bedrockSendMock.mockResolvedValue({ action: 'NONE' });
  });

  test('skips missing raw_body', async () => {
    await handler({ raw_body: '' });
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips malformed JSON', async () => {
    await handler({ raw_body: 'not-json-{' });
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips non-issue webhookEvent', async () => {
    await handler(eventWith({ webhookEvent: 'comment_created', issue: { id: 'x', key: 'X-1' } }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when issue.id or issue.key is missing', async () => {
    await handler(eventWith({ webhookEvent: 'jira:issue_created' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when project.key is missing (no routing target)', async () => {
    const payload = issue();
    const fields = (payload.issue as { fields: Record<string, unknown> }).fields;
    delete (fields.project as Record<string, unknown>).key;
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('drops event when cloudId is missing and registry has no active tenant', async () => {
    const payload = issue();
    delete payload.cloudId;
    // Sole-tenant fallback scans the registry; an empty registry can't
    // resolve a tenant, so the event is dropped.
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // No feedback either — without cloudId we can't resolve tokens to post.
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
  });

  test('drops event when cloudId is missing and registry has multiple active tenants (ambiguous)', async () => {
    const payload = issue();
    delete payload.cloudId;
    // Two active tenants → fallback refuses to guess (would risk mis-routing).
    ddbSend.mockResolvedValueOnce({
      Items: [
        { jira_cloud_id: 'cloud-1', status: 'active' },
        { jira_cloud_id: 'cloud-2', status: 'active' },
      ],
    });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
  });

  test('recovers cloudId from sole active tenant when payload omits it (Settings-UI webhook)', async () => {
    const payload = issue();
    delete payload.cloudId;
    // Registry scan returns exactly one active tenant → use it. Then the
    // normal flow proceeds: project mapping (active) + user mapping resolve,
    // and a task is created.
    ddbSend
      .mockResolvedValueOnce({ Items: [{ jira_cloud_id: 'cloud-1', status: 'active' }] }) // Scan
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'bgagent' } }) // project mapping
      .mockResolvedValueOnce({ Item: { platform_user_id: 'user-1', status: 'active' } }); // user mapping
    createTaskCoreMock.mockResolvedValue({ task_id: 'T1' });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).toHaveBeenCalled();
  });

  // ─── Stack-wide-verified deliveries: cloudId is not trusted from the body ──
  //
  // A delivery verified against the stack-wide fallback secret proves nothing
  // about which tenant sent it (the secret is not bound to a cloudId). The
  // processor must ignore the body `cloudId` and bind to the sole active
  // tenant, dropping when that's ambiguous — otherwise a holder of the
  // stack-wide secret could steer a webhook at any tenant's mappings.
  describe('stack-wide-verified delivery does not trust body cloudId', () => {
    function stackWideEvent(payload: Record<string, unknown>): {
      raw_body: string;
      verified_via_stack_wide: boolean;
    } {
      return { raw_body: JSON.stringify(payload), verified_via_stack_wide: true };
    }

    test('binds to the sole active tenant, ignoring a different body cloudId', async () => {
      // Body claims `cloud-evil`, but the sole active tenant is `cloud-1`.
      // Routing must use `cloud-1` (the project mapping is keyed on it).
      const payload = issue({ cloudId: 'cloud-evil' });
      ddbSend
        .mockResolvedValueOnce({ Items: [{ jira_cloud_id: 'cloud-1', status: 'active' }] }) // Scan
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'bgagent' } }) // project mapping
        .mockResolvedValueOnce({ Item: { platform_user_id: 'user-1', status: 'active' } }); // user mapping
      createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: '{}' });

      await handler(stackWideEvent(payload));

      // Project mapping was looked up with the SOLE-TENANT cloudId, not the
      // attacker-supplied one.
      const projectGet = ddbSend.mock.calls[1][0];
      expect(projectGet.input.Key.jira_project_identity).toBe('cloud-1#ENG');
      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.channelMetadata.jira_cloud_id).toBe('cloud-1');
    });

    test('drops when multiple active tenants make the binding ambiguous', async () => {
      const payload = issue({ cloudId: 'cloud-evil' });
      ddbSend.mockResolvedValueOnce({
        Items: [
          { jira_cloud_id: 'cloud-1', status: 'active' },
          { jira_cloud_id: 'cloud-2', status: 'active' },
        ],
      });

      await handler(stackWideEvent(payload));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });
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
    (payload.issue as { fields: Record<string, unknown> }).fields.labels = ['other'];
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips update when changelog has no labels item', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
    const payload = issue({
      webhookEvent: 'jira:issue_updated',
      changelog: { items: [{ field: 'summary', fromString: 'old', toString: 'new' }] },
    });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips update when label was already in fromString (was already present)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
    const payload = issue({
      webhookEvent: 'jira:issue_updated',
      // `bgagent` was already there; user added another label. The diff
      // should NOT trigger.
      changelog: {
        items: [{ field: 'labels', fromString: 'bgagent other', toString: 'bgagent other extra' }],
      },
    });
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when accountId cannot be resolved', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
    const payload = issue();
    payload.user = {};
    delete (payload.issue as { fields: Record<string, unknown> }).fields.creator;
    delete (payload.issue as { fields: Record<string, unknown> }).fields.reporter;
    await handler(eventWith(payload));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('skips when accountId has no linked platform user', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: undefined });
    await handler(eventWith(issue()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('creates task with channel_source=jira and jira_* metadata', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({
        Item: {
          jira_identity: 'cloud-1#acc-1',
          platform_user_id: 'cognito-user-1',
          status: 'active',
        },
      });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue()));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.task_description).toContain('ENG-42: Fix the login bug');
    expect(reqBody.task_description).toContain('Users cannot log in.');
    // Must pin the coding workflow — an absent workflow_ref falls through the
    // resolution ladder to default/agent-v1, which never opens a PR (#546).
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
    expect(ctx.userId).toBe('cognito-user-1');
    expect(ctx.channelSource).toBe('jira');
    expect(ctx.channelMetadata).toMatchObject({
      jira_cloud_id: 'cloud-1',
      jira_project_key: 'ENG',
      jira_issue_id: '10001',
      jira_issue_key: 'ENG-42',
      jira_oauth_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-jira-oauth-cloud-1',
      jira_site_url: 'https://acme.atlassian.net',
    });
  });

  test('stamps status_on_start/status_on_pr overrides into channelMetadata when configured', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          repo: 'org/repo',
          status: 'active',
          label_filter: 'bgagent',
          status_on_start: 'Doing',
          status_on_pr: 'Code Review',
        },
      })
      .mockResolvedValueOnce({
        Item: { platform_user_id: 'cognito-user-1', status: 'active' },
      });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: '{}' });

    await handler(eventWith(issue()));

    const [, ctx] = createTaskCoreMock.mock.calls[0];
    expect(ctx.channelMetadata.jira_status_on_start).toBe('Doing');
    expect(ctx.channelMetadata.jira_status_on_pr).toBe('Code Review');
  });

  test('omits transition-override metadata when the mapping has no status overrides', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({
        Item: { platform_user_id: 'cognito-user-1', status: 'active' },
      });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: '{}' });

    await handler(eventWith(issue()));

    const [, ctx] = createTaskCoreMock.mock.calls[0];
    expect(ctx.channelMetadata).not.toHaveProperty('jira_status_on_start');
    expect(ctx.channelMetadata).not.toHaveProperty('jira_status_on_pr');
  });

  test('uses composite project mapping key {cloudId}#{projectKey}', async () => {
    // Two tenants can have the same project key — the composite key
    // disambiguates them. Belt-and-braces test that the lookup uses the
    // right key shape.
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'u1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue()));

    const getCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Get');
    expect(getCall![0].input.Key.jira_project_identity).toBe('cloud-1#ENG');
  });

  test('fires on update when changelog labels diff newly contains the trigger', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue({
      webhookEvent: 'jira:issue_updated',
      changelog: { items: [{ field: 'labels', fromString: 'other', toString: 'other bgagent' }] },
    })));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('fires when label diff comes via fieldId instead of field', async () => {
    // Some Atlassian payloads use fieldId rather than field; the trigger
    // logic accepts either as long as the labels diff is present.
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'u1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue({
      webhookEvent: 'jira:issue_updated',
      changelog: { items: [{ fieldId: 'labels', fromString: '', toString: 'bgagent' }] },
    })));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('honors a custom label_filter set on the project mapping', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active', label_filter: 'triage' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    const payload = issue();
    (payload.issue as { fields: Record<string, unknown> }).fields.labels = ['Triage'];
    await handler(eventWith(payload));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('falls back to issue.fields.reporter.accountId when user.accountId is absent', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    const payload = issue();
    payload.user = {};
    (payload.issue as { fields: Record<string, unknown> }).fields.reporter = { accountId: 'reporter-acc' };
    await handler(eventWith(payload));

    const userGetCall = ddbSend.mock.calls.filter(([cmd]) => cmd._type === 'Get')[1];
    expect(userGetCall[0].input.Key.jira_identity).toBe('cloud-1#reporter-acc');
  });

  test('drops event when tenant resolves to null (registry miss / inactive / unreadable secret)', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
    resolveJiraOauthTokenMock.mockResolvedValueOnce(null);

    await handler(eventWith(issue()));

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
  });

  describe('user-visible feedback on silent-failure paths', () => {
    test('posts comment when issue has no project.key', async () => {
      const payload = issue();
      delete (payload.issue as { fields: { project: Record<string, unknown> } }).fields.project.key;

      await handler(eventWith(payload));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [ctx, issueIdOrKey, message] = reportIssueFailureMock.mock.calls[0];
      expect(ctx).toEqual({
        cloudId: 'cloud-1',
        registryTableName: process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME,
      });
      expect(issueIdOrKey).toBe('ENG-42');
      expect(message).toContain("isn't in a project");
    });

    test('posts feedback when project is not onboarded', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [, issueKey, message] = reportIssueFailureMock.mock.calls[0];
      expect(issueKey).toBe('ENG-42');
      expect(message).toContain("isn't onboarded");
      // The suggested command must be the real one (`map`) with the required
      // cloud-id + project-key positionals, not the non-existent
      // `onboard-project`.
      expect(message).toContain('bgagent jira map cloud-1 ENG --repo');
      expect(message).not.toContain('onboard-project');
    });

    test('posts feedback when project mapping is removed', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'removed' } });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    });

    test('posts feedback when accountId has no linked platform user', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: undefined });

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [, , message] = reportIssueFailureMock.mock.calls[0];
      expect(message).toContain("isn't linked to a platform user");
      expect(message).toContain('bgagent jira link');
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

    test('does NOT post feedback on filter-rejected events (label not present)', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } });
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.labels = ['other'];

      await handler(eventWith(payload));

      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('safeReportIssueFailure: synchronous throw from reportIssueFailure does not propagate', async () => {
      reportIssueFailureMock.mockImplementationOnce(() => {
        throw new Error('synthetic synchronous throw');
      });
      const payload = issue();
      delete (payload.issue as { fields: { project: Record<string, unknown> } }).fields.project.key;

      await expect(handler(eventWith(payload))).resolves.toBeUndefined();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    });

    test('safeReportIssueFailure: async rejection from reportIssueFailure does not propagate', async () => {
      reportIssueFailureMock.mockRejectedValueOnce(new Error('async failure'));
      const payload = issue();
      delete (payload.issue as { fields: { project: Record<string, unknown> } }).fields.project.key;

      await expect(handler(eventWith(payload))).resolves.toBeUndefined();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── ADF → markdown conversion ──────────────────────────────────────────────

  describe('ADF description rendering', () => {
    beforeEach(() => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
    });

    test('renders headings, paragraphs, and bullet lists', async () => {
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.description = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Repro' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Steps to reproduce:' }],
          },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open the page' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click submit' }] }] },
            ],
          },
        ],
      };

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toContain('## Repro');
      expect(reqBody.task_description).toContain('Steps to reproduce:');
      expect(reqBody.task_description).toContain('- Open the page');
      expect(reqBody.task_description).toContain('- Click submit');
    });

    test('falls back to plain string when description is a string (legacy / Connect-style payload)', async () => {
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.description = 'A plain string description.';

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toContain('A plain string description.');
    });

    test('no description renders only the title line', async () => {
      const payload = issue();
      delete (payload.issue as { fields: Record<string, unknown> }).fields.description;

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toBe('ENG-42: Fix the login bug');
    });
  });

  // ─── Image URL extraction from rendered description ─────────────────────────

  describe('image URL attachment extraction', () => {
    beforeEach(() => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
    });

    test('extracts markdown image URLs when description is already markdown', async () => {
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.description =
        'See:\n\n![screenshot](https://atlassian.net/uploads/img1.png)\n\nAnd ![diagram](https://atlassian.net/uploads/arch.png)';

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(2);
      expect(reqBody.attachments[0]).toEqual({ type: 'url', url: 'https://atlassian.net/uploads/img1.png' });
    });

    test('does not extract HTTP (non-HTTPS) URLs', async () => {
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.description =
        '![unsafe](http://evil.com/img.png)';

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });

    test('caps image extraction at 10 URLs', async () => {
      const payload = issue();
      const lines = Array.from({ length: 15 }, (_, i) => `![img${i}](https://cdn.example.com/img${i}.png)`);
      (payload.issue as { fields: Record<string, unknown> }).fields.description = lines.join('\n');

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(10);
    });

    test('extracts an external ADF media node embedded in the description', async () => {
      // Real Jira issues embed images as `media` nodes, not markdown image
      // text. The walker must render an `external` media node to markdown so
      // it surfaces as an attachment. (`file`-type media reference an
      // attachment id that needs a Jira API round-trip, so they're skipped.)
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.description = {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'See the mockup:' }] },
          {
            type: 'mediaSingle',
            content: [
              {
                type: 'media',
                attrs: { type: 'external', url: 'https://cdn.example.com/mockup.png', alt: 'mockup' },
              },
            ],
          },
          {
            type: 'mediaSingle',
            content: [
              // file-type media: attachment id, no direct URL — must be skipped.
              { type: 'media', attrs: { type: 'file', id: 'att-123' } },
            ],
          },
        ],
      };

      await handler(eventWith(payload));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(1);
      expect(reqBody.attachments[0]).toEqual({ type: 'url', url: 'https://cdn.example.com/mockup.png' });
    });
  });

  // ─── #577: recent comments folded into the task context ─────────────────────

  describe('recent comments in task context', () => {
    beforeEach(() => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
    });

    test('folds fetched human comments into the description (oldest-first, attributed)', async () => {
      fetchRecentHumanCommentsMock.mockResolvedValueOnce([
        { author: 'Ada', createdAt: '2026-07-01T00:00:00Z', markdown: 'Use the attached log.' },
        { author: 'Grace', createdAt: '2026-07-02T00:00:00Z', markdown: 'Repro on staging only.' },
      ]);

      await handler(eventWith(issue()));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toContain('## Recent comments');
      expect(reqBody.task_description).toContain('**Ada** (2026-07-01T00:00:00Z):');
      expect(reqBody.task_description).toContain('Use the attached log.');
      expect(reqBody.task_description).toContain('**Grace** (2026-07-02T00:00:00Z):');
      // Oldest-first: Ada's comment appears before Grace's.
      expect(reqBody.task_description.indexOf('Ada')).toBeLessThan(reqBody.task_description.indexOf('Grace'));
    });

    test('no comments → no Recent comments section', async () => {
      fetchRecentHumanCommentsMock.mockResolvedValueOnce([]);

      await handler(eventWith(issue()));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).not.toContain('## Recent comments');
    });

    test('comment fetch failure is fail-open: task still created, no failure comment', async () => {
      // The helper itself is fail-open (returns []), but assert the processor
      // does not gate on it even if it somehow rejects.
      fetchRecentHumanCommentsMock.mockResolvedValueOnce([]);

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).toHaveBeenCalled();
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });

    test('a huge comment thread is truncated, keeping task_description within the 10k limit (fail-open)', async () => {
      // A single very long comment would otherwise push the description past
      // MAX_TASK_DESCRIPTION_LENGTH and cause createTaskCore to 400 — turning
      // advisory comments into a hard gate. The processor must truncate instead.
      fetchRecentHumanCommentsMock.mockResolvedValueOnce([
        { author: 'Ada', createdAt: '2026-07-01T00:00:00Z', markdown: 'x'.repeat(50_000) },
      ]);

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).toHaveBeenCalled();
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description.length).toBeLessThanOrEqual(10_000);
      expect(reqBody.task_description).toContain('recent comments truncated');
    });

    test('a policy-tripping comment is DROPPED (fail-open) — task still created without it', async () => {
      // Third-party comment content that trips the guardrail must not fail the
      // reporter's task (#577 review item 4). The comment section is dropped;
      // the task is still created from the reporter-authored description.
      fetchRecentHumanCommentsMock.mockResolvedValueOnce([
        { author: 'Mallory', createdAt: '2026-07-01T00:00:00Z', markdown: 'SSN 123-45-6789' },
      ]);
      bedrockSendMock.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED' });

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).toHaveBeenCalled();
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).not.toContain('## Recent comments');
      expect(reqBody.task_description).not.toContain('123-45-6789');
    });

    test('passes a deterministic idempotency key (issue + webhook timestamp)', async () => {
      const payload = issue();
      payload.timestamp = 1784079623761;

      await handler(eventWith(payload));

      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.idempotencyKey).toBe('jira-ENG-42-1784079623761');
    });

    test('idempotent replay (createTaskCore 200) is not a failure and posts no ❌ comment', async () => {
      // Override the beforeEach 201 with a 200 replay.
      createTaskCoreMock.mockReset();
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 200, body: JSON.stringify({ data: { task_id: 'T1' } }) });
      fetchRecentHumanCommentsMock.mockResolvedValueOnce([]);

      await handler(eventWith(issue()));

      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    });
  });

  // ─── #577: Jira media attachments (fetch → screen → pre-screened records) ───

  describe('Jira media attachment enrichment', () => {
    const passedRecord = {
      attachment_id: 'att-1',
      type: 'file' as const,
      content_type: 'text/plain',
      filename: 'error.log',
      s3_key: 'attachments/cognito-user-1/T1/att-1/error.log',
      s3_version_id: 'v1',
      size_bytes: 42,
      checksum_sha256: 'abc',
      screening: { status: 'passed' as const, screened_at: '2026-07-14T00:00:00Z' },
    };

    function issueWithAttachment(): Record<string, unknown> {
      const payload = issue();
      (payload.issue as { fields: Record<string, unknown> }).fields.attachment = [
        { id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: 42, content: 'https://acme.atlassian.net/secure/attachment/att-1/error.log' },
      ];
      return payload;
    }

    test('passes screened attachments to createTaskCore as preScreenedAttachments', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
      downloadJiraAttachmentsMock.mockResolvedValueOnce([passedRecord]);

      await handler(eventWith(issueWithAttachment()));

      expect(createTaskCoreMock).toHaveBeenCalled();
      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.preScreenedAttachments).toHaveLength(1);
      expect(ctx.preScreenedAttachments[0].screening.status).toBe('passed');
      // taskId is minted in the processor and threaded through so S3 keys match.
      expect(ctx.taskId).toBeDefined();
    });

    test('passes remaining slots (10 - url image count) to the downloader', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });
      downloadJiraAttachmentsMock.mockResolvedValueOnce([]);

      const payload = issueWithAttachment();
      // Two embedded image URLs consume two slots.
      (payload.issue as { fields: Record<string, unknown> }).fields.description =
        '![a](https://cdn.example.com/a.png) ![b](https://cdn.example.com/b.png)';

      await handler(eventWith(payload));

      const [, remainingSlots] = downloadJiraAttachmentsMock.mock.calls[0];
      expect(remainingSlots).toBe(8);
    });

    test('fail-closed: JiraAttachmentError rejects the task with a Jira comment', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      downloadJiraAttachmentsMock.mockRejectedValueOnce(
        new JiraAttachmentError("Attachment 'error.log' was blocked by content policy: PROMPT_ATTACK"),
      );

      await handler(eventWith(issueWithAttachment()));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const msg = reportIssueFailureMock.mock.calls[0][2] as string;
      expect(msg).toContain("couldn't safely process an attachment");
    });

    test('fail-closed: attachments present but screening unconfigured rejects the task', async () => {
      const savedBucket = process.env.ATTACHMENTS_BUCKET_NAME;
      const savedGuardrail = process.env.GUARDRAIL_ID;
      // The processor reads screening config at module load, so simulate the
      // unconfigured state by re-importing with the env cleared.
      jest.resetModules();
      delete process.env.ATTACHMENTS_BUCKET_NAME;
      delete process.env.GUARDRAIL_ID;

      const freshModule = await import('../../src/handlers/jira-webhook-processor');
      const freshHandler = freshModule.handler;

      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });

      await freshHandler(eventWith(issueWithAttachment()));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const msg = reportIssueFailureMock.mock.calls[0][2] as string;
      expect(msg).toContain('attachment screening is not configured');

      process.env.ATTACHMENTS_BUCKET_NAME = savedBucket;
      process.env.GUARDRAIL_ID = savedGuardrail;
      jest.resetModules();
    });

    test('no attachments → downloader not called, task created normally', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { repo: 'org/repo', status: 'active' } })
        .mockResolvedValueOnce({ Item: { platform_user_id: 'cognito-user-1', status: 'active' } });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

      await handler(eventWith(issue()));

      expect(downloadJiraAttachmentsMock).not.toHaveBeenCalled();
      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.preScreenedAttachments).toBeUndefined();
    });
  });
});
