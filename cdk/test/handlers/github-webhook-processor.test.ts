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

const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: s3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

// DynamoDB doc client — drives persistScreenshotUrl.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const captureScreenshotMock = jest.fn();
jest.mock('../../src/handlers/shared/agentcore-browser', () => ({
  captureScreenshot: (...args: unknown[]) => captureScreenshotMock(...args),
}));

const resolveGitHubTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: (...args: unknown[]) => resolveGitHubTokenMock(...args),
}));

const upsertTaskCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/github-comment', () => ({
  upsertTaskComment: (...args: unknown[]) => upsertTaskCommentMock(...args),
}));

const postIssueCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
}));

const findLinearIssueMock = jest.fn();
const extractLinearIdentifierMock = jest.fn();
const extractFromBranchMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-issue-lookup', () => ({
  findLinearIssueByIdentifier: (...args: unknown[]) => findLinearIssueMock(...args),
  extractLinearIdentifier: (...args: unknown[]) => extractLinearIdentifierMock(...args),
  extractLinearIdentifierFromBranch: (...args: unknown[]) => extractFromBranchMock(...args),
}));

const deliverJiraMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-deployment-preview', () => ({
  deliverJiraDeploymentPreview: (...args: unknown[]) => deliverJiraMock(...args),
}));

process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraRegistry';
process.env.SCREENSHOT_BUCKET_NAME = 'screenshot-bucket';
process.env.SCREENSHOT_PUBLIC_HOST = 'd1.cloudfront.net';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-token';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/github-webhook-processor';
import { normalizeAmplifyPreviewCheck } from '../../src/handlers/shared/github-deployment-status';
import { logger } from '../../src/handlers/shared/logger';

function payload(overrides: Record<string, unknown> = {}): { raw_body: string } {
  const body = {
    deployment_status: {
      id: 99,
      state: 'success',
      environment_url: 'https://preview.example.com',
    },
    deployment: { id: 42, sha: 'abc1234', environment: 'Preview' },
    repository: { full_name: 'owner/repo' },
    ...overrides,
  };
  return { raw_body: JSON.stringify(body) };
}

function fetchOk(jsonValue: unknown, status = 200): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonValue,
  } as unknown as Response);
}

describe('github-webhook-processor handler', () => {
  beforeEach(() => {
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraRegistry';
    deliverJiraMock.mockReset();
    s3Send.mockReset();
    captureScreenshotMock.mockReset();
    resolveGitHubTokenMock.mockReset();
    upsertTaskCommentMock.mockReset();
    postIssueCommentMock.mockReset();
    findLinearIssueMock.mockReset();
    extractLinearIdentifierMock.mockReset();
    extractFromBranchMock.mockReset();
    // Default: persistScreenshotUrl's UpdateItem succeeds with a NON-integration
    // task record (no orchestration_sub_issue_id) → standalone Linear comment
    // still posts, as the pre-existing tests expect.
    ddbSend.mockReset().mockResolvedValue({ Attributes: { channel_metadata: {} } });
    jest.restoreAllMocks();
  });

  test('returns silently when raw_body is empty', async () => {
    await handler({ raw_body: '' });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
  });

  test('returns silently when raw_body is malformed JSON', async () => {
    await handler({ raw_body: 'not-json{' });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
  });

  test('returns when payload missing repo/sha/preview_url', async () => {
    await handler({ raw_body: JSON.stringify({ deployment: { id: 42 } }) });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
  });

  test('returns when GitHub token cannot be resolved', async () => {
    resolveGitHubTokenMock.mockRejectedValueOnce(new Error('SM unavailable'));
    await handler(payload());
    expect(captureScreenshotMock).not.toHaveBeenCalled();
  });

  test('returns when no open PR is associated with the SHA after retries', async () => {
    jest.useFakeTimers();
    try {
      resolveGitHubTokenMock.mockResolvedValue('gh-tok');
      // Four calls (delays = [0, 5s, 10s, 20s]) all return empty list.
      fetchOk([]);
      fetchOk([]);
      fetchOk([]);
      fetchOk([]);
      const promise = handler(payload());
      await jest.runAllTimersAsync();
      await promise;
      expect(captureScreenshotMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('only OPEN PRs are accepted (closed/merged are filtered)', async () => {
    jest.useFakeTimers();
    try {
      resolveGitHubTokenMock.mockResolvedValue('gh-tok');
      fetchOk([{ number: 1, state: 'closed', title: 'old', body: '' }]);
      fetchOk([{ number: 1, state: 'closed', title: 'old', body: '' }]);
      fetchOk([{ number: 1, state: 'closed', title: 'old', body: '' }]);
      fetchOk([{ number: 1, state: 'closed', title: 'old', body: '' }]);
      const promise = handler(payload());
      await jest.runAllTimersAsync();
      await promise;
      expect(captureScreenshotMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('picks the head-SHA owner when commit-pulls returns a stacked chain', async () => {
    // A stacked sub-issue chain: the deploy SHA `abc1234` is the head of
    // PR 73, but the commit-pulls API also lists PRs 74 and 75 stacked on
    // top (their history contains the commit). The PR whose own head is
    // the SHA must win, so the screenshot routes to 73's branch.
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([
      { number: 73, state: 'open', title: 't73', body: 'b73', head: { ref: 'bgagent/01T/abca-152-x', sha: 'abc1234' } },
      { number: 74, state: 'open', title: 't74', body: 'b74', head: { ref: 'bgagent/01T/abca-153-y', sha: 'def5678' } },
      { number: 75, state: 'open', title: 't75', body: 'b75', head: { ref: 'bgagent/01T/abca-154-z', sha: 'aaa9999' } },
    ]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce('ABCA-152');
    findLinearIssueMock.mockResolvedValueOnce({ issueId: 'issue-152', linearWorkspaceId: 'ws-1', workspaceSlug: 'abca' });
    postIssueCommentMock.mockResolvedValueOnce(true);

    await handler(payload());

    const commentArg = upsertTaskCommentMock.mock.calls[0][0] as { issueOrPrNumber: number };
    expect(commentArg.issueOrPrNumber).toBe(73);
    expect(extractFromBranchMock).toHaveBeenCalledWith('bgagent/01T/abca-152-x');
    expect(postIssueCommentMock.mock.calls[0][1]).toBe('issue-152');
  });

  test('happy path: PR found → screenshot → S3 → PR comment posted', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'feat: add x', body: 'body' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });

    await handler(payload());

    // Capture leaves 30s for post-capture work, including optional Jira delivery.
    expect(captureScreenshotMock.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(80_000);
    expect(captureScreenshotMock).toHaveBeenCalledWith(
      'https://preview.example.com',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(s3Send).toHaveBeenCalledTimes(1);
    const putArg = (s3Send.mock.calls[0][0] as { input: { Key: string; ContentType: string } }).input;
    // Key carries the high-entropy suffix (key entropy).
    expect(putArg.Key).toMatch(/^screenshots\/owner_repo\/abc1234-42-[0-9a-f]{16}\.png$/);
    expect(putArg.ContentType).toBe('image/png');
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    const commentArg = upsertTaskCommentMock.mock.calls[0][0] as { repo: string; issueOrPrNumber: number; body: string };
    expect(commentArg.repo).toBe('owner/repo');
    expect(commentArg.issueOrPrNumber).toBe(17);
    expect(commentArg.body).toMatch(/https:\/\/d1\.cloudfront\.net\/screenshots\/owner_repo\/abc1234-42-[0-9a-f]{16}\.png/);
  });

  test('aborts when screenshot capture throws', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 't', body: '' }]);
    captureScreenshotMock.mockRejectedValueOnce(new Error('CDP failed'));

    await handler(payload());

    expect(s3Send).not.toHaveBeenCalled();
    expect(upsertTaskCommentMock).not.toHaveBeenCalled();
  });

  test('aborts when S3 PutObject throws', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 't', body: '' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockRejectedValueOnce(new Error('S3 throttled'));

    await handler(payload());

    expect(upsertTaskCommentMock).not.toHaveBeenCalled();
  });

  test('PR comment failure is non-fatal (log + continue)', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 't', body: '' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockRejectedValueOnce(new Error('GitHub 502'));

    // Should not throw — the handler is best-effort.
    await expect(handler(payload())).resolves.toBeUndefined();
  });

  test('Linear branch fires when registry table set + identifier in PR title', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    // No branch identifier here — exercises the title fallback path.
    fetchOk([{ number: 17, state: 'open', title: 'ABCA-42 fix login', body: 'body', head: { ref: 'feature-x', sha: 'abc1234' } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce(null);
    extractLinearIdentifierMock.mockReturnValueOnce('ABCA-42');
    findLinearIssueMock.mockResolvedValueOnce({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    });
    postIssueCommentMock.mockResolvedValueOnce({ ok: true });

    await handler(payload());

    expect(extractLinearIdentifierMock).toHaveBeenCalledWith('ABCA-42 fix login');
    expect(findLinearIssueMock).toHaveBeenCalledWith('ABCA-42', 'LinearWorkspaceRegistry');
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    const linearArg = postIssueCommentMock.mock.calls[0];
    expect(linearArg[1]).toBe('issue-uuid');
    expect(linearArg[2]).toMatch(/https:\/\/d1\.cloudfront\.net\/screenshots\/owner_repo\/abc1234-42-[0-9a-f]{16}\.png/);
  });

  test('branch-name identifier wins over a predecessor named in the PR body (stacked PR)', async () => {
    // A stacked PR closes one issue but its body mentions the PREDECESSOR
    // issue first ("cherry-picked from predecessor branch ..."). Branch-first
    // routing must win so the screenshot lands on the issue this PR actually
    // implements, not the predecessor named earlier in the body.
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{
      number: 73,
      state: 'open',
      title: 'feat(destinations): add Lisbon destination card',
      body: 'cherry-picked from predecessor branch ABCA-151 ... Closes ABCA-152',
      head: { ref: 'bgagent/01TASK/abca-152-link-lisbon-from-destinationsht', sha: 'abc1234' },
    }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    // Real branch extractor behaviour: pulls ABCA-152 from the branch.
    extractFromBranchMock.mockReturnValueOnce('ABCA-152');
    findLinearIssueMock.mockResolvedValueOnce({
      issueId: 'issue-152',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    });
    postIssueCommentMock.mockResolvedValueOnce(true);

    await handler(payload());

    // Routed to ABCA-152 from the branch; title/body extractor never consulted.
    expect(extractFromBranchMock).toHaveBeenCalledWith('bgagent/01TASK/abca-152-link-lisbon-from-destinationsht');
    expect(findLinearIssueMock).toHaveBeenCalledWith('ABCA-152', 'LinearWorkspaceRegistry');
    expect(extractLinearIdentifierMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(postIssueCommentMock.mock.calls[0][1]).toBe('issue-152');
  });

  test('falls back to title then body when branch yields no identifier', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'feat: add foo', body: 'closes ABCA-42', head: { ref: 'random-branch', sha: 'abc1234' } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce(null); // branch produces no match
    extractLinearIdentifierMock
      .mockReturnValueOnce(null) // title produces no match
      .mockReturnValueOnce('ABCA-42'); // body does
    findLinearIssueMock.mockResolvedValueOnce({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    });
    postIssueCommentMock.mockResolvedValueOnce({ ok: true });

    await handler(payload());

    expect(extractFromBranchMock).toHaveBeenCalledTimes(1);
    expect(extractLinearIdentifierMock).toHaveBeenCalledTimes(2);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
  });

  test('skips Linear when no identifier extracted', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'no id', body: 'no id' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractLinearIdentifierMock.mockReturnValue(null);

    await handler(payload());

    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('skips Linear post when identifier does not resolve to an issue', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ABCA-42 stale', body: '' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractLinearIdentifierMock.mockReturnValueOnce('ABCA-42');
    findLinearIssueMock.mockResolvedValueOnce(null);

    await handler(payload());

    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('Linear comment failure does not propagate (best-effort)', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ABCA-42 fix', body: '' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractLinearIdentifierMock.mockReturnValueOnce('ABCA-42');
    findLinearIssueMock.mockResolvedValueOnce({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    });
    postIssueCommentMock.mockResolvedValueOnce({ ok: false, retryable: false });

    // No throw — postIssueComment returning false is just logged.
    await expect(handler(payload())).resolves.toBeUndefined();
  });

  test('persists BOTH screenshot_url and screenshot_preview_url on the task record', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 't', body: '', head: { ref: 'bgagent/01TASKID/abca-42-x', sha: 'abc1234' } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce(null);
    extractLinearIdentifierMock.mockReturnValue(null);

    await handler(payload());

    const upd = ddbSend.mock.calls.find((c) => c[0]?._type === 'Update');
    expect(upd).toBeDefined();
    const input = upd![0].input as { Key: { task_id: string }; ExpressionAttributeValues: Record<string, string> };
    expect(input.Key.task_id).toBe('01TASKID'); // 2nd branch segment
    expect(input.ExpressionAttributeValues[':u']).toMatch(/cloudfront\.net\/screenshots/);
    expect(input.ExpressionAttributeValues[':p']).toBe('https://preview.example.com'); // the deploy preview URL
  });

  test('integration node deploy persists the URL but does NOT post a standalone Linear comment', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    // The integration node's PR — branch + title both name the PARENT epic,
    // which WOULD route a Linear comment onto the parent.
    fetchOk([{
      number: 191,
      state: 'open',
      title: 'feat(pages): integrate FAQ + Reviews (ABCA-301 combined result)',
      body: 'combined',
      head: { ref: 'bgagent/01INTEGRATION/integrate-the-sub-issues', sha: 'abc1234' },
    }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    // The persisted task record marks this as the synthetic integration node.
    ddbSend.mockReset().mockResolvedValue({
      Attributes: { channel_metadata: { orchestration_sub_issue_id: 'orch_1__integration' } },
    });
    extractFromBranchMock.mockReturnValue(null);
    extractLinearIdentifierMock.mockReturnValue('ABCA-301');

    await handler(payload());

    // URL persisted (panel embed path) …
    expect(ddbSend.mock.calls.some((c) => c[0]?._type === 'Update')).toBe(true);
    // … the GitHub PR comment still posts (load-bearing on the PR) …
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    // … but NO standalone Linear comment on the parent epic.
    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });
});

describe('authoritative Jira deployment routing', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    deliverJiraMock.mockReset().mockResolvedValue(undefined);
    resolveGitHubTokenMock.mockResolvedValue('token');
    captureScreenshotMock.mockResolvedValue(Buffer.from('png'));
    s3Send.mockResolvedValue({});
    upsertTaskCommentMock.mockReset().mockResolvedValue({ commentId: 12 });
    postIssueCommentMock.mockReset();
    findLinearIssueMock.mockReset();
  });
  test.each(['jira', 'linear'])('routes a %s task by the record even when the branch contains a Jira key', async (source) => {
    fetchOk([{ number: 12, state: 'open', title: 'ENG-42', body: '', head: { ref: 'bgagent/task-1/ENG-42', sha: 'abc1234' } }]);
    ddbSend.mockResolvedValue({ Attributes: { task_id: 'task-1', repo: 'owner/repo', channel_source: source, channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'ACTUAL-7' } } });
    await handler(payload());
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    if (source === 'jira') {
      expect(deliverJiraMock).toHaveBeenCalledWith(expect.anything(), 'TaskTable', 'JiraRegistry', expect.objectContaining({ channel_source: 'jira' }), 'owner/repo', 'abc1234', expect.stringContaining('https://d1.cloudfront.net/'), 'https://preview.example.com', expect.any(Function));
      expect(findLinearIssueMock).not.toHaveBeenCalled();
    } else {
      expect(deliverJiraMock).not.toHaveBeenCalled();
    }
  });

  test('a failed task lookup cannot route a Jira-like branch to Linear', async () => {
    fetchOk([{ number: 17, state: 'open', title: 'ENG-42', head: { ref: 'bgagent/01JXABCDEF1234567890ABCDEF/eng-42' } }]);
    ddbSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    await handler(payload());
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(deliverJiraMock).not.toHaveBeenCalled();
    expect(findLinearIssueMock).not.toHaveBeenCalled();
  });

  test('missing Jira registry is observable and never falls through to Linear', async () => {
    const warn = jest.spyOn(logger, 'warn');
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    fetchOk([{ number: 17, state: 'open', head: { ref: 'bgagent/01JXABCDEF1234567890ABCDEF/eng-42' } }]);
    ddbSend.mockResolvedValue({ Attributes: { channel_source: 'jira' } });
    await handler(payload());
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'screenshot.jira_missing_registry' }));
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(deliverJiraMock).not.toHaveBeenCalled();
    expect(findLinearIssueMock).not.toHaveBeenCalled();
  });
});

describe('validated Amplify PR routing', () => {
  const sha = 'a'.repeat(40);
  const taskId = '01JXABCDEF1234567890ABCDEF';
  const branch = `bgagent/${taskId}/eng-42`;
  const pr41 = { number: 41, state: 'open', title: 'ENG-41', head: { ref: 'bgagent/wrong-task/eng-41', sha } };
  const pr42 = { number: 42, state: 'open', title: 'ENG-42', head: { ref: branch, sha } };

  function amplifyEvent() {
    const result = normalizeAmplifyPreviewCheck({
      action: 'completed',
      repository: { full_name: 'owner/repo' },
      check_run: {
        id: 123,
        name: 'AWS Amplify Console Web Preview',
        status: 'completed',
        conclusion: 'success',
        head_sha: sha,
        details_url: 'https://pr-42.app123.amplifyapp.com',
        app: { slug: 'aws-amplify-us-east-1', owner: { login: 'aws-amplify-console' } },
        pull_requests: [pr41, pr42],
      },
    });
    if (!result.ok) throw new Error(result.reason);
    return { raw_body: JSON.stringify(result.payload), validated_pr_number: result.prNumber };
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraRegistry';
    deliverJiraMock.mockReset().mockResolvedValue(undefined);
    resolveGitHubTokenMock.mockReset().mockResolvedValue('token');
    captureScreenshotMock.mockReset().mockResolvedValue(Buffer.from('png'));
    s3Send.mockReset().mockResolvedValue({});
    ddbSend.mockReset();
    upsertTaskCommentMock.mockReset().mockResolvedValue({ commentId: 12 });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
    findLinearIssueMock.mockReset().mockResolvedValue({ issueId: 'issue-42', linearWorkspaceId: 'ws' });
    extractFromBranchMock.mockReset().mockImplementation((ref) => ref === branch ? 'ENG-42' : 'ENG-41');
  });

  test.each(['jira', 'linear'])('two PRs with one SHA route GitHub and %s feedback to the validated PR', async (source) => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      // The commit-pulls endpoint would pick PR 41. Only a lookup by number
      // preserves the PR encoded in the preview URL through task persistence.
      json: async () => String(url).endsWith('/pulls/42') ? pr42 : [pr41, pr42],
    } as Response));
    const task = { task_id: taskId, repo: 'owner/repo', head_sha: sha, channel_source: source, channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'TG-42' } };
    ddbSend.mockResolvedValue({ Attributes: task });

    await handler(amplifyEvent());

    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/pulls/42', expect.anything());
    expect(captureScreenshotMock).toHaveBeenCalledWith('https://pr-42.app123.amplifyapp.com', expect.anything());
    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', issueOrPrNumber: 42 }));
    expect(ddbSend.mock.calls[0][0].input.Key).toEqual({ task_id: taskId });
    if (source === 'jira') {
      expect(deliverJiraMock).toHaveBeenCalledWith(expect.anything(), 'TaskTable', 'JiraRegistry', task,
        'owner/repo', sha, expect.stringContaining('https://d1.cloudfront.net/'),
        'https://pr-42.app123.amplifyapp.com', expect.any(Function));
      expect(findLinearIssueMock).not.toHaveBeenCalled();
    } else {
      expect(findLinearIssueMock).toHaveBeenCalledWith('ENG-42', 'LinearWorkspaceRegistry');
      expect(postIssueCommentMock).toHaveBeenCalledWith(expect.anything(), 'issue-42', expect.stringContaining('https://pr-42.app123.amplifyapp.com'));
      expect(deliverJiraMock).not.toHaveBeenCalled();
    }
  });

  test.each([
    [pr41, 'pr_number_mismatch'],
    [{ ...pr42, state: 'closed' }, 'pr_not_open'],
    [{ ...pr42, head: { ref: branch, sha: 'b'.repeat(40) } }, 'head_sha_mismatch'],
    [{ ...pr42, head: { sha } }, 'missing_head_ref'],
    [null, 'pr_number_mismatch'],
    [[pr41, pr42], 'pr_number_mismatch'],
  ])('rejects a changed or malformed PR without capturing or falling back: %j', async (pr, reason) => {
    jest.useFakeTimers();
    try {
      const log = jest.spyOn(logger, 'warn');
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => pr } as Response);
      const pending = handler(amplifyEvent());
      await jest.runAllTimersAsync();
      await pending;
      expect(log).toHaveBeenCalledWith('Validated Amplify PR no longer matches preview', {
        event: 'screenshot.amplify_pr_rejected', reason, repo: 'owner/repo', pr_number: 42,
      });
      expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/pulls/42'))).toBe(true);
      expect(captureScreenshotMock).not.toHaveBeenCalled();
      expect(ddbSend).not.toHaveBeenCalled();
      expect(upsertTaskCommentMock).not.toHaveBeenCalled();
      expect(deliverJiraMock).not.toHaveBeenCalled();
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid forwarded PR number %s', async (number) => {
    await handler({ ...amplifyEvent(), validated_pr_number: number });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
    expect(captureScreenshotMock).not.toHaveBeenCalled();
  });
});
