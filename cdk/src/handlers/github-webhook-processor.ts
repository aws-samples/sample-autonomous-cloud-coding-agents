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
const TASK_TABLE = process.env.TASK_TABLE_NAME;

const SCREENSHOT_BUCKET = process.env.SCREENSHOT_BUCKET_NAME!;
const SCREENSHOT_PUBLIC_HOST = process.env.SCREENSHOT_PUBLIC_HOST!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN!;
const LINEAR_WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

const TOTAL_BUDGET_MS = 110_000;

const POST_CAPTURE_RESERVE_MS = 30_000;

const MIN_CAPTURE_BUDGET_MS = 15_000;

// Managed providers post `deployment_status` when their build finishes, which can be
// before the PR for the SHA exists: 5-15s measured on Vercel, similar on Netlify and Amplify.
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
 * Captures a screenshot of `deployment.environment_url`, PUTs the PNG to the
 * screenshot bucket and POSTs a fresh PR comment with it. Every external call
 * is best-effort: a failed step is logged and the handler returns.
 */
// eslint-disable-next-line complexity -- predates the ceiling (56, down from 59 when it landed); must not grow
export async function handler(event: ProcessorEvent): Promise<void> {
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
    logger.warn('Processor received invalid deployment_status payload — skipping', {
      repo: raw.repository?.full_name,
      deployment_id: raw.deployment?.id,
    });
    return;
  }
  const { repoFullName: repo, sha, environmentUrl: previewUrl, deploymentId } = payload;

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
      existingCommentId: undefined,
    });
    logger.info('Posted screenshot comment to PR', {
      repo,
      pr_number: pr.number,
      comment_id: result.commentId,
      public_url: publicUrl,
    });
  } catch (err) {
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

  if (LINEAR_WORKSPACE_REGISTRY_TABLE && !isIntegrationDeploy && task?.channel_source !== 'jira') {
    const linearIssue = await linearIssueFor(task, repo, pr, LINEAR_WORKSPACE_REGISTRY_TABLE);
    if (linearIssue) {
      const ctx = {
        linearWorkspaceId: linearIssue.linearWorkspaceId,
        registryTableName: LINEAR_WORKSPACE_REGISTRY_TABLE,
      };
      if (isIterationDeploy) {
        const iter = lookupValueOr(await findIterationReplyId(linearIssue.issueId, repo, sha), null);
        if (iter) {
          await persistScreenshotOnIterationTask(iter.taskId, publicUrl, previewUrl);
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

async function findIterationReplyId(
  linearIssueId: string,
  repo: string,
  deploySha?: string,
): Promise<LookupResult<{ replyId: string; taskId: string }>> {
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
      ScanIndexForward: false,
    }));
    const here = repo.toLowerCase();
    const candidates = ((res.Items ?? []) as Array<{ task_id?: string; repo?: unknown; channel_metadata?: { iteration_reply_comment_id?: string } }>)
      .filter((item) => typeof item.repo === 'string' && item.repo.toLowerCase() === here)
      .map((item) => ({ taskId: item.task_id, replyId: item.channel_metadata?.iteration_reply_comment_id }))
      .filter((c): c is { taskId: string; replyId: string } =>
        typeof c.taskId === 'string' && typeof c.replyId === 'string' && c.replyId.length > 0);
    if (candidates.length === 0) return LOOKUP_ABSENT;

    if (deploySha) {
      for (const c of candidates) {
        const got = await ddb.send(new GetCommand({
          TableName: TASK_TABLE, Key: { task_id: c.taskId }, ProjectionExpression: 'head_sha',
        }));
        if (got.Item?.head_sha === deploySha) return lookupFound({ replyId: c.replyId, taskId: c.taskId });
      }
    }
    return lookupFound({ replyId: candidates[0].replyId, taskId: candidates[0].taskId });
  } catch (err) {
    logger.warn('findIterationReplyId query failed (non-fatal)', {
      linear_issue_id: linearIssueId, error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
}

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

interface OpenPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRefName: string;
  // GitHub returns `head.repo: null` for a pull request from a fork that was deleted.
  readonly headRepo: string | null;
}

type PrLookup =
  | { readonly ok: true; readonly pr: OpenPr }
  | { readonly ok: false; readonly kind: 'pr_rejected'; readonly reason: PrLookupRejectionReason }
  | { readonly ok: false; readonly kind: 'request_rejected'; readonly reason: PrLookupRequestRejectionReason; readonly status: number }
  | { readonly ok: false; readonly kind: 'retryable'; readonly reason: PrLookupRetryableReason };

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

async function findPullRequestForSha(
  repo: string,
  sha: string,
  token: string,
  validatedPrNumber?: number,
): Promise<PrLookup> {
  const url = validatedPrNumber === undefined
    ? `https://api.github.com/repos/${repo}/commits/${sha}/pulls`
    : `https://api.github.com/repos/${repo}/pulls/${validatedPrNumber}`;
  let res: Response;
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
    // GitHub secondary rate limits can return 403 without rate-limit headers.
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
  // repository from a branch of this one.
  const here = repo.toLowerCase();
  const openPulls = pulls.filter((p) => {
    const baseRepo = p.base?.repo?.full_name;
    return p.state === 'open' && typeof p.number === 'number'
      && typeof baseRepo === 'string' && baseRepo.toLowerCase() === here;
  });
  if (openPulls.length === 0) return { ok: false, kind: 'retryable', reason: 'pr_not_linked' };
  // For a stacked PR chain commit-pulls also lists every PR stacked on top of
  // the commit's own: their history contains the commit.
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
  if (pr.headRepo === null) {
    logger.warn('GitHub named no head repository for the pull request; its branch cannot name a task', {
      event: 'screenshot.head_repo_missing',
      task_id: taskId,
      pr_number: pr.number,
    });
    return lookupFailed(new Error('GitHub named no head repository for the pull request'));
  }
  try {
    // GitHub answers to any letter case of a repository name and reports its own.
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
  const safePreview = encodeMarkdownUrl(previewUrl);
  return [
    '🖼️ **Preview screenshot**',
    '',
    `[![preview](${publicUrl})](${safePreview})`,
    '',
    `_From [preview link](${safePreview}) — captured automatically by ABCA after the deploy finished._`,
  ].join('\n');
}

// Linear collapses linked-image syntax (`[![alt](img)](url)`) to a link with a
// tiny preview; plain `![alt](url)` renders inline.
function renderLinearCommentBody(publicUrl: string, previewUrl: string): string {
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
