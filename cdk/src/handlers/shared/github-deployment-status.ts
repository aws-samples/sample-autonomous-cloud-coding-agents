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

  return { state, statusId, environmentUrl, deploymentId, sha, environment, repoFullName };
}
