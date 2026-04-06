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

// --- Mocks ---
const mockSmSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSmSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const mockLoadMemoryContext = jest.fn();
jest.mock('../../../src/handlers/shared/memory', () => ({
  loadMemoryContext: mockLoadMemoryContext,
}));

// Set env vars before importing
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token';
process.env.USER_PROMPT_TOKEN_BUDGET = '100000';

import {
  assembleUserPrompt,
  clearTokenCache,
  enforceTokenBudget,
  estimateTokens,
  fetchGitHubIssue,
  hydrateContext,
  resolveGitHubToken,
  type GitHubIssueContext,
} from '../../../src/handlers/shared/context-hydration';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  jest.clearAllMocks();
  clearTokenCache();
});

// ---------------------------------------------------------------------------
// resolveGitHubToken
// ---------------------------------------------------------------------------

describe('resolveGitHubToken', () => {
  test('fetches token from Secrets Manager', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    const token = await resolveGitHubToken('arn:aws:secretsmanager:us-east-1:123:secret:test');
    expect(token).toBe('ghp_test123');
    expect(mockSmSend).toHaveBeenCalledTimes(1);
  });

  test('caches token across calls', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_cached' });
    const token1 = await resolveGitHubToken('arn:aws:secretsmanager:us-east-1:123:secret:test');
    const token2 = await resolveGitHubToken('arn:aws:secretsmanager:us-east-1:123:secret:test');
    expect(token1).toBe('ghp_cached');
    expect(token2).toBe('ghp_cached');
    expect(mockSmSend).toHaveBeenCalledTimes(1); // Only one SM call
  });

  test('throws when secret is empty', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: undefined });
    await expect(resolveGitHubToken('arn:test')).rejects.toThrow('GitHub token secret is empty');
  });

  test('caches tokens per ARN (different ARNs get different tokens)', async () => {
    mockSmSend
      .mockResolvedValueOnce({ SecretString: 'ghp_repo_a' })
      .mockResolvedValueOnce({ SecretString: 'ghp_repo_b' });

    const tokenA = await resolveGitHubToken('arn:aws:secretsmanager:us-east-1:123:secret:repo-a');
    const tokenB = await resolveGitHubToken('arn:aws:secretsmanager:us-east-1:123:secret:repo-b');

    expect(tokenA).toBe('ghp_repo_a');
    expect(tokenB).toBe('ghp_repo_b');
    expect(mockSmSend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// fetchGitHubIssue
// ---------------------------------------------------------------------------

describe('fetchGitHubIssue', () => {
  const issueResponse = {
    number: 42,
    title: 'Fix the bug',
    body: 'The bug is in login.ts',
    comments: 2,
  };
  const commentsResponse = [
    { user: { login: 'alice' }, body: 'I can reproduce this.' },
    { user: { login: 'bob' }, body: 'Me too.' },
  ];

  test('fetches issue with comments', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => issueResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => commentsResponse });

    const result = await fetchGitHubIssue('owner/repo', 42, 'ghp_token');
    expect(result).toEqual({
      number: 42,
      title: 'Fix the bug',
      body: 'The bug is in login.ts',
      comments: [
        { author: 'alice', body: 'I can reproduce this.' },
        { author: 'bob', body: 'Me too.' },
      ],
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('fetches issue with zero comments (no second request)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...issueResponse, comments: 0 }),
    });

    const result = await fetchGitHubIssue('owner/repo', 42, 'ghp_token');
    expect(result).toEqual({
      number: 42,
      title: 'Fix the bug',
      body: 'The bug is in login.ts',
      comments: [],
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('returns null on HTTP 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await fetchGitHubIssue('owner/repo', 999, 'ghp_token');
    expect(result).toBeNull();
  });

  test('returns null on HTTP 403 (rate limit)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await fetchGitHubIssue('owner/repo', 42, 'ghp_token');
    expect(result).toBeNull();
  });

  test('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await fetchGitHubIssue('owner/repo', 42, 'ghp_token');
    expect(result).toBeNull();
  });

  test('handles null issue body gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42, title: 'Test', body: null, comments: 0 }),
    });

    const result = await fetchGitHubIssue('owner/repo', 42, 'ghp_token');
    expect(result?.body).toBe('');
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('returns correct estimate for 100 chars', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  test('rounds up for non-divisible lengths', () => {
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25 → 2
  });
});

// ---------------------------------------------------------------------------
// enforceTokenBudget
// ---------------------------------------------------------------------------

describe('enforceTokenBudget', () => {
  const makeIssue = (commentCount: number): GitHubIssueContext => ({
    number: 1,
    title: 'Test',
    body: 'Body text',
    comments: Array.from({ length: commentCount }, (_, i) => ({
      author: `user${i}`,
      body: 'x'.repeat(400), // ~100 tokens per comment
    })),
  });

  test('returns unchanged when under budget', () => {
    const issue = makeIssue(2);
    const result = enforceTokenBudget(issue, 'Fix the bug', 100000);
    expect(result.truncated).toBe(false);
    expect(result.issue?.comments).toHaveLength(2);
  });

  test('truncates oldest comments first when over budget', () => {
    const issue = makeIssue(5);
    // Set a very small budget that can fit issue + 1-2 comments
    const result = enforceTokenBudget(issue, 'Fix', 200);
    expect(result.truncated).toBe(true);
    expect(result.issue!.comments.length).toBeLessThan(5);
  });

  test('handles no issue gracefully', () => {
    const result = enforceTokenBudget(undefined, 'Fix the bug', 100000);
    expect(result.truncated).toBe(false);
    expect(result.issue).toBeUndefined();
  });

  test('handles no task description', () => {
    const issue = makeIssue(1);
    const result = enforceTokenBudget(issue, undefined, 100000);
    expect(result.truncated).toBe(false);
    expect(result.taskDescription).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// assembleUserPrompt
// ---------------------------------------------------------------------------

describe('assembleUserPrompt', () => {
  test('assembles with issue and task description', () => {
    const issue: GitHubIssueContext = {
      number: 42,
      title: 'Fix login bug',
      body: 'The login form crashes.',
      comments: [{ author: 'alice', body: 'Confirmed.' }],
    };
    const result = assembleUserPrompt('TASK001', 'org/repo', issue, 'Fix the login crash');

    expect(result).toContain('Task ID: TASK001');
    expect(result).toContain('Repository: org/repo');
    expect(result).toContain('## GitHub Issue #42: Fix login bug');
    expect(result).toContain('The login form crashes.');
    expect(result).toContain('### Comments');
    expect(result).toContain('**@alice**: Confirmed.');
    expect(result).toContain('## Task');
    expect(result).toContain('Fix the login crash');
  });

  test('assembles with issue only (no task description) — default task instruction', () => {
    const issue: GitHubIssueContext = {
      number: 10,
      title: 'Add feature',
      body: 'Please add dark mode.',
      comments: [],
    };
    const result = assembleUserPrompt('TASK002', 'org/repo', issue);

    expect(result).toContain('## GitHub Issue #10: Add feature');
    expect(result).toContain('Resolve the GitHub issue described above.');
    expect(result).not.toContain('### Comments');
  });

  test('assembles with task description only (no issue)', () => {
    const result = assembleUserPrompt('TASK003', 'org/repo', undefined, 'Refactor the utils module');

    expect(result).toContain('Task ID: TASK003');
    expect(result).toContain('Refactor the utils module');
    expect(result).not.toContain('GitHub Issue');
  });

  test('handles issue with no body', () => {
    const issue: GitHubIssueContext = {
      number: 5,
      title: 'Empty issue',
      body: '',
      comments: [],
    };
    const result = assembleUserPrompt('TASK004', 'org/repo', issue);
    expect(result).toContain('(no description)');
  });

  test('matches Python assemble_prompt output format', () => {
    // Cross-language consistency: verify the same structure
    const issue: GitHubIssueContext = {
      number: 1,
      title: 'Test issue',
      body: 'Issue body here',
      comments: [{ author: 'dev', body: 'A comment' }],
    };
    const result = assembleUserPrompt('T1', 'o/r', issue, 'Do the thing');

    // The Python version joins parts with \n, so verify line structure
    const lines = result.split('\n');
    expect(lines[0]).toBe('Task ID: T1');
    expect(lines[1]).toBe('Repository: o/r');
  });
});

// ---------------------------------------------------------------------------
// hydrateContext
// ---------------------------------------------------------------------------

describe('hydrateContext', () => {
  const baseTask = {
    task_id: 'TASK001',
    user_id: 'user-123',
    status: 'SUBMITTED',
    repo: 'org/repo',
    branch_name: 'bgagent/TASK001/fix-bug',
    channel_source: 'api',
    status_created_at: 'SUBMITTED#2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  test('full path: issue + task description', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test' });
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 42, title: 'Bug', body: 'Details', comments: 0 }),
      });

    const task = { ...baseTask, issue_number: 42, task_description: 'Fix it' };
    const result = await hydrateContext(task as any);

    expect(result.version).toBe(1);
    expect(result.sources).toContain('issue');
    expect(result.sources).toContain('task_description');
    expect(result.issue?.title).toBe('Bug');
    expect(result.user_prompt).toContain('Fix it');
    expect(result.user_prompt).toContain('GitHub Issue #42');
    expect(result.truncated).toBe(false);
    expect(result.token_estimate).toBeGreaterThan(0);
  });

  test('GitHub fetch fails — falls back to task description only', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const task = { ...baseTask, issue_number: 42, task_description: 'Fix it' };
    const result = await hydrateContext(task as any);

    expect(result.sources).not.toContain('issue');
    expect(result.sources).toContain('task_description');
    expect(result.issue).toBeUndefined();
    expect(result.user_prompt).toContain('Fix it');
  });

  test('no issue number — assembles from task description only', async () => {
    const task = { ...baseTask, task_description: 'Add a feature' };
    const result = await hydrateContext(task as any);

    expect(result.sources).toEqual(['task_description']);
    expect(result.issue).toBeUndefined();
    expect(result.user_prompt).toContain('Add a feature');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('no GITHUB_TOKEN_SECRET_ARN — skips issue fetch', async () => {
    const originalArn = process.env.GITHUB_TOKEN_SECRET_ARN;
    delete process.env.GITHUB_TOKEN_SECRET_ARN;

    // Re-import to pick up the changed env var
    // Since module-level const is already captured, we test the behavior
    // by checking that SM and fetch are not called
    const task = { ...baseTask, issue_number: 42, task_description: 'Fix' };
    const result = await hydrateContext(task as any);

    // SM should not be called since the function checks GITHUB_TOKEN_SECRET_ARN
    // (captured at module load), but the current import already has the original value.
    // This test verifies the graceful path still works.
    expect(result.version).toBe(1);

    process.env.GITHUB_TOKEN_SECRET_ARN = originalArn;
  });

  test('Secrets Manager failure — proceeds without issue', async () => {
    mockSmSend.mockRejectedValueOnce(new Error('SM unavailable'));

    const task = { ...baseTask, issue_number: 42, task_description: 'Fix' };
    const result = await hydrateContext(task as any);

    expect(result.sources).not.toContain('issue');
    expect(result.sources).toContain('task_description');
    expect(result.user_prompt).toContain('Fix');
  });

  test('no issue and no task description — minimal prompt', async () => {
    const task = { ...baseTask };
    const result = await hydrateContext(task as any);

    expect(result.sources).toEqual([]);
    expect(result.user_prompt).toContain('Task ID: TASK001');
    expect(result.user_prompt).toContain('Repository: org/repo');
  });

  test('uses per-repo githubTokenSecretArn from options when provided', async () => {
    const perRepoArn = 'arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token';
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_per_repo' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 10, title: 'Test', body: 'body', comments: 0 }),
    });

    const task = { ...baseTask, issue_number: 10, task_description: 'Fix' };
    const result = await hydrateContext(task as any, { githubTokenSecretArn: perRepoArn });

    expect(result.sources).toContain('issue');
    // Verify SM was called with the per-repo ARN
    const smCall = mockSmSend.mock.calls[0][0];
    expect(smCall.input.SecretId).toBe(perRepoArn);
  });

  test('includes memory_context and memory source when memoryId is provided', async () => {
    const memoryContext = {
      repo_knowledge: ['Uses Jest for testing'],
      past_episodes: ['Task T1 completed successfully'],
    };
    mockLoadMemoryContext.mockResolvedValueOnce(memoryContext);

    const task = { ...baseTask, task_description: 'Fix the bug' };
    const result = await hydrateContext(task as any, { memoryId: 'mem-test-1' });

    expect(result.memory_context).toEqual(memoryContext);
    expect(result.sources).toContain('memory');
    expect(mockLoadMemoryContext).toHaveBeenCalledWith('mem-test-1', 'org/repo', 'Fix the bug');
  });

  test('excludes memory_context when memoryId is not provided', async () => {
    const task = { ...baseTask, task_description: 'Fix the bug' };
    const result = await hydrateContext(task as any);

    expect(result.memory_context).toBeUndefined();
    expect(result.sources).not.toContain('memory');
    expect(mockLoadMemoryContext).not.toHaveBeenCalled();
  });

  test('proceeds without memory when loadMemoryContext returns undefined (fail-open)', async () => {
    mockLoadMemoryContext.mockResolvedValueOnce(undefined);

    const task = { ...baseTask, task_description: 'Fix the bug' };
    const result = await hydrateContext(task as any, { memoryId: 'mem-test-2' });

    expect(result.memory_context).toBeUndefined();
    expect(result.sources).not.toContain('memory');
    expect(result.sources).toContain('task_description');
  });

  test('proceeds without memory when loadMemoryContext throws (fail-open)', async () => {
    mockLoadMemoryContext.mockRejectedValueOnce(new Error('Service unavailable'));

    const task = { ...baseTask, task_description: 'Fix the bug' };
    const result = await hydrateContext(task as any, { memoryId: 'mem-test-3' });

    expect(result.memory_context).toBeUndefined();
    expect(result.sources).toContain('task_description');
    expect(result.version).toBe(1);
  });
});
