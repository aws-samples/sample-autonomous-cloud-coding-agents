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
const appendOnceToCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  appendOnceToComment: (...args: unknown[]) => appendOnceToCommentMock(...args),
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

const originalJiraRegistry = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
beforeEach(() => { process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraRegistry'; });
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (originalJiraRegistry === undefined) delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  else process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = originalJiraRegistry;
});
process.env.SCREENSHOT_BUCKET_NAME = 'screenshot-bucket';
process.env.SCREENSHOT_PUBLIC_HOST = 'd1.cloudfront.net';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-token';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/github-webhook-processor';
import { normalizeAmplifyPreviewCheck } from '../../src/handlers/shared/github-deployment-status';
import { logger } from '../../src/handlers/shared/logger';
import { LOOKUP_ABSENT, lookupFailed, lookupFound } from '../../src/handlers/shared/lookup-result';

const OWN_REPO = { full_name: 'owner/repo' };

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
  const body = Array.isArray(jsonValue)
    ? jsonValue.map((pr: Record<string, unknown>) => ({ base: { repo: OWN_REPO }, ...pr }))
    : jsonValue;
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response);
}

function sentToTable(type: string): Array<Record<string, unknown>> {
  return ddbSend.mock.calls
    .map((c) => c[0] as { _type: string; input: Record<string, unknown> })
    .filter((c) => c._type === type)
    .map((c) => c.input);
}

describe('github-webhook-processor handler', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraRegistry';
    deliverJiraMock.mockReset();
    s3Send.mockReset();
    captureScreenshotMock.mockReset();
    resolveGitHubTokenMock.mockReset();
    upsertTaskCommentMock.mockReset();
    postIssueCommentMock.mockReset();
    appendOnceToCommentMock.mockReset();
    findLinearIssueMock.mockReset();
    extractLinearIdentifierMock.mockReset();
    extractFromBranchMock.mockReset();
    ddbSend.mockReset().mockResolvedValue({ Item: { repo: 'owner/repo' }, Attributes: { channel_metadata: {} } });
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
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([
      { number: 73, state: 'open', title: 't73', body: 'b73', head: { ref: 'bgagent/01T/abca-152-x', sha: 'abc1234', repo: OWN_REPO } },
      { number: 74, state: 'open', title: 't74', body: 'b74', head: { ref: 'bgagent/01T/abca-153-y', sha: 'def5678', repo: OWN_REPO } },
      { number: 75, state: 'open', title: 't75', body: 'b75', head: { ref: 'bgagent/01T/abca-154-z', sha: 'aaa9999', repo: OWN_REPO } },
    ]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce('ABCA-152');
    findLinearIssueMock.mockResolvedValueOnce(lookupFound({ issueId: 'issue-152', linearWorkspaceId: 'ws-1', workspaceSlug: 'abca' }));
    postIssueCommentMock.mockResolvedValueOnce(true);

    await handler(payload());

    const commentArg = upsertTaskCommentMock.mock.calls[0][0] as { issueOrPrNumber: number };
    expect(commentArg.issueOrPrNumber).toBe(73);
    expect(extractFromBranchMock).toHaveBeenCalledWith('bgagent/01T/abca-152-x');
    expect(postIssueCommentMock.mock.calls[0][1]).toBe('issue-152');
  });

  test('the pull request whose head is the deployed commit wins over a lower number that only contains it', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([
      { number: 75, state: 'open', title: 't75', body: '', head: { ref: 'feature-on-top', sha: 'def5678', repo: OWN_REPO } },
      { number: 80, state: 'open', title: 't80', body: '', head: { ref: 'feature-below', sha: 'abc1234', repo: OWN_REPO } },
    ]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });

    await handler(payload());

    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ issueOrPrNumber: 80 }));
  });

  test('a pull request that lives in another repository is not taken for the deployment\'s own', async () => {
    // GitHub lists the open pull requests of a commit by the repository of their
    // HEAD branch, so the answer includes pull requests that live in other repositories.
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    const head = { ref: 'bgagent/01TASKID/tidy-up-the-footer', sha: 'abc1234', repo: OWN_REPO };
    fetchOk([
      { number: 3, state: 'open', title: 'GLX-7', body: '', head, base: { repo: { full_name: 'mallory/repo' } } },
      { number: 10, state: 'open', title: 'Tidy up the footer', body: '', head, base: { repo: OWN_REPO } },
    ]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractLinearIdentifierMock.mockImplementation((text: string) => (text === 'GLX-7' ? 'GLX-7' : null));
    findLinearIssueMock.mockResolvedValue(lookupFound({ issueId: 'issue-glx-7', linearWorkspaceId: 'ws-globex', workspaceSlug: 'globex' }));
    postIssueCommentMock.mockResolvedValue({ ok: true });

    await handler(payload());

    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', issueOrPrNumber: 10 }));
    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test.each([
    ['lives in another repository', { repo: { full_name: 'mallory/repo' } }],
    ['names no base repository', { repo: null }],
    ['has no base', undefined],
  ])('a commit whose only pull request %s has no pull request of the deployment', async (_label, base) => {
    jest.useFakeTimers();
    try {
      resolveGitHubTokenMock.mockResolvedValue('gh-tok');
      const answer = [{ number: 3, state: 'open', title: 'GLX-7', body: '', head: { ref: 'bgagent/01TASKID/x', sha: 'abc1234', repo: OWN_REPO }, base }];
      fetchOk(answer);
      fetchOk(answer);
      fetchOk(answer);
      fetchOk(answer);
      const error = jest.spyOn(logger, 'error');
      const promise = handler(payload());
      await jest.runAllTimersAsync();
      await promise;
      expect(captureScreenshotMock).not.toHaveBeenCalled();
      expect(upsertTaskCommentMock).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        error_id: 'SCREENSHOT_PR_LOOKUP_EXHAUSTED', reason: 'pr_not_linked',
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['first', true],
    ['second', false],
  ])('a second pull request from the branch of an ABCA pull request does not take its place, listed %s', async (_label, listedFirst) => {
    // In a public repository anyone can open a pull request from an existing
    // branch into another branch of the repository itself.
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    const head = { ref: 'bgagent/01TASKID/tidy-up-the-footer', sha: 'abc1234', repo: OWN_REPO };
    const own = { number: 10, state: 'open', title: 'Tidy up the footer', body: '', head };
    const other = { number: 23, state: 'open', title: 'GLX-7', body: '', head, base: { ref: 'release', repo: OWN_REPO } };
    fetchOk(listedFirst ? [other, own] : [own, other]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractLinearIdentifierMock.mockImplementation((text: string) => (text === 'GLX-7' ? 'GLX-7' : null));
    findLinearIssueMock.mockResolvedValue(lookupFound({ issueId: 'issue-glx-7', linearWorkspaceId: 'ws-globex', workspaceSlug: 'globex' }));
    postIssueCommentMock.mockResolvedValue({ ok: true });

    await handler(payload());

    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', issueOrPrNumber: 10 }));
    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test.each([
    ['from an ordinary branch', 'abc1234', true],
    ['from an ordinary branch', 'abc1234', false],
    ['when the deployed commit is no pull request\'s head', 'fff0000', true],
    ['when the deployed commit is no pull request\'s head', 'fff0000', false],
  ])('of two pull requests %s the lower number is taken (head %s, higher number listed first: %s)', async (_label, headSha, higherFirst) => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    const head = { ref: 'feature-x', sha: headSha, repo: OWN_REPO };
    const lower = { number: 5, state: 'open', title: 'Add x', body: '', head };
    const higher = { number: 9, state: 'open', title: 'Backport x', body: '', head, base: { ref: 'release', repo: OWN_REPO } };
    fetchOk(higherFirst ? [higher, lower] : [lower, higher]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });

    await handler(payload());

    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ issueOrPrNumber: 5 }));
    expect(extractLinearIdentifierMock).toHaveBeenCalledWith('Add x');
    expect(extractLinearIdentifierMock).not.toHaveBeenCalledWith('Backport x');
  });

  test('happy path: PR found → screenshot → S3 → PR comment posted', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'feat: add x', body: 'body' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });

    await handler(payload());

    expect(captureScreenshotMock.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(80_000);
    expect(captureScreenshotMock).toHaveBeenCalledWith(
      'https://preview.example.com',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(s3Send).toHaveBeenCalledTimes(1);
    const putArg = (s3Send.mock.calls[0][0] as { input: { Key: string; ContentType: string } }).input;
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

    await expect(handler(payload())).resolves.toBeUndefined();
  });

  test('Linear branch fires when registry table set + identifier in PR title', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ABCA-42 fix login', body: 'body', head: { ref: 'feature-x', sha: 'abc1234' } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce(null);
    extractLinearIdentifierMock.mockReturnValueOnce('ABCA-42');
    findLinearIssueMock.mockResolvedValueOnce(lookupFound({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    }));
    postIssueCommentMock.mockResolvedValueOnce({ ok: true });

    await handler(payload());

    expect(extractLinearIdentifierMock).toHaveBeenCalledWith('ABCA-42 fix login');
    expect(findLinearIssueMock).toHaveBeenCalledWith('ABCA-42', 'LinearWorkspaceRegistry');
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    const linearArg = postIssueCommentMock.mock.calls[0];
    expect(linearArg[1]).toBe('issue-uuid');
    expect(linearArg[2]).toMatch(/https:\/\/d1\.cloudfront\.net\/screenshots\/owner_repo\/abc1234-42-[0-9a-f]{16}\.png/);
  });

  test('a Linear task\'s preview goes to the issue and workspace on its own record, not to an identifier lookup', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ENG-7 fix login', body: '', head: { ref: 'bgagent/01TASKID/eng-7-fix-login', sha: 'abc1234', repo: OWN_REPO } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    ddbSend.mockReset().mockResolvedValue({
      Item: { repo: 'owner/repo' },
      Attributes: {
        repo: 'owner/repo',
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'issue-globex', linear_workspace_id: 'ws-globex', linear_workspace_slug: 'globex' },
      },
    });
    extractFromBranchMock.mockReturnValueOnce('ENG-7');
    findLinearIssueMock.mockResolvedValue(lookupFound({ issueId: 'issue-acme', linearWorkspaceId: 'ws-acme', workspaceSlug: 'acme' }));
    postIssueCommentMock.mockResolvedValueOnce({ ok: true });

    await handler(payload());

    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(postIssueCommentMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'ws-globex', registryTableName: 'LinearWorkspaceRegistry' },
      'issue-globex',
      expect.stringContaining('https://d1.cloudfront.net/screenshots/'),
    );
    expect(findLinearIssueMock).not.toHaveBeenCalled();
  });

  test('a task started from a Linear comment gets its preview although nothing in the pull request names the issue', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 7, state: 'open', title: 'Add a dark mode toggle', body: '', head: { ref: 'bgagent/01TASKID/add-a-dark-mode-toggle', sha: 'abc1234', repo: OWN_REPO } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    const channelMetadata = {
      trigger_comment_id: 'comment-1',
      linear_issue_id: 'issue-42',
      linear_workspace_id: 'ws-1',
      iteration_reply_comment_id: 'reply-R',
    };
    ddbSend.mockReset().mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'Query') return { Items: [{ task_id: '01TASKID', repo: 'owner/repo', channel_metadata: channelMetadata }] };
      if (cmd._type === 'Get') return { Item: { repo: 'owner/repo', head_sha: 'abc1234' } };
      return { Attributes: { repo: 'owner/repo', channel_source: 'linear', channel_metadata: channelMetadata } };
    });
    extractFromBranchMock.mockReturnValue(null);
    extractLinearIdentifierMock.mockReturnValue(null);
    appendOnceToCommentMock.mockResolvedValueOnce(true);

    await handler(payload());

    expect(appendOnceToCommentMock).toHaveBeenCalledTimes(1);
    expect(appendOnceToCommentMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'ws-1', registryTableName: 'LinearWorkspaceRegistry' },
      'reply-R',
      expect.stringContaining('https://d1.cloudfront.net/screenshots/'),
      '[preview]',
    );
    expect(sentToTable('Query')).toEqual([expect.objectContaining({ ExpressionAttributeValues: { ':iid': 'issue-42' } })]);
    expect(findLinearIssueMock).not.toHaveBeenCalled();
  });

  test('a pull request whose branch names a task of another repository writes nothing onto that task', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ENG-7', body: '', head: { ref: 'bgagent/01OTHERSTASK/eng-7-x', sha: 'abc1234', repo: OWN_REPO } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    ddbSend.mockReset().mockResolvedValue({
      Item: { repo: 'other/repo' },
      Attributes: {
        repo: 'other/repo',
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'issue-of-other-repo', linear_workspace_id: 'ws-globex' },
      },
    });
    extractFromBranchMock.mockReturnValue('ENG-7');
    findLinearIssueMock.mockResolvedValue(lookupFound({ issueId: 'issue-of-other-repo', linearWorkspaceId: 'ws-globex', workspaceSlug: 'globex' }));
    postIssueCommentMock.mockResolvedValue({ ok: true });
    const warn = jest.spyOn(logger, 'warn');

    await handler(payload());

    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(sentToTable('Update')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: 'screenshot.persist_failed', task_id: '01OTHERSTASK',
    }));
    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(deliverJiraMock).not.toHaveBeenCalled();
  });

  test('after such a pull request the task\'s own first deployment still posts its headline comment', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    captureScreenshotMock.mockResolvedValue(new Uint8Array([1]));
    s3Send.mockResolvedValue({});
    upsertTaskCommentMock.mockResolvedValue({ commentId: 'cmt-1' });
    postIssueCommentMock.mockResolvedValue({ ok: true });
    const row: Record<string, unknown> = {
      repo: 'other/repo',
      channel_source: 'linear',
      channel_metadata: { linear_issue_id: 'issue-of-other-repo', linear_workspace_id: 'ws-globex' },
    };
    ddbSend.mockReset().mockImplementation(async (cmd: { _type: string; input: { ExpressionAttributeValues?: Record<string, string> } }) => {
      if (cmd._type === 'Get') return { Item: { repo: row.repo } };
      if (cmd._type === 'Query') return { Items: [] };
      const before = { ...row };
      row.screenshot_url = cmd.input.ExpressionAttributeValues![':u'];
      return { Attributes: before };
    });
    const ref = 'bgagent/01OTHERSTASK/eng-7-x';
    extractFromBranchMock.mockReturnValue('ENG-7');

    fetchOk([{ number: 17, state: 'open', title: 'ENG-7', body: '', head: { ref, sha: 'abc1234', repo: OWN_REPO } }]);
    await handler(payload());
    const otherRepo = { full_name: 'other/repo' };
    fetchOk([{ number: 3, state: 'open', title: 'ENG-7', body: '', head: { ref, sha: 'abc1234', repo: otherRepo }, base: { repo: otherRepo } }]);
    await handler(payload({ repository: { full_name: 'other/repo' } }));

    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(postIssueCommentMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'ws-globex', registryTableName: 'LinearWorkspaceRegistry' },
      'issue-of-other-repo',
      expect.stringContaining('https://d1.cloudfront.net/screenshots/other_repo/'),
    );
    expect(appendOnceToCommentMock).not.toHaveBeenCalled();
  });

  test.each([
    ['a fork', { full_name: 'evil/repo' }, 'screenshot.persist_failed'],
    ['a fork that was deleted', null, 'screenshot.head_repo_missing'],
    ['a branch whose repository GitHub does not name', undefined, 'screenshot.head_repo_missing'],
  ])('a pull request from %s cannot name a task of this repository by its branch', async (_label, headRepo, event) => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ENG-7', body: '', head: { ref: 'bgagent/01TASKID/eng-7-x', sha: 'abc1234', repo: headRepo } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    ddbSend.mockReset().mockResolvedValue({
      Item: { repo: 'owner/repo' },
      Attributes: {
        repo: 'owner/repo',
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'issue-7', linear_workspace_id: 'ws-1' },
      },
    });
    extractFromBranchMock.mockReturnValue('ENG-7');
    findLinearIssueMock.mockResolvedValue(lookupFound({ issueId: 'issue-7', linearWorkspaceId: 'ws-1', workspaceSlug: 'abca' }));
    postIssueCommentMock.mockResolvedValue({ ok: true });
    const warn = jest.spyOn(logger, 'warn');

    await handler(payload());

    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event, task_id: '01TASKID' }));
    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(deliverJiraMock).not.toHaveBeenCalled();
  });

  test('a task whose blueprint spells the repository in another letter case is this repository\'s task', async () => {
    // GitHub reports its own spelling of a repository name and answers to any other.
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    const asGitHubSpellsIt = { full_name: 'Owner/Repo' };
    fetchOk([{
      number: 17,
      state: 'open',
      title: 'ENG-7 fix login',
      body: '',
      head: { ref: 'bgagent/01TASKID/eng-7-fix-login', sha: 'abc1234', repo: asGitHubSpellsIt },
      base: { repo: asGitHubSpellsIt },
    }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    ddbSend.mockReset().mockResolvedValue({
      Item: { repo: 'owner/repo' },
      Attributes: {
        repo: 'owner/repo',
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'issue-globex', linear_workspace_id: 'ws-globex' },
      },
    });
    extractFromBranchMock.mockReturnValue('ENG-7');
    findLinearIssueMock.mockResolvedValue(lookupFound({ issueId: 'issue-acme', linearWorkspaceId: 'ws-acme', workspaceSlug: 'acme' }));
    postIssueCommentMock.mockResolvedValueOnce({ ok: true });

    await handler(payload({ repository: { full_name: 'Owner/Repo' } }));

    expect(sentToTable('Get')).toEqual([expect.objectContaining({ Key: { task_id: '01TASKID' } })]);
    expect(sentToTable('Update')).toEqual([expect.objectContaining({ Key: { task_id: '01TASKID' } })]);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(postIssueCommentMock.mock.calls[0][1]).toBe('issue-globex');
    expect(findLinearIssueMock).not.toHaveBeenCalled();
  });

  test('branch-name identifier wins over a predecessor named in the PR body (stacked PR)', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{
      number: 73,
      state: 'open',
      title: 'feat(destinations): add Lisbon destination card',
      body: 'cherry-picked from predecessor branch ABCA-151 ... Closes ABCA-152',
      head: { ref: 'bgagent/01TASK/abca-152-link-lisbon-from-destinationsht', sha: 'abc1234', repo: OWN_REPO },
    }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce('ABCA-152');
    extractLinearIdentifierMock.mockReturnValueOnce(null).mockReturnValueOnce('ABCA-151');
    findLinearIssueMock.mockImplementation(async (identifier: string) => lookupFound({
      issueId: identifier === 'ABCA-152' ? 'issue-152' : 'issue-151',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    }));
    postIssueCommentMock.mockResolvedValueOnce(true);

    await handler(payload());

    expect(extractFromBranchMock).toHaveBeenCalledWith('bgagent/01TASK/abca-152-link-lisbon-from-destinationsht');
    expect(findLinearIssueMock.mock.calls).toEqual([['ABCA-152', 'LinearWorkspaceRegistry']]);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(postIssueCommentMock.mock.calls[0][1]).toBe('issue-152');
  });

  test('a word and a number in the branch name do not hide the identifier in the title', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ENG-42: Upgrade to Node 22', body: '', head: { ref: 'feature/upgrade-node-22', sha: 'abc1234' } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce('NODE-22');
    extractLinearIdentifierMock.mockReturnValueOnce('ENG-42').mockReturnValueOnce(null);
    findLinearIssueMock.mockImplementation(async (identifier: string) => identifier === 'ENG-42'
      ? lookupFound({ issueId: 'issue-42', linearWorkspaceId: 'ws-1', workspaceSlug: 'abca' })
      : LOOKUP_ABSENT);
    postIssueCommentMock.mockResolvedValueOnce({ ok: true });

    await handler(payload());

    expect(findLinearIssueMock.mock.calls.map((c) => c[0])).toEqual(['NODE-22', 'ENG-42']);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(postIssueCommentMock.mock.calls[0][1]).toBe('issue-42');
  });

  test('an identifier that could not be looked up is not replaced by one further down', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{
      number: 73,
      state: 'open',
      title: 'feat(destinations): add Lisbon destination card',
      body: 'cherry-picked from predecessor branch ABCA-151 ... Closes ABCA-152',
      head: { ref: 'abca-152-link-lisbon-from-destinations', sha: 'abc1234' },
    }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce('ABCA-152');
    extractLinearIdentifierMock.mockReturnValueOnce(null).mockReturnValueOnce('ABCA-151');
    findLinearIssueMock.mockImplementation(async (identifier: string) => identifier === 'ABCA-152'
      ? lookupFailed(new Error('Not every workspace could be asked'))
      : lookupFound({ issueId: 'issue-151', linearWorkspaceId: 'ws-1', workspaceSlug: 'abca' }));

    await handler(payload());

    expect(findLinearIssueMock.mock.calls.map((c) => c[0])).toEqual(['ABCA-152']);
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('falls back to title then body when branch yields no identifier', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'feat: add foo', body: 'closes ABCA-42', head: { ref: 'random-branch', sha: 'abc1234' } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce(null);
    extractLinearIdentifierMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('ABCA-42');
    findLinearIssueMock.mockResolvedValueOnce(lookupFound({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    }));
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
    findLinearIssueMock.mockResolvedValueOnce(LOOKUP_ABSENT);
    const info = jest.spyOn(logger, 'info');

    await handler(payload());

    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Linear identifier did not resolve to an issue — skipping Linear post', {
      identifiers: ['ABCA-42'], repo: 'owner/repo', pr_number: 17,
    });
  });

  test('Linear comment failure does not propagate (best-effort)', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'ABCA-42 fix', body: '' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractLinearIdentifierMock.mockReturnValueOnce('ABCA-42');
    findLinearIssueMock.mockResolvedValueOnce(lookupFound({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-1',
      workspaceSlug: 'abca',
    }));
    postIssueCommentMock.mockResolvedValueOnce({ ok: false, retryable: false });

    await expect(handler(payload())).resolves.toBeUndefined();
  });

  test('persists BOTH screenshot_url and screenshot_preview_url on the task record', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 't', body: '', head: { ref: 'bgagent/01TASKID/abca-42-x', sha: 'abc1234', repo: OWN_REPO } }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    extractFromBranchMock.mockReturnValueOnce(null);
    extractLinearIdentifierMock.mockReturnValue(null);

    await handler(payload());

    const upd = ddbSend.mock.calls.find((c) => c[0]?._type === 'Update');
    expect(upd).toBeDefined();
    const input = upd![0].input as { Key: { task_id: string }; ExpressionAttributeValues: Record<string, string> };
    expect(input.Key.task_id).toBe('01TASKID');
    expect(input.ExpressionAttributeValues[':u']).toMatch(/cloudfront\.net\/screenshots/);
    expect(input.ExpressionAttributeValues[':p']).toBe('https://preview.example.com');
  });

  test('integration node deploy persists the URL but does NOT post a standalone Linear comment', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{
      number: 191,
      state: 'open',
      title: 'feat(pages): integrate FAQ + Reviews (ABCA-301 combined result)',
      body: 'combined',
      head: { ref: 'bgagent/01INTEGRATION/integrate-the-sub-issues', sha: 'abc1234', repo: OWN_REPO },
    }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
    ddbSend.mockReset().mockResolvedValue({
      Item: { repo: 'owner/repo' },
      Attributes: { channel_metadata: { orchestration_sub_issue_id: 'orch_1__integration' } },
    });
    extractFromBranchMock.mockReturnValue(null);
    extractLinearIdentifierMock.mockReturnValue('ABCA-301');

    await handler(payload());

    expect(ddbSend.mock.calls.some((c) => c[0]?._type === 'Update')).toBe(true);
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(findLinearIssueMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  describe('re-deploy on a Linear issue that has iteration replies', () => {
    function reDeploy(headShas: Record<string, string>, repos: Record<string, string> = {}, asGitHubSpellsIt = OWN_REPO): void {
      resolveGitHubTokenMock.mockResolvedValue('gh-tok');
      fetchOk([{
        number: 17,
        state: 'open',
        title: 't',
        body: '',
        head: { ref: 'bgagent/01ORIG/eng-42-x', sha: 'abc1234', repo: asGitHubSpellsIt },
        base: { repo: asGitHubSpellsIt },
      }]);
      captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
      s3Send.mockResolvedValueOnce({});
      upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
      extractFromBranchMock.mockReturnValueOnce('ENG-42');
      findLinearIssueMock.mockResolvedValueOnce(lookupFound({ issueId: 'issue-42', linearWorkspaceId: 'ws-1', workspaceSlug: 'abca' }));
      appendOnceToCommentMock.mockResolvedValueOnce(true);
      ddbSend.mockReset().mockImplementation(async (cmd: { _type: string; input: { Key?: { task_id: string } } }) => {
        if (cmd._type === 'Query') {
          return {
            Items: ['iter-2', 'iter-1'].map((id) => ({
              task_id: id,
              repo: repos[id] ?? 'owner/repo',
              channel_metadata: { iteration_reply_comment_id: id.replace('iter', 'reply') },
            })),
          };
        }
        if (cmd._type === 'Get') return { Item: { repo: 'owner/repo', head_sha: headShas[cmd.input.Key!.task_id] } };
        return { Attributes: { screenshot_url: 'https://d1.cloudfront.net/old.png', channel_metadata: {} } };
      });
    }

    test('stores the screenshot on the iteration that pushed the commit and appends the preview to its reply', async () => {
      reDeploy({ 'iter-2': 'fff0000', 'iter-1': 'abc1234' });

      await handler(payload());

      expect(sentToTable('Query')).toEqual([expect.objectContaining({
        IndexName: 'LinearIssueIndex',
        ExpressionAttributeValues: { ':iid': 'issue-42' },
        ScanIndexForward: false,
      })]);
      expect(sentToTable('Update')).toEqual([
        expect.objectContaining({ Key: { task_id: '01ORIG' } }),
        expect.objectContaining({
          Key: { task_id: 'iter-1' },
          ConditionExpression: 'attribute_exists(task_id)',
          ExpressionAttributeValues: {
            ':u': expect.stringMatching(/^https:\/\/d1\.cloudfront\.net\/screenshots\//),
            ':p': 'https://preview.example.com',
          },
        }),
      ]);
      expect(appendOnceToCommentMock).toHaveBeenCalledTimes(1);
      expect(appendOnceToCommentMock).toHaveBeenCalledWith(
        { linearWorkspaceId: 'ws-1', registryTableName: 'LinearWorkspaceRegistry' },
        'reply-1',
        expect.stringMatching(/^\n\n\[!\[preview\]\(https:\/\/d1\.cloudfront\.net\/screenshots\/[^)]+\)\]\(https:\/\/preview\.example\.com\)$/),
        '[preview]',
      );
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    });

    test('appends to the newest reply when no iteration recorded the deployed commit', async () => {
      reDeploy({ 'iter-2': 'fff0000', 'iter-1': 'eee1111' });

      await handler(payload());

      expect(sentToTable('Update')[1]).toMatchObject({ Key: { task_id: 'iter-2' } });
      expect(appendOnceToCommentMock).toHaveBeenCalledTimes(1);
      expect(appendOnceToCommentMock).toHaveBeenCalledWith(expect.anything(), 'reply-2', expect.any(String), '[preview]');
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    });

    test('a pull request that names an issue of another repository writes nothing onto that issue\'s iteration task', async () => {
      reDeploy({ 'iter-2': 'fff0000', 'iter-1': 'eee1111' }, { 'iter-2': 'globex/site', 'iter-1': 'globex/site' });

      await handler(payload());

      expect(sentToTable('Update')).toEqual([expect.objectContaining({ Key: { task_id: '01ORIG' } })]);
      expect(appendOnceToCommentMock).not.toHaveBeenCalled();
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    });

    test.each([
      ['by its commit', { 'iter-2': 'fff0000', 'iter-1': 'abc1234' }],
      // A fork has the commits of its parent: a task of another repository can have recorded the deployed commit.
      ['as the newest of this repository, although the other one recorded the deployed commit', { 'iter-2': 'abc1234', 'iter-1': 'eee1111' }],
    ])('an iteration of this repository is found %s when the newest iteration is another repository\'s', async (_label, headShas) => {
      reDeploy(headShas, { 'iter-2': 'globex/site' });

      await handler(payload());

      expect(sentToTable('Update')).toEqual([
        expect.objectContaining({ Key: { task_id: '01ORIG' } }),
        expect.objectContaining({ Key: { task_id: 'iter-1' } }),
      ]);
      expect(appendOnceToCommentMock).toHaveBeenCalledTimes(1);
      expect(appendOnceToCommentMock).toHaveBeenCalledWith(expect.anything(), 'reply-1', expect.any(String), '[preview]');
    });

    test('an iteration is found when GitHub spells the repository in another letter case than its blueprint', async () => {
      reDeploy({ 'iter-2': 'fff0000', 'iter-1': 'abc1234' }, {}, { full_name: 'Owner/Repo' });

      await handler(payload({ repository: { full_name: 'Owner/Repo' } }));

      expect(sentToTable('Update')[1]).toMatchObject({ Key: { task_id: 'iter-1' } });
      expect(appendOnceToCommentMock).toHaveBeenCalledWith(expect.anything(), 'reply-1', expect.any(String), '[preview]');
    });
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
    fetchOk([{ number: 12, state: 'open', title: 'ENG-42', body: '', head: { ref: 'bgagent/task-1/ENG-42', sha: 'abc1234', repo: OWN_REPO } }]);
    ddbSend.mockResolvedValue({ Item: { repo: 'owner/repo' }, Attributes: { task_id: 'task-1', repo: 'owner/repo', channel_source: source, channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'ACTUAL-7' } } });
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
    fetchOk([{ number: 17, state: 'open', title: 'ENG-42', head: { ref: 'bgagent/01JXABCDEF1234567890ABCDEF/eng-42', repo: OWN_REPO } }]);
    ddbSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    await handler(payload());
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
    expect(deliverJiraMock).not.toHaveBeenCalled();
    expect(findLinearIssueMock).not.toHaveBeenCalled();
  });

  test('missing Jira registry is observable and never falls through to Linear', async () => {
    const warn = jest.spyOn(logger, 'warn');
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    fetchOk([{ number: 17, state: 'open', head: { ref: 'bgagent/01JXABCDEF1234567890ABCDEF/eng-42', repo: OWN_REPO } }]);
    ddbSend.mockResolvedValue({ Item: { repo: 'owner/repo' }, Attributes: { channel_source: 'jira' } });
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
  const pr41 = { number: 41, state: 'open', title: 'ENG-41', head: { ref: 'bgagent/wrong-task/eng-41', sha, repo: OWN_REPO } };
  const pr42 = { number: 42, state: 'open', title: 'ENG-42', head: { ref: branch, sha, repo: OWN_REPO } };

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
    findLinearIssueMock.mockReset().mockResolvedValue(lookupFound({ issueId: 'issue-42', linearWorkspaceId: 'ws' }));
    extractFromBranchMock.mockReset().mockImplementation((ref) => ref === branch ? 'ENG-42' : 'ENG-41');
  });

  test.each(['jira', 'linear'])('two PRs with one SHA route GitHub and %s feedback to the validated PR', async (source) => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/pulls/42') ? pr42 : [pr41, pr42],
    } as Response));
    const task = { task_id: taskId, repo: 'owner/repo', head_sha: sha, channel_source: source, channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'TG-42' } };
    ddbSend.mockResolvedValue({ Item: { repo: task.repo }, Attributes: task });

    await handler(amplifyEvent());

    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/pulls/42', expect.anything());
    expect(captureScreenshotMock).toHaveBeenCalledWith('https://pr-42.app123.amplifyapp.com', expect.anything());
    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', issueOrPrNumber: 42 }));
    expect(ddbSend.mock.calls[0][0].input.Key).toEqual({ task_id: taskId });
    expect(sentToTable('Update')).toEqual([expect.objectContaining({ Key: { task_id: taskId } })]);
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
    ['a fork', { full_name: 'evil/repo' }],
    ['a fork that was deleted', null],
  ])('a validated pull request from %s cannot name a task by its branch', async (_label, headRepo) => {
    fetchOk({ ...pr42, head: { ...pr42.head, repo: headRepo } });
    ddbSend.mockResolvedValue({
      Item: { repo: 'owner/repo' },
      Attributes: { task_id: taskId, repo: 'owner/repo', head_sha: sha, channel_source: 'jira', channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'TG-42' } },
    });

    await handler(amplifyEvent());

    expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/repo', issueOrPrNumber: 42 }));
    expect(ddbSend).not.toHaveBeenCalled();
    expect(deliverJiraMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test.each([
    [pr41, 'pr_number_mismatch'],
    [{ ...pr42, state: 'closed' }, 'pr_not_open'],
    [{ ...pr42, head: { ref: branch, sha: 'b'.repeat(40) } }, 'live_pr_head_sha_mismatch'],
    [{ ...pr42, head: { sha } }, 'missing_head_ref'],
    [null, 'malformed_pr_response'],
    [[pr41, pr42], 'malformed_pr_response'],
    ['invalid', 'malformed_pr_response'],
  ])('rejects a changed or malformed PR without capturing or falling back: %j', async (pr, reason) => {
    jest.useFakeTimers();
    try {
      const log = jest.spyOn(logger, 'warn');
      const error = jest.spyOn(logger, 'error');
      const start = Date.now();
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => pr } as Response);
      const pending = handler(amplifyEvent());
      await jest.runAllTimersAsync();
      await pending;
      expect(log).toHaveBeenCalledWith('Validated Amplify PR no longer matches preview', {
        event: 'screenshot.amplify_pr_rejected', reason, repo: 'owner/repo', pr_number: 42,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/pulls/42', expect.anything());
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      expect(Date.now()).toBe(start);
      expect(captureScreenshotMock).not.toHaveBeenCalled();
      expect(ddbSend).not.toHaveBeenCalled();
      expect(upsertTaskCommentMock).not.toHaveBeenCalled();
      expect(deliverJiraMock).not.toHaveBeenCalled();
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([404, 400, 401, 422])('HTTP %s stops immediately with an actionable request error', async (status) => {
    jest.useFakeTimers();
    try {
      const warn = jest.spyOn(logger, 'warn');
      const error = jest.spyOn(logger, 'error');
      const fetchMock = fetchOk({}, status);
      const start = Date.now();
      const pending = handler(amplifyEvent());
      await jest.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('GitHub rejected the validated Amplify PR lookup', {
        event: 'screenshot.pr_lookup_rejected',
        error_id: 'SCREENSHOT_PR_LOOKUP_REJECTED',
        reason: status === 404 ? 'pr_not_found' : 'pr_request_rejected',
        repo: 'owner/repo',
        pr_number: 42,
        status,
      });
      expect(Date.now()).toBe(start);
      expect(captureScreenshotMock).not.toHaveBeenCalled();
      expect(upsertTaskCommentMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each(['fetch error', 'timeout', '500', '502', '503', 'non-JSON', '403 quota', '403 retry-after', '403 no headers', '403 remaining quota', '408', '429'])('retries transient %s and captures the same PR after recovery', async (failure) => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.spyOn(global, 'fetch');
      if (failure === 'fetch error') {
        fetchMock.mockRejectedValueOnce(new Error('network unavailable'));
      } else if (failure === 'timeout') {
        fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));
      } else if (failure.startsWith('403')) {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 403,
          headers: new Headers(failure === '403 quota' ? { 'x-ratelimit-remaining': '0' }
            : failure === '403 retry-after' ? { 'retry-after': '5' }
              : failure === '403 remaining quota' ? { 'x-ratelimit-remaining': '4999' } : {}),
        } as Response);
      } else if (['408', '429', '500', '502', '503'].includes(failure)) {
        fetchMock.mockResolvedValueOnce({ ok: false, status: Number(failure), headers: new Headers() } as Response);
      } else {
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('secret-response-fragment'); } } as unknown as Response);
      }
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => pr42 } as Response);
      const error = jest.spyOn(logger, 'error');
      const warn = jest.spyOn(logger, 'warn');
      const pending = handler(amplifyEvent());
      await jest.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url] of fetchMock.mock.calls) expect(url).toBe('https://api.github.com/repos/owner/repo/pulls/42');
      expect(captureScreenshotMock).toHaveBeenCalledTimes(1);
      expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ issueOrPrNumber: 42 }));
      expect(error).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-response-fragment');
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([503, 403])('persistent HTTP %s failures retain the operational error', async (status) => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status, headers: new Headers({ 'x-ratelimit-remaining': '4999' }) } as Response);
      const error = jest.spyOn(logger, 'error');
      const pending = handler(amplifyEvent());
      await jest.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        error_id: 'SCREENSHOT_PR_LOOKUP_EXHAUSTED', reason: 'http_error',
      }));
      expect(captureScreenshotMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('coerces non-string PR title/body before Linear identifier lookup', async () => {
    fetchOk({ ...pr42, title: {}, body: 42 });
    ddbSend.mockResolvedValue({ Item: { repo: 'owner/repo' }, Attributes: {} });
    extractLinearIdentifierMock.mockReset().mockReturnValue(null);
    extractFromBranchMock.mockReturnValue(null);
    await handler(amplifyEvent());
    expect(extractLinearIdentifierMock).toHaveBeenCalledTimes(2);
    expect(extractLinearIdentifierMock).toHaveBeenNthCalledWith(1, '');
    expect(extractLinearIdentifierMock).toHaveBeenNthCalledWith(2, '');
    expect(upsertTaskCommentMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    'https://preview.example.com/path?token=secret',
    'not-a-url?token=secret',
    'https://user:secret@pr-42.app123.amplifyapp.com',
    'https://pr-42.app123.amplifyapp.com:8080/path?token=secret',
    'http://pr-42.app123.amplifyapp.com/path?token=secret',
  ])('revalidates the forwarded Amplify URL without logging secrets: %s', async (url) => {
    const warn = jest.spyOn(logger, 'warn');
    const forwarded = amplifyEvent();
    const raw = JSON.parse(forwarded.raw_body);
    raw.deployment_status.environment_url = url;
    await handler({ ...forwarded, raw_body: JSON.stringify(raw) });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
    expect(captureScreenshotMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'screenshot.preview_url_rejected', reason: 'untrusted_preview_url', url_parsed: url.startsWith('http') }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(url);
  });

  test.each([41, 99])('a preview for PR %s cannot override forwarded PR 42', async (previewPr) => {
    const warn = jest.spyOn(logger, 'warn');
    const error = jest.spyOn(logger, 'error');
    const forwarded = amplifyEvent();
    const raw = JSON.parse(forwarded.raw_body);
    raw.deployment_status.environment_url = `https://pr-${previewPr}.app123.amplifyapp.com/path?token=secret`;
    await handler({ ...forwarded, raw_body: JSON.stringify(raw) });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
    expect(captureScreenshotMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: 'screenshot.preview_url_rejected',
      error_id: 'SCREENSHOT_PREVIEW_PR_MISMATCH',
      reason: 'preview_pr_number_mismatch',
      pr_number: 42,
    }));
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
  });

  test.each([
    ['deployment', 'http_error', 404],
    ['deployment', 'malformed_pr_response', 200],
    ['deployment', 'pr_not_linked', 200],
    ['amplify', 'fetch_failed', 200],
    ['amplify', 'non_json_response', 200],
  ] as const)('%s lookup exhausts %s without capture', async (provider, reason, status) => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      if (reason === 'fetch_failed') throw new Error('network unavailable');
      return {
        ok: status === 200,
        status,
        headers: new Headers(),
        json: async () => {
          if (reason === 'non_json_response') throw new SyntaxError('secret-response-fragment');
          return reason === 'pr_not_linked' ? [] : {};
        },
      } as Response;
    });
    const error = jest.spyOn(logger, 'error');
    const warn = jest.spyOn(logger, 'warn');
    const pending = handler(provider === 'amplify' ? amplifyEvent() : payload());
    await jest.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    if (provider === 'deployment') {
      expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/commits/abc1234/pulls', expect.anything());
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: 'screenshot.pr_lookup_exhausted', error_id: 'SCREENSHOT_PR_LOOKUP_EXHAUSTED', reason,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-response-fragment');
    expect(captureScreenshotMock).not.toHaveBeenCalled();
    expect(upsertTaskCommentMock).not.toHaveBeenCalled();
  });

  test('token resolution consuming the lookup budget skips GitHub and capture', async () => {
    jest.useFakeTimers();
    resolveGitHubTokenMock.mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 65_000);
      return 'token';
    });
    const fetchMock = jest.spyOn(global, 'fetch');
    const error = jest.spyOn(logger, 'error');
    await handler(amplifyEvent());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureScreenshotMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      error_id: 'SCREENSHOT_PR_LOOKUP_EXHAUSTED', reason: 'budget_exhausted', budget_ms: 0,
    }));
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid forwarded PR number %s', async (number) => {
    const warn = jest.spyOn(logger, 'warn');
    await handler({ ...amplifyEvent(), validated_pr_number: number });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      event: 'screenshot.amplify_pr_rejected', reason: 'invalid_forwarded_pr_number',
    });
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
    expect(captureScreenshotMock).not.toHaveBeenCalled();
  });
});
