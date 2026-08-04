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

import { BedrockClient, GetFoundationModelCommand } from '@aws-sdk/client-bedrock';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { isGithubTokenConfigured } from './github-token';
import { checkLinearWorkspaceAuth, type LinearProbe, type LinearRefreshVerifier } from './linear-auth-health';
import { PLATFORM_REPO_DEFAULTS } from './repo-display';
import { countActiveRepos } from './repo-lookup';
import { getStackOutput } from './stack-outputs';

/**
 * Default foundation model checked when no onboarded repo specifies model_id.
 *
 * Derived from the platform default model so the two never drift on a model
 * bump: `PLATFORM_REPO_DEFAULTS.model_id` is the cross-region inference profile
 * (`us.anthropic.…`) used at invoke time, while `GetFoundationModel` requires
 * the bare foundation-model id, so we strip the regional inference prefix.
 */
export const DEFAULT_BEDROCK_MODEL_ID =
  PLATFORM_REPO_DEFAULTS.model_id.replace(/^(us|eu|apac)\./, '');

export type DoctorCheckStatus = 'pass' | 'fail' | 'warn';

export interface DoctorCheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorCheckStatus;
  readonly detail: string;
}

export interface RunPlatformDoctorOptions {
  readonly region: string;
  readonly stackName: string;
  /** Injectable Linear auth probe (tests supply a fake; production uses the default). */
  readonly linearProbe?: LinearProbe;
  /**
   * Opt-in resolver for the indeterminate auth state. Absent by default because
   * it rotates a real token (safely — it persists the rotation), which an
   * operator should choose rather than have a read-only-looking command do.
   */
  readonly linearVerifyRefresh?: LinearRefreshVerifier;
}

/** Smoke-check deployed platform readiness (operator AWS credentials). */
export async function runPlatformDoctor(
  options: RunPlatformDoctorOptions,
): Promise<DoctorCheckResult[]> {
  const { region, stackName } = options;
  const [
    apiUrl,
    userPoolId,
    appClientId,
    githubTokenSecretArn,
    repoTableName,
    linearRegistryTableName,
  ] = await Promise.all([
    getStackOutput(region, stackName, 'ApiUrl'),
    getStackOutput(region, stackName, 'UserPoolId'),
    getStackOutput(region, stackName, 'AppClientId'),
    getStackOutput(region, stackName, 'GitHubTokenSecretArn'),
    getStackOutput(region, stackName, 'RepoTableName'),
    getStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
  ]);

  const checks: DoctorCheckResult[] = [];

  checks.push(await checkApiReachable(apiUrl));
  checks.push(await checkCognitoConfig(region, userPoolId, appClientId));
  checks.push(await checkGithubToken(region, githubTokenSecretArn));
  checks.push(await checkActiveRepos(region, repoTableName));
  checks.push(await checkBedrockModel(region, DEFAULT_BEDROCK_MODEL_ID));
  checks.push(await checkLinearAuth(
    region, linearRegistryTableName, options.linearProbe, options.linearVerifyRefresh,
  ));

  return checks;
}

async function checkApiReachable(apiUrl: string | null): Promise<DoctorCheckResult> {
  const id = 'api_reachable';
  const label = 'Task API reachable';
  if (!apiUrl) {
    return { id, label, status: 'fail', detail: 'Stack output ApiUrl is missing.' };
  }

  const url = `${apiUrl.replace(/\/+$/, '')}/tasks`;
  try {
    const response = await fetch(url, { method: 'GET' });
    // Unauthenticated list returns 401 when the gateway + authorizer are wired.
    if (response.status === 401 || response.status === 403) {
      return { id, label, status: 'pass', detail: `API responded (${response.status}) at ${url}` };
    }
    if (response.ok) {
      return { id, label, status: 'pass', detail: `API responded (${response.status}) at ${url}` };
    }
    return {
      id,
      label,
      status: 'warn',
      detail: `Unexpected HTTP ${response.status} from ${url}`,
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'fail',
      detail: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkCognitoConfig(
  region: string,
  userPoolId: string | null,
  appClientId: string | null,
): Promise<DoctorCheckResult> {
  const id = 'cognito_config';
  const label = 'Cognito user pool + app client';
  if (!userPoolId || !appClientId) {
    return {
      id,
      label,
      status: 'fail',
      detail: 'Stack outputs UserPoolId and/or AppClientId are missing.',
    };
  }

  const cognito = new CognitoIdentityProviderClient({ region });
  try {
    await cognito.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
    await cognito.send(new DescribeUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: appClientId,
    }));
    return {
      id,
      label,
      status: 'pass',
      detail: `User pool ${userPoolId} and client ${appClientId} are valid.`,
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkGithubToken(
  region: string,
  secretArn: string | null,
): Promise<DoctorCheckResult> {
  const id = 'github_token';
  const label = 'Platform GitHub token secret populated';
  if (!secretArn) {
    return { id, label, status: 'fail', detail: 'Stack output GitHubTokenSecretArn is missing.' };
  }

  const configured = await isGithubTokenConfigured(region, secretArn);
  if (configured) {
    return { id, label, status: 'pass', detail: 'GitHubTokenSecretArn contains a token value.' };
  }
  return {
    id,
    label,
    status: 'fail',
    detail: 'GitHub token secret is empty or still the CDK placeholder. Run `bgagent github set-token`.',
  };
}

async function checkActiveRepos(
  region: string,
  repoTableName: string | null,
): Promise<DoctorCheckResult> {
  const id = 'active_repos';
  const label = 'At least one active onboarded repo';
  if (!repoTableName) {
    return { id, label, status: 'fail', detail: 'Stack output RepoTableName is missing.' };
  }

  try {
    const count = await countActiveRepos(region, repoTableName);
    if (count >= 1) {
      return { id, label, status: 'pass', detail: `${count} active repo(s) in ${repoTableName}.` };
    }
    return {
      id,
      label,
      status: 'fail',
      detail: 'No active repos in RepoTable. Register a Blueprint and redeploy.',
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkBedrockModel(region: string, modelId: string): Promise<DoctorCheckResult> {
  const id = 'bedrock_model';
  const label = `Bedrock model catalog (${modelId})`;
  const bedrock = new BedrockClient({ region });
  try {
    await bedrock.send(new GetFoundationModelCommand({ modelIdentifier: modelId }));
    return {
      id,
      label,
      status: 'pass',
      detail: `Foundation model ${modelId} is visible in ${region}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: DoctorCheckStatus = message.includes('AccessDenied') ? 'warn' : 'fail';
    return {
      id,
      label,
      status,
      detail: `${message} Enable model access in the Bedrock console if tasks fail at invoke time.`,
    };
  }
}

/**
 * Linear workspaces whose OAuth authorization has died. This is the one failure
 * mode that is otherwise INVISIBLE: the webhook processor can't resolve a token,
 * drops the event, and the user sees their label do nothing at all. A revoked
 * authorization is a total outage for that workspace, so it fails the check; an
 * expired-but-refreshable token is normal and self-healing, so it doesn't.
 */
async function checkLinearAuth(
  region: string,
  registryTableName: string | null,
  probe?: LinearProbe,
  verifyRefresh?: LinearRefreshVerifier,
): Promise<DoctorCheckResult> {
  const id = 'linear_workspace_auth';
  const label = 'Linear workspace authorizations live';
  if (!registryTableName) {
    // Linear is optional — a stack with no Linear integration is not broken.
    return { id, label, status: 'pass', detail: 'No Linear workspace registry on this stack (integration not deployed).' };
  }

  try {
    const health = await checkLinearWorkspaceAuth({
      region,
      registryTableName,
      ...(probe && { probe }),
      ...(verifyRefresh && { verifyRefresh }),
    });
    if (health.length === 0) {
      return { id, label, status: 'pass', detail: 'No Linear workspaces onboarded yet.' };
    }

    const revoked = health.filter((w) => w.state === 'revoked');
    // Indeterminate is NOT healthy. It is the exact shape of the workspace whose
    // authorization died on 2026-07-25 — expired access token, refresh token
    // present but dead — and reporting it as a pass is how that outage stayed
    // invisible for over an hour. It is a warn rather than a fail because the
    // same shape is also a perfectly healthy idle workspace, and failing every
    // quiet workspace would train operators to ignore the check.
    const indeterminate = health.filter((w) => w.state === 'expired_indeterminate');
    const unknown = health.filter((w) => w.state === 'unknown');
    const summary = health
      .map((w) => `${w.workspaceSlug}=${w.state}`)
      .join(', ');

    if (revoked.length > 0) {
      const remedies = revoked.map((w) => `  ${w.workspaceSlug}: ${w.detail}`).join('\n');
      return {
        id,
        label,
        status: 'fail',
        detail: `${revoked.length} of ${health.length} workspace(s) have a REVOKED authorization — their `
          + `Linear events are being dropped silently.\n${remedies}\n  (${summary})`,
      };
    }
    if (indeterminate.length > 0) {
      return {
        id,
        label,
        status: 'warn',
        detail: `${indeterminate.length} of ${health.length} workspace(s) could NOT be confirmed `
          + 'authorized — an expired access token looks identical whether the refresh token behind it '
          + 'is alive or revoked. Re-run `bgagent platform doctor --verify-refresh` to settle it '
          + `(that performs the refresh the platform would, and persists the rotated token).\n  (${summary})`,
      };
    }
    if (unknown.length > 0) {
      return {
        id,
        label,
        status: 'warn',
        detail: `Could not assess ${unknown.length} of ${health.length} workspace(s): ${summary}`,
      };
    }
    return { id, label, status: 'pass', detail: `${health.length} workspace(s) authorized: ${summary}` };
  } catch (err) {
    return {
      id,
      label,
      status: 'warn',
      detail: `Could not read the Linear workspace registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** True when every check passed (warnings are acceptable). */
export function doctorChecksPassed(results: readonly DoctorCheckResult[]): boolean {
  return results.every((r) => r.status === 'pass' || r.status === 'warn');
}
