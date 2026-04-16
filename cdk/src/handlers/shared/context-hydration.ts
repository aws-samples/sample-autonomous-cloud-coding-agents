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

import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { logger } from './logger';
import { loadMemoryContext, type MemoryContext } from './memory';
import { sanitizeExternalContent } from './sanitization';
import { isPrTaskType, type TaskRecord, type TaskType } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Detail of a single guardrail filter that triggered. */
export interface GuardrailAssessmentDetail {
  readonly filter_type: 'CONTENT' | 'TOPIC' | 'WORD' | 'SENSITIVE_INFO';
  readonly filter_name: string;
  readonly confidence?: string;
  readonly action: string;
}

/** Result of guardrail screening including assessment details. */
export interface GuardrailScreeningResult {
  readonly action: 'GUARDRAIL_INTERVENED' | 'NONE';
  readonly assessments?: GuardrailAssessmentDetail[];
}

/**
 * A single comment on a GitHub issue.
 */
export interface IssueComment {
  readonly id: number;
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
  readonly id: number;
  readonly in_reply_to_id?: number;
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly diff_hunk?: string;
}

/**
 * GitHub pull request context fetched from the GitHub API.
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
  readonly guardrail_blocked?: string;
  readonly resolved_branch_name?: string;
  readonly resolved_base_branch?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN;
const USER_PROMPT_TOKEN_BUDGET = Number(process.env.USER_PROMPT_TOKEN_BUDGET ?? '100000');
const GITHUB_API_TIMEOUT_MS = 30_000;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const bedrockClient = (GUARDRAIL_ID && GUARDRAIL_VERSION) ? new BedrockRuntimeClient({}) : undefined;
if (GUARDRAIL_ID && !GUARDRAIL_VERSION) {
  logger.error('GUARDRAIL_ID is set but GUARDRAIL_VERSION is missing — guardrail screening disabled', {
    metric_type: 'guardrail_misconfiguration',
  });
}

// ---------------------------------------------------------------------------
// Bedrock Guardrail screening
// ---------------------------------------------------------------------------

/**
 * Error thrown when the Bedrock Guardrail API call fails. Distinguished from
 * other errors so the outer catch in hydrateContext can re-throw it instead of
 * falling back to unscreened content (fail-closed).
 */
export class GuardrailScreeningError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GuardrailScreeningError';
  }
}

/** Mapping from policy response keys to assessment detail extraction rules. */
const POLICY_EXTRACTORS: ReadonlyArray<{
  readonly policyKey: string;
  readonly itemsKey: string;
  readonly filterType: GuardrailAssessmentDetail['filter_type'];
  readonly nameField: string;
}> = [
  { policyKey: 'contentPolicy', itemsKey: 'filters', filterType: 'CONTENT', nameField: 'type' },
  { policyKey: 'topicPolicy', itemsKey: 'topics', filterType: 'TOPIC', nameField: 'name' },
  { policyKey: 'wordPolicy', itemsKey: 'customWords', filterType: 'WORD', nameField: 'match' },
  { policyKey: 'wordPolicy', itemsKey: 'managedWordLists', filterType: 'WORD', nameField: 'match' },
  { policyKey: 'sensitiveInformationPolicy', itemsKey: 'piiEntities', filterType: 'SENSITIVE_INFO', nameField: 'type' },
];

/**
 * Extract assessment details from the Bedrock ApplyGuardrail response.
 */
function extractAssessmentDetails(
  assessments: Array<Record<string, unknown>> | undefined,
): GuardrailAssessmentDetail[] {
  const details: GuardrailAssessmentDetail[] = [];
  if (!assessments) return details;

  for (const assessment of assessments) {
    for (const extractor of POLICY_EXTRACTORS) {
      const policy = assessment[extractor.policyKey] as Record<string, unknown> | undefined;
      const items = policy?.[extractor.itemsKey] as Array<Record<string, unknown>> | undefined;
      if (items) {
        for (const item of items) {
          details.push({
            filter_type: extractor.filterType,
            filter_name: (item[extractor.nameField] as string) ?? 'UNKNOWN',
            ...(item.confidence !== undefined && { confidence: item.confidence as string }),
            action: (item.action as string) ?? 'BLOCKED',
          });
        }
      }
    }
  }

  return details;
}

/**
 * Format a guardrail-blocked message from the screening result.
 * Returns undefined when the guardrail did not intervene.
 */
function formatGuardrailBlocked(
  screenResult: GuardrailScreeningResult | undefined,
  prefix: string,
): string | undefined {
  if (screenResult?.action !== 'GUARDRAIL_INTERVENED') return undefined;
  const details = screenResult.assessments
    ?.map(a => `${a.filter_type}/${a.filter_name}${a.confidence ? ` (${a.confidence})` : ''}`)
    .join(', ');
  return `${prefix} blocked by content policy${details ? ': ' + details : ''}`;
}

/**
 * Screen text through the Bedrock Guardrail for prompt injection detection.
 * Fail-closed: throws on Bedrock errors so unscreened content never reaches the agent.
 * @param text - the text to screen.
 * @param taskId - the task ID (for logging).
 * @returns a GuardrailScreeningResult with action and assessment details, or undefined when
 *          guardrail is not configured (env vars missing).
 * @throws GuardrailScreeningError when the Bedrock Guardrail API call fails (fail-closed).
 */
export async function screenWithGuardrail(text: string, taskId: string): Promise<GuardrailScreeningResult | undefined> {
  if (!bedrockClient || !GUARDRAIL_ID || !GUARDRAIL_VERSION) {
    logger.info('Guardrail screening skipped — guardrail not configured', {
      task_id: taskId,
      metric_type: 'guardrail_screening_skipped',
    });
    return undefined;
  }

  try {
    const result = await bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));

    const assessments = extractAssessmentDetails(
      result.assessments as Array<Record<string, unknown>> | undefined,
    );

    if (result.action === 'GUARDRAIL_INTERVENED') {
      logger.warn('Content blocked by guardrail', {
        task_id: taskId,
        guardrail_id: GUARDRAIL_ID,
        guardrail_version: GUARDRAIL_VERSION,
        assessment_details: assessments.length > 0 ? JSON.stringify(assessments) : undefined,
      });
      return {
        action: 'GUARDRAIL_INTERVENED',
        ...(assessments.length > 0 && { assessments }),
      };
    }

    return { action: 'NONE' };
  } catch (err) {
    logger.error('Guardrail screening failed (fail-closed)', {
      task_id: taskId,
      guardrail_id: GUARDRAIL_ID,
      error: err instanceof Error ? err.message : String(err),
      error_name: err instanceof Error ? err.name : undefined,
      metric_type: 'guardrail_screening_failure',
    });
    throw new GuardrailScreeningError(
      `Guardrail screening unavailable: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
}

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
 * Mirrors agent/src/context.py:fetch_github_issue.
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
          if (typeof c.id !== 'number') {
            logger.warn('Skipping issue comment with missing or non-numeric id', {
              repo, issue_number: issueNumber, raw_id: String(c.id),
            });
            continue;
          }
          comments.push({
            id: c.id,
            author: (c.user as Record<string, unknown>)?.login as string || 'unknown',
            body: c.body as string ?? '',
          });
        }
        if (raw.length > 0 && comments.length === 0) {
          logger.error('All issue comments skipped due to invalid IDs — possible API response format change', {
            repo, issue_number: issueNumber, total_raw: raw.length,
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
// GraphQL review threads (filters resolved threads at fetch time)
// ---------------------------------------------------------------------------

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $prNumber: Int!, $threadCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100, after: $threadCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
              author { login }
              body
              path
              line
              diffHunk
            }
          }
        }
      }
    }
  }
}`;

async function fetchReviewCommentsGraphQL(
  repo: string,
  prNumber: number,
  token: string,
): Promise<PullRequestReviewComment[]> {
  const [owner, repoName] = repo.split('/');
  const comments: PullRequestReviewComment[] = [];
  let cursor: string | null = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: { owner, repo: repoName, prNumber, threadCursor: cursor },
        }),
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });

      if (!resp.ok) {
        logger.warn('GitHub GraphQL review threads fetch failed', {
          repo, pr_number: prNumber, status: resp.status,
        });
        return [];
      }

      const json = await resp.json() as Record<string, unknown>;

      if (json.errors) {
        logger.warn('GitHub GraphQL review threads returned errors', {
          repo, pr_number: prNumber, errors: JSON.stringify(json.errors),
        });
        return [];
      }

      const data = json.data as Record<string, unknown> | undefined;
      const repository = (data?.repository ?? null) as Record<string, unknown> | null;
      const pullRequest = (repository?.pullRequest ?? null) as Record<string, unknown> | null;
      const reviewThreads = (pullRequest?.reviewThreads ?? null) as Record<string, unknown> | null;
      if (!reviewThreads) {
        logger.warn('GitHub GraphQL response missing expected review threads structure', {
          repo, pr_number: prNumber,
        });
        return [];
      }
      const pageInfo = reviewThreads.pageInfo as { hasNextPage: boolean; endCursor: string };
      const nodes = reviewThreads.nodes as Array<Record<string, unknown>>;

      for (const thread of nodes) {
        if (thread.isResolved === true) {
          continue;
        }

        const threadComments = thread.comments as Record<string, unknown>;
        const commentNodes = threadComments.nodes as Array<Record<string, unknown>>;

        if (commentNodes.length >= 100) {
          logger.warn('Review thread has 100+ comments — inner pagination not implemented', {
            repo, pr_number: prNumber,
          });
        }

        let rootId: number | undefined;
        for (const c of commentNodes) {
          const databaseId = c.databaseId;
          if (typeof databaseId !== 'number') {
            logger.warn('Skipping review comment with missing or non-numeric databaseId', {
              repo, pr_number: prNumber, raw_id: String(databaseId),
            });
            continue;
          }

          if (rootId === undefined) {
            rootId = databaseId;
          }

          const author = c.author as Record<string, unknown> | null | undefined;
          comments.push({
            id: databaseId,
            in_reply_to_id: databaseId === rootId ? undefined : rootId,
            author: (author?.login as string) || 'unknown',
            body: (c.body as string) ?? '',
            path: c.path as string | undefined,
            line: c.line as number | undefined,
            diff_hunk: c.diffHunk as string | undefined,
          });
        }
      }

      if (!pageInfo.hasNextPage) {
        break;
      }
      cursor = pageInfo.endCursor;
    }
  } catch (err) {
    logger.warn('GitHub GraphQL review threads fetch error', {
      repo, pr_number: prNumber, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  return comments;
}

// ---------------------------------------------------------------------------
// GitHub pull request fetching
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub pull request's metadata (REST), review comments (GraphQL, filters
 * resolved threads), issue comments (REST), and diff summary (REST).
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
    // Fetch PR metadata (REST), review comments (GraphQL), issue comments (REST), and files (REST) in parallel
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [prResp, reviewComments, issueResp, filesResp] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
        headers, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      }),
      fetchReviewCommentsGraphQL(repo, prNumber, token),
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

    // Parse issue/conversation comments
    const issueComments: IssueComment[] = [];
    if (issueResp.ok) {
      const raw = await issueResp.json() as Array<Record<string, unknown>>;
      for (const c of raw) {
        if (typeof c.id !== 'number') {
          logger.warn('Skipping conversation comment with missing or non-numeric id', {
            repo, pr_number: prNumber, raw_id: String(c.id),
          });
          continue;
        }
        issueComments.push({
          id: c.id,
          author: (c.user as Record<string, unknown>)?.login as string || 'unknown',
          body: c.body as string ?? '',
        });
      }
      if (raw.length > 0 && issueComments.length === 0) {
        logger.error('All conversation comments skipped due to invalid IDs — possible API response format change', {
          repo, pr_number: prNumber, total_raw: raw.length,
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
 * Mirrors agent/src/context.py:assemble_prompt.
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
    parts.push(`\n## GitHub Issue #${issue.number}: ${sanitizeExternalContent(issue.title)}\n`);
    parts.push(sanitizeExternalContent(issue.body) || '(no description)');
    if (issue.comments.length > 0) {
      parts.push('\n### Comments\n');
      for (const c of issue.comments) {
        parts.push(`**@${sanitizeExternalContent(c.author)}**: ${sanitizeExternalContent(c.body)}\n`);
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
  parts.push(`\n## Pull Request #${pr.number}: ${sanitizeExternalContent(pr.title)}\n`);
  parts.push(sanitizeExternalContent(pr.body) || '(no description)');
  parts.push(`\nBase branch: ${pr.base_ref}`);
  parts.push(`Head branch: ${pr.head_ref}`);

  if (pr.review_comments.length > 0) {
    parts.push('\n### Review Comments\n');

    // Group review comments into threads using in_reply_to_id
    const rootComments = new Map<number, PullRequestReviewComment>();
    const replies = new Map<number, PullRequestReviewComment[]>();

    for (const c of pr.review_comments) {
      if (c.in_reply_to_id === undefined) {
        // Top-level comment (thread root)
        if (rootComments.has(c.id)) {
          logger.warn('Duplicate root comment id detected — keeping first occurrence', {
            comment_id: c.id, existing_author: rootComments.get(c.id)!.author, duplicate_author: c.author,
          });
          continue;
        }
        rootComments.set(c.id, c);
        if (!replies.has(c.id)) {
          replies.set(c.id, []);
        }
      } else {
        // Reply to an existing thread
        const rootId = c.in_reply_to_id;
        if (!replies.has(rootId)) {
          replies.set(rootId, []);
        }
        replies.get(rootId)!.push(c);
      }
    }

    // Render threads rooted by known top-level comments
    for (const [rootId, root] of rootComments) {
      const location = root.path ? `\`${root.path}${root.line ? `:${root.line}` : ''}\`` : 'general';
      parts.push(`**Thread on ${location}** (reply with comment_id: ${rootId})`);
      parts.push(`> **@${sanitizeExternalContent(root.author)}**: ${sanitizeExternalContent(root.body)}`);
      // diff_hunk and path are not sanitized: they contain code content inside markdown
      // code blocks, and sanitizing them could corrupt legitimate code snippets.
      if (root.diff_hunk) {
        parts.push(`> \`\`\`diff\n> ${root.diff_hunk}\n> \`\`\``);
      }
      const threadReplies = replies.get(rootId) ?? [];
      for (const r of threadReplies) {
        parts.push(`\n  - **@${sanitizeExternalContent(r.author)}**: ${sanitizeExternalContent(r.body)}`);
      }
      parts.push('');
    }

    // Render orphan replies (in_reply_to_id points to a root not in our fetched set)
    for (const [rootId, orphanReplies] of replies) {
      if (rootComments.has(rootId)) continue;
      for (const r of orphanReplies) {
        const location = r.path ? `\`${r.path}${r.line ? `:${r.line}` : ''}\`` : 'general';
        const replyTarget = r.in_reply_to_id ?? r.id;
        parts.push(`**Comment on ${location}** (reply with comment_id: ${replyTarget})`);
        parts.push(`> **@${sanitizeExternalContent(r.author)}**: ${sanitizeExternalContent(r.body)}`);
        if (r.diff_hunk) {
          parts.push(`> \`\`\`diff\n> ${r.diff_hunk}\n> \`\`\``);
        }
        parts.push('');
      }
    }
  }

  if (pr.issue_comments.length > 0) {
    parts.push('\n### Conversation Comments\n');
    for (const c of pr.issue_comments) {
      parts.push(`**@${sanitizeExternalContent(c.author)}** (comment_id: ${c.id}): ${sanitizeExternalContent(c.body)}\n`);
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
 * Hydrate context for a task: resolve GitHub token, fetch issue/PR, enforce
 * token budget, assemble the user prompt, and screen through Bedrock Guardrail
 * for prompt injection (PR tasks; new_task when issue content is present).
 * @param task - the task record from DynamoDB.
 * @param options - optional per-repo overrides.
 * @returns the hydrated context. `guardrail_blocked` is set when the guardrail
 *          intervened (PR tasks: always screened; new_task: screened when issue content is present).
 * @throws GuardrailScreeningError when the Bedrock Guardrail API call fails
 *         (fail-closed — propagated to prevent unscreened content from reaching the agent).
 */
export async function hydrateContext(task: TaskRecord, options?: HydrateContextOptions): Promise<HydratedContext> {
  const sources: string[] = [];
  let issue: GitHubIssueContext | undefined;
  let memoryContext: MemoryContext | undefined;

  try {
    // Fetch GitHub issue, memory context, and PR context in parallel
    const memoryId = options?.memoryId ?? process.env.MEMORY_ID;
    const tokenSecretArn = options?.githubTokenSecretArn ?? GITHUB_TOKEN_SECRET_ARN;

    const isPrTask = isPrTaskType(task.task_type as TaskType);

    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [issueResult, memoryResult, prResult] = await Promise.all([
      // Issue fetch (skip for PR task types)
      (async () => {
        if (isPrTask) return undefined;
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
      // PR fetch (only for PR task types)
      (async () => {
        if (isPrTask && task.pr_number !== undefined && tokenSecretArn) {
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

    if (isPrTask) {
      if (!prResult) {
        // PR fetch failed — log error and return minimal context
        logger.error(`PR context fetch failed for ${task.task_type} task`, {
          task_id: task.task_id, pr_number: task.pr_number, task_type: task.task_type,
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
      let effectiveTaskDescription = budgetResult.taskDescription;
      if (!effectiveTaskDescription && task.task_type === 'pr_review') {
        logger.info('Using default task description for pr_review task', { task_id: task.task_id });
        effectiveTaskDescription = 'Review this pull request. Follow the workflow in your system instructions.';
      }
      userPrompt = assemblePrIterationPrompt(task.task_id, task.repo, prResult, effectiveTaskDescription);

      // Trim PR context if the assembled prompt exceeds the token budget
      let truncated = budgetResult.truncated;
      const promptEstimate = estimateTokens(userPrompt);
      if (promptEstimate > USER_PROMPT_TOKEN_BUDGET) {
        logger.warn('PR task prompt exceeds token budget — trimming review comments', {
          task_id: task.task_id, estimate: promptEstimate, budget: USER_PROMPT_TOKEN_BUDGET,
        });
        // Build thread-grouped list so we can trim whole threads at a time
        const threads: PullRequestReviewComment[][] = [];
        const threadMap = new Map<number, number>(); // root id -> index in threads[]
        for (const c of prResult.review_comments) {
          if (c.in_reply_to_id === undefined) {
            threadMap.set(c.id, threads.length);
            threads.push([c]);
          } else {
            const idx = threadMap.get(c.in_reply_to_id);
            if (idx !== undefined) {
              threads[idx].push(c);
            } else {
              // Orphan reply — treat as its own "thread"
              threads.push([c]);
            }
          }
        }

        const trimmedIssueComments = [...prResult.issue_comments];
        let trimmedReviewComments = prResult.review_comments;
        let trimmedPr = {
          ...prResult,
          review_comments: trimmedReviewComments,
          issue_comments: trimmedIssueComments,
        };
        const estimateTrimmed = (): number =>
          estimateTokens(assemblePrIterationPrompt(
            task.task_id, task.repo, trimmedPr, budgetResult.taskDescription,
          ));

        // Trim oldest issue comments first
        while (trimmedIssueComments.length > 0 && estimateTrimmed() > USER_PROMPT_TOKEN_BUDGET) {
          trimmedIssueComments.shift();
          trimmedPr = { ...trimmedPr, issue_comments: trimmedIssueComments };
        }

        // Trim oldest review comment threads (root + all replies as a unit)
        while (threads.length > 0 && estimateTrimmed() > USER_PROMPT_TOKEN_BUDGET) {
          const removed = threads.shift()!;
          logger.warn('Trimmed review comment thread to fit token budget', {
            task_id: task.task_id,
            removed_root_id: removed[0].id,
            removed_count: removed.length,
          });
          trimmedReviewComments = threads.flat();
          trimmedPr = { ...trimmedPr, review_comments: trimmedReviewComments };
        }

        userPrompt = assemblePrIterationPrompt(task.task_id, task.repo, trimmedPr, budgetResult.taskDescription);
        const finalEstimate = estimateTokens(userPrompt);
        if (finalEstimate > USER_PROMPT_TOKEN_BUDGET) {
          logger.warn('Token budget still exceeded after trimming all comments — non-comment content too large', {
            task_id: task.task_id,
            final_estimate: finalEstimate,
            budget: USER_PROMPT_TOKEN_BUDGET,
          });
        }
        truncated = true;
      }

      resolvedBranchName = prResult.head_ref;
      resolvedBaseBranch = prResult.base_ref;

      // Screen assembled PR prompt through Bedrock Guardrail for prompt injection
      const screenResult = await screenWithGuardrail(userPrompt, task.task_id);

      const guardrailBlocked = formatGuardrailBlocked(screenResult, 'PR context');

      const prContext: HydratedContext = {
        version: 1,
        user_prompt: userPrompt,
        memory_context: memoryContext,
        resolved_branch_name: resolvedBranchName,
        resolved_base_branch: resolvedBaseBranch,
        sources,
        token_estimate: estimateTokens(userPrompt),
        truncated,
        ...(guardrailBlocked && { guardrail_blocked: guardrailBlocked }),
      };

      return prContext;
    }

    // Standard task
    const budgetResult = enforceTokenBudget(issue, task.task_description, USER_PROMPT_TOKEN_BUDGET);
    issue = budgetResult.issue;

    userPrompt = assembleUserPrompt(task.task_id, task.repo, issue, budgetResult.taskDescription);
    const tokenEstimate = estimateTokens(userPrompt);

    // Screen assembled prompt when it includes GitHub issue content (attacker-controlled input).
    // Skipped when no issue is present — task_description is already screened at submission time.
    const screenResult = issue
      ? await screenWithGuardrail(userPrompt, task.task_id)
      : undefined;

    const guardrailBlocked = formatGuardrailBlocked(screenResult, 'Task context');

    return {
      version: 1,
      user_prompt: userPrompt,
      issue,
      memory_context: memoryContext,
      sources,
      token_estimate: tokenEstimate,
      truncated: budgetResult.truncated,
      ...(guardrailBlocked && { guardrail_blocked: guardrailBlocked }),
    };
  } catch (err) {
    // Guardrail failures must propagate (fail-closed) — unscreened content must not reach the agent
    if (err instanceof GuardrailScreeningError) {
      throw err;
    }
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
