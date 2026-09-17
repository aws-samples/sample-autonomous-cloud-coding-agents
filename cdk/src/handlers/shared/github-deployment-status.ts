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

import { isValidRepo } from './validation';

/**
 * Subset of GitHub's `deployment_status` webhook payload that the
 * screenshot pipeline reads. Shared between the receiver (HMAC verify,
 * filter, dedup) and the processor (capture + post). Single source of
 * truth so the two sides can't drift on field shape — and so the
 * receiver-side filter and the processor-side reads agree on what's
 * required.
 *
 * The interesting fields:
 *  - `deployment_status.state`: `success` | `failure` | `error` |
 *    `pending` | `in_progress`
 *  - `deployment_status.environment_url`: the deployed URL — lives on
 *    the *status* object, not the deployment. (The deployment object
 *    only has the immutable SHA + environment name; URL changes per
 *    status update — first `pending` has no URL, then `success` fills
 *    it in.)
 *  - `deployment.environment`: provider-defined string (Vercel uses
 *    `Preview`/`Production`, Amplify uses the branch name, GitHub
 *    Actions uses whatever the workflow passes). Filtered against
 *    `SCREENSHOT_TARGET_ENVIRONMENT` env var.
 *  - `deployment.sha`: the commit SHA the deploy is for (used to map
 *    back to a PR via the GitHub commit-pulls API)
 */
export interface GitHubDeploymentStatusPayload {
  readonly action?: string;
  readonly deployment_status?: {
    readonly id?: number;
    readonly state?: string;
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

export type AmplifyPreviewRejectionReason =
  | 'invalid_payload'
  | 'action_not_completed'
  | 'check_not_completed'
  | 'check_not_successful'
  | 'unexpected_check_name'
  | 'unexpected_app_owner'
  | 'unexpected_app_slug'
  | 'invalid_check_id'
  | 'invalid_head_sha'
  | 'invalid_details_url'
  | 'untrusted_preview_url'
  | 'invalid_preview_pr_number'
  | 'invalid_pull_requests'
  | 'preview_pr_not_found'
  | 'head_sha_mismatch'
  | 'invalid_repository';

export type AmplifyPreviewCheckResult =
  | { readonly ok: true; readonly payload: GitHubDeploymentStatusPayload; readonly prNumber: number }
  | { readonly ok: false; readonly reason: AmplifyPreviewRejectionReason };

/**
 * Normalize a signed Amplify PR preview check for capture. Rejections carry
 * static reason codes so the receiver can diagnose skips without logging input.
 * Keep the validated PR identity separate from the deployment-shaped payload.
 */
export function normalizeAmplifyPreviewCheck(value: unknown): AmplifyPreviewCheckResult {
  const record = (input: unknown): Record<string, unknown> =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
  const reject = (reason: AmplifyPreviewRejectionReason): AmplifyPreviewCheckResult => ({ ok: false, reason });
  const raw = record(value);
  const check = record(raw.check_run);
  const app = record(check.app);
  if (Object.keys(check).length === 0) return reject('invalid_payload');
  if (raw.action !== 'completed') return reject('action_not_completed');
  if (check.status !== 'completed') return reject('check_not_completed');
  if (check.conclusion !== 'success') return reject('check_not_successful');
  if (check.name !== 'AWS Amplify Console Web Preview') return reject('unexpected_check_name');
  if (record(app.owner).login !== 'aws-amplify-console') return reject('unexpected_app_owner');
  if (typeof app.slug !== 'string' || !/^aws-amplify-[a-z0-9-]+$/.test(app.slug)) return reject('unexpected_app_slug');
  if (typeof check.id !== 'number' || !Number.isSafeInteger(check.id) || check.id <= 0) return reject('invalid_check_id');
  if (typeof check.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(check.head_sha)) return reject('invalid_head_sha');
  if (typeof check.details_url !== 'string') return reject('invalid_details_url');
  let url: URL;
  try {
    url = new URL(check.details_url);
  } catch {
    return reject('invalid_details_url');
  }
  const preview = /^pr-([1-9]\d*)\.[a-z0-9]+\.amplifyapp\.com$/.exec(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !preview) {
    return reject('untrusted_preview_url');
  }
  const prNumber = Number(preview[1]);
  if (!Number.isSafeInteger(prNumber)) return reject('invalid_preview_pr_number');
  if (!Array.isArray(check.pull_requests)) return reject('invalid_pull_requests');
  const previewPrs = check.pull_requests.filter((pr: unknown) => record(pr).number === prNumber);
  if (previewPrs.length === 0) return reject('preview_pr_not_found');
  if (!previewPrs.some((pr: unknown) => record(record(pr).head).sha === check.head_sha)) {
    return reject('head_sha_mismatch');
  }
  const repository = record(raw.repository);
  if (typeof repository.full_name !== 'string' || !isValidRepo(repository.full_name)) return reject('invalid_repository');
  return {
    ok: true,
    prNumber,
    payload: {
      repository: { full_name: repository.full_name },
      deployment: { id: check.id, sha: check.head_sha, environment: 'Preview' },
      deployment_status: { id: check.id, state: 'success', environment_url: check.details_url },
    },
  };
}

/**
 * Validated `deployment_status` payload — every field the processor
 * requires to do useful work is present and non-empty. Returned by
 * `validateDeploymentStatusPayload` so callers can stop carrying
 * `?` everywhere downstream.
 */
export interface ValidatedDeploymentStatusPayload {
  readonly state: string;
  readonly statusId: number;
  readonly environmentUrl: string;
  readonly deploymentId: number;
  readonly sha: string;
  readonly environment: string;
  readonly repoFullName: string;
}

/**
 * Narrow a raw deployment_status envelope into a fully-validated shape.
 * Returns null when any required field is missing, so the receiver and
 * processor share one validation contract instead of duplicating
 * presence checks. Callers that 200-skip on missing fields stay
 * responsible for their own logging / response.
 */
export function validateDeploymentStatusPayload(
  raw: GitHubDeploymentStatusPayload,
): ValidatedDeploymentStatusPayload | null {
  const state = raw.deployment_status?.state;
  const statusId = raw.deployment_status?.id;
  const environmentUrl = raw.deployment_status?.environment_url;
  const deploymentId = raw.deployment?.id;
  const sha = raw.deployment?.sha;
  const environment = raw.deployment?.environment;
  const repoFullName = raw.repository?.full_name;

  if (
    typeof state !== 'string' || state.length === 0
    || typeof statusId !== 'number'
    || typeof environmentUrl !== 'string' || environmentUrl.length === 0
    || typeof deploymentId !== 'number'
    || typeof sha !== 'string' || sha.length === 0
    || typeof environment !== 'string' || environment.length === 0
    || typeof repoFullName !== 'string' || repoFullName.length === 0
  ) {
    return null;
  }

  // Shape checks beyond presence: repoFullName and sha are interpolated
  // into the GitHub API URL and the S3 object key downstream. The payload
  // is HMAC-verified so this is defense-in-depth, not an exploit fix —
  // but a malformed value should fail closed here rather than produce a
  // bad URL or object key. (`isValidRepo` enforces `owner/repo`; GitHub
  // sends full 40-char hex SHAs, accept abbreviated ones defensively.)
  if (!isValidRepo(repoFullName) || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }

  return { state, statusId, environmentUrl, deploymentId, sha, environment, repoFullName };
}
