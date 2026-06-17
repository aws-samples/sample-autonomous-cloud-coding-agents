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

// DynamoDB doc client — drives persistScreenshotUrl (#247 UX.16/UX.17).
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
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

process.env.SCREENSHOT_BUCKET_NAME = 'screenshot-bucket';
process.env.SCREENSHOT_PUBLIC_HOST = 'd1.cloudfront.net';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-token';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/github-webhook-processor';

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

  test('picks the head-SHA owner when commit-pulls returns a stacked chain (#247)', async () => {
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

    // captureScreenshot now receives a deadline-aware budget (PR-241 B1).
    expect(captureScreenshotMock).toHaveBeenCalledWith(
      'https://preview.example.com',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(s3Send).toHaveBeenCalledTimes(1);
    const putArg = (s3Send.mock.calls[0][0] as { input: { Key: string; ContentType: string } }).input;
    // Key carries the high-entropy suffix added in PR-241 (key entropy).
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

  test('branch-name identifier wins over a predecessor named in the PR body (#247 stacked PR)', async () => {
    // The #247 Lisbon-epic regression: PR #73 (closes ABCA-152) carries a
    // body that mentions ABCA-151 ("cherry-picked from predecessor branch
    // ABCA-151") BEFORE the issue it closes. Branch-first routing must win
    // so the screenshot lands on ABCA-152, not the predecessor.
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

  test('#247 UX.17: persists BOTH screenshot_url and screenshot_preview_url on the task record', async () => {
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

  test('#247 UX.16: integration node deploy persists the URL but does NOT post a standalone Linear comment', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    // The integration node's PR — branch + title both name the PARENT epic
    // (ABCA-301), which WOULD route a Linear comment onto the parent.
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
