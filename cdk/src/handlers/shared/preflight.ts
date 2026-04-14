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

// Admission / pre-invoke checks before orchestration. See docs/design/ORCHESTRATOR.md (admission control).
// Tests: cdk/test/handlers/shared/preflight.test.ts

import { resolveGitHubToken } from './context-hydration';
import { logger } from './logger';
import type { BlueprintConfig } from './repo-config';
import type { TaskType } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PreflightFailureReason = {
  GITHUB_UNREACHABLE: 'GITHUB_UNREACHABLE',
  INSUFFICIENT_GITHUB_REPO_PERMISSIONS: 'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
  REPO_NOT_FOUND_OR_NO_ACCESS: 'REPO_NOT_FOUND_OR_NO_ACCESS',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  PR_NOT_FOUND_OR_CLOSED: 'PR_NOT_FOUND_OR_CLOSED',
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API_TIMEOUT_MS = 5_000;

/** GitHub GraphQL `viewerPermission` values that allow pushing branches (new_task / pr_iteration). */
const CONTENTS_WRITE_LEVELS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/**
 * Minimum `viewerPermission` for pr_review (issue/PR comments without Contents write).
 * See GitHub collaborator roles; TRIAGE can manage PRs without push.
 */
const PR_REVIEW_INTERACTION_LEVELS = new Set(['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']);

function taskRequiresContentsWrite(taskType: TaskType): boolean {
  return taskType === 'new_task' || taskType === 'pr_iteration';
}

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
  try {
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
    if (!resp.ok) {
      return undefined;
    }
    const body = await resp.json() as { data?: { repository?: { viewerPermission?: string | null } } };
    const perm = body.data?.repository?.viewerPermission;
    return perm ?? undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('GitHub GraphQL viewerPermission lookup failed', { repo, error: detail });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal check functions
// ---------------------------------------------------------------------------

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

async function checkRepoAccess(repo: string, token: string, taskType: TaskType): Promise<PreflightCheckResult> {
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
      if (resp.status === 404 || resp.status === 403) {
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
        detail: `GitHub API returned HTTP ${resp.status} for ${repo}`,
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

    const needsWrite = taskRequiresContentsWrite(taskType);
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
        reason: PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED,
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

/** Order for surfacing the most actionable failure when multiple checks fail. */
const PREFLIGHT_FAILURE_PRIORITY: readonly PreflightFailureReasonType[] = [
  PreflightFailureReason.GITHUB_UNREACHABLE,
  PreflightFailureReason.INSUFFICIENT_GITHUB_REPO_PERMISSIONS,
  PreflightFailureReason.REPO_NOT_FOUND_OR_NO_ACCESS,
  PreflightFailureReason.PR_NOT_FOUND_OR_CLOSED,
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

// ---------------------------------------------------------------------------
// Main pre-flight check runner
// ---------------------------------------------------------------------------

export async function runPreflightChecks(
  repo: string,
  blueprintConfig: BlueprintConfig,
  prNumber?: number,
  taskType: TaskType = 'new_task',
): Promise<PreflightResult> {
  const checks: PreflightCheckResult[] = [];

  if (blueprintConfig.github_token_secret_arn) {
    // Resolve token — fail immediately if token resolution fails
    let token: string;
    const tokenStart = Date.now();
    try {
      token = await resolveGitHubToken(blueprintConfig.github_token_secret_arn);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('GitHub token resolution failed', { repo, error: detail });
      checks.push({
        check: 'github_token_resolution',
        passed: false,
        reason: PreflightFailureReason.GITHUB_UNREACHABLE,
        detail,
        durationMs: Date.now() - tokenStart,
      });
      return {
        passed: false,
        checks,
        failureReason: PreflightFailureReason.GITHUB_UNREACHABLE,
        failureDetail: detail,
      };
    }

    // Run reachability + repo access checks in parallel
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const results = await Promise.allSettled([
      checkGitHubReachability(token),
      checkRepoAccess(repo, token, taskType),
      ...(prNumber !== undefined ? [checkPrAccessible(repo, prNumber, token)] : []),
    ]);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        checks.push(result.value);
      } else {
        // Defensive: inner check functions catch internally, but handle unexpected rejections fail-closed
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

  // Runtime check (behind feature flag — read at call time so tests can toggle)
  if (process.env.PREFLIGHT_CHECK_RUNTIME === 'true') {
    checks.push(await checkRuntimeAvailability());
  }

  // Aggregate: passed only if all checks passed
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
