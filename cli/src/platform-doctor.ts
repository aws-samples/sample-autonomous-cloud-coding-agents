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
import {
  LAMBDA_MICROVM_REMEDY,
  LambdaMicrovmProbeClientFactory,
  probeLambdaMicrovmAvailability,
} from './lambda-microvm-availability';
import { PLATFORM_REPO_DEFAULTS } from './repo-display';
import { listRepoConfigs, RepoConfigRow } from './repo-lookup';
import { getStackOutput } from './stack-outputs';

/**
 * Default foundation model checked when no onboarded repo specifies model_id.
 *
 * Derived from the platform default model so the two never drift on a model
 * bump: `PLATFORM_REPO_DEFAULTS.model_id` is the cross-region inference profile
 * (`us.anthropic.…`) used at invoke time, while `GetFoundationModel` requires
 * the bare foundation-model id, so we strip the regional inference prefix.
 */
const DEFAULT_BEDROCK_MODEL_ID =
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
  /** Override for deterministic/offline tests. */
  readonly lambdaMicrovmClientFactory?: LambdaMicrovmProbeClientFactory;
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
  ] = await Promise.all([
    getStackOutput(region, stackName, 'ApiUrl'),
    getStackOutput(region, stackName, 'UserPoolId'),
    getStackOutput(region, stackName, 'AppClientId'),
    getStackOutput(region, stackName, 'GitHubTokenSecretArn'),
    getStackOutput(region, stackName, 'RepoTableName'),
  ]);

  const checks: DoctorCheckResult[] = [];

  checks.push(await checkApiReachable(apiUrl));
  checks.push(await checkCognitoConfig(region, userPoolId, appClientId));
  checks.push(await checkGithubToken(region, githubTokenSecretArn));
  const activeRepoResult = await loadActiveRepos(region, repoTableName);
  checks.push(checkActiveRepos(repoTableName, activeRepoResult));
  checks.push(await checkBedrockModel(region, DEFAULT_BEDROCK_MODEL_ID));
  if (activeRepoResult.repos.some((repo) => repo.compute_type === 'lambda-microvm')) {
    checks.push(await checkLambdaMicrovmAvailability(
      region,
      options.lambdaMicrovmClientFactory,
    ));
  }

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

async function loadActiveRepos(
  region: string,
  repoTableName: string | null,
): Promise<{ readonly repos: RepoConfigRow[]; readonly error?: string }> {
  if (!repoTableName) return { repos: [] };
  try {
    return {
      repos: (await listRepoConfigs(region, repoTableName))
        .filter((repo) => repo.status === 'active'),
    };
  } catch (err) {
    return { repos: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function checkActiveRepos(
  repoTableName: string | null,
  result: { readonly repos: readonly RepoConfigRow[]; readonly error?: string },
): DoctorCheckResult {
  const id = 'active_repos';
  const label = 'At least one active onboarded repo';
  if (!repoTableName) {
    return { id, label, status: 'fail', detail: 'Stack output RepoTableName is missing.' };
  }

  if (result.error) {
    return { id, label, status: 'fail', detail: result.error };
  }

  const count = result.repos.length;
  if (count >= 1) {
    return { id, label, status: 'pass', detail: `${count} active repo(s) in ${repoTableName}.` };
  }
  return {
    id,
    label,
    status: 'fail',
    detail: 'No active repos in RepoTable. Register a Blueprint and redeploy.',
  };
}

async function checkLambdaMicrovmAvailability(
  region: string,
  clientFactory?: LambdaMicrovmProbeClientFactory,
): Promise<DoctorCheckResult> {
  const id = 'lambda_microvm_availability';
  const label = `Lambda MicroVMs service (${region})`;
  try {
    await probeLambdaMicrovmAvailability(region, clientFactory);
    return {
      id,
      label,
      status: 'pass',
      detail: `Managed MicroVM images are available in ${region}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : '';
    const accessDenied = /AccessDenied|Unauthorized|not authorized/i.test(`${errorName} ${message}`);
    return {
      id,
      label,
      status: accessDenied ? 'warn' : 'fail',
      detail: accessDenied
        ? `${message}. Cannot verify Lambda MicroVM availability in ${region}; check IAM permissions for `
          + 'lambda-microvms List* actions.'
        : `${message}. ${LAMBDA_MICROVM_REMEDY}`,
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

/** True when every check passed (warnings are acceptable). */
export function doctorChecksPassed(results: readonly DoctorCheckResult[]): boolean {
  return results.every((r) => r.status === 'pass' || r.status === 'warn');
}
