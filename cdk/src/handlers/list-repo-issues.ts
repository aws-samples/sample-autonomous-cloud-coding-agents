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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { resolveGitHubToken } from './shared/context-hydration';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { loadRepoConfig } from './shared/repo-config';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { ListRepoIssuesResponse, RepoIssueSummary } from './shared/types';
import { isValidRepo } from './shared/validation';

/** Enough for a picker; the console searches within the page. */
const PAGE_SIZE = 50;
const GITHUB_TIMEOUT_MS = 8_000;

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly labels?: ReadonlyArray<string | { readonly name?: string }>;
  /** Present when the "issue" is a pull request; GitHub lists both on this endpoint. */
  readonly pull_request?: unknown;
}

function toSummary(issue: GitHubIssue): RepoIssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    updated_at: issue.updated_at,
    labels: (issue.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
      .filter((name) => name !== ''),
  };
}

/**
 * GET /v1/repos/{repo_id}/issues: open issues of an onboarded repository, for the
 * console's issue picker.
 *
 * Calls GitHub server-side with the repository's token (its Blueprint override, else
 * the platform token), so the token never reaches a browser. Only onboarded
 * repositories are served: this is not a general GitHub proxy. Returns titles and
 * metadata only, never issue bodies.
 *
 * Errors:
 *  - 400 VALIDATION_ERROR: repo_id is not `owner/repo`
 *  - 422 REPO_NOT_ONBOARDED: no Blueprint for the repository
 *  - 503 SERVICE_UNAVAILABLE: GitHub refused or did not answer (message says which)
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  try {
    if (!extractUserId(event)) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }
    const repo = decodeURIComponent(event.pathParameters?.repo_id ?? '');
    if (!isValidRepo(repo)) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'repo_id must be in owner/repo format.', requestId);
    }
    // Fail closed: without the repo table the onboarding gate would allow any repository.
    if (!process.env.REPO_TABLE_NAME || !process.env.GITHUB_TOKEN_SECRET_ARN) {
      logger.error('list-repo-issues is missing REPO_TABLE_NAME or GITHUB_TOKEN_SECRET_ARN', { request_id: requestId });
      return errorResponse(503, ErrorCode.SERVICE_UNAVAILABLE, 'Issue listing is not configured on this deployment.', requestId);
    }
    const config = await loadRepoConfig(repo);
    if (!config) {
      return errorResponse(422, ErrorCode.REPO_NOT_ONBOARDED, `Repository '${repo}' is not onboarded.`, requestId);
    }

    const token = await resolveGitHubToken(config.github_token_secret_arn ?? process.env.GITHUB_TOKEN_SECRET_ARN);
    const url = `https://api.github.com/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn('GitHub issue list did not answer', { repo, request_id: requestId, error: String(err) });
      return errorResponse(503, ErrorCode.SERVICE_UNAVAILABLE, 'GitHub did not answer. Try again in a moment.', requestId);
    }
    if (!res.ok) {
      logger.warn('GitHub issue list refused', { repo, status: res.status, request_id: requestId });
      const hint = res.status === 401 || res.status === 403 || res.status === 404
        ? 'GitHub refused the request. Check that the stored GitHub token can read issues on this repository.'
        : `GitHub returned HTTP ${res.status}. Try again in a moment.`;
      return errorResponse(503, ErrorCode.SERVICE_UNAVAILABLE, hint, requestId);
    }
    const issues = (await res.json()) as GitHubIssue[];
    const body: ListRepoIssuesResponse = {
      repo,
      issues: issues.filter((i) => i.pull_request === undefined).map(toSummary),
    };
    return successResponse(200, body, requestId);
  } catch (err) {
    logger.error('list-repo-issues failed', { request_id: requestId, error: err instanceof Error ? err.message : String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Could not list issues.', requestId);
  }
}
