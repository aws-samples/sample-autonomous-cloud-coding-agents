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

// --- Mocks (before imports) ---
const mockSmSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSmSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

jest.mock('../../../src/handlers/shared/memory', () => ({
  loadMemoryContext: jest.fn(),
}));

import { clearTokenCache } from '../../../src/handlers/shared/context-hydration';
import {
  PreflightFailureReason,
  runPreflightChecks,
} from '../../../src/handlers/shared/preflight';
import type { BlueprintConfig } from '../../../src/handlers/shared/repo-config';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const baseBlueprintConfig: BlueprintConfig = {
  compute_type: 'AGENTCORE',
  runtime_arn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test',
  github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token',
};

/** Successful GET /repos/... with a `permissions` object (preflight parses JSON). */
function githubRepoOk(permissions: { push?: boolean; pull?: boolean } = { push: true }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ permissions }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearTokenCache();
  delete process.env.PREFLIGHT_CHECK_RUNTIME;
});

// ---------------------------------------------------------------------------
// runPreflightChecks
// ---------------------------------------------------------------------------

describe('runPreflightChecks', () => {
  test('all checks pass when token configured and both GitHub calls return 200', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].check).toBe('github_reachability');
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[1].check).toBe('repo_access');
    expect(result.checks[1].passed).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  test('skips GitHub checks when no token configured — passes with no fetch/SM calls', async () => {
    const config: BlueprintConfig = {
      ...baseBlueprintConfig,
      github_token_secret_arn: undefined,
    };

    const result = await runPreflightChecks('owner/repo', config);

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(mockSmSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('passes with runtime check enabled (placeholder always passes)', async () => {
    process.env.PREFLIGHT_CHECK_RUNTIME = 'true';
    const config: BlueprintConfig = {
      ...baseBlueprintConfig,
      github_token_secret_arn: undefined,
    };

    const result = await runPreflightChecks('owner/repo', config);

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe('runtime_availability');
    expect(result.checks[0].passed).toBe(true);
  });

  test('fails GITHUB_UNREACHABLE on rate_limit 5xx', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('500');
  });

  test('fails GITHUB_UNREACHABLE on rate_limit 401 (revoked token)', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_revoked' });
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('401');
  });

  test('fails GITHUB_UNREACHABLE on network timeout', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockRejectedValueOnce(new Error('The operation was aborted'))
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('aborted');
  });

  test('fails GITHUB_UNREACHABLE on DNS/network error', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'))
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('ENOTFOUND');
  });

  test('fails REPO_NOT_FOUND_OR_NO_ACCESS on repo 404', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.REPO_NOT_FOUND_OR_NO_ACCESS);
    expect(result.failureDetail).toContain('404');
    expect(result.failureDetail).toContain('owner/repo');
  });

  test('fails REPO_NOT_FOUND_OR_NO_ACCESS on repo 403', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.REPO_NOT_FOUND_OR_NO_ACCESS);
    expect(result.failureDetail).toContain('403');
  });

  test('reports GITHUB_UNREACHABLE as primary reason when both checks fail', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.checks).toHaveLength(2);
    const failedChecks = result.checks.filter(c => !c.passed);
    expect(failedChecks).toHaveLength(2);
  });

  test('fails GITHUB_UNREACHABLE when Secrets Manager is unavailable', async () => {
    mockSmSend.mockRejectedValueOnce(new Error('Service unavailable'));

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('Service unavailable');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe('github_token_resolution');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('fails GITHUB_UNREACHABLE when token secret is empty', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: undefined });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('empty');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('measures durationMs on each check (>= 0)', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    for (const check of result.checks) {
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof check.durationMs).toBe('number');
    }
  });

  test('skips runtime check when env var not set', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(true);
    const runtimeCheck = result.checks.find(c => c.check === 'runtime_availability');
    expect(runtimeCheck).toBeUndefined();
  });

  test('fails GITHUB_UNREACHABLE on repo 5xx', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 502 });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('502');
    expect(result.failureDetail).toContain('owner/repo');
  });

  test('fails GITHUB_UNREACHABLE on repo network error', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('socket hang up'));

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.GITHUB_UNREACHABLE);
    expect(result.failureDetail).toContain('socket hang up');
  });

  test('handles Promise.allSettled unexpected rejection fail-closed', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    // Both promises reject — inner functions should catch, but test defensive path
    mockFetch
      .mockImplementationOnce(() => { throw new Error('sync throw in reachability'); })
      .mockImplementationOnce(() => { throw new Error('sync throw in repo access'); });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.checks.length).toBeGreaterThanOrEqual(1);
    // At least one check should be failed
    const failedChecks = result.checks.filter(c => !c.passed);
    expect(failedChecks.length).toBeGreaterThanOrEqual(1);
  });

  test('passes when prNumber is provided and PR is open', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 }) // reachability
      .mockResolvedValueOnce(githubRepoOk()) // repo access
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: 'open' }) }); // PR

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig, 42);

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks[2].check).toBe('pr_accessible');
    expect(result.checks[2].passed).toBe(true);
  });

  test('fails when PR returns 404', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk())
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig, 42);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED);
  });

  test('fails when PR is closed', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_test123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk())
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: 'closed' }) });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig, 42);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED);
  });

  test('uses per-repo github_token_secret_arn from blueprint config', async () => {
    const perRepoArn = 'arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token';
    const config: BlueprintConfig = {
      ...baseBlueprintConfig,
      github_token_secret_arn: perRepoArn,
    };
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_per_repo' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk());

    const result = await runPreflightChecks('owner/repo', config);

    expect(result.passed).toBe(true);
    const smCall = mockSmSend.mock.calls[0][0];
    expect(smCall.input.SecretId).toBe(perRepoArn);
  });

  test('fails INSUFFICIENT_GITHUB_REPO_PERMISSIONS when token is read-only (GraphQL viewer READ)', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_readonly' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk({ push: false, pull: true }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { viewerPermission: 'READ' } } }),
      });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.INSUFFICIENT_GITHUB_REPO_PERMISSIONS);
    expect(result.failureDetail).toMatch(/push|Contents write/i);
  });

  test('passes new_task when REST omits push but GraphQL reports WRITE', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_fine_grained' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk({}))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { viewerPermission: 'WRITE' } } }),
      });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig);

    expect(result.passed).toBe(true);
    expect(result.checks.filter(c => c.check === 'repo_access' && c.passed)).toHaveLength(1);
  });

  test('passes pr_review when token has TRIAGE but not push (GraphQL)', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_triage' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk({ push: false, pull: true }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: 'open' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { viewerPermission: 'TRIAGE' } } }),
      });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig, 7, 'pr_review');

    expect(result.passed).toBe(true);
  });

  test('fails pr_review when viewerPermission is READ-only', async () => {
    mockSmSend.mockResolvedValueOnce({ SecretString: 'ghp_readonly' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(githubRepoOk({ push: false, pull: true }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: 'open' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { viewerPermission: 'READ' } } }),
      });

    const result = await runPreflightChecks('owner/repo', baseBlueprintConfig, 7, 'pr_review');

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(PreflightFailureReason.INSUFFICIENT_GITHUB_REPO_PERMISSIONS);
  });
});
