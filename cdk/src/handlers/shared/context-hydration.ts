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

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { logger } from './logger';
import { loadMemoryContext, type MemoryContext } from './memory';
import type { TaskRecord } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single comment on a GitHub issue.
 */
export interface IssueComment {
  readonly author: string;
  readonly body: string;
}

/**
 * GitHub issue context fetched from the REST API.
 */
export interface GitHubIssueContext {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly comments: IssueComment[];
}

/**
 * A review comment on a GitHub pull request.
 */
export interface PullRequestReviewComment {
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly diff_hunk?: string;
}

/**
 * GitHub pull request context fetched from the REST API.
 */
export interface GitHubPullRequestContext {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly head_ref: string;
  readonly base_ref: string;
  readonly state: string;
  readonly diff_summary: string;
  readonly review_comments: PullRequestReviewComment[];
  readonly issue_comments: IssueComment[];
}

/**
 * The result of the context hydration pipeline.
 */
export interface HydratedContext {
  readonly version: number;
  readonly user_prompt: string;
  readonly issue?: GitHubIssueContext;
  readonly memory_context?: MemoryContext;
  readonly sources: string[];
  readonly token_estimate: number;
  readonly truncated: boolean;
  readonly fallback_error?: string;
  readonly resolved_branch_name?: string;
  readonly resolved_base_branch?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN;
const USER_PROMPT_TOKEN_BUDGET = Number(process.env.USER_PROMPT_TOKEN_BUDGET ?? '100000');
const GITHUB_API_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// GitHub token resolution (Secrets Manager with caching)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const smClient = new SecretsManagerClient({});

/**
 * Resolve the GitHub token from Secrets Manager with per-ARN caching.
 * @param secretArn - the ARN of the secret.
 * @returns the secret string.
 */
export async function resolveGitHubToken(secretArn: string): Promise<string> {
  const cached = tokenCache.get(secretArn);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error('GitHub token secret is empty');
  }

  tokenCache.set(secretArn, { token: result.SecretString, expiresAt: Date.now() + CACHE_TTL_MS });
  return result.SecretString;
}

/**
 * Clear the cached tokens (for testing).
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// GitHub issue fetching
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub issue's title, body, and comments via the REST API.
 * Returns null on any error (logged).
 * Mirrors agent/entrypoint.py:fetch_github_issue.
 * @param repo - the "owner/repo" string.
 * @param issueNumber - the issue number.
 * @param token - the GitHub PAT.
 * @returns the issue context or null on failure.
 */
export async function fetchGitHubIssue(
  repo: string,
  issueNumber: number,
  token: string,
): Promise<GitHubIssueContext | null> {
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    // Fetch issue
    const issueResp = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
      { headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    );
    if (!issueResp.ok) {
      logger.warn('GitHub issue fetch failed', {
        repo, issue_number: issueNumber, status: issueResp.status,
      });
      return null;
    }
    const issue = await issueResp.json() as Record<string, unknown>;

    // Fetch comments if any
    const comments: IssueComment[] = [];
    const commentCount = issue.comments as number ?? 0;
    if (commentCount > 0) {
      const commentsResp = await fetch(
        `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
        { headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
      );
      if (commentsResp.ok) {
        const raw = await commentsResp.json() as Array<Record<string, unknown>>;
        for (const c of raw) {
          comments.push({
            author: (c.user as Record<string, unknown>)?.login as string ?? 'unknown',
            body: c.body as string ?? '',
          });
        }
      } else {
        logger.warn('GitHub comments fetch failed', {
          repo, issue_number: issueNumber, status: commentsResp.status,
        });
      }
    }

    return {
      number: issue.number as number,
      title: issue.title as string,
      body: (issue.body as string) ?? '',
      comments,
    };
  } catch (err) {
    logger.warn('GitHub issue fetch error', {
      repo, issue_number: issueNumber, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub pull request fetching
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub pull request's metadata, review comments, issue comments, and diff summary.
 * Returns null on any error (logged).
 * @param repo - the "owner/repo" string.
 * @param prNumber - the PR number.
 * @param token - the GitHub PAT.
 * @returns the PR context or null on failure.
 */
export async function fetchGitHubPullRequest(
  repo: string,
  prNumber: number,
  token: string,
): Promise<GitHubPullRequestContext | null> {
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    // Fetch PR metadata, review comments, issue comments, and files in parallel
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [prResp, reviewResp, issueResp, filesResp] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
        headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      }),
      fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`, {
        headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      }),
      fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`, {
        headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      }),
      fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`, {
        headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      }),
    ]);

    if (!prResp.ok) {
      logger.warn('GitHub PR fetch failed', { repo, pr_number: prNumber, status: prResp.status });
      return null;
    }

    const pr = await prResp.json() as Record<string, unknown>;

    // Parse review comments
    const reviewComments: PullRequestReviewComment[] = [];
    if (reviewResp.ok) {
      const raw = await reviewResp.json() as Array<Record<string, unknown>>;
      for (const c of raw) {
        reviewComments.push({
          author: (c.user as Record<string, unknown>)?.login as string ?? 'unknown',
          body: c.body as string ?? '',
          path: c.path as string | undefined,
          line: c.line as number | undefined,
          diff_hunk: c.diff_hunk as string | undefined,
        });
      }
    } else {
      logger.warn('GitHub PR review comments fetch failed', {
        repo, pr_number: prNumber, status: reviewResp.status,
      });
    }

    // Parse issue/conversation comments
    const issueComments: IssueComment[] = [];
    if (issueResp.ok) {
      const raw = await issueResp.json() as Array<Record<string, unknown>>;
      for (const c of raw) {
        issueComments.push({
          author: (c.user as Record<string, unknown>)?.login as string ?? 'unknown',
          body: c.body as string ?? '',
        });
      }
    } else {
      logger.warn('GitHub PR conversation comments fetch failed', {
        repo, pr_number: prNumber, status: issueResp.status,
      });
    }

    // Build diff summary from files
    let diffSummary = '';
    if (filesResp.ok) {
      const files = await filesResp.json() as Array<Record<string, unknown>>;
      const fileParts: string[] = [];
      for (const f of files) {
        const filename = f.filename as string;
        const status = f.status as string;
        const additions = f.additions as number;
        const deletions = f.deletions as number;
        const patch = (f.patch as string | undefined) ?? '';
        const truncatedPatch = patch.length > 500 ? patch.slice(0, 500) + '\n... [truncated]' : patch;
        fileParts.push(`### ${filename} (${status}, +${additions}/-${deletions})\n\`\`\`diff\n${truncatedPatch}\n\`\`\``);
      }
      diffSummary = fileParts.join('\n\n');
    } else {
      logger.warn('GitHub PR files fetch failed', {
        repo, pr_number: prNumber, status: filesResp.status,
      });
    }

    // Validate critical nested fields before accessing
    const head = pr.head as Record<string, unknown> | null | undefined;
    const base = pr.base as Record<string, unknown> | null | undefined;
    if (!head?.ref || !base?.ref) {
      logger.warn('PR missing head_ref or base_ref (possibly deleted fork)', {
        repo, pr_number: prNumber, has_head: !!head?.ref, has_base: !!base?.ref,
      });
      return null;
    }

    return {
      number: pr.number as number,
      title: pr.title as string,
      body: (pr.body as string) ?? '',
      head_ref: head.ref as string,
      base_ref: base.ref as string,
      state: pr.state as string,
      diff_summary: diffSummary,
      review_comments: reviewComments,
      issue_comments: issueComments,
    };
  } catch (err) {
    logger.warn('GitHub PR fetch error', {
      repo, pr_number: prNumber, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token estimation and budget enforcement
// ---------------------------------------------------------------------------

/**
 * Estimate the token count for a string using a character heuristic.
 * ~4 characters per token for English text.
 * @param text - the input text.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Enforce a token budget on the issue context by trimming oldest comments first.
 * Operates on the raw issue data BEFORE prompt assembly.
 * @param issue - the issue context (may be modified via shallow copy).
 * @param taskDescription - the user task description.
 * @param budget - the token budget.
 * @returns the (possibly trimmed) issue, taskDescription, and truncated flag.
 */
export function enforceTokenBudget(
  issue: GitHubIssueContext | undefined,
  taskDescription: string | undefined,
  budget: number,
): { issue: GitHubIssueContext | undefined; taskDescription: string | undefined; truncated: boolean } {
  // Quick estimate of all text combined
  let total = 0;
  if (issue) {
    total += estimateTokens(issue.title) + estimateTokens(issue.body);
    for (const c of issue.comments) {
      total += estimateTokens(c.author) + estimateTokens(c.body);
    }
  }
  if (taskDescription) {
    total += estimateTokens(taskDescription);
  }

  if (total <= budget) {
    return { issue, taskDescription, truncated: false };
  }

  // Truncate: remove oldest comments first (from the front)
  if (issue && issue.comments.length > 0) {
    const trimmedComments = [...issue.comments];
    while (trimmedComments.length > 0) {
      const removed = trimmedComments.shift()!;
      total -= estimateTokens(removed.author) + estimateTokens(removed.body);
      if (total <= budget) {
        return {
          issue: { ...issue, comments: trimmedComments },
          taskDescription,
          truncated: true,
        };
      }
    }
    // All comments removed, still over budget — return issue without comments
    issue = { ...issue, comments: [] };
  }

  return { issue, taskDescription, truncated: true };
}

// ---------------------------------------------------------------------------
// User prompt assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the user prompt from issue context and task description.
 * Mirrors agent/entrypoint.py:assemble_prompt exactly.
 * @param taskId - the task ID.
 * @param repo - the "owner/repo" string.
 * @param issue - the GitHub issue context (optional).
 * @param taskDescription - the user's task description (optional).
 * @returns the assembled user prompt.
 */
export function assembleUserPrompt(
  taskId: string,
  repo: string,
  issue?: GitHubIssueContext,
  taskDescription?: string,
): string {
  const parts: string[] = [];

  parts.push(`Task ID: ${taskId}`);
  parts.push(`Repository: ${repo}`);

  if (issue) {
    parts.push(`\n## GitHub Issue #${issue.number}: ${issue.title}\n`);
    parts.push(issue.body || '(no description)');
    if (issue.comments.length > 0) {
      parts.push('\n### Comments\n');
      for (const c of issue.comments) {
        parts.push(`**@${c.author}**: ${c.body}\n`);
      }
    }
  }

  if (taskDescription) {
    parts.push(`\n## Task\n\n${taskDescription}`);
  } else if (issue) {
    parts.push(
      '\n## Task\n\nResolve the GitHub issue described above. '
      + 'Follow the workflow in your system instructions.',
    );
  }

  return parts.join('\n');
}

/**
 * Assemble the user prompt for a PR iteration task.
 * @param taskId - the task ID.
 * @param repo - the "owner/repo" string.
 * @param pr - the GitHub PR context.
 * @param taskDescription - optional additional user instructions.
 * @returns the assembled user prompt.
 */
export function assemblePrIterationPrompt(
  taskId: string,
  repo: string,
  pr: GitHubPullRequestContext,
  taskDescription?: string,
): string {
  const parts: string[] = [];

  parts.push(`Task ID: ${taskId}`);
  parts.push(`Repository: ${repo}`);
  parts.push(`\n## Pull Request #${pr.number}: ${pr.title}\n`);
  parts.push(pr.body || '(no description)');
  parts.push(`\nBase branch: ${pr.base_ref}`);
  parts.push(`Head branch: ${pr.head_ref}`);

  if (pr.review_comments.length > 0) {
    parts.push('\n### Review Comments\n');
    for (const c of pr.review_comments) {
      const location = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
      parts.push(`**@${c.author}**${location}: ${c.body}\n`);
      if (c.diff_hunk) {
        parts.push(`\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n`);
      }
    }
  }

  if (pr.issue_comments.length > 0) {
    parts.push('\n### Conversation Comments\n');
    for (const c of pr.issue_comments) {
      parts.push(`**@${c.author}**: ${c.body}\n`);
    }
  }

  if (pr.diff_summary) {
    parts.push('\n### Current Diff\n');
    parts.push(pr.diff_summary);
  }

  if (taskDescription) {
    parts.push(`\n## Additional Instructions\n\n${taskDescription}`);
  } else {
    parts.push(
      '\n## Task\n\nAddress the review feedback on this pull request. '
      + 'Follow the workflow in your system instructions.',
    );
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main hydration pipeline
// ---------------------------------------------------------------------------

/**
 * Options for context hydration, allowing per-repo overrides.
 */
export interface HydrateContextOptions {
  /** Override the GitHub token secret ARN (from per-repo Blueprint config). */
  readonly githubTokenSecretArn?: string;
  /** AgentCore Memory ID for loading cross-task memory context. */
  readonly memoryId?: string;
}

/**
 * Hydrate context for a task: resolve GitHub token, fetch issue, enforce
 * token budget, and assemble the user prompt.
 * @param task - the task record from DynamoDB.
 * @param options - optional per-repo overrides.
 * @returns the hydrated context.
 */
export async function hydrateContext(task: TaskRecord, options?: HydrateContextOptions): Promise<HydratedContext> {
  const sources: string[] = [];
  let issue: GitHubIssueContext | undefined;
  let memoryContext: MemoryContext | undefined;

  try {
    // Fetch GitHub issue, memory context, and PR context in parallel
    const memoryId = options?.memoryId ?? process.env.MEMORY_ID;
    const tokenSecretArn = options?.githubTokenSecretArn ?? GITHUB_TOKEN_SECRET_ARN;

    const isPrIteration = task.task_type === 'pr_iteration';

    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [issueResult, memoryResult, prResult] = await Promise.all([
      // Issue fetch (skip for pr_iteration)
      (async () => {
        if (isPrIteration) return undefined;
        if (task.issue_number !== undefined && tokenSecretArn) {
          try {
            const token = await resolveGitHubToken(tokenSecretArn);
            return await fetchGitHubIssue(task.repo, task.issue_number, token) ?? undefined;
          } catch (err) {
            logger.warn('Failed to resolve GitHub token or fetch issue', {
              task_id: task.task_id, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return undefined;
      })(),
      // Memory context load (fail-open)
      memoryId
        ? loadMemoryContext(memoryId, task.repo, task.task_description)
        : Promise.resolve(undefined),
      // PR fetch (only for pr_iteration)
      (async () => {
        if (isPrIteration && task.pr_number !== undefined && tokenSecretArn) {
          try {
            const token = await resolveGitHubToken(tokenSecretArn);
            return await fetchGitHubPullRequest(task.repo, task.pr_number, token) ?? undefined;
          } catch (err) {
            logger.warn('Failed to fetch PR context', {
              task_id: task.task_id,
              pr_number: task.pr_number,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return undefined;
      })(),
    ]);

    issue = issueResult;
    memoryContext = memoryResult;

    if (issue) {
      sources.push('issue');
    }
    if (prResult) {
      sources.push('pull_request');
    }
    if (memoryContext) {
      sources.push('memory');
    }
    if (task.task_description) {
      sources.push('task_description');
    }

    // Build user prompt based on task type
    let userPrompt: string;
    let resolvedBranchName: string | undefined;
    let resolvedBaseBranch: string | undefined;

    if (isPrIteration) {
      if (!prResult) {
        // PR fetch failed for a pr_iteration task — log error and return minimal context
        logger.error('PR context fetch failed for pr_iteration task', {
          task_id: task.task_id, pr_number: task.pr_number,
        });
        const fallbackPrompt = assembleUserPrompt(task.task_id, task.repo, undefined, task.task_description);
        return {
          version: 1,
          user_prompt: fallbackPrompt,
          sources: task.task_description ? ['task_description'] : [],
          token_estimate: estimateTokens(fallbackPrompt),
          truncated: false,
          fallback_error: `Failed to fetch PR #${task.pr_number} context from GitHub`,
        };
      }

      // Enforce token budget on the assembled PR prompt
      const budgetResult = enforceTokenBudget(undefined, task.task_description, USER_PROMPT_TOKEN_BUDGET);
      userPrompt = assemblePrIterationPrompt(task.task_id, task.repo, prResult, budgetResult.taskDescription);

      // Trim PR context if the assembled prompt exceeds the token budget
      let truncated = budgetResult.truncated;
      const promptEstimate = estimateTokens(userPrompt);
      if (promptEstimate > USER_PROMPT_TOKEN_BUDGET) {
        logger.warn('PR iteration prompt exceeds token budget — trimming review comments', {
          task_id: task.task_id, estimate: promptEstimate, budget: USER_PROMPT_TOKEN_BUDGET,
        });
        // Trim oldest review comments until under budget
        const trimmedReviewComments = [...prResult.review_comments];
        const trimmedIssueComments = [...prResult.issue_comments];
        let trimmedPr = {
          ...prResult,
          review_comments: trimmedReviewComments,
          issue_comments: trimmedIssueComments,
        };
        const estimateTrimmed = (): number =>
          estimateTokens(assemblePrIterationPrompt(
            task.task_id, task.repo, trimmedPr, budgetResult.taskDescription,
          ));
        while (trimmedIssueComments.length > 0 && estimateTrimmed() > USER_PROMPT_TOKEN_BUDGET) {
          trimmedIssueComments.shift();
          trimmedPr = { ...trimmedPr, issue_comments: trimmedIssueComments };
        }
        while (trimmedReviewComments.length > 0 && estimateTrimmed() > USER_PROMPT_TOKEN_BUDGET) {
          trimmedReviewComments.shift();
          trimmedPr = { ...trimmedPr, review_comments: trimmedReviewComments };
        }
        userPrompt = assemblePrIterationPrompt(task.task_id, task.repo, trimmedPr, budgetResult.taskDescription);
        truncated = true;
      }

      resolvedBranchName = prResult.head_ref;
      resolvedBaseBranch = prResult.base_ref;

      return {
        version: 1,
        user_prompt: userPrompt,
        memory_context: memoryContext,
        resolved_branch_name: resolvedBranchName,
        resolved_base_branch: resolvedBaseBranch,
        sources,
        token_estimate: estimateTokens(userPrompt),
        truncated,
      };
    }

    // Standard task: existing behavior
    const budgetResult = enforceTokenBudget(issue, task.task_description, USER_PROMPT_TOKEN_BUDGET);
    issue = budgetResult.issue;

    userPrompt = assembleUserPrompt(task.task_id, task.repo, issue, budgetResult.taskDescription);
    const tokenEstimate = estimateTokens(userPrompt);

    return {
      version: 1,
      user_prompt: userPrompt,
      issue,
      memory_context: memoryContext,
      sources,
      token_estimate: tokenEstimate,
      truncated: budgetResult.truncated,
    };
  } catch (err) {
    // Fallback: minimal context from task_description only
    logger.error('Unexpected error during context hydration', {
      task_id: task.task_id, error: err instanceof Error ? err.message : String(err),
    });
    const fallbackPrompt = assembleUserPrompt(task.task_id, task.repo, undefined, task.task_description);
    return {
      version: 1,
      user_prompt: fallbackPrompt,
      sources: task.task_description ? ['task_description'] : [],
      token_estimate: estimateTokens(fallbackPrompt),
      truncated: false,
      fallback_error: err instanceof Error ? err.message : String(err),
    };
  }
}
