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

import { resolveGitHubToken } from './context-hydration';
import { logger } from './logger';
import type { BlueprintConfig } from './repo-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PreflightFailureReason = {
  GITHUB_UNREACHABLE: 'GITHUB_UNREACHABLE',
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

async function checkRepoAccess(repo: string, token: string): Promise<PreflightCheckResult> {
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
    if (resp.ok) {
      return { check: 'repo_access', passed: true, durationMs };
    }
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

// ---------------------------------------------------------------------------
// Main pre-flight check runner
// ---------------------------------------------------------------------------

export async function runPreflightChecks(repo: string, blueprintConfig: BlueprintConfig, prNumber?: number): Promise<PreflightResult> {
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
      checkRepoAccess(repo, token),
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

  // Prioritize GITHUB_UNREACHABLE over REPO_NOT_FOUND_OR_NO_ACCESS
  const primaryFailure = failedChecks.find(c => c.reason === PreflightFailureReason.GITHUB_UNREACHABLE)
    ?? failedChecks[0];

  return {
    passed: false,
    checks,
    failureReason: primaryFailure.reason,
    failureDetail: primaryFailure.detail,
  };
}
