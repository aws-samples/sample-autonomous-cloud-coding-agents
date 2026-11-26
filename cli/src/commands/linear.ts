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

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { cognitoSubFromSession } from '../auth';
import { loadConfig } from '../config';
import { CliError } from '../errors';
import { requireDeployedFeature } from '../feature-guard';
import { formatJson } from '../format';
import { generateInviteCode } from '../invite-code';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  generatePkce,
  LINEAR_OAUTH_SECRET_PREFIX,
  linearOauthSecretName,
  type LinearTokenResponse,
  readExistingOauthTokens,
  resolveStoredGrantFields,
  readExistingWebhookSecret,
  StoredLinearOauthToken,
} from '../linear-oauth';
import {
  clearPendingConsent,
  savePendingConsent,
  takePendingConsent,
} from '../linear-pending-consent';
import {
  beginVaultConsent,
  finalizeVaultConsent,
  isVaultUnavailableError,
  linearVaultUserId,
  linearVaultUserIdForSlug,
  mintLinearTokenFromVault,
  probeLinearVaultCallbackUrl,
  upsertLinearCredentialProvider,
} from '../linear-vault';
import { awaitOauthCallback, CALLBACK_URL, openBrowser, randomState } from '../oauth-callback-server';
import { promptLine, promptSecret } from '../prompt-secret';
import { findStackOutput } from '../stack-outputs';
import type { CliConfig } from '../types';
import { makeClient, makeDocClient } from '../ua';

const DEFAULT_LABEL_FILTER = 'bgagent';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BANNER_WIDTH = 72;

const LINEAR_VAULT_WORKLOAD_NAME_FALLBACK = 'abca_linear_oauth';

async function resolveLinearVaultWorkloadName(region: string, stackName: string): Promise<string> {
  const fromStack = await findStackOutput(region, stackName, 'LinearVaultWorkloadName');
  return fromStack?.trim() || LINEAR_VAULT_WORKLOAD_NAME_FALLBACK;
}

/**
 * Split what the operator pasted from the consent page into a code and a state.
 *
 * The page returns `code=…&state=…`. A bare code is still accepted; callers must
 * then say that the state check could not run rather than implying it passed.
 */
export function parsePastedAuthorization(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  if (!trimmed.includes('code=')) return { code: trimmed };
  const parsed = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
  const code = (parsed.get('code') ?? '').trim();
  const state = parsed.get('state')?.trim();
  return state ? { code, state } : { code };
}

const DEFAULT_APP_NAME = 'bgagent';

const COMMENT_TRIGGER_TOKEN = '@bgagent';

const ANNOTATION_COLUMN = 22;

function annotate(value: string, note: string): string {
  return `${value.padEnd(ANNOTATION_COLUMN)} ← ${note}`;
}

export interface LinearAppTemplateOptions {
  /**
   * What the agent is CALLED in Linear. Linear derives the app's display name
   * from this, so it is the name that appears on the consent screen and as the
   * author of every comment the agent posts.
   *
   * It does NOT change what people type to summon the agent: the comment trigger
   * is a fixed `@bgagent` token, independent of this name.
   */
  readonly appName?: string;
  readonly developerName?: string;
  readonly developerUrl?: string;
  readonly description?: string;
  /**
   * AgentCore provider callback URL (`…/identities/oauth2/callback/<uuid>`), for
   * rendering a COMPLETE template once the credential provider exists. Omitted on
   * a first run — the id is minted at provider-create time — in which case the
   * template explains where to get it.
   */
  readonly vaultCallbackUrl?: string;
  /**
   * The stack's hosted consent page (`LinearVaultConsentUrl`). Its presence means the
   * Identity vault is deployed. It is Linear's `redirect_uri` ONLY when `setup` falls
   * back to Secrets Manager on a vault stack, so it is printed as a conditional entry,
   * never as the field's value.
   */
  readonly hostedConsentUrl?: string;
  /**
   * Set when a stack or vault lookup FAILED (credentials, region, permissions), as
   * opposed to finding nothing.
   */
  readonly lookupWarning?: string;
  /** ABCA's Linear webhook endpoint, derived from the configured API URL. */
  readonly webhookUrl?: string;
}

const WEBHOOK_URL_HINT = '(run `bgagent linear webhook-info`)';

function linearWebhookUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/linear/webhook`;
}

/**
 * Best-effort discovery of every URL the Linear app form needs.
 *
 * Never throws and never prompts: an unconfigured CLI, absent credentials, an
 * undeployed stack, or a not-yet-created credential provider all resolve to
 * `undefined`.
 */
export async function resolveTemplateCallbackUrls(args: {
  region?: string;
  stackName?: string;
  slug?: string;
}): Promise<{
  hostedConsentUrl?: string;
  vaultCallbackUrl?: string;
  lookupWarning?: string;
  webhookUrl?: string;
}> {
  let config: CliConfig | undefined;
  try {
    config = loadConfig();
  } catch {
    config = undefined;
  }
  const webhookUrl = config?.api_url ? linearWebhookUrl(config.api_url) : undefined;

  const region = args.region ?? config?.region;
  if (!region) return { webhookUrl };

  const failures: string[] = [];
  const hostedConsentUrl = args.stackName
    ? await findStackOutput(region, args.stackName, 'LinearVaultConsentUrl').catch((err: unknown) => {
      failures.push(`stack ${args.stackName} in ${region} (${(err as Error)?.name ?? 'Error'})`);
      return null;
    })
    : null;
  const probe = args.slug ? await probeLinearVaultCallbackUrl({ region, workspaceSlug: args.slug }) : null;
  if (probe?.kind === 'unreadable') failures.push(`vault provider for '${args.slug}' (${probe.errorName})`);

  return {
    hostedConsentUrl: hostedConsentUrl ?? undefined,
    vaultCallbackUrl: probe?.kind === 'found' ? probe.callbackUrl : undefined,
    lookupWarning: failures.length ? `Could not read ${failures.join('; ')}.` : undefined,
    webhookUrl,
  };
}

/**
 * The `redirect_uri` the Secrets-Manager leg of `setup` sends to Linear: on a vault
 * stack whose `setup` fell back to Secrets Manager this is the hosted consent page.
 */
export function chooseSetupRedirect(args: {
  readonly vaultAccessToken?: string | null;
  readonly consentPageUrl?: string | null;
}): { readonly hostedUrl?: string; readonly redirectUri: string } {
  const hostedUrl = args.vaultAccessToken ? undefined : (args.consentPageUrl ?? undefined);
  return { hostedUrl, redirectUri: hostedUrl ?? CALLBACK_URL };
}

export function renderLinearAppTemplate(opts: LinearAppTemplateOptions = {}): string {
  const appName = opts.appName?.trim() || DEFAULT_APP_NAME;
  const developerName = opts.developerName ?? 'ABCA';
  const developerUrl = opts.developerUrl ?? 'https://github.com/aws-samples/sample-autonomous-cloud-coding-agents';
  const description = opts.description ?? 'Autonomous Background Coding Agent';
  const callbackUrl = CALLBACK_URL;

  const bar = '═'.repeat(BANNER_WIDTH);
  return [
    bar,
    'Linear OAuth app template',
    bar,
    '',
    'Open https://linear.app/settings/api/applications/new and paste:',
    '',
    `  Application name:    ${annotate(appName, 'your agent\'s name in Linear')}`,
    `  Developer name:      ${developerName}`,
    `  Developer URL:       ${developerUrl}`,
    `  Description:         ${description}`,
    '',
    ...(opts.lookupWarning
      ? [
        `  ⚠ ${opts.lookupWarning}`,
        '    The Redirect URIs below may be wrong — check credentials and --region.',
        '',
      ]
      : []),
    '  Redirect URIs (one per line, copied EXACTLY — paste, do not retype):',
    ...(opts.vaultCallbackUrl
      ? [`    ${opts.vaultCallbackUrl}`]
      : opts.hostedConsentUrl
        ? [
          // Linear's create-app form accepts an empty Redirect URIs field.
          '    Leave empty — `bgagent linear setup <slug>` prints the URI to add, then stops.',
        ]
        : [
          `    ${callbackUrl}`,
          '    (loopback — needs the browser on this machine; deploy with',
          '    `--context enableLinearIdentityVault=true` for a hosted consent page)',
        ]),
    '',
    '  Public:              OFF',
    '  Client credentials:  OFF',
    '  Webhooks:            ON      ← this IS ABCA\'s webhook; no second one needed',
    `    Webhook URL:       ${opts.webhookUrl ?? WEBHOOK_URL_HINT}`,
    '    Data change events:  Issues + Comments   ← both, see below',
    '    App events:          all OFF             ← see below (one opt-in exception)',
    '    Copy the "Webhook signing secret" (lin_wh_…) — setup asks for it.',
    '',
    'Click Create, then come back with the Client ID, Client Secret and that',
    'signing secret:  bgagent linear setup <slug>',
    '',
    ...(opts.hostedConsentUrl
      ? [
        `Identity vault consent page: ${opts.hostedConsentUrl}`,
        '  Add it as a Redirect URI only if setup falls back to Secrets Manager —',
        '  setup says so when it does.',
        '',
      ]
      : []),
    'Traps worth knowing:',
    '  • Redirect URIs match EXACTLY — a missing trailing slash, a line-wrapped URI',
    '    (two malformed entries), or a wildcard all give "Invalid redirect_uri',
    '    parameter for the application". The error names the URI, not the mismatch.',
    '  • Tick Comments as well as Issues, or the trigger silently never fires:',
    `    Issues alone gives label-triggered tasks, and \`${COMMENT_TRIGGER_TOKEN}\` arrives as a Comment.`,
    '  • ONE webhook. The app\'s webhook above is the whole story — do not also add a',
    '    workspace webhook pointing here, or every event arrives twice under two',
    '    signing secrets, and only one of them can verify.',
    '  • Leave App events (agent session / inbox / permissions) OFF, or Linear turns',
    '    @mentions into an interactive agent surface instead of a comment thread,',
    '    which breaks the reply/reaction UX ABCA depends on. Exception: a stack',
    '    deployed with `--context enableLinearAgentSessions=true` answers natively —',
    '    tick only "Agent session events" there (see the Linear setup guide).',
    `  • The app name is not the trigger: that is always \`${COMMENT_TRIGGER_TOKEN} <request>\`, however`,
    '    you name the app (Linear lowercases the name for the display handle).',
    '  • actor=app cannot also request the `admin` scope — Linear rejects the pair.',
    ...(opts.hostedConsentUrl
      ? [`  • Using \`add-workspace\` instead of \`setup\`? It redirects to ${callbackUrl}.`]
      : []),
    bar,
  ].join('\n');
}

const SLUG_RE = /^[a-zA-Z0-9_-]{4,50}$/;

function assertWorkspaceSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new CliError(
      `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
      + 'This is the Linear urlKey, e.g. \'acme\' from linear.app/acme/...',
    );
  }
}

function assertSlugFreeFor(
  slug: string,
  organization: LinearOrganization,
  priorRow: Record<string, unknown> | undefined,
): void {
  if (priorRow?.linear_workspace_id === organization.id) {
    return;
  }
  if (organization.urlKey && organization.urlKey !== slug) {
    if (priorRow || SLUG_RE.test(organization.urlKey)) {
      throw new CliError(
        `Slug '${slug}' does not match Linear's urlKey '${organization.urlKey}' for the authorized `
        + 'workspace, so nothing was written to Secrets Manager or the registry. Re-run with the correct '
        + `slug, or authorize workspace '${slug}' instead of '${organization.urlKey}'. If `
        + `'${organization.urlKey}' is onboarded on this stack, check it with \`bgagent platform `
        + 'doctor`: the authorization just given can replace the grant it had.',
      );
    }
    return;
  }
  if (priorRow && priorRow.revoked_reason !== 'admin_removed') {
    throw new CliError(
      `Slug '${slug}' is registered to another Linear workspace (${String(priorRow.linear_workspace_id)}), `
      + 'whose token the one just issued would have replaced, so nothing was written to Secrets Manager '
      + 'or the registry. If that workspace is still used, set it up again under its own urlKey; if not, '
      + `remove it with \`bgagent linear remove-workspace ${slug}\`. Then re-run this command. If the `
      + 'workspace just authorized is onboarded on this stack, check it with `bgagent platform doctor`: '
      + 'the authorization just given can replace the grant it had.',
    );
  }
}

/**
 * The real Linear signing secret that the stack-wide LinearWebhookSecret
 * holds, or undefined while it holds CDK's autogenerated placeholder or
 * does not exist.
 *
 * Linear's webhook signing secrets start with `lin_wh_`.
 */
export async function readStackWideWebhookSecret(
  client: SecretsManagerClient,
  secretArn: string,
): Promise<string | undefined> {
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    return typeof value === 'string' && value.startsWith('lin_wh_') ? value.trim() : undefined;
  } catch (err) {
    const errorName = (err as { name?: string }).name;
    if (errorName === 'ResourceNotFoundException') {
      return undefined;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Failed to read Linear webhook secret '${secretArn}': ${errorName ?? 'Error'}: ${message}. `
      + 'Likely IAM permission gap — confirm your CLI principal has '
      + '`secretsmanager:GetSecretValue` on this ARN.',
    );
  }
}

/**
 * Idempotent secret upsert: tries CreateSecret first; if the secret
 * already exists (re-running setup, rotating refresh token), falls
 * back to PutSecretValue. Returns the secret ARN regardless of which
 * branch ran.
 */
export async function upsertOauthSecret(
  client: SecretsManagerClient,
  secretName: string,
  payload: StoredLinearOauthToken,
  workspaceSlug: string,
): Promise<string> {
  const secretString = JSON.stringify(payload);
  try {
    const create = await client.send(new CreateSecretCommand({
      Name: secretName,
      Description: `Linear OAuth token for workspace '${workspaceSlug}' (Phase 2.0b)`,
      SecretString: secretString,
      Tags: [
        { Key: 'bgagent:integration', Value: 'linear' },
        { Key: 'bgagent:linear:workspace_slug', Value: workspaceSlug },
      ],
    }));
    if (!create.ARN) {
      throw new CliError(`CreateSecret returned no ARN for '${secretName}'.`);
    }
    return create.ARN;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      const put = await client.send(new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretString,
      }));
      if (!put.ARN) {
        throw new CliError(`PutSecretValue returned no ARN for '${secretName}'.`);
      }
      return put.ARN;
    }
    throw err;
  }
}

/**
 * Find an OAuth credential pair (client_id + client_secret) reusable for a
 * new workspace install. Returns the values from the FIRST `active` row in
 * the workspace registry, by reading that row's per-workspace SM secret.
 *
 * Returns null when there's no existing active workspace, signalling that
 * the operator should run `bgagent linear setup` first.
 */
export async function findReusableOauthAppCredentials(
  ddb: DynamoDBDocumentClient,
  sm: SecretsManagerClient,
  registryTableName: string,
): Promise<{ clientId: string; clientSecret: string; sourceSlug: string } | null> {
  const row = (await listActiveWorkspaceRows(ddb, registryTableName))
    .find((r) => r.oauth_secret_arn && r.workspace_slug);
  if (!row) {
    return null;
  }
  const value = await sm.send(new GetSecretValueCommand({ SecretId: row.oauth_secret_arn as string }));
  if (!value.SecretString) {
    throw new CliError(
      `Workspace '${row.workspace_slug as string}' is registered but its OAuth secret `
      + `(${row.oauth_secret_arn as string}) has no value. Re-run \`bgagent linear setup\` `
      + 'for that workspace to repopulate it, or remove the registry row.',
    );
  }
  let parsed: Partial<StoredLinearOauthToken>;
  try {
    parsed = JSON.parse(value.SecretString) as Partial<StoredLinearOauthToken>;
  } catch (err) {
    throw new CliError(
      `Workspace '${row.workspace_slug as string}' OAuth secret is not valid JSON: `
      + `${err instanceof Error ? err.message : String(err)}. Re-run `
      + '`bgagent linear setup` for that workspace to fix it.',
    );
  }
  if (!parsed.client_id || !parsed.client_secret) {
    throw new CliError(
      `Workspace '${row.workspace_slug as string}' OAuth secret is missing `
      + 'client_id or client_secret. Re-run `bgagent linear setup` for that workspace.',
    );
  }
  return {
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    sourceSlug: row.workspace_slug as string,
  };
}

/**
 * Look up a workspace's registry row by its Linear `urlKey` slug.
 *
 * Passes NO `Limit` to the filtered Scan: DynamoDB applies `Limit` to the items
 * READ, *before* the FilterExpression runs.
 *
 * A slug can carry two rows. An active row is returned then; without one, a row
 * that is still a registration; whichever the scan reads first.
 */
export async function findWorkspaceRowBySlug(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
  slug: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(new ScanCommand({
    TableName: registryTableName,
    FilterExpression: 'workspace_slug = :s',
    ExpressionAttributeValues: { ':s': slug },
  }));
  const rows = (result.Items ?? []).filter((item) => item.workspace_slug === slug);
  return rows.find((row) => row.status === 'active')
    ?? rows.find((row) => row.revoked_reason !== 'admin_removed')
    ?? rows[0];
}

export async function listActiveWorkspaceRows(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: registryTableName,
      ExclusiveStartKey: lastKey,
    }));
    for (const item of page.Items ?? []) {
      if (item.status === 'active') rows.push(item);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return rows;
}

/**
 * Slugs of every onboarded workspace, registry first. Installs predating the registry
 * have only the `bgagent-linear-oauth-*` secrets, so that prefix listing is the fallback.
 */
export async function listOnboardedWorkspaceSlugs(args: {
  readonly sm: SecretsManagerClient;
  readonly ddb?: DynamoDBDocumentClient;
  readonly registryTableName?: string;
}): Promise<string[]> {
  if (args.ddb && args.registryTableName) {
    const rows = await listActiveWorkspaceRows(args.ddb, args.registryTableName);
    const slugs = rows
      .map((r) => r.workspace_slug as string | undefined)
      .filter((s): s is string => Boolean(s));
    if (slugs.length > 0) return slugs;
  }

  const collected: string[] = [];
  let nextToken: string | undefined;
  do {
    const listed = await args.sm.send(new ListSecretsCommand({
      Filters: [{ Key: 'name', Values: [LINEAR_OAUTH_SECRET_PREFIX] }],
      MaxResults: 100,
      NextToken: nextToken,
    }));
    for (const s of listed.SecretList ?? []) {
      const name = s.Name ?? '';
      if (name.startsWith(LINEAR_OAUTH_SECRET_PREFIX)) {
        collected.push(name.slice(LINEAR_OAUTH_SECRET_PREFIX.length));
      }
    }
    nextToken = listed.NextToken;
  } while (nextToken);
  return collected;
}

/**
 * What can be established about where a workspace's signing secret came from.
 *
 * - `own` — the secret is provably NOT a copy of another workspace's.
 * - `inherited` — it equals the stack-wide value, so ownership cannot be established.
 * - `absent` — the workspace has no per-workspace secret at all.
 */
export type SecretProvenance = 'own' | 'inherited' | 'absent';

/**
 * Decide whether a workspace's signing secret is provably its own.
 *
 * Sound in ONE direction only: a secret that DIFFERS from the stack-wide value is
 * owned; one that EQUALS it gets `inherited`, which withholds a verdict rather than
 * asserting "not owned". With no stack-wide secret at all, any stored per-workspace
 * secret is owned.
 *
 * @param workspaceSecret - the workspace's stored `webhook_signing_secret`.
 * @param stackWideSecret - the stack-wide back-compat secret, if it is set.
 */
export function classifyWebhookSecretProvenance(
  workspaceSecret: string | undefined,
  stackWideSecret: string | undefined,
): SecretProvenance {
  if (!workspaceSecret) return 'absent';
  if (!stackWideSecret) return 'own';
  return workspaceSecret === stackWideSecret ? 'inherited' : 'own';
}

export type WorkspaceTokenResult =
  | { readonly kind: 'token'; readonly accessToken: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Resolve a usable Linear access token for one workspace, vault first.
 * Returns a reason rather than throwing.
 */
export async function resolveWorkspaceAccessToken(args: {
  readonly slug: string;
  readonly sm: SecretsManagerClient;
  readonly ddb?: DynamoDBDocumentClient;
  readonly registryTableName?: string;
  readonly region: string;
  readonly vaultWorkloadName: string;
}): Promise<WorkspaceTokenResult> {
  const { slug, sm, ddb, registryTableName, vaultWorkloadName } = args;

  if (ddb && registryTableName) {
    const row = await findWorkspaceRowBySlug(ddb, registryTableName, slug).catch(() => undefined);
    const providerName = row?.provider_name as string | undefined;
    if (providerName) {
      const workspaceId = row?.linear_workspace_id as string | undefined;
      const recorded = row?.vault_user_id as string | undefined;
      const userId = recorded
        ?? (workspaceId ? linearVaultUserId(workspaceId) : linearVaultUserIdForSlug(slug));
      const minted = await mintLinearTokenFromVault({
        region: args.region,
        workloadName: vaultWorkloadName,
        providerName,
        userId,
      });
      if (minted.kind === 'token') return { kind: 'token', accessToken: minted.accessToken };
    }
  }

  try {
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: linearOauthSecretName(slug) }));
    const stored = JSON.parse(resp.SecretString ?? '{}') as { access_token?: string };
    if (!stored.access_token) {
      return { kind: 'unavailable', reason: `secret ${linearOauthSecretName(slug)} is missing access_token` };
    }
    return { kind: 'token', accessToken: stored.access_token };
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `failed to read ${linearOauthSecretName(slug)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type ProjectOwnerResult =
  | { readonly kind: 'found'; readonly slug: string; readonly workspaceId: string }
  | { readonly kind: 'not-found'; readonly searched: readonly string[]; readonly errors: readonly string[] };

/**
 * Ask Linear which onboarded workspace owns `projectId`.
 *
 * `organization.id` comes from the same authenticated response as the project rather
 * than from the registry row.
 */
export async function findProjectOwnerWorkspace(args: {
  readonly projectId: string;
  readonly slugs: readonly string[];
  readonly sm: SecretsManagerClient;
  readonly ddb?: DynamoDBDocumentClient;
  readonly registryTableName?: string;
  readonly region: string;
  readonly vaultWorkloadName: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<ProjectOwnerResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const errors: string[] = [];

  for (const slug of args.slugs) {
    const token = await resolveWorkspaceAccessToken({ ...args, slug });
    if (token.kind !== 'token') {
      errors.push(`${slug}: ${token.reason}`);
      continue;
    }

    try {
      const res = await doFetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token.accessToken}`,
        },
        body: JSON.stringify({
          query: 'query($id: String!) { organization { id } project(id: $id) { id } }',
          variables: { id: args.projectId },
        }),
      });
      if (!res.ok) {
        errors.push(`${slug}: Linear API returned ${res.status}`);
        continue;
      }
      const body = await res.json() as {
        data?: { organization?: { id?: string }; project?: { id?: string } | null };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors) {
        errors.push(`${slug}: ${body.errors.map((e) => e.message).join('; ')}`);
        continue;
      }
      const foundId = body.data?.project?.id;
      const orgId = body.data?.organization?.id;
      if (foundId === args.projectId && orgId) {
        return { kind: 'found', slug, workspaceId: orgId };
      }
    } catch (err) {
      errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { kind: 'not-found', searched: args.slugs, errors };
}

export function makeLinearCommand(): Command {
  const linear = new Command('linear')
    .description('Manage Linear integration');

  linear.addCommand(
    new Command('app-template')
      .description('Print the field values to paste into Linear\'s OAuth app form')
      .option('--app-name <name>', `Your agent's name in Linear (default: ${DEFAULT_APP_NAME})`)
      .option('--developer-name <name>', 'Developer name shown on Linear\'s consent screen')
      .option('--developer-url <url>', 'Developer URL shown on Linear\'s consent screen')
      .option('--description <text>', 'App description shown on Linear\'s consent screen')
      .option('--vault-callback-url <url>', 'AgentCore provider callback URL — looked up automatically for --slug; this overrides it')
      .option('--hosted-consent-url <url>', 'Hosted consent page URL — read from the stack automatically; this overrides it')
      .option('--slug <slug>', 'Workspace slug, so an existing vault callback URL can be looked up and listed')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--offline', 'Skip the AWS lookups and render from flags alone')
      .action(async (opts) => {
        const looked = opts.offline
          ? { hostedConsentUrl: undefined, vaultCallbackUrl: undefined, lookupWarning: undefined, webhookUrl: undefined }
          : await resolveTemplateCallbackUrls({
            region: opts.region,
            stackName: opts.stackName,
            slug: opts.slug,
          });
        console.log(renderLinearAppTemplate({
          appName: opts.appName,
          developerName: opts.developerName,
          developerUrl: opts.developerUrl,
          description: opts.description,
          vaultCallbackUrl: opts.vaultCallbackUrl ?? looked.vaultCallbackUrl,
          hostedConsentUrl: opts.hostedConsentUrl ?? looked.hostedConsentUrl,
          lookupWarning: looked.lookupWarning,
          webhookUrl: looked.webhookUrl,
        }));
      }),
  );

  linear.addCommand(
    new Command('webhook-info')
      .description('Print the webhook URL + Linear settings for this stack')
      .action(() => {
        const config = loadConfig();
        if (!config.api_url) {
          throw new CliError(
            'No API URL configured. Run `bgagent configure` first to point at a deployed stack.',
          );
        }
        const webhookUrl = linearWebhookUrl(config.api_url);
        const bar = '═'.repeat(BANNER_WIDTH);
        console.log(bar);
        console.log('Linear webhook configuration');
        console.log(bar);
        console.log();
        console.log('In Linear → Settings → API → Webhooks → + New webhook, paste:');
        console.log();
        console.log(`  URL:             ${webhookUrl}`);
        console.log('  Resource types:  Issues, Comments');
        console.log('                   (Issues = label-triggered tasks + epic orchestration;');
        console.log('                    Comments = @bgagent re-iteration on a sub-issue PR)');
        console.log('  Team:            (whichever team owns the projects you map)');
        console.log();
        console.log('Save, then open the webhook detail page and copy the signing secret');
        console.log('(starts with `lin_wh_`). Feed it to ABCA via:');
        console.log();
        console.log('  bgagent linear update-webhook-secret <slug>');
        console.log();
        console.log('Note: webhook subscriptions are workspace-scoped, with a fresh signing');
        console.log('secret per subscription. Each Linear workspace you onboard needs its');
        console.log('own webhook configured this way.');
        console.log(bar);
      }),
  );

  linear.addCommand(
    new Command('link')
      .description('Redeem an invite code from `bgagent linear invite-user` to link your Linear identity')
      .argument('<code>', 'One-time invite code (e.g. link-3f8b4a2c)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (code: string, opts) => {
        const client = new ApiClient();

        if (opts.output !== 'json') {
          const preview = await client.linearLink(code, { dryRun: true });
          const name = preview.linear_user_name || preview.linear_user_id;
          const email = preview.linear_user_email ? ` (${preview.linear_user_email})` : '';
          const wsLabel = preview.linear_workspace_slug || preview.linear_workspace_id;
          console.log('You are about to link the following Linear identity to YOUR ABCA account:');
          console.log();
          console.log(`  Linear user:      ${name}${email}`);
          console.log(`  Linear workspace: ${wsLabel}`);
          console.log();
          console.log('After linking, tasks triggered by this Linear user will be attributed to');
          console.log('your platform user (concurrency caps, billing, `bgagent list`).');
          console.log();
          const confirm = (await promptLine('Continue? [Y/n]')).trim().toLowerCase();
          if (confirm && confirm !== 'y' && confirm !== 'yes') {
            console.log('Aborted. The invite code is still valid until it expires.');
            return;
          }
        }

        const result = await client.linearLink(code);
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log();
          console.log('✅ Linear account linked.');
          console.log(`  Linked at: ${result.linked_at}`);
        }
      }),
  );

  linear.addCommand(
    new Command('setup')
      .description('Authorize a Linear workspace. Uses the AgentCore Identity vault when the stack has '
        + 'one (no long-lived token stored) and Secrets Manager otherwise — one consent either way.')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--client-id <id>', 'Linear OAuth app Client ID (else prompted)')
      .option('--client-secret <secret>', 'Linear OAuth app Client Secret (else prompted; prefer interactive)')
      .option(
        '--webhook-secret <secret>',
        'Webhook signing secret from the app\'s Webhooks section (else prompted; prefer interactive). '
        + 'Pass an empty value to keep the secret already stored for this workspace.',
      )
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
      .option('--no-actor-app', 'Drop actor=app from the OAuth flow (diagnostic: isolates whether agent-install is blocking)')
      .option('--no-force-consent', 'Omit prompt=consent (diagnostic: restores the pre-fix behaviour that dead-ends on an already-installed app)')
      .option(
        '--code <code>',
        'Finish a hosted consent: the authorization code shown on the consent page. Uses the PKCE '
        + 'verifier saved by the first run, so it must be the same machine and the same workspace.',
      )
      // eslint-disable-next-line complexity -- predates the ceiling (97, down from 115 when it landed); must not grow
      .action(async (slug: string, opts) => {
        assertWorkspaceSlug(slug);
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const [
          workspaceRegistryTable,
          userMappingTable,
          webhookSecretArn,
        ] = await Promise.all([
          findStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
          findStackOutput(region, stackName, 'LinearUserMappingTableName'),
          findStackOutput(region, stackName, 'LinearWebhookSecretArn'),
        ]);

        const missing: string[] = [];
        if (!workspaceRegistryTable) missing.push('LinearWorkspaceRegistryTableName');
        if (!userMappingTable) missing.push('LinearUserMappingTableName');
        if (!webhookSecretArn) missing.push('LinearWebhookSecretArn');
        if (missing.length > 0) {
          throw new CliError(
            `Stack '${stackName}' is missing outputs ${missing.join(', ')}. `
            + 'Re-deploy with the 2.0b CDK changes (mise //cdk:deploy).',
          );
        }

        const cognitoSub = cognitoSubFromSession();

        console.log(`bgagent linear setup — workspace '${slug}'`);
        console.log(`  region: ${region}`);
        console.log(
          '\nLinear OAuth app credentials needed. If you have not created one, run `bgagent linear app-template`'
          + ' for the values to paste into Linear → Settings → API → New application.\n',
        );
        const clientId = (opts.clientId ?? await promptSecret('Linear Client ID: ')).trim();
        if (!clientId) {
          throw new CliError('Client ID is required.');
        }
        const clientSecret = (opts.clientSecret ?? await promptSecret('Linear Client Secret: ')).trim();
        if (!clientSecret) {
          throw new CliError('Client Secret is required.');
        }
        const sm = makeClient(SecretsManagerClient, { region });
        let existingWebhookSecret: string | undefined;
        try {
          existingWebhookSecret = await readExistingWebhookSecret(
            async () => {
              const prior = await sm.send(new GetSecretValueCommand({ SecretId: linearOauthSecretName(slug) }));
              return prior.SecretString;
            },
            (err) => (err as { name?: string }).name === 'ResourceNotFoundException',
          );
        } catch (err) {
          const errorName = (err as { name?: string }).name;
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(
            `Failed to read the existing Linear webhook secret for '${slug}' before re-write: `
            + `${errorName ?? 'Error'}: ${message}. Refusing to proceed — continuing could clobber `
            + 'this workspace\'s webhook signing secret with the stack-wide value (a 401 on every '
            + 'delivery). Likely an IAM/KMS gap: confirm your CLI principal has '
            + '`secretsmanager:GetSecretValue` (and kms:Decrypt if a CMK) on '
            + `${linearOauthSecretName(slug)}, or run \`bgagent linear update-webhook-secret ${slug}\` `
            + 'after fixing access.',
          );
        }
        const stackWideSecretValue = await readStackWideWebhookSecret(sm, webhookSecretArn!);
        const holdsOwnWebhookSecret = Boolean(
          existingWebhookSecret && existingWebhookSecret !== stackWideSecretValue,
        );

        const webhookSecretPrompt = holdsOwnWebhookSecret
          ? 'Webhook signing secret (Enter to keep the one already stored): '
          : 'Webhook signing secret (lin_wh_…, from the app\'s Webhooks section): ';
        const suppliedWebhookSecret = (
          (opts.webhookSecret as string | undefined) ?? await promptSecret(webhookSecretPrompt)
        ).trim();
        if (!suppliedWebhookSecret && !holdsOwnWebhookSecret) {
          throw new CliError(
            `Workspace '${slug}' has no webhook signing secret of its own, so one is required.\n`
            + '  Copy it from the Linear app you are onboarding: Settings → API → your app →\n'
            + '  Webhooks → Webhook signing secret (starts with `lin_wh_`).\n'
            + '  Without it, Linear\'s deliveries fail signature verification and no task is\n'
            + '  ever created — the integration looks installed and does nothing.',
          );
        }
        if (suppliedWebhookSecret && !suppliedWebhookSecret.startsWith('lin_wh_')) {
          throw new CliError(
            'That does not look like a Linear webhook signing secret (they start with `lin_wh_`). '
            + 'Copy it from the app\'s Webhooks section'
            + (holdsOwnWebhookSecret ? ', or press Enter to keep the one already stored.' : '.'),
          );
        }

        const priorRow = workspaceRegistryTable
          ? await findWorkspaceRowBySlug(makeDocClient({ region }), workspaceRegistryTable, slug)
          : undefined;

        let resumed: { code: string; codeVerifier: string; redirectUri: string } | undefined;
        if (opts.code) {
          const pending = takePendingConsent(slug);
          if (pending.clientId !== clientId) {
            throw new CliError(
              'The pending consent was started with a different Linear Client ID. Re-run '
              + `\`bgagent linear setup ${slug}\` with the client you intend to use.`,
            );
          }
          const { code: pastedCode, state: pastedState } = parsePastedAuthorization(String(opts.code));
          if (!pastedCode) {
            throw new CliError(
              'Could not find an authorization code in what you pasted. Copy the whole '
              + 'value the consent page shows, exactly as displayed.',
            );
          }
          if (pastedState && pending.state && pastedState !== pending.state) {
            throw new CliError(
              'OAuth state mismatch: the pasted value did not come from the authorization '
              + `this machine started for '${slug}'. Re-run \`bgagent linear setup ${slug}\` `
              + 'and use the value from the page that run opens.',
            );
          }
          if (!pastedState) {
            console.log('  ⚠ The pasted value carried no state, so the request could not be');
            console.log('    correlated with the one this machine started.');
          }
          resumed = {
            code: pastedCode,
            codeVerifier: pending.codeVerifier,
            redirectUri: pending.redirectUri,
          };
          console.log('  → Resuming the hosted consent for this workspace.');
        }

        const consentPageUrl = await findStackOutput(region, stackName, 'LinearVaultConsentUrl');
        const alreadyOnVault = Boolean(priorRow?.provider_name);
        const useVault = Boolean(consentPageUrl) && !resumed;
        if (alreadyOnVault && !useVault) {
          throw new CliError(
            `Workspace '${slug}' is already onboarded through the AgentCore Identity vault, but this `
            + 'run would re-register it on Secrets Manager and discard that binding.\n\n'
            + (resumed
              ? '  `--code` resumes the Secrets Manager authorization-code flow. A vault workspace '
                + 'finishes its consent in one run — re-run without `--code`.'
              : `  The stack '${stackName}' publishes no LinearVaultConsentUrl, so its last deploy `
                + 'omitted `--context enableLinearIdentityVault=true`. Re-deploy with it, or move '
                + 'this workspace off the vault deliberately by deleting its registry row first.'),
          );
        }
        if (!consentPageUrl && !resumed) {
          console.log(
            `  Stack '${stackName}' has no Identity vault (deployed without `
            + '`--context enableLinearIdentityVault=true`) — using Secrets Manager.',
          );
        }

        let vaultProviderName: string | undefined;
        let vaultUserId: string | undefined;
        let vaultAccessToken: string | undefined;
        if (useVault) {
          let provider: { providerName: string; callbackUrl: string; created: boolean } | undefined;
          try {
            process.stdout.write('  → Registering the Linear app with the Identity vault...');
            provider = await upsertLinearCredentialProvider({
              region, workspaceSlug: slug, clientId, clientSecret,
            });
            console.log(' ✓');
          } catch (err) {
            console.log(' —');
            if (!isVaultUnavailableError(err) || alreadyOnVault) throw err;
            console.log(`  AgentCore Identity not available in ${region} — using Secrets Manager.`);
          }

          if (provider?.created) {
            console.log('\n  One more Redirect URI to add to the Linear app.');
            console.log('  Copy the whole line below — leading spaces make it invalid:\n');
            console.log(provider.callbackUrl);
            console.log(`\n  Then re-run:  bgagent linear setup ${slug}\n`);
            return;
          }

          if (provider) {
            vaultProviderName = provider.providerName;
            const priorVaultUserId = priorRow?.vault_user_id as string | undefined;
            const priorWorkspaceId = priorRow?.linear_workspace_id as string | undefined;
            vaultUserId = priorVaultUserId
              ?? (alreadyOnVault && priorWorkspaceId
                ? linearVaultUserId(priorWorkspaceId)
                : linearVaultUserIdForSlug(slug));
            const returnUrl = consentPageUrl!;

            const consent = await beginVaultConsent({
              region,
              workloadName: await resolveLinearVaultWorkloadName(region, stackName),
              providerName: provider.providerName,
              userId: vaultUserId,
              returnUrl,
            });

            if (consent.kind === 'consent-required') {
              if (provider.callbackUrl) {
                console.log('\n  This consent redirects through the vault callback below, which MUST be');
                console.log('  one of the Linear app\'s Redirect URIs — otherwise Linear answers');
                console.log('  "Invalid redirect_uri parameter for the application":\n');
                console.log(provider.callbackUrl);
              }
              console.log('\n  → Open this URL and Authorize:\n');
              console.log(consent.authorizationUrl);
              console.log('');
              const sessionId = (await promptLine('  Paste the session id from the page you land on')).trim();
              if (!sessionId) {
                throw new CliError(
                  'No session id entered, so the consent cannot be completed. Re-run '
                  + `\`bgagent linear setup ${slug}\` when you have it.`,
                );
              }
              process.stdout.write('  → Completing the consent...');
              await finalizeVaultConsent({ region, userId: vaultUserId, sessionUri: sessionId });
              console.log(' ✓');
            } else {
              console.log('  ✓ Existing vault grant is healthy — no consent needed.');
            }

            process.stdout.write('  → Minting a Linear token from the vault...');
            const minted = await consent.poll();
            if (!minted) {
              throw new CliError(
                'The vault did not return a token after the consent completed. Re-run '
                + `\`bgagent linear setup ${slug}\`; if it recurs, confirm the Linear app lists the `
                + 'vault callback printed above as a Redirect URI.',
              );
            }
            vaultAccessToken = minted;
            console.log(' ✓');
          }
        }

        const { hostedUrl: setupHostedUrl, redirectUri: setupRedirectUri } = chooseSetupRedirect({
          vaultAccessToken, consentPageUrl,
        });

        const pkce = generatePkce();
        const state = randomState();
        const useActorApp = opts.actorApp !== false;
        const authorizationUrl = buildAuthorizationUrl({
          clientId,
          redirectUri: setupRedirectUri,
          state,
          codeChallenge: pkce.codeChallenge,
          actorApp: useActorApp,
          forceConsent: opts.forceConsent !== false,
        });
        if (!useActorApp) {
          console.log('  ⚠ --no-actor-app: dropping actor=app for diagnosis. Token will not be agent-scoped.');
        }

        if (setupHostedUrl && !resumed) {
          savePendingConsent({
            slug,
            state,
            codeVerifier: pkce.codeVerifier,
            clientId,
            redirectUri: setupRedirectUri,
            createdAt: new Date().toISOString(),
          });
          console.log('\n  → Open this URL in any browser and Authorize:\n');
          console.log(`    ${authorizationUrl}\n`);
          console.log(`  You will land on ${setupHostedUrl}, which shows a value to paste back.`);
          console.log(
            '\n  ⚠ That exact URL must be registered as a Redirect URI on the Linear app,'
            + '\n    or consent fails with "Invalid redirect_uri". It is a generated'
            + '\n    CloudFront domain, so it CHANGES if the consent page is ever recreated'
            + '\n    (flag toggled off/on, stack recreated). If consent starts failing after a'
            + '\n    redeploy, re-check this URL against the app — Linear accepts several, so'
            + '\n    adding the new one is safe and the stale entry does no harm.\n',
          );
          const pasted = (await promptLine('  Paste the value shown on that page')).trim();
          if (!pasted) {
            console.log('\n  No code entered. When you have it, finish with:');
            console.log(`    bgagent linear setup ${slug} --code <code>`);
            console.log('  (Codes are single-use and expire quickly, so run it promptly.)');
            return;
          }
          clearPendingConsent(slug);
          const inSession = parsePastedAuthorization(pasted);
          if (!inSession.code) {
            throw new CliError(
              'Could not find an authorization code in what you pasted. Copy the whole '
              + 'value the consent page shows, exactly as displayed.',
            );
          }
          if (inSession.state && inSession.state !== state) {
            throw new CliError(
              'OAuth state mismatch: the pasted value did not come from the authorization '
              + 'this run started. Re-run the command and use the value from the page it opens.',
            );
          }
          resumed = {
            code: inSession.code,
            codeVerifier: pkce.codeVerifier,
            redirectUri: setupRedirectUri,
          };
        }

        const callbackPromise = (resumed || vaultAccessToken) ? undefined : awaitOauthCallback();

        console.log();
        if (!resumed && !setupHostedUrl && !vaultAccessToken) {
          console.log(`  Redirecting to: ${setupRedirectUri}`);
          console.log('  That exact URI must be one of the app\'s Redirect URIs, or consent');
          console.log('  fails with "Invalid redirect_uri parameter for the application".');
          console.log('  No localhost on this machine? Deploy the consent page with');
          console.log('  `--context enableLinearIdentityVault=true`.\n');
        }
        if (resumed || vaultAccessToken) {
          // nothing to open: consent already happened in the operator's browser.
        } else if (opts.browser !== false) {
          const opened = await openBrowser(authorizationUrl);
          if (opened) {
            console.log('  → Opened your browser to the Linear consent screen.');
            console.log('    The browser will redirect to a localhost page after you Authorize — that\'s expected.');
          } else {
            console.log('  → Could not open browser automatically. Open this URL manually:');
            console.log(`    ${authorizationUrl}`);
          }
        } else {
          console.log('  → --no-browser: open this URL manually:');
          console.log(`    ${authorizationUrl}`);
        }

        let exchangeCode = '';
        let exchangeVerifier = '';
        let exchangeRedirect = '';
        if (vaultAccessToken) {
          // Token already in hand from the vault consent above.
        } else if (resumed) {
          exchangeCode = resumed.code;
          exchangeVerifier = resumed.codeVerifier;
          exchangeRedirect = resumed.redirectUri;
        } else {
          process.stdout.write('  → Waiting for browser callback...');
          const callback = await callbackPromise!;
          console.log(' ✓');

          if (callback.kind !== 'direct-oauth') {
            throw new CliError(
              'Localhost callback returned an AgentCore session_id, not a direct OAuth code. '
            + '`bgagent linear setup` uses the direct redirect — verify Linear\'s redirect URI is '
              + `${CALLBACK_URL}.`,
            );
          }
          if (callback.state !== state) {
            throw new CliError(
              `OAuth state mismatch (expected '${state}', got '${callback.state}'). `
              + 'Possible CSRF attack or stale tab — re-run setup.',
            );
          }
          exchangeCode = callback.code;
          exchangeVerifier = pkce.codeVerifier;
          exchangeRedirect = setupRedirectUri;
        }

        let tokenResponse: LinearTokenResponse | undefined;
        if (!vaultAccessToken) {
          process.stdout.write('  → Exchanging code for access token...');
          tokenResponse = await exchangeAuthorizationCode({
            code: exchangeCode,
            codeVerifier: exchangeVerifier,
            redirectUri: exchangeRedirect,
            clientId,
            clientSecret,
          });
          console.log(' ✓');
        }
        const linearAccessToken = vaultAccessToken ?? tokenResponse!.access_token;

        process.stdout.write('  → Querying Linear viewer + organization...');
        const identity = await queryLinearIdentity(`Bearer ${linearAccessToken}`);
        if (!identity) {
          throw new CliError(
            'Linear viewer query rejected the access token. This is unexpected — token was just issued. '
            + 'Re-run `bgagent linear setup` if Linear\'s API is recovering from a transient outage.',
          );
        }
        console.log(` ✓ (${identity.organization.name ?? identity.organization.urlKey ?? identity.organization.id})`);

        if (!vaultAccessToken) {
          assertSlugFreeFor(slug, identity.organization, priorRow);
        }
        if (identity.organization.urlKey && identity.organization.urlKey !== slug) {
          console.log(
            `  ⚠ Slug '${slug}' does not match Linear's urlKey '${identity.organization.urlKey}'. `
            + 'Re-run with the correct slug to keep the registry key aligned with Linear.',
          );
        }

        process.stdout.write('  → Storing OAuth token...');
        const now = new Date().toISOString();
        let preservedTokens: Awaited<ReturnType<typeof readExistingOauthTokens>>;
        if (vaultAccessToken) {
          try {
            preservedTokens = await readExistingOauthTokens(
              async () => {
                const prior = await sm.send(
                  new GetSecretValueCommand({ SecretId: linearOauthSecretName(slug) }),
                );
                return prior.SecretString;
              },
              (err) => (err as { name?: string }).name === 'ResourceNotFoundException',
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new CliError(
              `Failed to read '${slug}''s existing Linear token before moving it onto the vault: `
              + `${message}. Refusing to proceed — the re-write would discard a working `
              + 'credential, leaving no fallback if the vault becomes unreachable.',
            );
          }
        }
        const stored: StoredLinearOauthToken = {
          ...resolveStoredGrantFields(tokenResponse, preservedTokens),
          client_id: clientId,
          client_secret: clientSecret,
          workspace_id: identity.organization.id,
          workspace_slug: slug,
          installed_at: now,
          updated_at: now,
          installed_by_platform_user_id: cognitoSub,
          webhook_signing_secret: suppliedWebhookSecret || existingWebhookSecret,
        };
        if (!vaultAccessToken && !stored.refresh_token) {
          throw new CliError(
            'Linear did not return a refresh_token. The integration cannot self-renew tokens; '
            + 're-check that the Linear OAuth app permits refresh-token grants.',
          );
        }
        const secretName = linearOauthSecretName(slug);
        const oauthSecretArn = await upsertOauthSecret(sm, secretName, stored, slug);
        console.log(` ✓ (${secretName})`);
        if (preservedTokens) {
          console.log('  ✓ Kept the existing Secrets Manager token as a fallback');
        }
        console.log(suppliedWebhookSecret
          ? '  ✓ Using the webhook signing secret you entered'
          : '  ✓ Preserving this workspace\'s existing webhook signing secret (re-run — not overwriting)');

        const ddb = makeDocClient({ region });

        const teamKeysResult = await queryLinearTeamKeys(`Bearer ${linearAccessToken}`);
        if (!teamKeysResult.ok) {
          console.log(
            '  ⚠ Could not read this workspace\'s Linear team keys — recording the workspace '
            + 'without them. Issue lookups will fall back to scanning every workspace; re-run '
            + 'setup later to record team keys for faster prefix-routing.',
          );
        }
        const teamKeys = teamKeysResult.ok ? teamKeysResult.keys : [];

        const webhookSecretOwned = Boolean(suppliedWebhookSecret) || holdsOwnWebhookSecret;

        await ddb.send(new PutCommand({
          TableName: workspaceRegistryTable!,
          Item: {
            linear_workspace_id: identity.organization.id,
            workspace_slug: slug,
            oauth_secret_arn: oauthSecretArn,
            installed_by_platform_user_id: cognitoSub,
            installed_at: now,
            updated_at: now,
            status: 'active',
            ...(webhookSecretOwned ? { webhook_secret_owned: true } : {}),
            ...(teamKeys.length > 0 ? { team_keys: teamKeys } : {}),
            ...(vaultProviderName ? { provider_name: vaultProviderName } : {}),
            ...(vaultUserId ? { vault_user_id: vaultUserId } : {}),
          },
        }));
        console.log(
          teamKeys.length > 0
            ? `  ✓ Recorded workspace in registry (team keys: ${teamKeys.join(', ')})`
            : '  ✓ Recorded workspace in registry',
        );

        // With actor=app, Linear's `viewer` returns the bot user, not the operator.
        console.log();
        const linked = await runSelfLinkPicker({
          ddb,
          userMappingTable: userMappingTable!,
          accessToken: linearAccessToken,
          workspaceId: identity.organization.id,
          slug,
          cognitoSub,
          linkMethod: 'auto_setup_oauth',
        });

        console.log();
        console.log('✅ Setup complete.');
        console.log();
        console.log('Next steps:');
        if (!linked) {
          console.log(`  1. Re-run \`bgagent linear setup ${slug}\` to retry the self-link picker,`);
          console.log('     OR label a test issue and the resulting CloudWatch warning will tell you');
          console.log('     your Linear UUID. (Required — without linking, your Linear-triggered tasks are dropped.)');
          console.log('  2. Onboard a Linear project to a GitHub repo:');
          console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
        } else {
          console.log('  1. Onboard a Linear project to a GitHub repo:');
          console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
          console.log('  2. Add the trigger label to a Linear issue in a mapped project.');
          console.log('  (To onboard teammates: `bgagent linear invite-user <slug>`.)');
        }
      }),
  );

  linear.addCommand(
    new Command('add-workspace')
      .description('Authorize an additional Linear workspace using the existing OAuth app + webhook secret')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
      .option('--no-actor-app', 'Drop actor=app from the OAuth flow (diagnostic)')
      .option('--no-force-consent', 'Omit prompt=consent (diagnostic)')
      .action(async (slug: string, opts) => {
        assertWorkspaceSlug(slug);
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const [
          workspaceRegistryTable,
          userMappingTable,
        ] = await Promise.all([
          findStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
          findStackOutput(region, stackName, 'LinearUserMappingTableName'),
        ]);

        const missing: string[] = [];
        if (!workspaceRegistryTable) missing.push('LinearWorkspaceRegistryTableName');
        if (!userMappingTable) missing.push('LinearUserMappingTableName');
        if (missing.length > 0) {
          throw new CliError(
            `Stack '${stackName}' is missing outputs ${missing.join(', ')}. `
            + 'Re-deploy with the 2.0b CDK changes (mise //cdk:deploy).',
          );
        }

        const cognitoSub = cognitoSubFromSession();

        const sm = makeClient(SecretsManagerClient, { region });
        const ddb = makeDocClient({ region });

        console.log(`bgagent linear add-workspace — workspace '${slug}'`);
        console.log(`  region: ${region}`);
        console.log();

        process.stdout.write('  → Looking for an existing workspace to reuse OAuth credentials...');
        const existing = await findReusableOauthAppCredentials(ddb, sm, workspaceRegistryTable!);
        if (!existing) {
          console.log(' ✗');
          throw new CliError(
            'No active Linear workspace found in the registry. '
            + 'Run `bgagent linear setup <slug>` first to install the OAuth app, '
            + 'then re-run `bgagent linear add-workspace` for additional workspaces.',
          );
        }
        console.log(' ✓');
        console.log();
        console.log('  Linear OAuth credentials. Press Enter to reuse the existing app, or paste new values');
        console.log('  (the existing app may be private to its origin workspace and not authorize cross-install).');
        const clientId = await promptLine('  Linear Client ID', existing.clientId);
        const sameAsExisting = clientId === existing.clientId;
        const clientSecret = sameAsExisting
          ? existing.clientSecret
          : (await promptSecret('  Linear Client Secret: ')).trim();
        if (!clientId || !clientSecret) {
          throw new CliError('Client ID and Client Secret are both required.');
        }
        console.log();

        const pkce = generatePkce();
        const state = randomState();
        const useActorApp = opts.actorApp !== false;
        const authorizationUrl = buildAuthorizationUrl({
          clientId,
          redirectUri: CALLBACK_URL,
          state,
          codeChallenge: pkce.codeChallenge,
          actorApp: useActorApp,
          forceConsent: opts.forceConsent !== false,
        });
        if (!useActorApp) {
          console.log('  ⚠ --no-actor-app: dropping actor=app for diagnosis. Token will not be agent-scoped.');
        }

        console.log(`\n  Redirecting to: ${CALLBACK_URL}`);
        console.log('  That exact URI must be one of the app\'s Redirect URIs.');
        console.log(`  No localhost here? Use \`bgagent linear setup ${slug}\` instead — it needs`);
        console.log('  none, and is the only path that supports the Identity vault.\n');
        const callbackPromise = awaitOauthCallback();

        console.log();
        if (opts.browser !== false) {
          const opened = await openBrowser(authorizationUrl);
          if (opened) {
            console.log('  → Opened your browser to the Linear consent screen.');
            console.log('    Sign in to the workspace you want to add (use a workspace switcher if needed).');
          } else {
            console.log('  → Could not open browser automatically. Open this URL manually:');
            console.log(`    ${authorizationUrl}`);
          }
        } else {
          console.log('  → --no-browser: open this URL manually:');
          console.log(`    ${authorizationUrl}`);
        }

        process.stdout.write('  → Waiting for browser callback...');
        const callback = await callbackPromise;
        console.log(' ✓');

        if (callback.kind !== 'direct-oauth') {
          throw new CliError(
            'Localhost callback returned an AgentCore session_id, not a direct OAuth code. '
            + `Verify Linear's redirect URI is set to ${CALLBACK_URL} and re-run.`,
          );
        }
        if (callback.state !== state) {
          throw new CliError(
            `OAuth state mismatch (expected '${state}', got '${callback.state}'). `
            + 'Possible CSRF attack or stale tab — re-run add-workspace.',
          );
        }

        process.stdout.write('  → Exchanging code for access token...');
        const tokenResponse = await exchangeAuthorizationCode({
          code: callback.code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: CALLBACK_URL,
          clientId,
          clientSecret,
        });
        console.log(' ✓');

        process.stdout.write('  → Querying Linear viewer + organization...');
        const identity = await queryLinearIdentity(`Bearer ${tokenResponse.access_token}`);
        if (!identity) {
          throw new CliError(
            'Linear viewer query rejected the access token. This is unexpected — token was just issued. '
            + 'Re-run `bgagent linear add-workspace` if Linear\'s API is recovering from a transient outage.',
          );
        }
        console.log(` ✓ (${identity.organization.name ?? identity.organization.urlKey ?? identity.organization.id})`);

        if (identity.organization.urlKey && identity.organization.urlKey !== slug) {
          throw new CliError(
            `Slug '${slug}' does not match Linear's urlKey '${identity.organization.urlKey}' for the authorized workspace. `
            + 'Re-run with the correct slug — using the wrong slug would shadow the secret name and produce a confusing registry row.',
          );
        }

        // No `Limit`: DynamoDB applies it before the filter (see findWorkspaceRowBySlug).
        const dupCheck = await ddb.send(new ScanCommand({
          TableName: workspaceRegistryTable!,
          FilterExpression: 'linear_workspace_id = :id',
          ExpressionAttributeValues: { ':id': identity.organization.id },
        }));
        if (dupCheck.Items && dupCheck.Items.length > 0) {
          throw new CliError(
            `Workspace '${slug}' (${identity.organization.id}) is already in the registry. `
            + 'Use `bgagent linear setup` to re-authorize an existing workspace, or remove the registry row manually before retrying.',
          );
        }
        assertSlugFreeFor(slug, identity.organization, await findWorkspaceRowBySlug(ddb, workspaceRegistryTable!, slug));

        const now = new Date().toISOString();
        const stored: StoredLinearOauthToken = {
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token ?? '',
          expires_at: computeExpiresAt(tokenResponse.expires_in),
          scope: tokenResponse.scope,
          client_id: clientId,
          client_secret: clientSecret,
          workspace_id: identity.organization.id,
          workspace_slug: slug,
          installed_at: now,
          updated_at: now,
          installed_by_platform_user_id: cognitoSub,
        };
        if (!stored.refresh_token) {
          throw new CliError(
            'Linear did not return a refresh_token. The integration cannot self-renew tokens; '
            + 're-check that the Linear OAuth app permits refresh-token grants.',
          );
        }

        const apiBaseUrl = config.api_url.replace(/\/+$/, '');
        console.log();
        console.log(`  Webhook signing secret needed for '${slug}'.`);
        console.log(`  In Linear (signed into '${slug}') → Settings → API → Webhooks, create a webhook pointing at:`);
        console.log(`    ${apiBaseUrl}/linear/webhook`);
        console.log('  Subscribe to: Issues AND Comments (Comments carries the @bgagent trigger).');
        console.log('  Copy the signing secret from the webhook detail page.');
        console.log();
        const webhookSigningSecret = (await promptSecret('  Webhook signing secret (lin_wh_…): ')).trim();
        if (!webhookSigningSecret) {
          throw new CliError('Webhook signing secret is required.');
        }
        if (!webhookSigningSecret.startsWith('lin_wh_')) {
          throw new CliError(
            'Webhook signing secrets start with \'lin_wh_\'. Got something different — re-check the Linear webhook detail page.',
          );
        }

        process.stdout.write('  → Storing OAuth token...');
        const secretName = linearOauthSecretName(slug);
        const oauthSecretArn = await upsertOauthSecret(
          sm, secretName, { ...stored, webhook_signing_secret: webhookSigningSecret }, slug,
        );
        console.log(` ✓ (${secretName})`);

        const teamKeysResult = await queryLinearTeamKeys(`Bearer ${tokenResponse.access_token}`);
        if (!teamKeysResult.ok) {
          console.log(
            '  ⚠ Could not read this workspace\'s Linear team keys — recording the workspace '
            + 'without them. Issue lookups will fall back to scanning every workspace; re-run '
            + `\`bgagent linear setup ${slug}\` later to record team keys for faster prefix-routing.`,
          );
        }
        const teamKeys = teamKeysResult.ok ? teamKeysResult.keys : [];
        await ddb.send(new PutCommand({
          TableName: workspaceRegistryTable!,
          Item: {
            linear_workspace_id: identity.organization.id,
            workspace_slug: slug,
            oauth_secret_arn: oauthSecretArn,
            installed_by_platform_user_id: cognitoSub,
            installed_at: now,
            updated_at: now,
            status: 'active',
            webhook_secret_owned: true,
            ...(teamKeys.length > 0 ? { team_keys: teamKeys } : {}),
          },
        }));
        console.log(
          teamKeys.length > 0
            ? `  ✓ Recorded workspace in registry (team keys: ${teamKeys.join(', ')})`
            : '  ✓ Recorded workspace in registry',
        );

        console.log();
        const linked = await runSelfLinkPicker({
          ddb,
          userMappingTable: userMappingTable!,
          accessToken: tokenResponse.access_token,
          workspaceId: identity.organization.id,
          slug,
          cognitoSub,
          linkMethod: 'add_workspace_oauth',
        });

        console.log();
        console.log('✅ Workspace added.');
        console.log();
        console.log('Next steps:');
        if (!linked) {
          console.log(`  1. Re-run \`bgagent linear setup ${slug}\` to retry the self-link picker,`);
          console.log('     OR label a test issue and the resulting CloudWatch warning will tell you');
          console.log('     your Linear UUID. (Required — without linking, your Linear-triggered tasks are dropped.)');
          console.log('  2. Onboard a Linear project to a GitHub repo:');
          console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
        } else {
          console.log('  1. Onboard a Linear project from this workspace to a GitHub repo:');
          console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
          console.log('  (To onboard teammates: `bgagent linear invite-user <slug>`.)');
        }
      }),
  );

  linear.addCommand(
    new Command('update-webhook-secret')
      .description('Update the per-workspace webhook signing secret without re-running OAuth')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (slug: string, opts) => {
        assertWorkspaceSlug(slug);
        const config = loadConfig();
        const region = opts.region || config.region;

        const sm = makeClient(SecretsManagerClient, { region });
        const secretName = linearOauthSecretName(slug);

        let stored: StoredLinearOauthToken;
        try {
          const value = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
          if (!value.SecretString) {
            throw new CliError(
              `Secret '${secretName}' has no SecretString. Run \`bgagent linear setup ${slug}\` to install fresh.`,
            );
          }
          stored = JSON.parse(value.SecretString) as StoredLinearOauthToken;
        } catch (err) {
          const errorName = (err as { name?: string }).name;
          if (errorName === 'ResourceNotFoundException') {
            throw new CliError(
              `Workspace '${slug}' is not installed (no Secrets Manager secret '${secretName}'). `
              + `Run \`bgagent linear setup ${slug}\` first.`,
            );
          }
          if (err instanceof CliError) throw err;
          throw new CliError(
            `Could not read existing OAuth bundle: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!stored.workspace_id) {
          throw new CliError(
            `Secret '${secretName}' is missing the workspace_id field. `
            + `Bundle may be corrupted; re-run \`bgagent linear setup ${slug}\` to rebuild.`,
          );
        }

        console.log(`bgagent linear update-webhook-secret — workspace '${slug}'`);
        console.log(`  region: ${region}`);
        console.log(`  current webhook_signing_secret: ${stored.webhook_signing_secret ? 'set' : 'not set'}`);
        console.log();
        console.log('  Paste the new signing secret from Linear → Settings → API → Webhooks');
        console.log(`  (signed into '${slug}'). Open the webhook detail page and copy the signing secret.`);
        console.log();

        const webhookSigningSecret = (await promptSecret('  Webhook signing secret (lin_wh_…): ')).trim();
        if (!webhookSigningSecret) {
          throw new CliError('Webhook signing secret is required.');
        }
        if (!webhookSigningSecret.startsWith('lin_wh_')) {
          throw new CliError(
            'Webhook signing secrets start with \'lin_wh_\'. Got something different — re-check the Linear webhook detail page.',
          );
        }

        const merged: StoredLinearOauthToken = {
          ...stored,
          webhook_signing_secret: webhookSigningSecret,
          updated_at: new Date().toISOString(),
        };
        await upsertOauthSecret(sm, secretName, merged, slug);

        const registryTableName = await findStackOutput(region, opts.stackName, 'LinearWorkspaceRegistryTableName');
        if (!registryTableName) {
          throw new CliError(
            'Updated the signing secret, but could not find LinearWorkspaceRegistryTableName in '
            + `stack '${opts.stackName}'.\n`
            + '  The secret is only half the repair — verification also reads a registry flag\n'
            + '  recording that this workspace owns it, and that flag was not written.\n'
            + '  Re-run with --stack-name <your-stack> (the secret you entered is preserved).',
          );
        }
        try {
          await makeDocClient({ region }).send(new UpdateCommand({
            TableName: registryTableName,
            Key: { linear_workspace_id: stored.workspace_id },
            UpdateExpression: 'SET webhook_secret_owned = :t, updated_at = :u',
            ConditionExpression: 'attribute_exists(linear_workspace_id)',
            ExpressionAttributeValues: { ':t': true, ':u': new Date().toISOString() },
          }));
          console.log('  ✓ Recorded that this workspace owns its signing secret');
        } catch (err) {
          if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
            throw new CliError(
              `Updated the signing secret, but workspace '${slug}' has no registry row `
              + `(${stored.workspace_id}).\n  Run \`bgagent linear setup ${slug}\` so the workspace `
              + 'is registered; the secret you just entered will be preserved.',
            );
          }
          throw new CliError(
            'Updated the signing secret, but could not record its provenance: '
            + `${err instanceof Error ? err.message : String(err)}\n`
            + '  Re-run this command once the registry table is writable, otherwise this\n'
            + '  workspace is still treated as carrying an inherited secret.',
          );
        }

        console.log();
        console.log(`✅ Updated webhook signing secret for '${slug}'.`);
        console.log();
        console.log('Next webhook event from this workspace will verify against the new secret.');
      }),
  );

  linear.addCommand(
    new Command('remove-workspace')
      .description('Deregister a Linear workspace: revoke the registry row + delete its OAuth secret')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--purge', 'Delete the registry row entirely instead of keeping it with status=revoked (no audit trail)')
      .option('--yes', 'Skip the slug-confirmation prompt (for scripted use)')
      .action(async (slug: string, opts) => {
        assertWorkspaceSlug(slug);

        const purge = Boolean(opts.purge);

        if (!opts.yes) {
          console.log(`About to remove Linear workspace '${slug}'. This will:`);
          console.log(purge
            ? '  • DELETE the registry row entirely (no audit trail)'
            : '  • Mark the registry row status=revoked (preserves audit trail)');
          console.log(`  • Delete the Secrets Manager secret '${linearOauthSecretName(slug)}' if it exists`);
          console.log('  • Leave project→repo mappings in place (remove those by project id)');
          console.log('  • NOT delete an AgentCore credential provider, if this workspace is vault-managed');
          console.log();
          const confirm = (await promptLine('Type the workspace slug to confirm')).trim();
          if (confirm !== slug) {
            console.log('Aborted — the confirmation did not match the slug. Nothing was removed.');
            return;
          }
        }

        const client = new ApiClient();
        const result = await client.linearRemoveWorkspace(slug, { purge });

        console.log();
        console.log(`✅ Workspace '${result.workspace_slug}' removed (${result.status}).`);
        console.log(result.status === 'purged'
          ? '  ✓ Registry row deleted'
          : '  ✓ Registry row revoked');
        switch (result.secret) {
          case 'deleted':
            console.log('  ✓ OAuth secret deleted');
            break;
          case 'absent':
            console.log('  • OAuth secret was already absent (nothing to delete)');
            break;
          case 'not_applicable':
            console.log('  • No Secrets Manager secret for this workspace — its credential is vault-managed');
            break;
        }
        console.log('  • Project→repo mappings left in place — remove by project id if needed');

        if (result.provider_name) {
          console.log();
          console.log('⚠️  Teardown is NOT complete. This workspace is vault-managed, and its');
          console.log('   AgentCore credential provider still holds the Linear client secret and a');
          console.log('   live refresh grant. It is not managed by CloudFormation — delete it with:');
          console.log();
          console.log(`     aws bedrock-agentcore-control delete-oauth2-credential-provider --name ${result.provider_name}`);
        }
      }),
  );

  linear.addCommand(
    new Command('invite-user')
      .description('Generate a one-time code for a Linear teammate to redeem via `bgagent linear link <code>`')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (slug: string, opts) => {
        assertWorkspaceSlug(slug);
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const [workspaceRegistryTable, userMappingTable] = await Promise.all([
          findStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
          findStackOutput(region, stackName, 'LinearUserMappingTableName'),
        ]);
        const missing: string[] = [];
        if (!workspaceRegistryTable) missing.push('LinearWorkspaceRegistryTableName');
        if (!userMappingTable) missing.push('LinearUserMappingTableName');
        if (missing.length > 0) {
          throw new CliError(
            `Stack '${stackName}' is missing outputs ${missing.join(', ')}. `
            + 'Re-deploy with the 2.0b CDK changes (mise //cdk:deploy).',
          );
        }

        const callerCognitoSub = cognitoSubFromSession();

        const sm = makeClient(SecretsManagerClient, { region });
        const ddb = makeDocClient({ region });
        const registryRow = (await listActiveWorkspaceRows(ddb, workspaceRegistryTable!))
          .find((row) => row.workspace_slug === slug);
        if (!registryRow) {
          throw new CliError(
            `Workspace '${slug}' is not in the registry (or status != 'active'). `
            + `Run \`bgagent linear setup ${slug}\` first.`,
          );
        }
        const workspaceId = registryRow.linear_workspace_id as string;
        const oauthSecretArn = registryRow.oauth_secret_arn as string;

        process.stdout.write('  → Querying Linear for workspace members...');
        const oauthSecret = await sm.send(new GetSecretValueCommand({ SecretId: oauthSecretArn }));
        const stored = JSON.parse(oauthSecret.SecretString ?? '{}') as { access_token?: string };
        let inviteToken = stored.access_token;
        const inviteProvider = registryRow.provider_name as string | undefined;
        if (inviteProvider) {
          const recordedSubject = registryRow.vault_user_id as string | undefined;
          const inviteWorkspaceId = registryRow.linear_workspace_id as string | undefined;
          const minted = await mintLinearTokenFromVault({
            region,
            workloadName: await resolveLinearVaultWorkloadName(region, stackName),
            providerName: inviteProvider,
            userId: recordedSubject
              ?? (inviteWorkspaceId ? linearVaultUserId(inviteWorkspaceId) : linearVaultUserIdForSlug(slug)),
          });
          inviteToken = minted.kind === 'token' ? minted.accessToken : stored.access_token;
        }
        if (!inviteToken) {
          console.log(' ✗');
          throw new CliError(
            `No usable Linear token for '${slug}': the vault has no live grant and `
            + `'${oauthSecretArn}' holds no access token. Re-run \`bgagent linear setup ${slug}\`.`,
          );
        }
        const members = await queryLinearWorkspaceMembers(`Bearer ${inviteToken}`);
        if (!members || members.length === 0) {
          console.log(' ✗');
          throw new CliError('Linear API returned no workspace members. Token may be expired or scope insufficient.');
        }
        const humans = members.filter((m) => !(m.email ?? '').endsWith('@oauthapp.linear.app'));
        console.log(` ✓ (${humans.length} member${humans.length === 1 ? '' : 's'})`);
        if (humans.length === 0) {
          throw new CliError('No human users found in this workspace. Add teammates in Linear first.');
        }

        console.log();
        console.log(`  Workspace '${slug}' members:`);
        humans.forEach((m, i) => {
          const email = m.email ? ` (${m.email})` : '';
          console.log(`    ${i + 1}. ${m.name ?? m.id}${email}`);
        });
        console.log();
        const pickRaw = (await promptLine(`  Which one is the teammate? [1-${humans.length}]`)).trim();
        const pickIdx = parseInt(pickRaw, 10) - 1;
        if (Number.isNaN(pickIdx) || pickIdx < 0 || pickIdx >= humans.length) {
          throw new CliError(`Invalid selection '${pickRaw}'.`);
        }
        const picked = humans[pickIdx];
        const pickedLabel = `${picked.name ?? picked.id}${picked.email ? ` (${picked.email})` : ''}`;

        const code = generateInviteCode();
        const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
        await ddb.send(new PutCommand({
          TableName: userMappingTable!,
          Item: {
            linear_identity: `pending#${code}`,
            status: 'pending',
            linear_workspace_id: workspaceId,
            linear_workspace_slug: slug,
            linear_user_id: picked.id,
            linear_user_name: picked.name ?? '',
            linear_user_email: picked.email ?? '',
            invited_at: new Date().toISOString(),
            invited_by_platform_user_id: callerCognitoSub,
            ttl,
          },
        }));
        console.log();
        console.log('✅ Invite created.');
        console.log();
        console.log('  Send this to the teammate (Slack/email/etc):');
        console.log();
        console.log(`      bgagent linear link ${code}`);
        console.log();
        console.log(`  Picked Linear user: ${pickedLabel}`);
        console.log(`  Code expires:       ${new Date(ttl * 1000).toISOString()} (24h)`);
        console.log();
        console.log('  The teammate sees the Linear identity above and confirms before the');
        console.log('  mapping is written. If you picked the wrong member, the teammate aborts.');
      }),
  );

  linear.addCommand(
    new Command('onboard-project')
      .description('Map a Linear project to a GitHub repository (admin IAM required)')
      .argument('<linear-project-id>', 'Linear project UUID')
      .requiredOption('--repo <owner/repo>', 'GitHub repository the mapped project should route tasks to')
      .option('--label <label>', `Label that triggers a task (default: ${DEFAULT_LABEL_FILTER})`, DEFAULT_LABEL_FILTER)
      .option('--team-id <id>', 'Optional Linear team UUID for the project (stored for debug)')
      .option('--slug <slug>', 'Only look for the project in this workspace (default: every onboarded workspace)')
      .option(
        '--workspace-id <uuid>',
        'Record this owning workspace instead of asking Linear. For when the Linear API is '
        + 'unreachable — a wrong value routes this project\'s tasks nowhere.',
      )
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (projectId: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const tableName = await findStackOutput(region, opts.stackName, 'LinearProjectMappingTableName');
        if (!tableName) {
          console.error('Could not find LinearProjectMappingTableName in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) {
          console.error(`Invalid --repo value: ${opts.repo}. Expected owner/repo.`);
          process.exit(1);
        }

        if (!UUID_RE.test(projectId)) {
          console.error(`Invalid Linear project UUID: ${projectId}`);
          console.error('');
          console.error('Linear project URLs contain a *truncated* UUID. The real UUID is a full 36-character');
          console.error('UUID (e.g. a680cae8-704c-4e64-92ac-0c80346d1aad). Run:');
          console.error('');
          console.error('  bgagent linear list-projects');
          console.error('');
          console.error('to see the full UUID for each project in your workspace.');
          process.exit(1);
        }

        const now = new Date().toISOString();
        const ddb = makeDocClient({ region });

        let ownerWorkspaceId: string | undefined;
        let ownerLabel: string | undefined;
        if (opts.workspaceId) {
          if (!UUID_RE.test(opts.workspaceId)) {
            console.error(`Invalid --workspace-id value: ${opts.workspaceId}. Expected a UUID.`);
            process.exit(1);
          }
          ownerWorkspaceId = opts.workspaceId;
          ownerLabel = `${ownerWorkspaceId} (from --workspace-id, not verified with Linear)`;
        } else {
          process.stdout.write('→ Resolving which workspace owns the project...');
          const sm = makeClient(SecretsManagerClient, { region });
          const registryTableName = await findStackOutput(region, opts.stackName, 'LinearWorkspaceRegistryTableName');
          const slugs = opts.slug
            ? [opts.slug as string]
            : await listOnboardedWorkspaceSlugs({ sm, ddb, registryTableName: registryTableName ?? undefined });

          const owner = await findProjectOwnerWorkspace({
            projectId,
            slugs,
            sm,
            ddb,
            registryTableName: registryTableName ?? undefined,
            region,
            vaultWorkloadName: await resolveLinearVaultWorkloadName(region, opts.stackName),
          });

          if (owner.kind !== 'found') {
            console.log(' ✗');
            console.error(`Could not determine which workspace owns project ${projectId}.`);
            console.error('');
            console.error(`Searched: ${owner.searched.length > 0 ? owner.searched.join(', ') : '(no onboarded workspaces)'}`);
            for (const e of owner.errors) console.error(`  - ${e}`);
            console.error('');
            console.error('Run `bgagent linear list-projects` to confirm the project UUID, or pass');
            console.error('--slug to narrow the search. If the Linear API is unreachable, pass');
            console.error('--workspace-id <uuid> to record the owner without verifying it.');
            process.exit(1);
          }
          ownerWorkspaceId = owner.workspaceId;
          ownerLabel = `${owner.slug} (${ownerWorkspaceId})`;
          console.log(' ✓');
        }

        const existing = await ddb.send(new GetCommand({
          TableName: tableName,
          Key: { linear_project_id: projectId },
          ConsistentRead: true,
        }));
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: {
            linear_project_id: projectId,
            linear_workspace_id: ownerWorkspaceId,
            repo: opts.repo,
            label_filter: opts.label,
            ...(opts.teamId && { team_id: opts.teamId }),
            status: 'active',
            onboarded_at: existing.Item?.onboarded_at ?? now,
            updated_at: now,
          },
        }));

        console.log(`✓ Mapped Linear project ${projectId} → ${opts.repo}`);
        console.log(`  Trigger label:    ${opts.label}`);
        console.log(`  Owning workspace: ${ownerLabel}`);
        if (opts.teamId) {
          console.log(`  Team:             ${opts.teamId}`);
        }
      }),
  );

  linear.addCommand(
    new Command('backfill-secret-provenance')
      .description('Record which workspaces provably own their webhook signing secret')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--dry-run', 'Report what would change without writing')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const [registryTableName, webhookSecretArn] = await Promise.all([
          findStackOutput(region, opts.stackName, 'LinearWorkspaceRegistryTableName'),
          findStackOutput(region, opts.stackName, 'LinearWebhookSecretArn'),
        ]);
        if (!registryTableName) {
          console.error('Could not find LinearWorkspaceRegistryTableName in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        const ddb = makeDocClient({ region });
        const sm = makeClient(SecretsManagerClient, { region });

        let stackWideSecret: string | undefined;
        if (webhookSecretArn) {
          try {
            const v = await sm.send(new GetSecretValueCommand({ SecretId: webhookSecretArn }));
            stackWideSecret = v.SecretString?.trim() || undefined;
          } catch (err) {
            if ((err as { name?: string })?.name !== 'ResourceNotFoundException') {
              throw new CliError(
                `Could not read the stack-wide webhook secret: ${err instanceof Error ? err.message : String(err)}\n`
                + '  Without it, ownership cannot be established for any workspace — refusing to\n'
                + '  guess. Re-run once the secret is readable (check IAM and KMS permissions).',
              );
            }
          }
        }

        const rows = await listActiveWorkspaceRows(ddb, registryTableName);
        if (rows.length === 0) {
          console.log('No active Linear workspaces in the registry.');
          return;
        }
        console.log(`${rows.length} active workspace(s). Stack-wide secret: ${stackWideSecret ? 'set' : 'not set'}`);
        console.log();

        let recorded = 0;
        const needsOperator: Array<{ slug: string; why: SecretProvenance }> = [];

        for (const row of rows) {
          const slug = (row.workspace_slug as string | undefined) ?? '<unknown-slug>';
          const workspaceId = row.linear_workspace_id as string | undefined;
          const secretArn = row.oauth_secret_arn as string | undefined;
          if (!workspaceId || !secretArn) {
            console.log(`  ⚠ ${slug}: registry row is incomplete — skipping`);
            continue;
          }
          if (row.webhook_secret_owned === true) {
            console.log(`  · ${slug}: already recorded as owning its secret`);
            continue;
          }

          let workspaceSecret: string | undefined;
          try {
            workspaceSecret = await readExistingWebhookSecret(
              async () => {
                const v = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
                return v.SecretString ?? undefined;
              },
              (err) => (err as { name?: string })?.name === 'ResourceNotFoundException',
            );
          } catch (err) {
            console.log(`  ⚠ ${slug}: could not read its OAuth bundle — ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          const provenance = classifyWebhookSecretProvenance(workspaceSecret, stackWideSecret);
          if (provenance !== 'own') {
            needsOperator.push({ slug, why: provenance });
            console.log(`  ⚠ ${slug}: ${provenance === 'absent'
              ? 'has no signing secret of its own'
              : 'holds the stack-wide secret, so ownership cannot be established'}`);
            continue;
          }

          if (opts.dryRun) {
            console.log(`  would record ${slug} as owning its secret`);
          } else {
            try {
              await ddb.send(new UpdateCommand({
                TableName: registryTableName,
                Key: { linear_workspace_id: workspaceId },
                UpdateExpression: 'SET webhook_secret_owned = :t, updated_at = :u',
                ConditionExpression: 'attribute_exists(linear_workspace_id)',
                ExpressionAttributeValues: { ':t': true, ':u': new Date().toISOString() },
              }));
            } catch (err) {
              if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
                console.log(`  · ${slug}: row changed underneath the backfill — skipped`);
                continue;
              }
              throw err;
            }
            console.log(`  ✓ ${slug}: recorded as owning its secret`);
          }
          recorded += 1;
        }

        console.log();
        console.log(opts.dryRun
          ? `Dry run: ${recorded} workspace(s) would be recorded.`
          : `✓ Recorded ${recorded} workspace(s).`);

        if (needsOperator.length > 0) {
          console.log();
          console.log(`⚠ ${needsOperator.length} workspace(s) need a signing secret of their own.`);
          console.log('  Until then, on a stack with two or more active workspaces their webhook');
          console.log('  deliveries are rejected, because a shared secret cannot attest which');
          console.log('  workspace sent them. Fix each one with its own secret from Linear:');
          for (const w of needsOperator) {
            console.log(`    bgagent linear update-webhook-secret ${w.slug}`);
          }
        }
      }),
  );

  linear.addCommand(
    new Command('list-projects')
      .description('List Linear projects visible to the OAuth-installed workspace (with full UUIDs)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--slug <slug>', 'Linear workspace slug (urlKey). If omitted, queries every active workspace in the registry.')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;
        const sm = makeClient(SecretsManagerClient, { region });

        const slugs: string[] = opts.slug ? [opts.slug] : await listOnboardedWorkspaceSlugs({ sm });
        if (slugs.length === 0) {
          console.error('No Linear OAuth installs found. Run `bgagent linear setup <slug>` first.');
          process.exit(1);
        }

        type ProjectRow = {
          slug: string;
          id: string;
          name: string;
          team?: string;
        };
        const rows: ProjectRow[] = [];
        let answered = 0;

        const registryTableForVault = await findStackOutput(region, opts.stackName as string, 'LinearWorkspaceRegistryTableName');
        const ddbForVault = registryTableForVault ? makeDocClient({ region }) : undefined;
        const vaultWorkloadName = ddbForVault
          ? await resolveLinearVaultWorkloadName(region, opts.stackName as string)
          : LINEAR_VAULT_WORKLOAD_NAME_FALLBACK;

        for (const slug of slugs) {
          const token = await resolveWorkspaceAccessToken({
            slug,
            sm,
            ddb: ddbForVault,
            registryTableName: registryTableForVault ?? undefined,
            region,
            vaultWorkloadName,
          });
          if (token.kind !== 'token') {
            console.error(`Skipping '${slug}': ${token.reason}`);
            continue;
          }

          try {
            for (const p of await queryLinearProjects(token.accessToken)) {
              rows.push({
                slug,
                id: p.id,
                name: p.name,
                team: p.teams?.nodes?.[0]?.name,
              });
            }
            answered += 1;
          } catch (err) {
            console.error(`Failed to fetch projects for '${slug}': ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }

        if (answered < slugs.length) {
          process.exitCode = 1;
        }

        if (opts.output === 'json') {
          console.log(formatJson(rows));
          return;
        }

        if (rows.length === 0) {
          if (answered < slugs.length) {
            console.log(`No projects listed: ${slugs.length - answered} of ${slugs.length} workspace(s) could not be queried (see the errors above).`);
            return;
          }
          if (slugs.length === 1) {
            console.log(`Workspace '${slugs[0]}' has no projects yet.`);
            console.log(`Create one in Linear (https://linear.app/${slugs[0]}/), then re-run.`);
          } else {
            console.log(`No projects found in any of: ${slugs.join(', ')}.`);
            console.log('Create a project in at least one workspace, then re-run.');
          }
          return;
        }

        console.log(`Found ${rows.length} Linear project(s):\n`);
        for (const r of rows) {
          console.log(`  ${r.name}`);
          console.log(`    id:        ${r.id}`);
          console.log(`    workspace: ${r.slug}`);
          if (r.team) {
            console.log(`    team:      ${r.team}`);
          }
          console.log('');
        }
        console.log('Onboard with:');
        console.log('  bgagent linear onboard-project <id> --repo owner/repo [--label abca]');
      }),
  );

  return requireDeployedFeature(linear, 'linear');
}

interface LinearViewer {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
}

interface LinearOrganization {
  readonly id: string;
  readonly name?: string;
  readonly urlKey?: string;
}

interface LinearWorkspaceMember {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
}

/**
 * Outcome of a {@link queryLinearTeamKeys} call. An empty `keys` array is a
 * legitimate success (a workspace with no teams).
 */
export type TeamKeysResult =
  | { readonly ok: true; readonly keys: string[] }
  | { readonly ok: false; readonly error: unknown };

/**
 * Query the workspace's team keys (e.g. `["ABCA", "PLAT"]`).
 *
 * Every error layer is a failure, not an empty list. In particular Linear's
 * GraphQL API answers auth/scope/validation problems with **HTTP 200 and an
 * `errors` array**, whose `data` is absent. A missing `teams` connection is
 * treated as a malformed body: a real workspace always returns the connection,
 * empty (`{ nodes: [] }`) when it has no teams.
 */
export async function queryLinearTeamKeys(authorizationHeader: string): Promise<TeamKeysResult> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeader,
      },
      body: JSON.stringify({
        query: '{ teams(first: 100) { nodes { key } } }',
      }),
    });
    if (!res.ok) {
      return { ok: false, error: new Error(`Linear teams query returned HTTP ${res.status}`) };
    }
    const body = await res.json() as {
      data?: { teams?: { nodes?: Array<{ key?: string }> } };
      errors?: unknown;
    };
    if (body.errors) {
      return { ok: false, error: body.errors };
    }
    const teams = body.data?.teams;
    if (!teams) {
      return { ok: false, error: new Error('Linear teams query returned no `teams` connection') };
    }
    const keys = (teams.nodes ?? [])
      .map((t) => t.key)
      .filter((k): k is string => typeof k === 'string' && k.length > 0)
      .map((k) => k.toUpperCase());
    return { ok: true, keys: Array.from(new Set(keys)).sort() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

interface LinearProject {
  readonly id: string;
  readonly name: string;
  readonly teams?: { readonly nodes?: Array<{ readonly name: string }> };
}

async function queryLinearProjects(accessToken: string): Promise<LinearProject[]> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: '{ projects(first: 100) { nodes { id name teams(first: 1) { nodes { name } } } } }',
    }),
  });
  if (!res.ok) {
    throw new Error(`Linear API returned ${res.status}`);
  }
  const body = await res.json() as {
    data?: { projects?: { nodes?: LinearProject[] } };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  return body.data?.projects?.nodes ?? [];
}

async function queryLinearWorkspaceMembers(
  authorizationHeader: string,
): Promise<LinearWorkspaceMember[] | null> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeader,
      },
      body: JSON.stringify({
        query: '{ users(first: 100, filter: { active: { eq: true } }) { nodes { id name email } } }',
      }),
    });
    if (!res.ok) {
      console.log(`  ⚠ Linear API returned ${res.status}`);
      return null;
    }
    const body = await res.json() as { data?: { users?: { nodes?: LinearWorkspaceMember[] } } };
    return body.data?.users?.nodes ?? [];
  } catch (err) {
    console.log(`  ⚠ Could not query Linear workspace members: ${err instanceof Error ? err.message : String(err)}`);
    return null; // nosemgrep: ts-silent-success-masking -- setup self-link picker is optional UX; null skips the picker without failing setup
  }
}

async function runSelfLinkPicker(args: {
  ddb: DynamoDBDocumentClient;
  userMappingTable: string;
  accessToken: string;
  workspaceId: string;
  slug: string;
  cognitoSub: string;
  linkMethod: string;
}): Promise<boolean> {
  process.stdout.write('  → Querying Linear members so you can pick yourself...');
  const members = await queryLinearWorkspaceMembers(`Bearer ${args.accessToken}`);
  if (!members || members.length === 0) {
    console.log(' ✗');
    console.log('  ⚠ Could not list workspace members; skipping self-link.');
    console.log(`    Re-run \`bgagent linear setup ${args.slug}\` to retry the self-link picker, or label an issue and follow the warning.`);
    return false;
  }
  const humans = members.filter((m) => !(m.email ?? '').endsWith('@oauthapp.linear.app'));
  console.log(` ✓ (${humans.length} member${humans.length === 1 ? '' : 's'})`);
  if (humans.length === 0) {
    console.log('  ⚠ No human users in workspace yet; skipping self-link.');
    return false;
  }
  console.log();
  console.log('  Pick your Linear identity in this workspace:');
  humans.forEach((m, i) => {
    const email = m.email ? ` (${m.email})` : '';
    console.log(`    ${i + 1}. ${m.name ?? m.id}${email}`);
  });
  console.log();
  const pickRaw = (await promptLine(`  Which one is you? [1-${humans.length}]`)).trim();
  const pickIdx = parseInt(pickRaw, 10) - 1;
  if (Number.isNaN(pickIdx) || pickIdx < 0 || pickIdx >= humans.length) {
    console.log(`  ⚠ Invalid selection '${pickRaw}'; skipping self-link.`);
    console.log('    Re-run setup or pick yourself later via the picker that fires on first failed trigger.');
    return false;
  }
  const picked = humans[pickIdx];
  await args.ddb.send(new PutCommand({
    TableName: args.userMappingTable,
    Item: {
      linear_identity: `${args.workspaceId}#${picked.id}`,
      platform_user_id: args.cognitoSub,
      linear_workspace_id: args.workspaceId,
      linear_user_id: picked.id,
      linked_at: new Date().toISOString(),
      status: 'active',
      link_method: args.linkMethod,
    },
  }));
  const label = `${picked.name ?? picked.id}${picked.email ? ` (${picked.email})` : ''}`;
  console.log(`  ✓ Linked Linear user ${label} → your platform user`);
  return true;
}

async function queryLinearIdentity(
  authorizationHeader: string,
): Promise<{ viewer: LinearViewer; organization: LinearOrganization } | null> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeader,
      },
      body: JSON.stringify({
        query: '{ viewer { id name email } organization { id name urlKey } }',
      }),
    });
    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status}`);
    }
    const body = await res.json() as { data?: { viewer?: LinearViewer; organization?: LinearOrganization } };
    if (!body.data?.viewer?.id || !body.data.organization?.id) {
      throw new Error('Linear API response missing viewer.id or organization.id');
    }
    return { viewer: body.data.viewer, organization: body.data.organization };
  } catch (err) {
    console.log(`  ⚠ Could not query Linear identity: ${err instanceof Error ? err.message : String(err)}`);
    return null; // nosemgrep: ts-silent-success-masking -- auto-link is optional setup UX; null skips gracefully so admin can link manually
  }
}
