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
import {
  checkLinearWorkspaceAuth,
  makeLinearVaultTokenMinter,
  type LinearProbe,
  type LinearRefreshVerifier,
} from './linear-auth-health';
import { BEDROCK_GEO_PREFIXES } from './model-id';
import { PLATFORM_REPO_DEFAULTS } from './repo-display';
import { listRepoConfigs, RepoConfigRow } from './repo-lookup';
import { getStackOutputs } from './stack-outputs';
import { makeClient } from './ua';

const GEO_PREFIX_RE = new RegExp(`^(?:${BEDROCK_GEO_PREFIXES.join('|')})\\.`);

/**
 * `GetFoundationModel` takes the bare foundation-model id, not an inference-profile id.
 */
const DEFAULT_BEDROCK_MODEL_ID =
  PLATFORM_REPO_DEFAULTS.model_id.replace(GEO_PREFIX_RE, '');

export type DoctorCheckStatus = 'pass' | 'fail' | 'warn';

type ProbeFailure = 'denied' | 'absent' | 'unverified';

function classifyProbeFailure(err: unknown): ProbeFailure {
  const text = `${err instanceof Error ? err.name : ''} ${err instanceof Error ? err.message : String(err)}`;
  if (/AccessDenied|Unauthorized|not authorized/i.test(text)) return 'denied';
  if (/ResourceNotFound|ValidationException|NoSuchResource|not found|does not exist/i.test(text)) {
    return 'absent';
  }
  return 'unverified';
}

const statusFor = (f: ProbeFailure): DoctorCheckStatus => (f === 'absent' ? 'fail' : 'warn');

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
   * Opt-in resolver for the indeterminate auth state. It rotates a real token and
   * persists the rotation.
   */
  readonly linearVerifyRefresh?: LinearRefreshVerifier;
}

/** Smoke-check deployed platform readiness (operator AWS credentials). */
export async function runPlatformDoctor(
  options: RunPlatformDoctorOptions,
): Promise<DoctorCheckResult[]> {
  const { region, stackName } = options;
  const {
    ApiUrl: apiUrl,
    UserPoolId: userPoolId,
    AppClientId: appClientId,
    GitHubTokenSecretArn: githubTokenSecretArn,
    RepoTableName: repoTableName,
    LinearWorkspaceRegistryTableName: linearRegistryTableName,
    JiraWorkspaceRegistryTableName: jiraRegistryTableName,
    BedrockGeoRegion: bedrockGeoRegion,
    BedrockModelIds: bedrockModelIds,
    LinearVaultWorkloadName: linearVaultWorkloadName,
    LinearProjectMappingTableName: linearProjectMappingTableName,
  } = await getStackOutputs(region, stackName, [
    'ApiUrl',
    'UserPoolId',
    'AppClientId',
    'GitHubTokenSecretArn',
    'RepoTableName',
    'LinearWorkspaceRegistryTableName',
    'JiraWorkspaceRegistryTableName',
    'BedrockGeoRegion',
    'BedrockModelIds',
    'LinearVaultWorkloadName',
    'LinearProjectMappingTableName',
  ]);

  const checks: DoctorCheckResult[] = [];

  checks.push(await checkApiReachable(apiUrl));
  checks.push(await checkCognitoConfig(region, userPoolId, appClientId));
  checks.push(await checkGithubToken(region, githubTokenSecretArn));
  const activeRepoResult = await loadActiveRepos(region, repoTableName);
  checks.push(checkActiveRepos(repoTableName, activeRepoResult));
  checks.push(await checkBedrockModel(region, DEFAULT_BEDROCK_MODEL_ID));
  checks.push(await checkBedrockInferenceProfile(region, DEFAULT_BEDROCK_MODEL_ID, bedrockGeoRegion));
  checks.push(await checkGrantedModelProfiles(region, bedrockModelIds, bedrockGeoRegion));
  if (activeRepoResult.repos.some((repo) => repo.compute_type === 'lambda-microvm')) {
    checks.push(await checkLambdaMicrovmAvailability(
      region,
      options.lambdaMicrovmClientFactory,
    ));
  }
  checks.push(await checkLinearAuth(
    region, linearRegistryTableName, options.linearProbe, options.linearVerifyRefresh,
    linearVaultWorkloadName,
  ));
  checks.push(await checkLinearSecretProvenance(region, linearRegistryTableName));
  checks.push(await checkLinearProjectWorkspaces(region, linearProjectMappingTableName, linearRegistryTableName));
  checks.push(await checkJiraAppIdentity(region, jiraRegistryTableName));

  return checks;
}

/**
 * Report workspaces whose signing secret is not recorded as provably their own.
 */
export async function checkLinearSecretProvenance(
  region: string,
  registryTableName: string | null,
): Promise<DoctorCheckResult> {
  const id = 'linear_secret_provenance';
  const label = 'Linear per-workspace signing secrets';
  if (!registryTableName) {
    return {
      id,
      label,
      status: 'pass',
      detail: 'No Linear workspace registry on this stack (integration not deployed).',
    };
  }

  try {
    const ddb = documentClient(region);
    const rows: Array<{ workspace_slug?: string; status?: string; webhook_secret_owned?: boolean }> = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: registryTableName,
        ProjectionExpression: ['workspace_slug', '#status', 'webhook_secret_owned'].join(', '),
        ExpressionAttributeNames: { '#status': 'status' },
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));
      rows.push(...(page.Items ?? []) as typeof rows);
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    const active = rows.filter((row) => row.status === 'active');
    if (active.length === 0) {
      return { id, label, status: 'pass', detail: 'No active Linear workspaces onboarded yet.' };
    }

    const unproven = active.filter((row) => row.webhook_secret_owned !== true);
    if (unproven.length === 0) {
      return {
        id,
        label,
        status: 'pass',
        detail: `All ${active.length} active Linear workspace(s) own their signing secret.`,
      };
    }

    const slugs = unproven.map((row) => row.workspace_slug ?? '<unknown-slug>').join(', ');
    if (active.length === 1) {
      return {
        id,
        label,
        status: 'pass',
        detail: 'Single active Linear workspace, so a shared signing secret cannot reach another '
          + 'tenant and provenance is not enforced. Onboarding a second workspace makes it matter — '
          + 'run `bgagent linear backfill-secret-provenance` then.',
      };
    }
    return {
      id,
      label,
      status: 'warn',
      detail: `${unproven.length} of ${active.length} active Linear workspace(s) are not recorded as `
        + `owning their signing secret, so their webhook deliveries are rejected: ${slugs}. Run `
        + '`bgagent linear backfill-secret-provenance --dry-run` to see which can be recorded '
        + 'automatically, then `bgagent linear update-webhook-secret <slug>` for the rest.',
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'warn',
      detail: `Could not read the Linear workspace registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function countActiveWorkspaces(
  ddb: ReturnType<typeof documentClient>,
  registryTableName: string,
): Promise<number | undefined> {
  try {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: registryTableName,
        ProjectionExpression: '#status',
        ExpressionAttributeNames: { '#status': 'status' },
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));
      count += (page.Items ?? []).filter((row) => row.status === 'active').length;
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return count;
  } catch {
    // nosemgrep: ts-silent-success-masking -- an unreadable registry yields the neutral verdict, which names the remedy without claiming the exposure is or is not live
    return undefined;
  }
}

/**
 * Report project mappings that do not record which workspace owns them.
 */
export async function checkLinearProjectWorkspaces(
  region: string,
  mappingTableName: string | null,
  registryTableName?: string | null,
): Promise<DoctorCheckResult> {
  const id = 'linear_project_workspaces';
  const label = 'Linear project → workspace binding';
  if (!mappingTableName) {
    return {
      id,
      label,
      status: 'pass',
      detail: 'No Linear project mapping table on this stack (integration not deployed).',
    };
  }

  try {
    const ddb = documentClient(region);
    const rows: Array<{ linear_project_id?: string; linear_workspace_id?: string; status?: string }> = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: mappingTableName,
        ProjectionExpression: ['linear_project_id', 'linear_workspace_id', '#status'].join(', '),
        ExpressionAttributeNames: { '#status': 'status' },
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));
      rows.push(...(page.Items ?? []) as typeof rows);
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    const active = rows.filter((row) => row.status === 'active');
    if (active.length === 0) {
      return { id, label, status: 'pass', detail: 'No active Linear project mappings yet.' };
    }

    const unbacked = active.filter((row) => !row.linear_workspace_id);
    if (unbacked.length === 0) {
      return {
        id,
        label,
        status: 'pass',
        detail: `All ${active.length} active Linear project mapping(s) record an owning workspace.`,
      };
    }

    const NAMED_LIMIT = 10;
    const allIds = unbacked.map((row) => row.linear_project_id ?? '<unknown-project-id>');
    const projectIds = allIds.length > NAMED_LIMIT
      ? `${allIds.slice(0, NAMED_LIMIT).join(', ')} (and ${allIds.length - NAMED_LIMIT} more)`
      : allIds.join(', ');
    const remedy = 're-run `bgagent linear onboard-project <uuid> --repo <owner/repo> --label <its trigger label>` for each of them';
    const unbackedSummary = `${unbacked.length} of ${active.length} active Linear project mapping(s) do not `
      + 'record an owning workspace, so a webhook naming them cannot be checked against the workspace that '
      + `signed it: ${projectIds}.`;
    const workspaces = registryTableName ? await countActiveWorkspaces(ddb, registryTableName) : undefined;
    if (workspaces !== undefined && workspaces > 1) {
      return {
        id,
        label,
        status: 'fail',
        detail: `${unbackedSummary} ${workspaces} workspaces are active, so any of them can name these `
          + `projects. Fix now: ${remedy}.`,
      };
    }
    return {
      id,
      label,
      status: 'warn',
      detail: workspaces === 1
        ? `${unbackedSummary} Harmless while only one workspace is active — there is no other tenant to `
          + `reach — but ${remedy} before onboarding a second workspace.`
        : `${unbackedSummary} This matters as soon as a second workspace is active: ${remedy}.`,
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'warn',
      detail: `Could not read the Linear project mapping table: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
        + '<cloud-id> --proxy-url <forge-v2-url> --stack-name <stack>` for each tenant.',
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
    detail: 'GitHub token secret is empty, still the CDK placeholder, or not in a GitHub token format. Run `bgagent github set-token`.',
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
    const failure = classifyProbeFailure(err);
    return {
      id,
      label,
      status: statusFor(failure),
      detail: failure === 'denied'
        ? `${message}. Cannot verify Lambda MicroVM availability in ${region}; check IAM permissions for `
          + 'lambda-microvms List* actions.'
        : failure === 'absent'
          ? `${message}. ${LAMBDA_MICROVM_REMEDY}`
          : `${message}. The check did not complete, so MicroVM availability in ${region} is unknown — `
            + 'not evidence it is unavailable. Re-run.',
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
    const failure = classifyProbeFailure(err);
    return {
      id,
      label,
      status: statusFor(failure),
      detail: failure === 'denied'
        ? `${message} That is a permissions gap on the caller, not evidence about the model — `
          + 're-run with credentials holding bedrock:GetFoundationModel to settle it.'
        : failure === 'absent'
          ? `${message} Enable model access in the Bedrock console if tasks fail at invoke time.`
          : `${message} The check did not complete, so model access is unknown — re-run before `
            + 'changing anything.',
    };
  }
}

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
  const label = `Bedrock inference profile visible (${profileId})`;
  const bedrock = makeClient(BedrockClient, { region });
  try {
    await bedrock.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: profileId }));
    return {
      id,
      label,
      status: 'pass',
      detail: `Inference profile ${profileId} resolves in ${region} for these operator `
        + 'credentials. Does not prove the workload role can invoke it — that grant is '
        + 'checked at task time.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failure = classifyProbeFailure(err);
    let detail: string;
    if (failure === 'denied') {
      detail = `${message} That is a permissions gap on the caller, not evidence the profile is `
        + `missing — the deployment grants '${geoRegion}' profiles (bedrockGeoRegion), and `
        + 'whether this one resolves is unknown until re-run with credentials holding '
        + 'bedrock:GetInferenceProfile.';
    } else if (failure === 'absent') {
      detail = `${message} The deployment grants '${geoRegion}' profiles (bedrockGeoRegion). `
        + `Either ${bareModelId} has no profile in that geography, or this account lacks its `
        + 'entitlements — tasks would fail at turn 0 with AccessDenied.';
    } else {
      detail = `${message} The check did not complete, so this says nothing about whether `
        + `${bareModelId} resolves in '${geoRegion}' — treat it as unverified, not as a `
        + 'misconfiguration, and re-run.';
    }
    return { id, label, status: statusFor(failure), detail };
  }
}

async function checkGrantedModelProfiles(
  region: string,
  bedrockModelIds: string | null,
  geoRegion: string | null,
): Promise<DoctorCheckResult> {
  const id = 'bedrock_granted_model_profiles';
  const label = 'Every granted Bedrock model has an inference profile';
  if (!bedrockModelIds || !geoRegion) {
    const missing = [
      ...(bedrockModelIds ? [] : ['BedrockModelIds']),
      ...(geoRegion ? [] : ['BedrockGeoRegion']),
    ].join(' and ');
    return {
      id,
      label,
      status: 'warn',
      detail: `Stack does not export ${missing}, so the granted inference profiles cannot be `
        + 'enumerated. Redeploy to surface what is missing; until then this check is skipped '
        + 'rather than assuming a value.',
    };
  }

  const bare = bedrockModelIds.split(',').map((s) => s.trim()).filter(Boolean);
  if (bare.length === 0) {
    return { id, label, status: 'warn', detail: 'BedrockModelIds is exported but empty.' };
  }

  const bedrock = makeClient(BedrockClient, { region });
  const missing: string[] = [];
  const denied: string[] = [];
  const unverified: string[] = [];
  for (const model of bare) {
    const profileId = `${geoRegion}.${model}`;
    try {
      await bedrock.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: profileId }));
    } catch (err) {
      const errorName = err instanceof Error ? err.name : '';
      switch (classifyProbeFailure(err)) {
        case 'denied':
          denied.push(profileId);
          break;
        case 'absent':
          missing.push(profileId);
          break;
        default:
          unverified.push(`${profileId} (${errorName || 'unknown error'})`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      id,
      label,
      status: 'fail',
      detail: `${missing.length} of ${bare.length} granted model(s) have no inference profile in `
        + `'${geoRegion}': ${missing.join(', ')}. Each is granted by IAM and passes `
        + '`repo onboard --model` and workflow admission, then fails at turn 0. Remove it from '
        + 'the bedrockModels context, or deploy a geography where it resolves.',
    };
  }
  if (denied.length > 0) {
    return {
      id,
      label,
      status: 'warn',
      detail: `${denied.length} of ${bare.length} granted model(s) could not be resolved under `
        + `these operator credentials: ${denied.join(', ')}. That is a permissions gap on the `
        + 'caller, not evidence the profile is missing — re-run with credentials holding '
        + 'bedrock:GetInferenceProfile to settle it.',
    };
  }
  if (unverified.length > 0) {
    return {
      id,
      label,
      status: 'warn',
      detail: `${unverified.length} of ${bare.length} granted model(s) could not be checked: `
        + `${unverified.join(', ')}. The call failed for a reason unrelated to the model, so this `
        + 'says nothing about whether the profile exists — do NOT remove anything from the grant '
        + 'set on the strength of it. Re-run to settle.',
    };
  }
  return {
    id,
    label,
    status: 'pass',
    detail: `All ${bare.length} granted model(s) resolve as '${geoRegion}.' inference profiles in `
      + `${region}. Visibility only: does not prove the workload role can invoke them.`,
  };
}

async function checkLinearAuth(
  region: string,
  registryTableName: string | null,
  probe?: LinearProbe,
  verifyRefresh?: LinearRefreshVerifier,
  vaultWorkloadName?: string | null,
): Promise<DoctorCheckResult> {
  const id = 'linear_workspace_auth';
  const label = 'Linear workspace authorizations live';
  if (!registryTableName) {
    return { id, label, status: 'pass', detail: 'No Linear workspace registry on this stack (integration not deployed).' };
  }

  try {
    const health = await checkLinearWorkspaceAuth({
      region,
      registryTableName,
      ...(probe && { probe }),
      ...(verifyRefresh && { verifyRefresh }),
      ...(vaultWorkloadName && {
        mintVaultToken: makeLinearVaultTokenMinter(region, vaultWorkloadName),
      }),
    });
    if (health.length === 0) {
      return { id, label, status: 'pass', detail: 'No Linear workspaces onboarded yet.' };
    }

    const revoked = health.filter((w) => w.state === 'revoked');
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
    const live = health.filter((w) => w.state !== 'disabled').length;
    const disabled = health.length - live;
    return {
      id,
      label,
      status: 'pass',
      detail: `${live} workspace(s) authorized${disabled ? `, ${disabled} disabled by design` : ''}: ${summary}`,
    };
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
