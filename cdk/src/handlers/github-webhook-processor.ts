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
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { captureScreenshot } from './shared/agentcore-browser';
import { resolveGitHubToken } from './shared/context-hydration';
import { upsertTaskComment } from './shared/github-comment';
import {
  type GitHubDeploymentStatusPayload,
  type ProcessorEvent,
  type PrLookupRejectionReason,
  type PrLookupRequestRejectionReason,
  type PrLookupRetryableReason,
  AMPLIFY_PREVIEW_HOST,
  validateDeploymentStatusPayload,
} from './shared/github-deployment-status';
import { renderPreviewBlock } from './shared/iteration-reply';
import { deliverJiraDeploymentPreview } from './shared/jira-deployment-preview';
import { appendOnceToComment, postIssueComment } from './shared/linear-feedback';
import {
  type LinearIssueLocation,
  extractLinearIdentifier,
  extractLinearIdentifierFromBranch,
  findLinearIssueByIdentifier,
} from './shared/linear-issue-lookup';
import { logger } from './shared/logger';
import { type LookupResult, LOOKUP_ABSENT, lookupFailed, lookupFound, lookupValueOr, isLookupFailure } from './shared/lookup-result';
import { isIntegrationNode } from './shared/orchestration-integration-node';
import { buildScreenshotKey, encodeMarkdownUrl, extractTaskIdFromBranch, isAllowedScreenshotUrl } from './shared/screenshot-url';
import type { TaskRecord } from './shared/types';
import { makeClient, makeDocClient } from './shared/ua';

const s3 = makeClient(S3Client);
const ddb = makeDocClient();
// Optional — when set, the processor persists the screenshot's public URL onto
// the deploy task's TaskRecord (keyed by the taskId in the deploy branch) so
// the orchestration reconciler can embed the integration node's combined
// preview in the parent epic panel. Unset → persistence and channel delivery are skipped; the PR comment still posts.
const TASK_TABLE = process.env.TASK_TABLE_NAME;

const SCREENSHOT_BUCKET = process.env.SCREENSHOT_BUCKET_NAME!;
// CloudFront distribution domain — `<dist>.cloudfront.net`. Used as
// the public host for the screenshot URL embedded in PR comments.
// The bucket is private; CloudFront with OAC reads on the agent's
// behalf.
const SCREENSHOT_PUBLIC_HOST = process.env.SCREENSHOT_PUBLIC_HOST!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN!;
// Optional — when set, the processor also tries to post the
// screenshot comment onto a linked Linear issue: the issue of the task
// that opened the PR, else the one resolved from the GitHub PR
// branch/title/body via a Linear-identifier regex (e.g. `ENG-42`) and
// looked up across the active workspaces in the registry.
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
 * the browser, plus up to 20s for optional Jira delivery and 1.5s to exit.
 * Anything left over is the screenshot's actual budget.
 */
const POST_CAPTURE_RESERVE_MS = 30_000;

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

/**
 * Async processor for verified deployment statuses and normalized Amplify checks.
 *
 * Flow:
 *  1. Parse the payload (already validated as deployment_status by the
 *     receiver, but we re-extract the fields we need).
 *  2. Fetch the validated Amplify PR, or find the deployment SHA's open PR.
 *  3. Capture a screenshot of `deployment.environment_url` via
 *     AgentCore Browser.
 *  4. PUT the PNG to the screenshot bucket.
 *  5. POST a fresh PR comment with `![preview](<public-url>)`.
 *
 * Every external call is best-effort. If any step fails, log + return —
 * the receiver already 200'd, so retries by GitHub will dedup at the
 * receiver layer.
 */
// eslint-disable-next-line complexity -- predates the ceiling (59 when it landed); must not grow
export async function handler(event: ProcessorEvent): Promise<void> {
  // One wall-clock deadline shared across PR lookup + screenshot capture
  // + S3 PUT + comment POST. Without this, findPullRequestForShaWithRetry
  // could spend ~35s before captureScreenshot starts its independent 60s
  // budget — totaling ~95s + S3 + comment, which exceeds the 120s Lambda
  // timeout on slow-GitHub days.
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  if (!event.raw_body) {
    logger.error('GitHub webhook processor invoked without raw_body');
    return;
  }

  let raw: GitHubDeploymentStatusPayload;
  try {
    raw = JSON.parse(event.raw_body) as GitHubDeploymentStatusPayload;
  } catch {
    logger.error('GitHub webhook processor could not parse raw_body', { reason: 'invalid_json' });
    return;
  }

  const validatedPrNumber = event.validated_pr_number;
  if (validatedPrNumber !== undefined
    && (!Number.isSafeInteger(validatedPrNumber) || validatedPrNumber <= 0)) {
    logger.warn('Processor received invalid validated PR number', {
      event: 'screenshot.amplify_pr_rejected', reason: 'invalid_forwarded_pr_number',
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
  // literal-IP, link-local, loopback) at the boundary.
  let preview: URL | undefined;
  try {
    preview = new URL(previewUrl);
  } catch { /* Rejected below without logging untrusted URL content. */ }
  const amplifyHost = preview && AMPLIFY_PREVIEW_HOST.exec(preview.hostname);
  if (!isAllowedScreenshotUrl(previewUrl)
    || (validatedPrNumber !== undefined && (preview?.username || preview?.password || preview?.port
      || !amplifyHost))) {
    logger.warn('Rejected deployment_status preview URL on allowlist', {
      repo,
      event: 'screenshot.preview_url_rejected',
      preview_host: preview?.hostname,
      url_parsed: Boolean(preview),
      reason: 'untrusted_preview_url',
    });
    return;
  }

  if (validatedPrNumber !== undefined && amplifyHost && Number(amplifyHost[1]) !== validatedPrNumber) {
    logger.error('Amplify preview URL does not match forwarded PR number', {
      event: 'screenshot.preview_url_rejected',
      error_id: 'SCREENSHOT_PREVIEW_PR_MISMATCH',
      reason: 'preview_pr_number_mismatch',
      repo,
      preview_host: preview?.hostname,
      pr_number: validatedPrNumber,
    });
    return;
  }

  logger.info('Screenshot pipeline starting', {
    repo,
    sha,
    preview_host: preview?.hostname,
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
  const lookup = await findPullRequestForShaWithRetry(repo, sha, token, prLookupBudget, validatedPrNumber);
  if (!lookup.ok && lookup.kind === 'request_rejected') {
    logger.error('GitHub rejected the validated Amplify PR lookup', {
      event: 'screenshot.pr_lookup_rejected',
      error_id: 'SCREENSHOT_PR_LOOKUP_REJECTED',
      reason: lookup.reason,
      repo,
      pr_number: validatedPrNumber,
      status: lookup.status,
    });
    return;
  }
  if (!lookup.ok && lookup.kind === 'pr_rejected') {
    logger.warn('Validated Amplify PR no longer matches preview', {
      event: 'screenshot.amplify_pr_rejected',
      reason: lookup.reason,
      repo,
      pr_number: validatedPrNumber,
    });
    return;
  }
  if (!lookup.ok) {
    // Promote to error: "no PR after the retry budget" is the shape of
    // a systematic break (deploy-without-PR, token regression, GitHub
    // outage). At warn level it went unnoticed. Add a
    // tagged event_id for the CloudWatch metric filter / alarm.
    logger.error('No open PR found for SHA after retries — skipping screenshot post', {
      event: 'screenshot.pr_lookup_exhausted',
      error_id: 'SCREENSHOT_PR_LOOKUP_EXHAUSTED',
      repo,
      sha,
      budget_ms: prLookupBudget,
      reason: lookup.reason,
    });
    return;
  }

  const pr = lookup.pr;

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
      preview_host: preview?.hostname,
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

  // Persist the screenshot + preview URLs on the deploy task's record
  // (keyed by the taskId in the branch) so the orchestration reconciler can
  // embed the integration node's combined preview in the parent epic panel.
  // Best-effort, before the comment posts so a comment-post failure doesn't
  // skip it. The return tells us whether this is the synthetic integration
  // node — whose screenshot belongs in the panel only, never as a standalone
  // Linear comment on the parent epic.
  const persisted = await persistScreenshotUrl(
    pr,
    repo,
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
    // delivered. Tagged event_id for the CloudWatch metric filter.
    logger.error('Failed to post screenshot PR comment', {
      event: 'screenshot.pr_comment_post_failed',
      error_id: 'SCREENSHOT_PR_COMMENT_POST_FAILED',
      repo,
      pr_number: pr.number,
      public_url: publicUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (isLookupFailure(persisted)) return;
  const { isIntegrationNode: isIntegrationDeploy, isIteration: isIterationDeploy, task } = lookupValueOr(
    persisted, { isIntegrationNode: false, isIteration: false, task: undefined },
  );
  const jiraRegistry = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (task?.channel_source === 'jira' && TASK_TABLE && jiraRegistry) {
    await deliverJiraDeploymentPreview(ddb, TASK_TABLE, jiraRegistry, task, repo, sha, publicUrl, previewUrl, remaining);
  } else if (task?.channel_source === 'jira') {
    logger.warn('Jira preview registry is not configured', {
      event: 'screenshot.jira_missing_registry', task_id: task.task_id,
    });
  }

  // Best-effort Linear comment. The GitHub PR comment above is the
  // load-bearing artifact; the Linear comment is bonus surface for
  // reviewers who live in Linear. Only fires when the registry table
  // is configured AND the task or the PR names a Linear issue.
  //
  // The synthetic integration node has no Linear sub-issue of its
  // own, so a Linear post here would resolve the parent-epic identifier from
  // the PR title and land a "🖼️ Preview screenshot" comment ON THE PARENT —
  // cluttering the maturing panel (which already embeds the combined preview
  // via the persisted screenshot_url). Skip the Linear post for the integration
  // node; the panel is the only Linear surface for the combined result.
  if (LINEAR_WORKSPACE_REGISTRY_TABLE && !isIntegrationDeploy && task?.channel_source !== 'jira') {
    const linearIssue = await linearIssueFor(task, repo, pr, LINEAR_WORKSPACE_REGISTRY_TABLE);
    if (linearIssue) {
      const ctx = {
        linearWorkspaceId: linearIssue.linearWorkspaceId,
        registryTableName: LINEAR_WORKSPACE_REGISTRY_TABLE,
      };
      if (isIterationDeploy) {
        // The preview belongs IN the iteration's maturing reply,
        // not a standalone comment. The screenshot capture is async and usually
        // lands AFTER the reply settled (✅ + cost), so we APPEND the preview
        // link to that reply now (in place). Find the most-recent iteration
        // reply id for this issue and edit it; idempotent via the [preview]
        // marker so a webhook redelivery won't double-append.
        const iter = lookupValueOr(await findIterationReplyId(linearIssue.issueId, repo, sha), null);
        if (iter) {
          // (1) Durably persist the screenshot onto the ITERATION task so the
          // terminal-settle renders the thumbnail from a strongly-consistent
          // DDB read — race-free against this comment edit, which used to
          // clobber the preview.
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
            linear_issue_id: linearIssue.issueId, workspace_slug: linearIssue.workspaceSlug,
          });
        } else {
          logger.warn('Failed to post screenshot Linear comment (non-fatal)', {
            event: 'screenshot.linear_comment_post_failed', linear_issue_id: linearIssue.issueId,
          });
        }
      }
    }
  }
}

/**
 * The Linear issue a deployment's preview belongs on.
 *
 * The task that opened the pull request records its own issue and workspace, and
 * that is the answer whenever it is there. It needs no identifier in the pull
 * request: a task started from a comment is described by that comment alone. And
 * an identifier such as `ENG-7` is unique inside one workspace only: on a stack
 * with two workspaces that both have it, a lookup by identifier can return the
 * other tenant's issue.
 *
 * `task` is a task of the deployment's repository, named by a branch of that
 * repository: `persistScreenshotUrl` hands on no other, because the task id
 * comes from the branch name, which whoever opens a pull request chooses.
 *
 * A pull request without such a task is searched for an identifier. Branch name
 * first: it encodes this PR's own issue (`bgagent/{taskId}/eng-151-...`). Title
 * and body are fallbacks: in a stacked orchestration the body often names a
 * predecessor issue before the one the PR closes, and `extractLinearIdentifier`
 * returns the first match in document order. A fallback is tried only when every
 * workspace answered that it has no issue of the identifier before it: any word
 * followed by a number reads as one (`feature/upgrade-node-22` gives `NODE-22`).
 * After a lookup that could not be completed, or that found two issues, nothing
 * is tried: the preview must not land on an issue the pull request only mentions.
 */
async function linearIssueFor(
  task: TaskRecord | undefined,
  repo: string,
  pr: OpenPr,
  registryTableName: string,
): Promise<LinearIssueLocation | null> {
  const meta = task?.channel_metadata;
  if (meta?.linear_issue_id && meta.linear_workspace_id) {
    return {
      issueId: meta.linear_issue_id,
      linearWorkspaceId: meta.linear_workspace_id,
      // Labels a log line only.
      workspaceSlug: meta.linear_workspace_slug ?? '',
    };
  }
  const candidates = new Set([
    extractLinearIdentifierFromBranch(pr.headRefName),
    extractLinearIdentifier(pr.title),
    extractLinearIdentifier(pr.body),
  ]);
  const tried: string[] = [];
  for (const identifier of candidates) {
    if (!identifier) continue;
    tried.push(identifier);
    const found = await findLinearIssueByIdentifier(identifier, registryTableName);
    if (found.ok) return found.value;
    if (isLookupFailure(found)) break;
  }
  if (tried.length > 0) {
    logger.info('Linear identifier did not resolve to an issue — skipping Linear post', {
      identifiers: tried,
      repo,
      pr_number: pr.number,
    });
  }
  return null;
}

/**
 * Find the most-recent iteration's maturing-reply comment id AND
 * its task id for a Linear issue. An @bgagent iteration persists
 * ``iteration_reply_comment_id`` on its task's channel_metadata. The screenshot
 * webhook (resolving the issue by PR identifier) uses the reply id to append the
 * preview to that reply, and the task id to persist the screenshot DURABLY onto
 * the iteration task — so the terminal-settle renders the preview from a
 * strongly-consistent DDB read rather than racing the (eventually-consistent)
 * Linear comment edit, which used to clobber the preview.
 *
 * Attribution: this deploy's commit ``sha`` is matched to the iteration task that
 * PUSHED it (``head_sha``), so when two iterations overlap on one PR the preview
 * lands on the RIGHT reply — not just the newest. ``head_sha`` is a top-level
 * field (NOT in the LinearIssueIndex INCLUDE projection, which can't be changed
 * in place), so we GetItem ``head_sha`` per reply-bearing candidate (bounded by
 * iterations-per-issue, newest-first so the common single-iteration case is one
 * read). Falls back to the newest reply-bearing task when no head_sha matches
 * (pre-fix tasks that never stored it, or a non-PR deploy).
 *
 * Only a task of the deployment's repository ``repo`` is a candidate, for the
 * match by commit and for the fallback alike. The issue can come from an
 * identifier in the pull request's branch, title or body, which whoever writes
 * them chooses, and then be an issue of another repository: its iteration task
 * and its reply must not get this deployment's screenshot. The index projects
 * ``repo``, so this costs no read.
 *
 * Returns a {@link LookupResult}: ``found`` with the reply + task ids, ``absent``
 * when the query ran and this issue has no reply-bearing iteration of this
 * repository, and a failure when the lookup could not run or broke (unconfigured
 * table, Query error) — so a caller is never told "no iteration reply" because
 * the read failed.
 */
async function findIterationReplyId(
  linearIssueId: string,
  repo: string,
  deploySha?: string,
): Promise<LookupResult<{ replyId: string; taskId: string }>> {
  // Misconfiguration, not absence: the query never ran, so we cannot claim there
  // is genuinely no iteration reply. Behaviourally identical to LOOKUP_ABSENT for
  // today's sole (best-effort) caller, but reporting it as absent is exactly the
  // conflation LookupResult exists to end — and it would mislead the next caller
  // that branches on the difference.
  if (!TASK_TABLE) {
    logger.warn('findIterationReplyId: TASK_TABLE_NAME is not configured — cannot look up the iteration reply');
    return lookupFailed(new Error('TASK_TABLE_NAME is not configured'));
  }
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: 'LinearIssueIndex',
      KeyConditionExpression: 'linear_issue_id = :iid',
      ExpressionAttributeValues: { ':iid': linearIssueId },
      ScanIndexForward: false, // newest first (SK = created_at)
    }));
    const here = repo.toLowerCase();
    const candidates = ((res.Items ?? []) as Array<{ task_id?: string; repo?: unknown; channel_metadata?: { iteration_reply_comment_id?: string } }>)
      .filter((item) => typeof item.repo === 'string' && item.repo.toLowerCase() === here)
      .map((item) => ({ taskId: item.task_id, replyId: item.channel_metadata?.iteration_reply_comment_id }))
      .filter((c): c is { taskId: string; replyId: string } =>
        typeof c.taskId === 'string' && typeof c.replyId === 'string' && c.replyId.length > 0);
    if (candidates.length === 0) return LOOKUP_ABSENT;

    // Prefer the task whose pushed head_sha matches this deploy's commit (correct
    // attribution under overlapping iterations). Walk newest-first; GetItem the
    // head_sha per candidate. Stop at the first match.
    if (deploySha) {
      for (const c of candidates) {
        const got = await ddb.send(new GetCommand({
          TableName: TASK_TABLE, Key: { task_id: c.taskId }, ProjectionExpression: 'head_sha',
        }));
        if (got.Item?.head_sha === deploySha) return lookupFound({ replyId: c.replyId, taskId: c.taskId });
      }
    }
    // No SHA match (pre-fix task / non-PR deploy) → newest reply-bearing task.
    return lookupFound({ replyId: candidates[0].replyId, taskId: candidates[0].taskId });
  } catch (err) {
    logger.warn('findIterationReplyId query failed (non-fatal)', {
      linear_issue_id: linearIssueId, error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
}

/**
 * Durably persist the captured screenshot URLs onto the ITERATION
 * task record (the one carrying the reply id), so the terminal-settle can render
 * the preview thumbnail from a strongly-consistent DDB read. This is the
 * race-free half of the fix: an @bgagent iteration's deploy pushes the SAME PR
 * branch, so ``persistScreenshotUrl`` (keyed by branch → original task) never
 * touches the iteration task — the settle then had no screenshot and the only
 * preview writer was the comment append, which the settle then clobbered.
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
   * Head branch ref (e.g. `bgagent/{taskId}/eng-151-...`). Names the
   * task, and is the first place searched for a Linear identifier when
   * the task record names no issue — see `linearIssueFor`.
   */
  readonly headRefName: string;
  /**
   * The repository that holds the head branch (`head.repo.full_name`): the
   * deployment's repository for a branch of the repository itself, the
   * fork's for a pull request from a fork. Null when GitHub names none (it
   * returns `null` for a fork that was deleted).
   */
  readonly headRepo: string | null;
}

type PrLookup =
  | { readonly ok: true; readonly pr: OpenPr }
  | { readonly ok: false; readonly kind: 'pr_rejected'; readonly reason: PrLookupRejectionReason }
  | { readonly ok: false; readonly kind: 'request_rejected'; readonly reason: PrLookupRequestRejectionReason; readonly status: number }
  | { readonly ok: false; readonly kind: 'retryable'; readonly reason: PrLookupRetryableReason };

/**
 * Wait for an open PR to exist for the given SHA, retrying with a
 * small backoff. Managed providers commonly post `deployment_status`
 * before the agent's `gh pr create` call lands (we've measured 5-15s
 * gap on Vercel; Netlify/Amplify behave similarly), so a single check
 * would silently miss the common case.
 *
 * Schedule: 0s, 5s, 10s, 20s — covers the observed gap with one
 * generous bonus retry. Capped by `budgetMs` so the caller can hand
 * over only what it can afford to spend off the shared deadline. Returns
 * a typed failure on exhaustion or timeout. Terminal Amplify rejections stop
 * immediately; only transient lookup failures enter the backoff.
 */
async function findPullRequestForShaWithRetry(
  repo: string,
  sha: string,
  token: string,
  budgetMs: number,
  validatedPrNumber?: number,
): Promise<PrLookup> {
  const deadline = Date.now() + budgetMs;
  let result: PrLookup = { ok: false, kind: 'retryable', reason: 'budget_exhausted' };
  for (let i = 0; i < PR_LOOKUP_RETRY_DELAYS_MS.length; i++) {
    const delay = PR_LOOKUP_RETRY_DELAYS_MS[i];
    if (delay > 0) {
      // Skip the wait if the deadline would land mid-sleep.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    }
    if (Date.now() >= deadline) return result;
    result = await findPullRequestForSha(repo, sha, token, validatedPrNumber);
    if (result.ok || result.kind !== 'retryable') return result;
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
  return result;
}

/**
 * With a validated Amplify PR number, fetch GET /repos/{repo}/pulls/{number}.
 * Accept only that open PR with a matching head; body validation and permanent
 * HTTP failures are terminal. Transient request failures remain retryable.
 *
 * For deployment statuses, use GET /repos/{repo}/commits/{sha}/pulls. Of the
 * open PRs that live in this repository, prefer those whose head matches the
 * SHA, falling back to all of them, and take the lowest number, whatever the
 * order of the answer. (The PR fetched by number above lives in the repository
 * by the endpoint's own scope.)
 * Missing PRs and request failures are retryable to cover the PR-creation race.
 */
async function findPullRequestForSha(
  repo: string,
  sha: string,
  token: string,
  validatedPrNumber?: number,
): Promise<PrLookup> {
  // A commit can head multiple PRs. Amplify's validated PR is authoritative;
  // fetch it directly so pagination or commit-pulls ordering cannot redirect it.
  const url = validatedPrNumber === undefined
    ? `https://api.github.com/repos/${repo}/commits/${sha}/pulls`
    : `https://api.github.com/repos/${repo}/pulls/${validatedPrNumber}`;
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
    logger.warn('GitHub PR lookup fetch failed', {
      repo,
      sha,
      timed_out: ac.signal.aborted,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, kind: 'retryable', reason: 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (validatedPrNumber !== undefined && res.status === 404) {
      return { ok: false, kind: 'request_rejected', reason: 'pr_not_found', status: res.status };
    }
    // Secondary rate limits can return 403 without rate-limit headers. Retry
    // all 403s conservatively; persistent permission failures exhaust into ERROR.
    const HTTP_STATUS_REQUEST_TIMEOUT = 408;
    const retryableStatus = [403, HTTP_STATUS_REQUEST_TIMEOUT, 429].includes(res.status);
    if (validatedPrNumber !== undefined && res.status >= 400 && res.status < 500
      && !retryableStatus) {
      return { ok: false, kind: 'request_rejected', reason: 'pr_request_rejected', status: res.status };
    }
    logger.warn('GitHub PR lookup returned non-2xx', {
      repo,
      sha,
      status: res.status,
    });
    return { ok: false, kind: 'retryable', reason: 'http_error' };
  }

  // Parse defensively: both endpoints can return an unexpected response body.
  // A validated Amplify PR must still be open and head this exact commit.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    logger.warn('GitHub PR lookup returned non-JSON body', { repo, sha });
    return { ok: false, kind: 'retryable', reason: 'non_json_response' };
  }
  if (validatedPrNumber !== undefined) {
    const pr = parsed as {
      number?: unknown;
      state?: unknown;
      title?: unknown;
      body?: unknown;
      head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null };
    } | null;
    const reject = (reason: PrLookupRejectionReason): PrLookup => ({ ok: false, kind: 'pr_rejected', reason });
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return reject('malformed_pr_response');
    if (pr.number !== validatedPrNumber) return reject('pr_number_mismatch');
    if (pr.state !== 'open') return reject('pr_not_open');
    if (pr.head?.sha !== sha) return reject('live_pr_head_sha_mismatch');
    if (typeof pr.head.ref !== 'string' || !pr.head.ref) return reject('missing_head_ref');
    return {
      ok: true,
      pr: {
        number: validatedPrNumber,
        title: typeof pr.title === 'string' ? pr.title : '',
        body: typeof pr.body === 'string' ? pr.body : '',
        headRefName: pr.head.ref,
        headRepo: typeof pr.head.repo?.full_name === 'string' ? pr.head.repo.full_name : null,
      },
    };
  }
  // A non-array body would crash array operations and fault the async processor.
  if (!Array.isArray(parsed)) {
    logger.warn('GitHub commit-pulls did not return an array', { repo, sha });
    return { ok: false, kind: 'retryable', reason: 'malformed_pr_response' };
  }
  const pulls = parsed as Array<{
    number?: number;
    state?: string;
    title?: string;
    body?: string | null;
    head?: { ref?: string; sha?: string; repo?: { full_name?: unknown } | null } | null;
    base?: { repo?: { full_name?: unknown } | null } | null;
  }>;
  // GitHub lists the open pull requests of a commit by the repository of their
  // HEAD branch, so the answer can hold one that somebody opened in another
  // repository from a branch of this one. Its number is a number of that
  // repository and its title and body are that author's: only a pull request
  // that lives in this repository (`base.repo`) counts, and one that names no
  // base does not.
  const here = repo.toLowerCase();
  const openPulls = pulls.filter((p) => {
    const baseRepo = p.base?.repo?.full_name;
    return p.state === 'open' && typeof p.number === 'number'
      && typeof baseRepo === 'string' && baseRepo.toLowerCase() === here;
  });
  if (openPulls.length === 0) return { ok: false, kind: 'retryable', reason: 'pr_not_linked' };
  // Prefer the PR whose own head is this SHA — the PR that introduced the
  // commit. For a stacked PR chain the commit-pulls API also lists every
  // PR stacked on top (their history contains the commit); routing reads
  // the selected PR's branch, so we must pick its true owner. Fall back to
  // the open PRs of the repository for non-head SHAs (e.g. a merge/base commit).
  //
  // Of several, the lowest number, not the first listed: a second pull request
  // from the same branch can be opened by anyone who can open one in the
  // repository (in a public one, into another of its branches), with a title of
  // its author's choice, and the order of GitHub's answer must not decide which
  // of the two gets the screenshot and has its title searched for an issue. ABCA
  // opens its pull request right after it pushes the branch, so its number is
  // the lower one unless another was opened in between. The task record cannot
  // say which is its own here: it holds the pull request only from the end of
  // the run, and is not read yet.
  const heads = openPulls.filter((p) => p.head?.sha === sha);
  const owner = (heads.length > 0 ? heads : openPulls).reduce((a, b) => (b.number! < a.number! ? b : a));
  const headRepo = owner.head?.repo?.full_name;
  return {
    ok: true,
    pr: {
      number: owner.number!,
      title: owner.title ?? '',
      body: owner.body ?? '',
      headRefName: owner.head?.ref ?? '',
      headRepo: typeof headRepo === 'string' ? headRepo : null,
    },
  };
}

/** Render the PR comment body. */
/**
 * Persist the captured screenshot's public URL onto the deploy task's
 * TaskRecord, so the orchestration reconciler can embed the integration node's
 * combined preview in the parent epic panel. Keyed by the taskId encoded in
 * the deploy branch (``bgagent/{taskId}/…``). Best-effort and never throws —
 * a non-ABCA branch (no taskId), an unset table, a vanished record (TTL), a
 * branch of another repository (a fork) or a task of another repository skips
 * persistence. Lookup failures skip both channel deliveries; the PR comment
 * still posts. The returned task is ALL_OLD: its screenshot is from the
 * previous deploy. Conditional on ``attribute_exists`` so we never resurrect a
 * TTL-reaped row.
 */
async function persistScreenshotUrl(
  pr: OpenPr,
  repo: string,
  publicUrl: string,
  previewUrl: string,
): Promise<LookupResult<{ isIntegrationNode: boolean; isIteration: boolean; task?: TaskRecord }>> {
  const result: { isIntegrationNode: boolean; isIteration: boolean; task?: TaskRecord } = { isIntegrationNode: false, isIteration: false };
  if (!TASK_TABLE) {
    logger.warn('Screenshot task table is not configured; skipping channel delivery', { event: 'screenshot.persist_failed' });
    return lookupFailed(new Error('Screenshot task table is not configured'));
  }
  const taskId = extractTaskIdFromBranch(pr.headRefName);
  if (!taskId) return LOOKUP_ABSENT;
  // Whoever opens a pull request chooses its branch name, so the task id in it
  // can be that of any task, and a task id is in the branch name of every ABCA
  // pull request. A branch names a task only when it is a branch of the
  // deployment's repository (ABCA pushes there; a fork's branch is its author's)
  // and the task is a task of that repository. Only such a task is written to
  // and handed on for channel delivery. Letter case is not compared: GitHub
  // answers to any spelling of a name and reports its own, the task has the
  // blueprint's.
  if (pr.headRepo === null) {
    // Its own log line: should GitHub stop naming the head repository, every
    // task would lose its screenshot, and this line is how that would be seen.
    logger.warn('GitHub named no head repository for the pull request; its branch cannot name a task', {
      event: 'screenshot.head_repo_missing',
      task_id: taskId,
      pr_number: pr.number,
    });
    return lookupFailed(new Error('GitHub named no head repository for the pull request'));
  }
  try {
    if (pr.headRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error('The branch of the pull request is in another repository');
    }
    const owner = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      ProjectionExpression: '#repo',
      ExpressionAttributeNames: { '#repo': 'repo' },
    }));
    const taskRepo: unknown = owner.Item?.repo;
    if (typeof taskRepo !== 'string' || taskRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error('The branch names no task of this repository');
    }
    // Persist BOTH the captured image URL and the live preview-deploy URL so
    // the reconciler can render a clickable combined-preview deep-link in the
    // panel. Return-on-values so we learn whether this deploy task
    // is a synthetic integration node WITHOUT a second Get: the
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
    if (upd.Attributes) result.task = { ...upd.Attributes, task_id: taskId } as TaskRecord;
    const subIssueId = upd.Attributes?.channel_metadata?.orchestration_sub_issue_id;
    result.isIntegrationNode = typeof subIssueId === 'string' && isIntegrationNode(subIssueId);
    // Suppress the standalone "🖼️ Preview screenshot" Linear comment
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
    // The branch is a fork's or names no task of this repository, the task row
    // is gone (TTL, ConditionalCheckFailed), or a transient DDB error. Preserve
    // the PR comment, but skip channel routing.
    logger.warn('Failed to persist screenshot_url (non-fatal)', {
      event: 'screenshot.persist_failed',
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
  return lookupFound(result);
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
