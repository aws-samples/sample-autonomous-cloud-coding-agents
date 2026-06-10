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

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { captureScreenshot } from './shared/agentcore-browser';
import { resolveGitHubToken } from './shared/context-hydration';
import { upsertTaskComment } from './shared/github-comment';
import {
  type GitHubDeploymentStatusPayload,
  validateDeploymentStatusPayload,
} from './shared/github-deployment-status';
import { postIssueComment } from './shared/linear-feedback';
import { extractLinearIdentifier, findLinearIssueByIdentifier } from './shared/linear-issue-lookup';
import { logger } from './shared/logger';
import { buildScreenshotKey, encodeMarkdownUrl, isAllowedScreenshotUrl } from './shared/screenshot-url';

const s3 = new S3Client({});

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
  // is configured AND the PR title/body carries a Linear identifier.
  if (LINEAR_WORKSPACE_REGISTRY_TABLE) {
    const identifier = extractLinearIdentifier(pr.title) ?? extractLinearIdentifier(pr.body);
    if (identifier) {
      const linearIssue = await findLinearIssueByIdentifier(identifier, LINEAR_WORKSPACE_REGISTRY_TABLE);
      if (linearIssue) {
        const ok = await postIssueComment(
          {
            linearWorkspaceId: linearIssue.linearWorkspaceId,
            registryTableName: LINEAR_WORKSPACE_REGISTRY_TABLE,
          },
          linearIssue.issueId,
          renderLinearCommentBody(publicUrl, previewUrl),
        );
        if (ok) {
          logger.info('Posted screenshot comment to Linear issue', {
            identifier,
            linear_issue_id: linearIssue.issueId,
            workspace_slug: linearIssue.workspaceSlug,
          });
        } else {
          logger.warn('Failed to post screenshot Linear comment (non-fatal)', {
            event: 'screenshot.linear_comment_post_failed',
            identifier,
            linear_issue_id: linearIssue.issueId,
          });
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
 * Open PR shape we extract from the GitHub commit-pulls API. Title +
 * body are used downstream by the Linear issue lookup; the others go
 * into log lines for debugging.
 */
interface OpenPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
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
  const delays = [0, 5_000, 10_000, 20_000];
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i];
    if (delay > 0) {
      // Skip the wait if the deadline would land mid-sleep.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    }
    if (Date.now() >= deadline) return null;
    const pr = await findPullRequestForSha(repo, sha, token);
    if (pr) return pr;
    const next = delays[i + 1];
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
 * Returns the first OPEN PR (with title/body), or null if none.
 * Closed/merged PRs are filtered out — v1 only screenshots active
 * reviews.
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
    return null;
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
    return null;
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
  }>;
  const open = pulls.find((p) => p.state === 'open' && typeof p.number === 'number');
  if (!open) return null;
  return {
    number: open.number!,
    title: open.title ?? '',
    body: open.body ?? '',
  };
}

/** Render the PR comment body. */
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
