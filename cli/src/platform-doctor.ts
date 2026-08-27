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

import { BedrockClient, GetFoundationModelCommand, GetInferenceProfileCommand } from '@aws-sdk/client-bedrock';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient } from './dynamo-clients';
import { isGithubTokenConfigured } from './github-token';
import {
  LAMBDA_MICROVM_REMEDY,
  LambdaMicrovmProbeClientFactory,
  probeLambdaMicrovmAvailability,
} from './lambda-microvm-availability';
import { checkLinearWorkspaceAuth, type LinearProbe, type LinearRefreshVerifier } from './linear-auth-health';
import { PLATFORM_REPO_DEFAULTS } from './repo-display';
import { listRepoConfigs, RepoConfigRow } from './repo-lookup';
import { getStackOutput } from './stack-outputs';
import { makeClient } from './ua';

/**
 * Every cross-Region inference-profile geography, mirroring
 * `CrossRegionInferenceProfileRegion` in `@aws-cdk/aws-bedrock-alpha` (the CLI is
 * a separate package and does not depend on CDK — see `PLATFORM_REPO_DEFAULTS`
 * for the same mirroring).
 *
 * Must list them ALL. An earlier version matched only `us|eu|apac`, so when the
 * platform default moved to a `global.` profile the strip below silently did
 * nothing and `GetFoundationModel` was handed a profile id it cannot resolve —
 * turning the one Bedrock check `doctor` performs into a false failure.
 */
const BEDROCK_GEO_PREFIXES = ['global', 'us-gov', 'us', 'eu', 'apac', 'jp', 'au'] as const;

/** Strips a leading `<geo>.` inference-profile prefix, if present. */
const GEO_PREFIX_RE = new RegExp(`^(?:${BEDROCK_GEO_PREFIXES.join('|')})\\.`);

/**
 * Default foundation model checked when no onboarded repo specifies model_id.
 *
 * Derived from the platform default model so the two never drift on a model
 * bump: `PLATFORM_REPO_DEFAULTS.model_id` is the cross-Region inference profile
 * used at invoke time, while `GetFoundationModel` requires the bare
 * foundation-model id, so the geo prefix is stripped.
 */
const DEFAULT_BEDROCK_MODEL_ID =
  PLATFORM_REPO_DEFAULTS.model_id.replace(GEO_PREFIX_RE, '');

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
    jiraRegistryTableName,
    bedrockGeoRegion,
  ] = await Promise.all([
    getStackOutput(region, stackName, 'ApiUrl'),
    getStackOutput(region, stackName, 'UserPoolId'),
    getStackOutput(region, stackName, 'AppClientId'),
    getStackOutput(region, stackName, 'GitHubTokenSecretArn'),
    getStackOutput(region, stackName, 'RepoTableName'),
    getStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
    getStackOutput(region, stackName, 'JiraWorkspaceRegistryTableName'),
    getStackOutput(region, stackName, 'BedrockGeoRegion'),
  ]);

  const checks: DoctorCheckResult[] = [];

  checks.push(await checkApiReachable(apiUrl));
  checks.push(await checkCognitoConfig(region, userPoolId, appClientId));
  checks.push(await checkGithubToken(region, githubTokenSecretArn));
  const activeRepoResult = await loadActiveRepos(region, repoTableName);
  checks.push(checkActiveRepos(repoTableName, activeRepoResult));
  checks.push(await checkBedrockModel(region, DEFAULT_BEDROCK_MODEL_ID));
  checks.push(await checkBedrockInferenceProfile(region, DEFAULT_BEDROCK_MODEL_ID, bedrockGeoRegion));
  if (activeRepoResult.repos.some((repo) => repo.compute_type === 'lambda-microvm')) {
    checks.push(await checkLambdaMicrovmAvailability(
      region,
      options.lambdaMicrovmClientFactory,
    ));
  }
  checks.push(await checkLinearAuth(
    region, linearRegistryTableName, options.linearProbe, options.linearVerifyRefresh,
  ));
  checks.push(await checkJiraAppIdentity(region, jiraRegistryTableName));

  return checks;
}

interface JiraRegistryIdentityRow {
  readonly jira_cloud_id?: string;
  readonly status?: string;
  readonly outbound_identity?: string;
  readonly app_actor_account_id?: string;
  readonly app_actor_display_name?: string;
  readonly app_actor_configured_at?: string;
}

/** Warn when Jira writes would still be attributed to the OAuth setup user. */
export async function checkJiraAppIdentity(
  region: string,
  registryTableName: string | null,
): Promise<DoctorCheckResult> {
  const id = 'jira_app_identity';
  const label = 'Jira outbound app identity';
  if (!registryTableName) {
    return {
      id,
      label,
      status: 'pass',
      detail: 'No Jira workspace registry on this stack (integration not deployed).',
    };
  }

  try {
    const ddb = documentClient(region);
    const rows: JiraRegistryIdentityRow[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: registryTableName,
        ProjectionExpression: [
          'jira_cloud_id',
          '#status',
          'outbound_identity',
          'app_actor_account_id',
          'app_actor_display_name',
          'app_actor_configured_at',
        ].join(', '),
        ExpressionAttributeNames: { '#status': 'status' },
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));
      rows.push(...(page.Items ?? []) as JiraRegistryIdentityRow[]);
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    const active = rows.filter((row) => row.status === 'active');
    if (active.length === 0) {
      return { id, label, status: 'pass', detail: 'No active Jira tenants onboarded yet.' };
    }

    const incomplete = active.filter((row) =>
      row.outbound_identity !== 'app'
      || !row.app_actor_account_id
      || !row.app_actor_display_name
      || !row.app_actor_configured_at,
    );
    if (incomplete.length === 0) {
      return {
        id,
        label,
        status: 'pass',
        detail: `${active.length} active Jira tenant(s) use the dedicated app identity.`,
      };
    }

    const tenantIds = incomplete
      .map((row) => row.jira_cloud_id ?? '<unknown-cloud-id>')
      .join(', ');
    return {
      id,
      label,
      status: 'warn',
      detail: `${incomplete.length} of ${active.length} active Jira tenant(s) will write as the OAuth `
        + `setup user or have incomplete Forge metadata: ${tenantIds}. Run \`bgagent jira app-setup `
        + '<cloud-id> --proxy-url <forge-v2-url> --stack-name <stack>\` for each tenant.',
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'warn',
      detail: `Could not read the Jira workspace registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

  const cognito = makeClient(CognitoIdentityProviderClient, { region });
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
  const bedrock = makeClient(BedrockClient, { region });
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
 * Check the cross-Region inference profile the deployment will actually invoke.
 *
 * Distinct from the catalog check above, and the reason both exist: the catalog
 * answers "is this model published in this Region", while the agent invokes a
 * `<geo>.<modelId>` PROFILE and the IAM grant is scoped to profile ARNs. A stack
 * configured for a geography whose profile does not exist — or whose entitlements
 * the account lacks — passes the catalog check and then fails every task at turn 0
 * with AccessDenied, which is exactly what doctor is supposed to pre-empt.
 *
 * Keeping the two separate also keeps the remedies distinct: a missing catalog
 * entry means the model is unavailable here at all, while a missing profile means
 * the geography is wrong for this model or Region.
 *
 * `geoRegion` is null when the stack predates the `BedrockGeoRegion` output. That
 * is reported rather than defaulted: guessing `us` and passing would state a
 * verification that never happened.
 */
async function checkBedrockInferenceProfile(
  region: string,
  bareModelId: string,
  geoRegion: string | null,
): Promise<DoctorCheckResult> {
  const id = 'bedrock_inference_profile';
  if (!geoRegion) {
    return {
      id,
      label: 'Bedrock inference profile',
      status: 'warn',
      detail: 'Stack does not export BedrockGeoRegion, so the inference profile the '
        + 'agent invokes cannot be determined. Redeploy to surface it; until then this '
        + 'check is skipped rather than assuming a geography.',
    };
  }

  const profileId = `${geoRegion}.${bareModelId}`;
  const label = `Bedrock inference profile (${profileId})`;
  const bedrock = makeClient(BedrockClient, { region });
  try {
    await bedrock.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: profileId }));
    return {
      id,
      label,
      status: 'pass',
      // Deliberately not claiming invocability: resolving a profile proves it
      // exists and is reachable, not that a task can call it. Only InvokeModel
      // proves that, and doctor does not spend a token to find out.
      detail: `Inference profile ${profileId} resolves in ${region}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: DoctorCheckStatus = message.includes('AccessDenied') ? 'warn' : 'fail';
    return {
      id,
      label,
      status,
      detail: `${message} The deployment grants '${geoRegion}' profiles (bedrockGeoRegion). `
        + `Either ${bareModelId} has no profile in that geography, or this account lacks its `
        + 'entitlements — tasks would fail at turn 0 with AccessDenied.',
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
