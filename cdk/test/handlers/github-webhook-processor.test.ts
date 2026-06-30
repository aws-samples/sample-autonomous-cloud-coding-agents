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
jest.mock('../../src/handlers/shared/linear-issue-lookup', () => ({
  findLinearIssueByIdentifier: (...args: unknown[]) => findLinearIssueMock(...args),
  extractLinearIdentifier: (...args: unknown[]) => extractLinearIdentifierMock(...args),
}));

process.env.SCREENSHOT_BUCKET_NAME = 'screenshot-bucket';
process.env.SCREENSHOT_PUBLIC_HOST = 'd1.cloudfront.net';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-token';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

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

  test('happy path: PR found → screenshot → S3 → PR comment posted', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'feat: add x', body: 'body' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });

    await handler(payload());

    // captureScreenshot receives a deadline-aware budget.
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
    fetchOk([{ number: 17, state: 'open', title: 'ABCA-42 fix login', body: 'body' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
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

  test('falls back to extractor on PR body when title yields no identifier', async () => {
    resolveGitHubTokenMock.mockResolvedValue('gh-tok');
    fetchOk([{ number: 17, state: 'open', title: 'feat: add foo', body: 'closes ABCA-42' }]);
    captureScreenshotMock.mockResolvedValueOnce(new Uint8Array([1]));
    s3Send.mockResolvedValueOnce({});
    upsertTaskCommentMock.mockResolvedValueOnce({ commentId: 'cmt-1' });
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
});
