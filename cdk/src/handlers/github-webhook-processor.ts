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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { captureScreenshot } from './shared/agentcore-browser';
import { resolveGitHubToken } from './shared/context-hydration';
import { upsertTaskComment } from './shared/github-comment';
import {
  type GitHubDeploymentStatusPayload,
  validateDeploymentStatusPayload,
} from './shared/github-deployment-status';
import { renderPreviewBlock } from './shared/iteration-reply';
import { appendOnceToComment, postIssueComment } from './shared/linear-feedback';
import {
  extractLinearIdentifier,
  extractLinearIdentifierFromBranch,
  findLinearIssueByIdentifier,
} from './shared/linear-issue-lookup';
import { logger } from './shared/logger';
import { isIntegrationNode } from './shared/orchestration-integration-node';
import { buildScreenshotKey, encodeMarkdownUrl, extractTaskIdFromBranch, isAllowedScreenshotUrl } from './shared/screenshot-url';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Optional — when set, the processor persists the screenshot's public URL onto
// the deploy task's TaskRecord (keyed by the taskId in the deploy branch) so
// the #247 orchestration reconciler can embed the integration node's combined
// preview in the parent epic panel. Unset → persistence is skipped (the PR +
// Linear comments still post).
const TASK_TABLE = process.env.TASK_TABLE_NAME;

const SCREENSHOT_BUCKET = process.env.SCREENSHOT_BUCKET_NAME!;
// CloudFront distribution domain — `<dist>.cloudfront.net`. Used as
// the public host for the screenshot URL embedded in PR comments.
// The bucket is private; CloudFront with OAC reads on the agent's
// behalf.
const SCREENSHOT_PUBLIC_HOST = process.env.SCREENSHOT_PUBLIC_HOST!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN!;
// Optional — when set, the processor also tries to post the
// screenshot comment onto a linked Linear issue. Resolved from the
// GitHub PR title/body via a Linear-identifier regex (e.g. `ABCA-42`),
// then looked up across all active workspaces in the registry.
const LINEAR_WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

/**
 * Total wall-clock budget for the processor run. The Lambda timeout is
 * 120s; we leave 10s of headroom for SDK retries + the runtime's
 * shutdown grace so a hard timeout never severs a comment-post mid-flight.
 * Threaded as a single deadline through PR-lookup retry + screenshot
 * capture + S3 PUT + comment POST so the worst case never exceeds it.
 */
const TOTAL_BUDGET_MS = 110_000;

/**
 * Reserve carved out of the remaining budget AFTER PR lookup, BEFORE
 * starting the screenshot capture. Covers S3 PUT (typically <2s) +
 * GitHub PR comment POST (typically <2s) + the 2s Page settle inside
 * the browser. Anything left over is the screenshot's actual budget.
 */
const POST_CAPTURE_RESERVE_MS = 8_000;

/**
 * Minimum budget we'll allow `captureScreenshot` to start with. If less
 * than this remains after PR lookup, fail fast rather than start a
 * session that's already doomed.
 */
const MIN_CAPTURE_BUDGET_MS = 15_000;

/** Backoff schedule (ms) while waiting for GitHub to link a PR to a deploy SHA. */
const PR_LOOKUP_RETRY_DELAY_0_MS = 0;
const PR_LOOKUP_RETRY_DELAY_1_MS = 5_000;
const PR_LOOKUP_RETRY_DELAY_2_MS = 10_000;
const PR_LOOKUP_RETRY_DELAY_3_MS = 20_000;
const PR_LOOKUP_RETRY_DELAYS_MS = [
  PR_LOOKUP_RETRY_DELAY_0_MS,
  PR_LOOKUP_RETRY_DELAY_1_MS,
  PR_LOOKUP_RETRY_DELAY_2_MS,
  PR_LOOKUP_RETRY_DELAY_3_MS,
] as const;

interface ProcessorEvent {
  readonly raw_body: string;
}

/**
 * Async processor for verified GitHub `deployment_status` webhooks.
 *
 * Flow:
 *  1. Parse the payload (already validated as deployment_status by the
 *     receiver, but we re-extract the fields we need).
 *  2. Find the open PR for the deploy SHA via the GitHub Commits API.
 *  3. Capture a screenshot of `deployment.environment_url` via
 *     AgentCore Browser.
 *  4. PUT the PNG to the screenshot bucket.
 *  5. POST a fresh PR comment with `![preview](<public-url>)`.
 *
 * Every external call is best-effort. If any step fails, log + return —
 * the receiver already 200'd, so retries by GitHub will dedup at the
 * receiver layer.
 */
export async function handler(event: ProcessorEvent): Promise<void> {
  // One wall-clock deadline shared across PR lookup + screenshot capture
  // + S3 PUT + comment POST. Without this, findPullRequestForShaWithRetry
  // could spend ~35s before captureScreenshot starts its independent 60s
  // budget — totaling ~95s + S3 + comment, which exceeds the 120s Lambda
  // timeout on slow-GitHub days. (theagenticguy PR-241 review item B1.)
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  if (!event.raw_body) {
    logger.error('GitHub webhook processor invoked without raw_body');
    return;
  }

  let raw: GitHubDeploymentStatusPayload;
  try {
    raw = JSON.parse(event.raw_body) as GitHubDeploymentStatusPayload;
  } catch (err) {
    logger.error('GitHub webhook processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const payload = validateDeploymentStatusPayload(raw);
  if (!payload) {
    // The receiver runs the same validation, so this branch should be
    // unreachable on the default dispatch path. Logging at warn (not
    // error) so the metric stays clean if someone replays an old event.
    logger.warn('Processor received invalid deployment_status payload — skipping', {
      repo: raw.repository?.full_name,
      deployment_id: raw.deployment?.id,
    });
    return;
  }
  const { repoFullName: repo, sha, environmentUrl: previewUrl, deploymentId } = payload;

  // SSRF defense-in-depth: the path is HMAC-gated and AgentCore Browser
  // sits outside the customer VPC, but whatever renders ends up on a
  // public CloudFront URL. Reject obviously-wrong shapes (non-https,
  // literal-IP, link-local, loopback) at the boundary. (theagenticguy
  // PR-241 review.)
  if (!isAllowedScreenshotUrl(previewUrl)) {
    logger.warn('Rejected deployment_status preview URL on allowlist', {
      repo,
      preview_url: previewUrl,
    });
    return;
  }

  logger.info('Screenshot pipeline starting', {
    repo,
    sha,
    preview_url: previewUrl,
    deployment_id: deploymentId,
    budget_ms: TOTAL_BUDGET_MS,
  });

  let token: string;
  try {
    token = await resolveGitHubToken(GITHUB_TOKEN_SECRET_ARN);
  } catch (err) {
    logger.error('Failed to resolve GitHub token; cannot post screenshot comment', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Race: managed providers (Vercel, Netlify, Amplify) post
  // `deployment_status` the moment their build finishes, which can
  // be ~5-15s before the agent calls `gh pr create` for the same SHA.
  // Retry the PR lookup, but cap by remaining budget so the screenshot
  // half always gets at least MIN_CAPTURE_BUDGET_MS.
  const prLookupBudget = Math.max(0, remaining() - POST_CAPTURE_RESERVE_MS - MIN_CAPTURE_BUDGET_MS);
  const pr = await findPullRequestForShaWithRetry(repo, sha, token, prLookupBudget);
  if (!pr) {
    // Promote to error: "no PR after the retry budget" is the shape of
    // a systematic break (deploy-without-PR, token regression, GitHub
    // outage). theagenticguy review: warn-level was invisible. Add a
    // tagged event_id for the CloudWatch metric filter / alarm.
    logger.error('No open PR found for SHA after retries — skipping screenshot post', {
      event: 'screenshot.pr_lookup_exhausted',
      error_id: 'SCREENSHOT_PR_LOOKUP_EXHAUSTED',
      repo,
      sha,
      budget_ms: prLookupBudget,
    });
    return;
  }

  // Confirm we have enough wall-clock left to even try a capture; if
  // PR lookup ate the budget on a slow GitHub day, fail fast rather
  // than start an AgentCore session that's already doomed.
  const captureBudget = Math.max(0, remaining() - POST_CAPTURE_RESERVE_MS);
  if (captureBudget < MIN_CAPTURE_BUDGET_MS) {
    logger.error('Insufficient budget remaining for screenshot capture — skipping', {
      event: 'screenshot.budget_exhausted',
      error_id: 'SCREENSHOT_BUDGET_EXHAUSTED',
      repo,
      pr_number: pr.number,
      remaining_ms: remaining(),
      capture_budget_ms: captureBudget,
    });
    return;
  }

  let png: Uint8Array;
  try {
    png = await captureScreenshot(previewUrl, { timeoutMs: captureBudget });
  } catch (err) {
    logger.error('Screenshot capture failed', {
      event: 'screenshot.capture_failed',
      error_id: 'SCREENSHOT_CAPTURE_FAILED',
      preview_url: previewUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const key = buildScreenshotKey(repo, sha, deploymentId);
  try {
    await s3.send(new PutObjectCommand({
      Bucket: SCREENSHOT_BUCKET,
      Key: key,
      Body: png,
      ContentType: 'image/png',
      Metadata: {
        repo,
        sha,
        // S3 metadata values must be ASCII; coerce numeric to string and
        // skip the URL itself (URL encoding into x-amz-meta-* is brittle).
        deployment_id: String(deploymentId),
      },
    }));
  } catch (err) {
    logger.error('Failed to upload screenshot to S3', {
      event: 'screenshot.s3_put_failed',
      error_id: 'SCREENSHOT_S3_PUT_FAILED',
      bucket: SCREENSHOT_BUCKET,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const publicUrl = `https://${SCREENSHOT_PUBLIC_HOST}/${key}`;
  const commentBody = renderCommentBody(publicUrl, previewUrl);

  // #247: persist the screenshot + preview URLs on the deploy task's record
  // (keyed by the taskId in the branch) so the orchestration reconciler can
  // embed the integration node's combined preview in the parent epic panel.
  // Best-effort, before the comment posts so a comment-post failure doesn't
  // skip it. The return tells us whether this is the synthetic integration
  // node — whose screenshot belongs in the panel only, never as a standalone
  // Linear comment on the parent epic (#247 UX.16).
  const { isIntegrationNode: isIntegrationDeploy, isIteration: isIterationDeploy } = await persistScreenshotUrl(
    pr.headRefName,
    publicUrl,
    previewUrl,
  );

  try {
    const result = await upsertTaskComment({
      repo,
      issueOrPrNumber: pr.number,
      body: commentBody,
      token,
      // Always POST fresh — a single PR can have multiple preview screenshots
      // as the user pushes new commits, and editing the prior comment in
      // place would lose the history.
      existingCommentId: undefined,
    });
    logger.info('Posted screenshot comment to PR', {
      repo,
      pr_number: pr.number,
      comment_id: result.commentId,
      public_url: publicUrl,
    });
  } catch (err) {
    // Promoted from warn → error: by this point we've already paid for
    // the AgentCore session + S3 PUT, so a comment-post failure is the
    // ONLY signal the operator gets that the screenshot wasn't
    // delivered. tagged event_id for the CloudWatch metric filter.
    // (theagenticguy PR-241 review.)
    logger.error('Failed to post screenshot PR comment', {
      event: 'screenshot.pr_comment_post_failed',
      error_id: 'SCREENSHOT_PR_COMMENT_POST_FAILED',
      repo,
      pr_number: pr.number,
      public_url: publicUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Best-effort Linear comment. The GitHub PR comment above is the
  // load-bearing artifact; the Linear comment is bonus surface for
  // reviewers who live in Linear. Only fires when the registry table
  // is configured AND the PR carries a Linear identifier.
  //
  // #247 UX.16: the synthetic integration node has no Linear sub-issue of its
  // own, so a Linear post here would resolve the parent-epic identifier from
  // the PR title and land a "🖼️ Preview screenshot" comment ON THE PARENT —
  // cluttering the maturing panel (which already embeds the combined preview
  // via the persisted screenshot_url). Skip the Linear post for the integration
  // node; the panel is the only Linear surface for the combined result.
  if (LINEAR_WORKSPACE_REGISTRY_TABLE && !isIntegrationDeploy) {
    // Branch-name first — it deterministically encodes this PR's own
    // issue (`bgagent/{taskId}/abca-151-...`). Title/body are ambiguous
    // fallbacks: in a stacked #247 orchestration the body often names a
    // predecessor issue before the one the PR closes, and
    // `extractLinearIdentifier` returns the first match in document
    // order — which would misroute the screenshot to the predecessor.
    const identifier =
      extractLinearIdentifierFromBranch(pr.headRefName)
      ?? extractLinearIdentifier(pr.title)
      ?? extractLinearIdentifier(pr.body);
    if (identifier) {
      const linearIssue = await findLinearIssueByIdentifier(identifier, LINEAR_WORKSPACE_REGISTRY_TABLE);
      if (linearIssue) {
        const ctx = {
          linearWorkspaceId: linearIssue.linearWorkspaceId,
          registryTableName: LINEAR_WORKSPACE_REGISTRY_TABLE,
        };
        if (isIterationDeploy) {
          // iteration-UX: the preview belongs IN the iteration's maturing reply,
          // not a standalone comment. The screenshot capture is async and usually
          // lands AFTER the reply settled (✅ + cost), so we APPEND the preview
          // link to that reply now (in place). Find the most-recent iteration
          // reply id for this issue and edit it; idempotent via the [preview]
          // marker so a webhook redelivery won't double-append.
          const iter = await findIterationReplyId(linearIssue.issueId);
          if (iter) {
            // (1) Durably persist the screenshot onto the ITERATION task so the
            // terminal-settle renders the thumbnail from a strongly-consistent
            // DDB read — race-free against this comment edit (ABCA-438 clobber).
            await persistScreenshotOnIterationTask(iter.taskId, publicUrl, previewUrl);
            // (2) Also append to the reply now, for the case where the deploy is
            // slow and the settle already ran (the append then wins). Embed the
            // captured PNG as a clickable thumbnail linking to the live deploy —
            // same shape as the first-task 🖼️ comment, NOT a bare text link.
            // previewUrl is payload-derived → markdown-escape (publicUrl is ours).
            const previewBlock = renderPreviewBlock(publicUrl, encodeMarkdownUrl(previewUrl));
            const appended = await appendOnceToComment(ctx, iter.replyId, `\n\n${previewBlock}`, '[preview]');
            logger.info('Appended preview thumbnail to iteration reply', {
              linear_issue_id: linearIssue.issueId, reply_id: iter.replyId, task_id: iter.taskId, appended,
            });
          } else {
            logger.info('Iteration deploy but no reply id found — skipping preview append', {
              linear_issue_id: linearIssue.issueId,
            });
          }
        } else {
          // First deploy / non-iteration: post the headline 🖼️ standalone comment.
          const postResult = await postIssueComment(ctx, linearIssue.issueId, renderLinearCommentBody(publicUrl, previewUrl));
          if (postResult.ok) {
            logger.info('Posted screenshot comment to Linear issue', {
              identifier, linear_issue_id: linearIssue.issueId, workspace_slug: linearIssue.workspaceSlug,
            });
          } else {
            logger.warn('Failed to post screenshot Linear comment (non-fatal)', {
              event: 'screenshot.linear_comment_post_failed', identifier, linear_issue_id: linearIssue.issueId,
            });
          }
        }
      } else {
        logger.info('Linear identifier did not resolve to an issue — skipping Linear post', {
          identifier,
          repo,
          pr_number: pr.number,
        });
      }
    }
  }
}

/**
 * iteration-UX: find the most-recent iteration's maturing-reply comment id AND
 * its task id for a Linear issue. An @bgagent iteration persists
 * ``iteration_reply_comment_id`` on its task's channel_metadata. The screenshot
 * webhook (resolving the issue by PR identifier) uses the reply id to append the
 * preview to that reply, and the task id to persist the screenshot DURABLY onto
 * the iteration task — so the terminal-settle renders the preview from a
 * strongly-consistent DDB read rather than racing the (eventually-consistent)
 * Linear comment edit (the ABCA-437/438 clobber). Queries LinearIssueIndex
 * newest-first; returns the first task carrying a reply id. Null when none.
 */
async function findIterationReplyId(linearIssueId: string): Promise<{ replyId: string; taskId: string } | null> {
  if (!TASK_TABLE) return null;
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: 'LinearIssueIndex',
      KeyConditionExpression: 'linear_issue_id = :iid',
      ExpressionAttributeValues: { ':iid': linearIssueId },
      ScanIndexForward: false, // newest first (SK = created_at)
    }));
    for (const item of (res.Items ?? []) as Array<{ task_id?: string; channel_metadata?: { iteration_reply_comment_id?: string } }>) {
      const replyId = item.channel_metadata?.iteration_reply_comment_id;
      if (typeof replyId === 'string' && replyId && typeof item.task_id === 'string') {
        return { replyId, taskId: item.task_id };
      }
    }
    return null;
  } catch (err) {
    logger.warn('findIterationReplyId query failed (non-fatal)', {
      linear_issue_id: linearIssueId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * iteration-UX: durably persist the captured screenshot URLs onto the ITERATION
 * task record (the one carrying the reply id), so the terminal-settle can render
 * the preview thumbnail from a strongly-consistent DDB read. This is the
 * race-free half of the fix: an @bgagent iteration's deploy pushes the SAME PR
 * branch, so ``persistScreenshotUrl`` (keyed by branch → original task) never
 * touches the iteration task — the settle then had no screenshot and the only
 * preview writer was the comment append, which the settle clobbered (ABCA-438).
 * Best-effort; guarded by attribute_exists so a TTL eviction can't zombie-create.
 */
async function persistScreenshotOnIterationTask(taskId: string, publicUrl: string, previewUrl: string): Promise<void> {
  if (!TASK_TABLE) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET screenshot_url = :u, screenshot_preview_url = :p',
      ConditionExpression: 'attribute_exists(task_id)',
      ExpressionAttributeValues: { ':u': publicUrl, ':p': previewUrl },
    }));
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') {
      logger.warn('persistScreenshotOnIterationTask failed (non-fatal)', {
        task_id: taskId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Open PR shape we extract from the GitHub commit-pulls API. Title +
 * body are used downstream by the Linear issue lookup; the others go
 * into log lines for debugging.
 */
interface OpenPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /**
   * Head branch ref (e.g. `bgagent/{taskId}/abca-151-...`). The
   * authoritative source for the linked Linear issue — see
   * `extractLinearIdentifierFromBranch`.
   */
  readonly headRefName: string;
}

/**
 * Wait for an open PR to exist for the given SHA, retrying with a
 * small backoff. Managed providers commonly post `deployment_status`
 * before the agent's `gh pr create` call lands (we've measured 5-15s
 * gap on Vercel; Netlify/Amplify behave similarly), so a single check
 * would silently miss the common case.
 *
 * Schedule: 0s, 5s, 10s, 20s — covers the observed gap with one
 * generous bonus retry. Capped by `budgetMs` so the caller can hand
 * over only what it can afford to spend (B1: shared deadline). Returns
 * null on exhaustion (no PR yet) or budget timeout.
 */
async function findPullRequestForShaWithRetry(
  repo: string,
  sha: string,
  token: string,
  budgetMs: number,
): Promise<OpenPr | null> {
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < PR_LOOKUP_RETRY_DELAYS_MS.length; i++) {
    const delay = PR_LOOKUP_RETRY_DELAYS_MS[i];
    if (delay > 0) {
      // Skip the wait if the deadline would land mid-sleep.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    }
    if (Date.now() >= deadline) return null;
    const pr = await findPullRequestForSha(repo, sha, token);
    if (pr) return pr;
    const next = PR_LOOKUP_RETRY_DELAYS_MS[i + 1];
    if (next !== undefined) {
      logger.info('Open PR not found yet for SHA — will retry', {
        repo,
        sha,
        next_delay_ms: next,
        attempt: i + 1,
      });
    }
  }
  return null;
}

/**
 * Look up an open PR associated with `sha`. Uses the
 * "List pull requests associated with a commit" GitHub API
 * (https://docs.github.com/rest/commits/commits#list-pull-requests-associated-with-a-commit).
 *
 * Returns the OPEN PR that the deploy is *for* (head SHA == `sha`), or
 * the first open PR as a fallback, or null if none. Closed/merged PRs
 * are filtered out — v1 only screenshots active reviews.
 */
async function findPullRequestForSha(
  repo: string,
  sha: string,
  token: string,
): Promise<OpenPr | null> {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}/pulls`;
  let res: Response;
  // 5s per-request timeout via AbortController. Mirrors the Linear
  // path, where unbounded fetches were previously blamed for budget
  // overruns. Note: this is the per-attempt cap, not the total retry
  // budget — the caller threads the wall-clock deadline.
  const ac = new AbortController();
  const fetchTimeoutMs = 5_000;
  const timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: ac.signal,
    });
  } catch (err) {
    logger.warn('GitHub commit-pulls fetch failed', {
      repo,
      sha,
      timed_out: ac.signal.aborted,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- GitHub commit-pulls lookup is best-effort; null means "no PR for this SHA"
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    logger.warn('GitHub commit-pulls returned non-2xx', {
      repo,
      sha,
      status: res.status,
    });
    return null;
  }

  // GitHub's contract is a JSON array, but a transient 2xx HTML body or
  // a malformed payload would crash an unguarded `.find` and throw out
  // of the (un-DLQ'd) processor. Treat anything non-array as no-PR.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    logger.warn('GitHub commit-pulls returned non-JSON body', {
      repo,
      sha,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- malformed GitHub body treated as no-PR; prevents processor crash on transient HTML/502
  }
  if (!Array.isArray(parsed)) {
    logger.warn('GitHub commit-pulls did not return an array', { repo, sha });
    return null;
  }
  const pulls = parsed as Array<{
    number?: number;
    state?: string;
    title?: string;
    body?: string | null;
    head?: { ref?: string; sha?: string } | null;
  }>;
  const openPulls = pulls.filter((p) => p.state === 'open' && typeof p.number === 'number');
  if (openPulls.length === 0) return null;
  // Prefer the PR whose own head is this SHA — the PR that introduced the
  // commit. For a stacked #247 chain the commit-pulls API also lists every
  // PR stacked on top (their history contains the commit); routing reads
  // the selected PR's branch, so we must pick its true owner. Fall back to
  // the first open PR for non-head SHAs (e.g. a merge/base commit).
  const owner = openPulls.find((p) => p.head?.sha === sha) ?? openPulls[0];
  return {
    number: owner.number!,
    title: owner.title ?? '',
    body: owner.body ?? '',
    headRefName: owner.head?.ref ?? '',
  };
}

/** Render the PR comment body. */
/**
 * #247: persist the captured screenshot's public URL onto the deploy task's
 * TaskRecord, so the orchestration reconciler can embed the integration node's
 * combined preview in the parent epic panel. Keyed by the taskId encoded in
 * the deploy branch (``bgagent/{taskId}/…``). Best-effort and never throws —
 * a non-ABCA branch (no taskId), an unset table, or a vanished record (TTL)
 * just skips persistence; the PR + Linear comments are the load-bearing
 * artifacts. Conditional on ``attribute_exists`` so we never resurrect a
 * TTL-reaped row.
 */
async function persistScreenshotUrl(
  branchName: string,
  publicUrl: string,
  previewUrl: string,
): Promise<{ isIntegrationNode: boolean; isIteration: boolean }> {
  const result = { isIntegrationNode: false, isIteration: false };
  if (!TASK_TABLE) return result;
  const taskId = extractTaskIdFromBranch(branchName);
  if (!taskId) return result;
  try {
    // Persist BOTH the captured image URL and the live preview-deploy URL so
    // the reconciler can render a clickable combined-preview deep-link in the
    // panel (#247 UX.17). Return-on-values so we learn whether this deploy task
    // is a synthetic integration node WITHOUT a second Get (#247 UX.16): the
    // integration node's screenshot belongs in the PANEL only — it must NOT
    // also post a standalone Linear comment on the parent epic.
    // ALL_OLD so we can see the PRE-update state: whether a screenshot was
    // already posted for this task (→ this is a RE-DEPLOY, i.e. an iteration push
    // on the same branch), and the channel_metadata (unchanged by this write).
    const upd = await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET screenshot_url = :u, screenshot_preview_url = :p',
      ConditionExpression: 'attribute_exists(task_id)',
      ExpressionAttributeValues: { ':u': publicUrl, ':p': previewUrl },
      ReturnValues: 'ALL_OLD',
    }));
    const subIssueId = upd.Attributes?.channel_metadata?.orchestration_sub_issue_id;
    result.isIntegrationNode = typeof subIssueId === 'string' && isIntegrationNode(subIssueId);
    // iteration-UX: suppress the standalone "🖼️ Preview screenshot" Linear comment
    // on a RE-DEPLOY. An @bgagent iteration pushes to the SAME PR branch, so the
    // task resolved by branch is the original (no trigger_comment_id) — the
    // reliable signal is that a screenshot_url was ALREADY set on this task before
    // this write. First deploy: no prior screenshot → post the headline 🖼️. Any
    // later push (iteration): prior screenshot present → suppress (the maturing
    // reply already carries the [preview](…) link). Also suppress when the task is
    // itself an iteration task (carries trigger_comment_id).
    const hadPriorScreenshot = typeof upd.Attributes?.screenshot_url === 'string';
    const isIterationTask = typeof upd.Attributes?.channel_metadata?.trigger_comment_id === 'string';
    result.isIteration = hadPriorScreenshot || isIterationTask;
    logger.info('Persisted screenshot_url on task record', {
      task_id: taskId,
      public_url: publicUrl,
      is_integration_node: result.isIntegrationNode,
      is_iteration: result.isIteration,
    });
  } catch (err) {
    // ConditionalCheckFailed = the task row is gone (TTL); anything else is a
    // transient DDB error. Either way the comments still posted — log + move on.
    logger.warn('Failed to persist screenshot_url (non-fatal)', {
      event: 'screenshot.persist_failed',
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

function renderCommentBody(publicUrl: string, previewUrl: string): string {
  // previewUrl is payload-derived; percent-encode its parens so a crafted
  // path can't break out of the markdown link and inject content into a
  // comment posted under ABCA's token. publicUrl is our own CloudFront key
  // (no parens by construction) so it's interpolated as-is.
  const safePreview = encodeMarkdownUrl(previewUrl);
  return [
    '🖼️ **Preview screenshot**',
    '',
    `[![preview](${publicUrl})](${safePreview})`,
    '',
    `_From [preview link](${safePreview}) — captured automatically by ABCA after the deploy finished._`,
  ].join('\n');
}

/**
 * Linear comment body. Linear's markdown renders image embeds the
 * same way GitHub does, but Linear collapses linked-image syntax —
 * use the simpler `![alt](url)` form so it renders inline rather than
 * as a clickable link with a tiny preview.
 */
function renderLinearCommentBody(publicUrl: string, previewUrl: string): string {
  // previewUrl is payload-derived — see renderCommentBody for the
  // markdown-breakout rationale.
  const safePreview = encodeMarkdownUrl(previewUrl);
  return [
    '🖼️ **Preview screenshot**',
    '',
    `![preview](${publicUrl})`,
    '',
    `[Preview link](${safePreview})`,
    '',
    '_Captured automatically by ABCA after the deploy finished._',
  ].join('\n');
}
