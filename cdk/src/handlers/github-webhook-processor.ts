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
import { logger } from './shared/logger';

const s3 = new S3Client({});

const SCREENSHOT_BUCKET = process.env.SCREENSHOT_BUCKET_NAME!;
// CloudFront distribution domain — `<dist>.cloudfront.net`. Used as
// the public host for the screenshot URL embedded in PR comments.
// The bucket is private; CloudFront with OAC reads on the agent's
// behalf.
const SCREENSHOT_PUBLIC_HOST = process.env.SCREENSHOT_PUBLIC_HOST!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN!;

interface GitHubDeploymentStatusPayload {
  readonly action?: string;
  readonly deployment_status?: {
    readonly id?: number;
    readonly state?: string;
    readonly target_url?: string;
    /** The deployed URL — lives on the *status* object, not the deployment. */
    readonly environment_url?: string;
  };
  readonly deployment?: {
    readonly id?: number;
    readonly sha?: string;
    readonly environment?: string;
  };
  readonly repository?: {
    readonly full_name?: string;
  };
}

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
  if (!event.raw_body) {
    logger.error('GitHub webhook processor invoked without raw_body');
    return;
  }

  let payload: GitHubDeploymentStatusPayload;
  try {
    payload = JSON.parse(event.raw_body) as GitHubDeploymentStatusPayload;
  } catch (err) {
    logger.error('GitHub webhook processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const repo = payload.repository?.full_name;
  const sha = payload.deployment?.sha;
  // The URL lives on `deployment_status` (it changes per status update —
  // `pending` has no URL, `success` fills it in), not on `deployment`.
  const previewUrl = payload.deployment_status?.environment_url;
  const deploymentId = payload.deployment?.id;

  if (!repo || !sha || !previewUrl) {
    logger.warn('GitHub deployment_status payload missing required fields', {
      repo,
      sha_present: Boolean(sha),
      preview_url_present: Boolean(previewUrl),
      deployment_id: deploymentId,
    });
    return;
  }

  logger.info('Screenshot pipeline starting', {
    repo,
    sha,
    preview_url: previewUrl,
    deployment_id: deploymentId,
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

  const prNumber = await findPullRequestForSha(repo, sha, token);
  if (!prNumber) {
    logger.info('No open PR found for SHA — skipping screenshot post', { repo, sha });
    return;
  }

  let png: Uint8Array;
  try {
    png = await captureScreenshot(previewUrl);
  } catch (err) {
    logger.error('Screenshot capture failed', {
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
        deployment_id: String(deploymentId ?? ''),
      },
    }));
  } catch (err) {
    logger.error('Failed to upload screenshot to S3', {
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
      issueOrPrNumber: prNumber,
      body: commentBody,
      token,
      // Always POST fresh — a single PR can have multiple preview screenshots
      // as the user pushes new commits, and editing the prior comment in
      // place would lose the history.
      existingCommentId: undefined,
    });
    logger.info('Posted screenshot comment to PR', {
      repo,
      pr_number: prNumber,
      comment_id: result.commentId,
      public_url: publicUrl,
    });
  } catch (err) {
    logger.warn('Failed to post screenshot PR comment (non-fatal)', {
      repo,
      pr_number: prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Look up an open PR associated with `sha`. Uses the
 * "List pull requests associated with a commit" GitHub API
 * (https://docs.github.com/rest/commits/commits#list-pull-requests-associated-with-a-commit).
 *
 * Returns the first OPEN PR's number, or null if none. Closed/merged
 * PRs are filtered out — v1 only screenshots active reviews.
 */
async function findPullRequestForSha(
  repo: string,
  sha: string,
  token: string,
): Promise<number | null> {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}/pulls`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    logger.warn('GitHub commit-pulls fetch failed', {
      repo,
      sha,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!res.ok) {
    logger.warn('GitHub commit-pulls returned non-2xx', {
      repo,
      sha,
      status: res.status,
    });
    return null;
  }

  const pulls = (await res.json()) as Array<{ number?: number; state?: string }>;
  const open = pulls.find((p) => p.state === 'open' && typeof p.number === 'number');
  return open?.number ?? null;
}

/** Build the S3 key for a screenshot. */
function buildScreenshotKey(repo: string, sha: string, deploymentId: number | undefined): string {
  const repoSlug = repo.replace('/', '_');
  const id = deploymentId !== undefined ? `-${deploymentId}` : '';
  return `screenshots/${repoSlug}/${sha}${id}.png`;
}

/** Render the PR comment body. */
function renderCommentBody(publicUrl: string, previewUrl: string): string {
  return [
    '🖼️ **Preview screenshot**',
    '',
    `[![preview](${publicUrl})](${previewUrl})`,
    '',
    `_From [${previewUrl}](${previewUrl}) — captured automatically by ABCA after the deploy finished._`,
  ].join('\n');
}
