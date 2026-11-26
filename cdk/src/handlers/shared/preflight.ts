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

import { resolveGitHubToken, MissingSecretError, SecretUnreadableError } from './context-hydration';
import { logger } from './logger';
import type { BlueprintConfig } from './repo-config';

export const PreflightFailureReason = {
  GITHUB_UNREACHABLE: 'GITHUB_UNREACHABLE',
  INSUFFICIENT_GITHUB_REPO_PERMISSIONS: 'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
  REPO_NOT_FOUND_OR_NO_ACCESS: 'REPO_NOT_FOUND_OR_NO_ACCESS',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  PR_NOT_FOUND_OR_CLOSED: 'PR_NOT_FOUND_OR_CLOSED',
  PR_FROM_FORK: 'PR_FROM_FORK',
  GITHUB_TOKEN_SECRET_MISSING: 'GITHUB_TOKEN_SECRET_MISSING',
  GITHUB_TOKEN_SECRET_UNREADABLE: 'GITHUB_TOKEN_SECRET_UNREADABLE',
} as const;

export type PreflightFailureReasonType = typeof PreflightFailureReason[keyof typeof PreflightFailureReason];

export interface PreflightCheckResult {
  readonly check: string;
  readonly passed: boolean;
  readonly reason?: PreflightFailureReasonType;
  readonly detail?: string;
  readonly httpStatus?: number;
  readonly durationMs: number;
}

export interface PreflightResult {
  readonly passed: boolean;
  readonly checks: readonly PreflightCheckResult[];
  readonly failureReason?: PreflightFailureReasonType;
  readonly failureDetail?: string;
}

const GITHUB_API_TIMEOUT_MS = 5_000;

const CONTENTS_WRITE_LEVELS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/** GitHub collaborator roles: TRIAGE can manage PRs without push. */
const PR_REVIEW_INTERACTION_LEVELS = new Set(['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']);

function splitRepo(repo: string): { owner: string; name: string } | undefined {
  const idx = repo.indexOf('/');
  if (idx <= 0 || idx === repo.length - 1) {
    return undefined;
  }
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

async function fetchViewerPermission(repo: string, token: string): Promise<string | undefined> {
  const parts = splitRepo(repo);
  if (!parts) {
    return undefined;
  }
  const resp = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      query: 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerPermission}}',
      variables: { owner: parts.owner, name: parts.name },
    }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (resp.status >= 500 || resp.status === 429) {
    throw new Error(`GitHub GraphQL API returned HTTP ${resp.status} for ${repo}`);
  }
  if (!resp.ok) {
    return undefined;
  }
  const body = await resp.json() as { data?: { repository?: { viewerPermission?: string | null } } };
  const perm = body.data?.repository?.viewerPermission;
  return perm ?? undefined;
}

async function checkGitHubReachability(token: string): Promise<PreflightCheckResult> {
  const start = Date.now();
  try {
    const resp = await fetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    const durationMs = Date.now() - start;
    if (resp.ok) {
      return { check: 'github_reachability', passed: true, durationMs };
    }
    return {
      check: 'github_reachability',
      passed: false,
      reason: PreflightFailureReason.GITHUB_UNREACHABLE,
      detail: `GitHub API returned HTTP ${resp.status}`,
      httpStatus: resp.status,
      durationMs,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('GitHub reachability check failed', { error: detail });
    return {
      check: 'github_reachability',
      passed: false,
      reason: PreflightFailureReason.GITHUB_UNREACHABLE,
      detail,
      durationMs: Date.now() - start,
    };
  }
}

async function checkRepoAccess(repo: string, token: string, readOnly: boolean): Promise<PreflightCheckResult> {
  const start = Date.now();
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    const durationMs = Date.now() - start;
    if (!resp.ok) {
      // GitHub answers 403 to a rate-limited token too, with x-ratelimit-remaining: 0
      // (primary limit) or a retry-after header (secondary limit), while /rate_limit
      // keeps answering 200.
      const rateLimited = resp.status === 403
        && (resp.headers.get('x-ratelimit-remaining') === '0' || resp.headers.has('retry-after'));
      if ((resp.status === 404 || resp.status === 403) && !rateLimited) {
        return {
          check: 'repo_access',
          passed: false,
          reason: PreflightFailureReason.REPO_NOT_FOUND_OR_NO_ACCESS,
          detail: `GitHub API returned HTTP ${resp.status} for ${repo}`,
          httpStatus: resp.status,
          durationMs,
        };
      }
      return {
        check: 'repo_access',
        passed: false,
        reason: PreflightFailureReason.GITHUB_UNREACHABLE,
        detail: `GitHub API returned HTTP ${resp.status} for ${repo}${rateLimited ? ' (rate limited)' : ''}`,
        httpStatus: resp.status,
        durationMs,
      };
    }

    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return {
        check: 'repo_access',
        passed: false,
        reason: PreflightFailureReason.GITHUB_UNREACHABLE,
        detail: `GitHub API returned invalid JSON for ${repo}`,
        durationMs: Date.now() - start,
      };
    }

    const permissions = (body as { permissions?: { push?: boolean } }).permissions;
    const restPush = permissions?.push === true;

    let viewerPermission: string | undefined;
    if (!restPush) {
      viewerPermission = await fetchViewerPermission(repo, token);
    }

    const contentsWriteOk = restPush || (viewerPermission !== undefined && CONTENTS_WRITE_LEVELS.has(viewerPermission));
    const prReviewOk = restPush || (viewerPermission !== undefined && PR_REVIEW_INTERACTION_LEVELS.has(viewerPermission));

    const needsWrite = !readOnly;
    const sufficient = needsWrite ? contentsWriteOk : prReviewOk;

    if (!sufficient) {
      const need = needsWrite
        ? 'Contents write (push branches) for this repository'
        : 'Pull request interaction (e.g. TRIAGE or Contents write) for this repository';
      const permHint = viewerPermission !== undefined ? ` GitHub reports viewerPermission=${viewerPermission}.` : '';
      const restHint = permissions?.push === false
        ? ' REST API reports push=false for this token.'
        : '';
      return {
        check: 'repo_access',
        passed: false,
        reason: PreflightFailureReason.INSUFFICIENT_GITHUB_REPO_PERMISSIONS,
        detail:
          `Token cannot ${needsWrite ? 'push to' : 'interact with pull requests on'} ${repo}.${restHint}${permHint}`
          + ` Required: ${need}. For fine-grained PATs use Contents **Read and write**, Pull requests **Read and write**, and Issues **Read** on this repo (see developer guide / agent README).`,
        durationMs: Date.now() - start,
      };
    }

    return { check: 'repo_access', passed: true, durationMs: Date.now() - start };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('Repo access check failed', { repo, error: detail });
    return {
      check: 'repo_access',
      passed: false,
      reason: PreflightFailureReason.GITHUB_UNREACHABLE,
      detail,
      durationMs: Date.now() - start,
    };
  }
}

/** GitHub returns `repo` as null once the fork is deleted. */
interface PullRequestSide {
  readonly repo?: { readonly full_name?: unknown } | null;
}

async function checkPrAccessible(repo: string, prNumber: number, token: string): Promise<PreflightCheckResult> {
  const start = Date.now();
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    const durationMs = Date.now() - start;
    if (!resp.ok) {
      return {
        check: 'pr_accessible',
        passed: false,
        reason: resp.status === 404 || resp.status === 403
          ? PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED
          : PreflightFailureReason.GITHUB_UNREACHABLE,
        detail: `GitHub API returned HTTP ${resp.status} for PR #${prNumber} in ${repo}`,
        httpStatus: resp.status,
        durationMs,
      };
    }
    const pr = await resp.json() as Record<string, unknown>;
    if (pr.state !== 'open') {
      return {
        check: 'pr_accessible',
        passed: false,
        reason: PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED,
        detail: `PR #${prNumber} in ${repo} is ${pr.state}, not open`,
        durationMs,
      };
    }
    const headRepo = (pr.head as PullRequestSide | undefined)?.repo?.full_name;
    const baseRepo = (pr.base as PullRequestSide | undefined)?.repo?.full_name;
    if (typeof headRepo !== 'string' || headRepo !== baseRepo) {
      return {
        check: 'pr_accessible',
        passed: false,
        reason: PreflightFailureReason.PR_FROM_FORK,
        detail: `PR #${prNumber} in ${repo} comes from another repository (a fork): its branch is not in ${repo}, so it cannot be checked out or pushed to`,
        durationMs,
      };
    }
    return { check: 'pr_accessible', passed: true, durationMs };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('PR accessibility check failed', { repo, pr_number: prNumber, error: detail });
    return {
      check: 'pr_accessible',
      passed: false,
      reason: PreflightFailureReason.GITHUB_UNREACHABLE,
      detail,
      durationMs: Date.now() - start,
    };
  }
}

async function checkRuntimeAvailability(): Promise<PreflightCheckResult> {
  const start = Date.now();
  return { check: 'runtime_availability', passed: true, durationMs: Date.now() - start };
}

const PREFLIGHT_FAILURE_PRIORITY: readonly PreflightFailureReasonType[] = [
  PreflightFailureReason.GITHUB_TOKEN_SECRET_MISSING,
  PreflightFailureReason.GITHUB_TOKEN_SECRET_UNREADABLE,
  PreflightFailureReason.GITHUB_UNREACHABLE,
  PreflightFailureReason.INSUFFICIENT_GITHUB_REPO_PERMISSIONS,
  PreflightFailureReason.REPO_NOT_FOUND_OR_NO_ACCESS,
  PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED,
  PreflightFailureReason.PR_FROM_FORK,
  PreflightFailureReason.RUNTIME_UNAVAILABLE,
];

function pickPrimaryPreflightFailure(failedChecks: PreflightCheckResult[]): PreflightCheckResult {
  for (const reason of PREFLIGHT_FAILURE_PRIORITY) {
    const hit = failedChecks.find(c => c.reason === reason);
    if (hit) {
      return hit;
    }
  }
  return failedChecks[0];
}

export async function runPreflightChecks(
  repo: string | undefined,
  blueprintConfig: BlueprintConfig,
  prNumber?: number,
  readOnly = false,
  requiresRepo = true,
): Promise<PreflightResult> {
  const checks: PreflightCheckResult[] = [];

  if (!requiresRepo) {
    return { passed: true, checks };
  }

  if (!repo) {
    return {
      passed: false,
      checks,
      failureReason: PreflightFailureReason.GITHUB_UNREACHABLE,
      failureDetail: 'repo-bound workflow has no repo (internal invariant violation)',
    };
  }

  if (blueprintConfig.github_token_secret_arn) {
    let token: string;
    const tokenStart = Date.now();
    try {
      token = await resolveGitHubToken(blueprintConfig.github_token_secret_arn);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = err instanceof MissingSecretError
        ? PreflightFailureReason.GITHUB_TOKEN_SECRET_MISSING
        : err instanceof SecretUnreadableError
          ? PreflightFailureReason.GITHUB_TOKEN_SECRET_UNREADABLE
          : PreflightFailureReason.GITHUB_UNREACHABLE;
      logger.error('GitHub token resolution failed', { repo, error: detail, reason });
      checks.push({
        check: 'github_token_resolution',
        passed: false,
        reason,
        detail,
        durationMs: Date.now() - tokenStart,
      });
      return {
        passed: false,
        checks,
        failureReason: reason,
        failureDetail: detail,
      };
    }

    const results = await Promise.allSettled([
      checkGitHubReachability(token),
      checkRepoAccess(repo, token, readOnly),
      ...(prNumber !== undefined ? [checkPrAccessible(repo, prNumber, token)] : []),
    ]);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        checks.push(result.value);
      } else {
        const errorDetail = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.error('Pre-flight check promise rejected unexpectedly', { repo, error: errorDetail });
        checks.push({
          check: 'unknown',
          passed: false,
          reason: PreflightFailureReason.GITHUB_UNREACHABLE,
          detail: `Internal error: ${errorDetail}`,
          durationMs: 0,
        });
      }
    }
  } else {
    logger.warn('No GitHub token configured — skipping GitHub pre-flight checks', { repo });
  }

  if (process.env.PREFLIGHT_CHECK_RUNTIME === 'true') {
    checks.push(await checkRuntimeAvailability());
  }

  const failedChecks = checks.filter(c => !c.passed);
  if (failedChecks.length === 0) {
    return { passed: true, checks };
  }

  const primaryFailure = pickPrimaryPreflightFailure(failedChecks);

  return {
    passed: false,
    checks,
    failureReason: primaryFailure.reason,
    failureDetail: primaryFailure.detail,
  };
}
