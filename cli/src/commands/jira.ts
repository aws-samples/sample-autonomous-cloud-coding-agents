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

import { execFile } from 'child_process';
import * as readline from 'readline';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { loadConfig, loadCredentials } from '../config';
import { CliError } from '../errors';
import { formatJson } from '../format';
import { generateInviteCode } from '../invite-code';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  fetchAccessibleResources,
  generatePkce,
  isAccessTokenExpiring,
  jiraOauthSecretName,
  parseStoredJiraOauthToken,
  refreshAccessToken,
  StoredJiraOauthToken,
} from '../jira-oauth';
import { awaitOauthCallback, CALLBACK_URL } from '../oauth-callback-server';
import { promptSecret } from '../prompt-secret';

/** Default label that triggers an ABCA task when applied to a Jira issue. */
const DEFAULT_LABEL_FILTER = 'bgagent';

/** Jira project keys are typically 2–10 uppercase chars, but Atlassian
 *  allows longer alphanumeric keys (and digits). Accept what Atlassian
 *  accepts at creation time. */
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,99}$/;

/** Width of the ═ rule used to frame the setup banner. */
const BANNER_WIDTH = 72;

/**
 * Render the printable Atlassian developer-console app config. Standalone
 * export so `bgagent jira setup` can call it inline.
 */
export interface JiraAppTemplateOptions {
  readonly developerName?: string;
  readonly description?: string;
  readonly callbackUrl?: string;
}

export function renderJiraAppTemplate(opts: JiraAppTemplateOptions = {}): string {
  const developerName = opts.developerName ?? 'ABCA';
  const description = opts.description ?? 'Autonomous Background Coding Agent';
  // Localhost callback works for everyone running setup interactively.
  // The redirect_uri value sent to Atlassian MUST byte-match what's
  // configured here.
  const callbackUrl = opts.callbackUrl ?? CALLBACK_URL;

  const bar = '═'.repeat(BANNER_WIDTH);
  return [
    bar,
    'Atlassian OAuth (3LO) app template',
    bar,
    '',
    'Open https://developer.atlassian.com/console/myapps/ → Create → OAuth 2.0',
    'integration, and enter:',
    '',
    `  Name:                bgagent — ${developerName}`,
    `  Description:         ${description}`,
    '',
    'In the new app, configure:',
    '',
    '  Permissions → Add APIs:',
    '    • Jira API    (scopes: read:jira-work, write:jira-work, read:jira-user)',
    '',
    '  Authorization → OAuth 2.0 (3LO):',
    `    Callback URL:    ${callbackUrl}`,
    '',
    '  Distribution:        Sharing OFF (private to your developer org)',
    '',
    'Save, then open Settings → copy the Client ID and Client Secret and return',
    'here.',
    '',
    'Why these specific fields:',
    '  • The 3 Jira scopes match what ABCA needs to read issues, post',
    '    comments, and resolve account → display name during link preview.',
    '  • offline_access is added implicitly by buildAuthorizationUrl — do',
    '    not enable it as a scope in the dev console UI; passing it in the',
    '    authorize request is sufficient and the dev console doesn\'t list',
    '    it as a togglable scope.',
    '  • The localhost callback removes the self-signed-cert browser warning',
    '    and works without a public hostname on the operator\'s machine.',
    bar,
  ].join('\n');
}

/**
 * Spawn the OS-default browser to open the given URL. Returns false on
 * failure so callers can fall back to printing the URL.
 */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let opener: { cmd: string; args: string[] };
    if (process.platform === 'darwin') {
      opener = { cmd: 'open', args: [url] };
    } else if (process.platform === 'win32') {
      opener = { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    } else {
      opener = { cmd: 'xdg-open', args: [url] };
    }
    execFile(opener.cmd, opener.args, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Generate an opaque, URL-safe `state` value for OAuth CSRF protection.
 */
function randomState(): string {
  const STATE_BYTES = 32;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return randomBytes(STATE_BYTES).toString('base64url');
}

/**
 * Idempotent secret upsert: tries CreateSecret first; if the secret
 * already exists, falls back to PutSecretValue. Returns the secret ARN
 * regardless of which branch ran.
 */
export async function upsertOauthSecret(
  client: SecretsManagerClient,
  secretName: string,
  payload: StoredJiraOauthToken,
  cloudId: string,
): Promise<string> {
  const secretString = JSON.stringify(payload);
  try {
    const create = await client.send(new CreateSecretCommand({
      Name: secretName,
      Description: `Jira OAuth token for tenant '${cloudId}'`,
      SecretString: secretString,
      Tags: [
        { Key: 'bgagent:integration', Value: 'jira' },
        { Key: 'bgagent:jira:cloud_id', Value: cloudId },
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
 * Marker key embedded in the CDK-generated stack-wide webhook-secret
 * placeholder. A secret whose JSON carries this key has never been
 * configured by an operator, so `setup` is free to seed the real value.
 *
 * MUST stay in sync with `JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY` in
 * `cdk/src/constructs/jira-integration.ts`. See #368.
 */
export const JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY = 'abca_jira_webhook_placeholder';

/**
 * Check whether the JiraWebhookSecret already holds a real, operator-set
 * signing secret (vs the CDK-generated placeholder). Used to decide whether
 * to seed the stack-wide secret on a `setup` run.
 *
 * Atlassian's generic-webhook signing secrets are operator-chosen — they have
 * no fixed prefix like Linear's `lin_wh_`, so we cannot positively recognize a
 * *real* value by shape. Instead we recognize the *placeholder*: the CDK
 * construct seeds an explicit JSON object carrying
 * `JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY`. Anything that is not that placeholder
 * is treated as an operator value.
 *
 * NOTE (#368 migration): stacks deployed before the explicit-placeholder fix
 * seeded a *bare random string* placeholder, which is indistinguishable from
 * an operator value and so is (conservatively) reported as configured. Such
 * installs must redeploy the CDK stack — which regenerates the secret with the
 * JSON placeholder — before `setup` will seed it.
 */
export async function isWebhookSecretConfigured(
  client: SecretsManagerClient,
  secretArn: string,
): Promise<boolean> {
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    if (typeof value !== 'string' || value.length === 0) return false;
    return !isWebhookSecretPlaceholder(value);
  } catch (err) {
    const errorName = (err as { name?: string }).name;
    if (errorName === 'ResourceNotFoundException') {
      return false;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Failed to read Jira webhook secret '${secretArn}': ${errorName ?? 'Error'}: ${message}. `
      + 'Likely IAM permission gap — confirm your CLI principal has '
      + '`secretsmanager:GetSecretValue` on this ARN.',
    );
  }
}

/**
 * True when `value` is the CDK-generated placeholder — a JSON object carrying
 * the {@link JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY} marker. A non-JSON value, or
 * JSON without the marker, is an operator-set secret.
 */
function isWebhookSecretPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  // Fast reject: real Atlassian signing secrets are bare strings.
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      typeof parsed === 'object'
      && parsed !== null
      && JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY in (parsed as Record<string, unknown>)
    );
  } catch {
    // Starts with `{` but isn't valid JSON — not our placeholder. Treat as a
    // (malformed) operator value rather than silently re-seeding over it.
    return false; // nosemgrep: ts-silent-success-masking -- unparseable secret is conservatively treated as operator-set (not the placeholder), so setup never overwrites it
  }
}

interface JiraUserSearchResult {
  readonly accountId?: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
  readonly active?: boolean;
  readonly accountType?: string;
}

function isJiraUser(value: unknown): value is JiraUserSearchResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.accountId === 'string' && obj.accountId.length > 0;
}

function isLinkableJiraUser(user: JiraUserSearchResult): boolean {
  return user.active !== false && user.accountType !== 'app';
}

function formatJiraUserLabel(user: JiraUserSearchResult): string {
  const name = user.displayName || user.accountId || '(unknown)';
  return `${name}${user.emailAddress ? ` (${user.emailAddress})` : ''}`;
}

async function parseJiraJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CliError(`Atlassian ${context} returned non-JSON: HTTP ${response.status}.`);
  }
}

async function fetchJiraUserByAccountId(
  accessToken: string,
  cloudId: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<JiraUserSearchResult | null> {
  const url = new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/user`);
  url.searchParams.set('accountId', accountId);
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CliError(
      `Atlassian Jira user lookup failed: HTTP ${response.status}. `
      + 'The stored OAuth token may be expired/revoked or missing read:jira-user.',
    );
  }
  const parsed = await parseJiraJson(response, 'Jira user lookup');
  if (!isJiraUser(parsed)) {
    throw new CliError(`Atlassian Jira user lookup returned an unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
}

async function searchJiraUsers(
  accessToken: string,
  cloudId: string,
  query: string,
  fetchImpl: typeof fetch,
): Promise<JiraUserSearchResult[]> {
  const url = new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/user/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('maxResults', '10');
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new CliError(
      `Atlassian Jira user search failed: HTTP ${response.status}. `
      + 'The stored OAuth token may be expired/revoked or missing read:jira-user.',
    );
  }
  const parsed = await parseJiraJson(response, 'Jira user search');
  if (!Array.isArray(parsed)) {
    throw new CliError(`Atlassian Jira user search returned an unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed.filter(isJiraUser);
}

async function resolveJiraUser(
  accessToken: string,
  cloudId: string,
  accountIdOrEmail: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraUserSearchResult> {
  const query = accountIdOrEmail.trim();
  if (!query) {
    throw new CliError('Jira account id or email is required.');
  }

  if (!query.includes('@')) {
    const direct = await fetchJiraUserByAccountId(accessToken, cloudId, query, fetchImpl);
    if (direct) {
      if (!isLinkableJiraUser(direct)) {
        throw new CliError(`Jira account '${query}' is inactive or is an app account.`);
      }
      return direct;
    }
  }

  const users = (await searchJiraUsers(accessToken, cloudId, query, fetchImpl)).filter(isLinkableJiraUser);
  const exactAccountId = users.find((user) => user.accountId === query);
  if (exactAccountId) return exactAccountId;

  if (query.includes('@')) {
    const lowerQuery = query.toLowerCase();
    const exactEmail = users.find((user) => (user.emailAddress ?? '').toLowerCase() === lowerQuery);
    if (exactEmail) return exactEmail;
  }

  if (users.length === 1) return users[0];
  if (users.length === 0) {
    throw new CliError(`No active Jira user found for '${query}' in tenant '${cloudId}'.`);
  }

  const candidates = users.map((user) => `- ${formatJiraUserLabel(user)} [${user.accountId}]`).join('\n');
  throw new CliError(
    `Jira user lookup for '${query}' returned multiple users. Re-run with the accountId for the intended user:\n${candidates}`,
  );
}

function promptLine(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label.endsWith(' ') ? label : `${label} `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function extractCognitoSub(): string {
  const creds = loadCredentials();
  if (!creds?.id_token) {
    throw new Error('not authenticated — run `bgagent login`');
  }
  const JWT_SEGMENTS = 3; // header.payload.signature
  const parts = creds.id_token.split('.');
  if (parts.length !== JWT_SEGMENTS) {
    throw new Error('malformed id_token in ~/.bgagent/credentials.json');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { sub?: string };
  if (!payload.sub) {
    throw new Error('id_token missing `sub` claim');
  }
  return payload.sub;
}

async function getStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  try {
    const cfn = new CloudFormationClient({ region });
    const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = result.Stacks?.[0]?.Outputs ?? [];
    const output = outputs.find((o) => o.OutputKey === outputKey);
    return output?.OutputValue ?? null;
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    const message = (err as Error)?.message ?? '';
    if (name === 'ValidationError' && /does not exist/i.test(message)) {
      return null;
    }
    throw err;
  }
}

export function makeJiraCommand(): Command {
  const jira = new Command('jira')
    .description('Manage Jira Cloud integration');

  // ─── app-template ─────────────────────────────────────────────────────────
  jira.addCommand(
    new Command('app-template')
      .description('Print the field values to paste into Atlassian\'s developer-console OAuth app form')
      .option('--developer-name <name>', 'Developer name shown on Atlassian\'s consent screen')
      .option('--description <text>', 'App description shown on Atlassian\'s consent screen')
      .option('--callback-url <url>', 'OAuth callback URL (defaults to localhost:8080/oauth/callback)')
      .action((opts) => {
        console.log(renderJiraAppTemplate({
          developerName: opts.developerName,
          description: opts.description,
          callbackUrl: opts.callbackUrl,
        }));
      }),
  );

  // ─── setup ────────────────────────────────────────────────────────────────
  jira.addCommand(
    new Command('setup')
      .description('Authorize a Jira Cloud tenant via OAuth (3LO direct flow, Secrets Manager storage)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--client-id <id>', 'Atlassian OAuth app Client ID (else prompted)')
      .option('--client-secret <secret>', 'Atlassian OAuth app Client Secret (else prompted; prefer interactive)')
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        // ─── Stack outputs ───────────────────────────────────────────────
        const [
          workspaceRegistryTable,
          webhookSecretArn,
        ] = await Promise.all([
          getStackOutput(region, stackName, 'JiraWorkspaceRegistryTableName'),
          getStackOutput(region, stackName, 'JiraWebhookSecretArn'),
        ]);

        const missing: string[] = [];
        if (!workspaceRegistryTable) missing.push('JiraWorkspaceRegistryTableName');
        if (!webhookSecretArn) missing.push('JiraWebhookSecretArn');
        if (missing.length > 0) {
          throw new CliError(
            `Stack '${stackName}' is missing outputs ${missing.join(', ')}. `
            + 'Re-deploy with the JiraIntegration CDK changes (mise //cdk:deploy).',
          );
        }

        // ─── Resolve caller identity ─────────────────────────────────────
        const creds = loadCredentials();
        if (!creds?.id_token) {
          throw new CliError('Not authenticated — run `bgagent login` first.');
        }
        let cognitoSub: string;
        try {
          cognitoSub = extractCognitoSub();
        } catch (err) {
          throw new CliError(
            `Could not read Cognito sub from cached id_token: ${err instanceof Error ? err.message : String(err)}. `
            + 'Run `bgagent login` to refresh credentials.',
          );
        }

        // ─── Atlassian OAuth app credentials ─────────────────────────────
        console.log('bgagent jira setup');
        console.log(`  region: ${region}`);
        console.log(
          '\nAtlassian OAuth app credentials needed. If you have not created one, run `bgagent jira app-template`'
          + ' for the values to paste into developer.atlassian.com → My apps.\n',
        );
        const clientId = (opts.clientId ?? await promptSecret('Atlassian Client ID: ')).trim();
        if (!clientId) {
          throw new CliError('Client ID is required.');
        }
        const clientSecret = (opts.clientSecret ?? await promptSecret('Atlassian Client Secret: ')).trim();
        if (!clientSecret) {
          throw new CliError('Client Secret is required.');
        }

        // ─── Step 1: Generate PKCE + open browser to Atlassian consent ───
        const pkce = generatePkce();
        const state = randomState();
        const authorizationUrl = buildAuthorizationUrl({
          clientId,
          redirectUri: CALLBACK_URL,
          state,
          codeChallenge: pkce.codeChallenge,
        });

        const callbackPromise = awaitOauthCallback();

        console.log();
        if (opts.browser !== false) {
          const opened = await openBrowser(authorizationUrl);
          if (opened) {
            console.log('  → Opened your browser to the Atlassian consent screen.');
            console.log('    The browser will redirect to a localhost page after you Authorize — that\'s expected.');
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
            + 'Verify Atlassian\'s redirect URI is set to http://localhost:8080/oauth/callback and re-run.',
          );
        }
        if (callback.state !== state) {
          throw new CliError(
            `OAuth state mismatch (expected '${state}', got '${callback.state}'). `
            + 'Possible CSRF attack or stale tab — re-run setup.',
          );
        }

        // ─── Step 2: Exchange code for access token ──────────────────────
        process.stdout.write('  → Exchanging code for access token...');
        const tokenResponse = await exchangeAuthorizationCode({
          code: callback.code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: CALLBACK_URL,
          clientId,
          clientSecret,
        });
        console.log(' ✓');

        if (!tokenResponse.refresh_token) {
          throw new CliError(
            'Atlassian did not return a refresh_token. The integration cannot self-renew tokens; '
            + 'verify the OAuth app requested the offline_access scope (re-run with the latest CLI; '
            + 'this is in the default scope list).',
          );
        }

        // ─── Step 3: Fetch accessible resources (cloudId + siteUrl) ──────
        process.stdout.write('  → Fetching accessible Atlassian sites...');
        const resources = await fetchAccessibleResources(tokenResponse.access_token);
        if (resources.length === 0) {
          throw new CliError(
            'Atlassian returned no accessible sites for the issued token. '
            + 'The user that authorized may not have access to any Jira sites — verify and re-run.',
          );
        }
        console.log(` ✓ (${resources.length} site${resources.length === 1 ? '' : 's'})`);

        let chosen = resources[0];
        if (resources.length > 1) {
          console.log();
          console.log('  Multiple Atlassian sites are accessible:');
          resources.forEach((r, i) => {
            console.log(`    [${i + 1}] ${r.name}  (${r.url})`);
          });
          const pick = (await promptLine(`  Select site [1-${resources.length}]:`)).trim();
          const idx = Number.parseInt(pick, 10) - 1;
          if (Number.isNaN(idx) || idx < 0 || idx >= resources.length) {
            throw new CliError(`Invalid selection '${pick}'.`);
          }
          chosen = resources[idx];
        }

        const cloudId = chosen.id;
        const siteUrl = chosen.url;
        console.log(`  Selected: ${chosen.name}`);
        console.log(`  cloud_id: ${cloudId}`);
        console.log(`  site_url: ${siteUrl}`);

        // ─── Step 4: Persist token to per-tenant Secrets Manager ─────────
        process.stdout.write('  → Storing OAuth token...');
        const sm = new SecretsManagerClient({ region });
        const now = new Date().toISOString();
        const stored: StoredJiraOauthToken = {
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token,
          expires_at: computeExpiresAt(tokenResponse.expires_in),
          scope: tokenResponse.scope,
          client_id: clientId,
          client_secret: clientSecret,
          cloud_id: cloudId,
          site_url: siteUrl,
          installed_at: now,
          updated_at: now,
          installed_by_platform_user_id: cognitoSub,
        };
        const secretName = jiraOauthSecretName(cloudId);
        const oauthSecretArn = await upsertOauthSecret(sm, secretName, stored, cloudId);
        console.log(` ✓ (${secretName})`);

        // ─── Step 5: Persist registry row ────────────────────────────────
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
        await ddb.send(new PutCommand({
          TableName: workspaceRegistryTable!,
          Item: {
            jira_cloud_id: cloudId,
            site_url: siteUrl,
            oauth_secret_arn: oauthSecretArn,
            installed_by_platform_user_id: cognitoSub,
            installed_at: now,
            updated_at: now,
            status: 'active',
          },
        }));
        console.log('  ✓ Recorded tenant in registry');

        // ─── Step 6: Webhook signing secret (per-tenant primary) ─────────
        //
        // Atlassian doesn't auto-generate webhook signing secrets — they're
        // operator-chosen at webhook-create time in the Jira admin UI, and
        // each tenant's webhook is configured independently with its OWN
        // secret. So we always prompt for THIS tenant's secret and store it
        // on the per-tenant OAuth bundle — the primary verification path.
        //
        // We deliberately do NOT copy an existing stack-wide secret into a
        // new tenant's bundle (the old behavior): that would make tenant A's
        // secret verify per-tenant for tenant B, and a holder of the
        // stack-wide secret could then forge per-tenant-signed events for any
        // tenant. The stack-wide secret is only seeded once, from the FIRST
        // tenant's secret, as the single-tenant back-compat fallback.
        const apiBaseUrl = config.api_url.replace(/\/+$/, '');
        console.log();
        console.log('  Webhook signing secret needed for THIS tenant.');
        console.log('  In Jira → Settings → System → Webhooks → Create a Webhook:');
        console.log(`    URL:           ${apiBaseUrl}/jira/webhook`);
        console.log('    Events:        Issue: created, updated');
        console.log('    Secret:        choose a strong random value (e.g. `openssl rand -hex 32`)');
        console.log();
        const webhookSigningSecret = await promptSecret('Webhook signing secret: ');
        if (!webhookSigningSecret) {
          throw new CliError('Webhook signing secret is required.');
        }

        const merged: StoredJiraOauthToken = {
          ...stored,
          webhook_signing_secret: webhookSigningSecret,
          updated_at: new Date().toISOString(),
        };
        await upsertOauthSecret(sm, secretName, merged, cloudId);
        console.log('  ✓ Stored signing secret on the per-tenant OAuth bundle');

        // Seed the stack-wide fallback only if it has never been set, so a
        // single-tenant install (no per-tenant routing) still verifies. Once
        // a second tenant onboards, its secret is per-tenant only — the
        // stack-wide secret stays pinned to the first tenant.
        const stackWideAlreadyConfigured = await isWebhookSecretConfigured(sm, webhookSecretArn!);
        if (stackWideAlreadyConfigured) {
          console.log('  ✓ Stack-wide fallback already configured (leaving as-is)');
        } else {
          await sm.send(new PutSecretValueCommand({
            SecretId: webhookSecretArn!,
            SecretString: webhookSigningSecret,
          }));
          console.log('  ✓ Seeded stack-wide fallback for single-tenant back-compat');
        }

        // ─── Done ─────────────────────────────────────────────────────────
        console.log();
        console.log('✅ Setup complete.');
        console.log();
        console.log('Next steps:');
        console.log('  1. Map a Jira project to a GitHub repo:');
        console.log(`       bgagent jira map ${cloudId} <PROJECT-KEY> --repo owner/repo`);
        console.log('  2. Link your Jira account so triggered tasks attribute to your platform user:');
        console.log(`       bgagent jira invite-user ${cloudId} <account-id-or-email>`);
        console.log('       bgagent jira link <code>');
        console.log(`  3. Add the trigger label '${DEFAULT_LABEL_FILTER}' to a Jira issue in a mapped project.`);
      }),
  );

  // ─── invite-user ──────────────────────────────────────────────────────────
  jira.addCommand(
    new Command('invite-user')
      .description('Generate a one-time code for a Jira teammate to redeem via `bgagent jira link <code>`')
      .argument('<cloud-id>', 'Atlassian tenant cloudId (UUID)')
      .argument('<account-id-or-email>', 'Jira accountId or email address for the teammate')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (cloudId: string, accountIdOrEmail: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const [workspaceRegistryTable, userMappingTable] = await Promise.all([
          getStackOutput(region, stackName, 'JiraWorkspaceRegistryTableName'),
          getStackOutput(region, stackName, 'JiraUserMappingTableName'),
        ]);
        const missing: string[] = [];
        if (!workspaceRegistryTable) missing.push('JiraWorkspaceRegistryTableName');
        if (!userMappingTable) missing.push('JiraUserMappingTableName');
        if (missing.length > 0) {
          throw new CliError(
            `Stack '${stackName}' is missing outputs ${missing.join(', ')}. `
            + 'Re-deploy with the JiraIntegration CDK changes (mise //cdk:deploy).',
          );
        }

        const creds = loadCredentials();
        if (!creds?.id_token) {
          throw new CliError('Not authenticated — run `bgagent login` first.');
        }
        const callerCognitoSub = extractCognitoSub();

        const sm = new SecretsManagerClient({ region });
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

        const registry = await ddb.send(new GetCommand({
          TableName: workspaceRegistryTable!,
          Key: { jira_cloud_id: cloudId },
        }));
        const registryRow = registry.Item;
        if (!registryRow || registryRow.status !== 'active') {
          throw new CliError(
            `Jira tenant '${cloudId}' is not in the registry (or status != 'active'). `
            + 'Run `bgagent jira setup` for that tenant first.',
          );
        }
        const oauthSecretArn = registryRow.oauth_secret_arn as string | undefined;
        if (!oauthSecretArn) {
          throw new CliError(`Jira tenant '${cloudId}' registry row is missing oauth_secret_arn. Re-run \`bgagent jira setup\`.`);
        }
        const siteUrl = (registryRow.site_url as string | undefined) ?? '';

        const oauthSecret = await sm.send(new GetSecretValueCommand({ SecretId: oauthSecretArn }));
        let stored = parseStoredJiraOauthToken(oauthSecret.SecretString, oauthSecretArn);

        console.log(`bgagent jira invite-user — tenant '${cloudId}'`);
        console.log(`  region: ${region}`);
        if (siteUrl) {
          console.log(`  site:   ${siteUrl}`);
        }

        if (isAccessTokenExpiring(stored.expires_at)) {
          process.stdout.write('  → Refreshing Jira OAuth token...');
          const refreshed = await refreshAccessToken({
            refreshToken: stored.refresh_token,
            clientId: stored.client_id,
            clientSecret: stored.client_secret,
          });
          if (!refreshed.refresh_token) {
            console.log(' ✗');
            throw new CliError('Atlassian refresh_token grant returned no refresh_token. Re-run `bgagent jira setup`.');
          }
          stored = {
            ...stored,
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token,
            expires_at: computeExpiresAt(refreshed.expires_in),
            scope: refreshed.scope,
            updated_at: new Date().toISOString(),
          };
          await sm.send(new PutSecretValueCommand({
            SecretId: oauthSecretArn,
            SecretString: JSON.stringify(stored),
          }));
          console.log(' ✓');
        }

        process.stdout.write('  → Resolving Jira user...');
        let picked: JiraUserSearchResult;
        try {
          picked = await resolveJiraUser(stored.access_token, cloudId, accountIdOrEmail);
          console.log(` ✓ (${formatJiraUserLabel(picked)})`);
        } catch (err) {
          console.log(' ✗');
          throw err;
        }

        // Warn (don't block) if this Jira identity is already linked, so the
        // admin knows a fresh invite will re-link an existing teammate. The
        // active row key mirrors the jira-link handler: `<cloudId>#<accountId>`.
        const existing = await ddb.send(new GetCommand({
          TableName: userMappingTable!,
          Key: { jira_identity: `${cloudId}#${picked.accountId}` },
        }));
        if (existing.Item && existing.Item.status === 'active') {
          console.log();
          console.log(`  ⚠ ${formatJiraUserLabel(picked)} is already linked in this tenant.`);
          console.log('    Redeeming this code will re-link them to whoever runs `bgagent jira link`.');
        }

        const code = generateInviteCode();
        const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
        try {
          await ddb.send(new PutCommand({
            TableName: userMappingTable!,
            // Guard against clobbering an existing pending invite on the
            // (astronomically unlikely) chance the generated code collides.
            // Better to fail loudly and let the admin re-run than silently
            // overwrite a still-valid code.
            ConditionExpression: 'attribute_not_exists(jira_identity)',
            Item: {
              jira_identity: `pending#${code}`,
              status: 'pending',
              jira_cloud_id: cloudId,
              jira_site_url: siteUrl,
              jira_account_id: picked.accountId,
              jira_user_name: picked.displayName ?? '',
              jira_user_email: picked.emailAddress ?? '',
              invited_at: new Date().toISOString(),
              invited_by_platform_user_id: callerCognitoSub,
              ttl,
            },
          }));
        } catch (err) {
          if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
            throw new CliError(`Invite code '${code}' collided with an existing invite. Re-run the command to mint a fresh code.`);
          }
          throw err;
        }

        console.log();
        console.log('✅ Invite created.');
        console.log();
        console.log('  Send this to the teammate (Slack/email/etc):');
        console.log();
        console.log(`      bgagent jira link ${code}`);
        console.log();
        console.log(`  Picked Jira user: ${formatJiraUserLabel(picked)}`);
        console.log(`  Jira tenant:      ${siteUrl || cloudId}`);
        console.log(`  Code expires:     ${new Date(ttl * 1000).toISOString()} (24h)`);
        console.log();
        console.log('  The teammate sees the Jira identity above and confirms before the');
        console.log('  mapping is written. If you picked the wrong user, the teammate aborts.');
      }),
  );

  // ─── link ─────────────────────────────────────────────────────────────────
  jira.addCommand(
    new Command('link')
      .description('Redeem an invite code from `bgagent jira invite-user` to link your Jira identity')
      .argument('<code>', 'One-time invite code')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (code: string, opts) => {
        const client = new ApiClient();

        if (opts.output !== 'json') {
          const preview = await client.jiraLink(code, { dryRun: true });
          const name = preview.jira_user_name || preview.jira_account_id;
          const email = preview.jira_user_email ? ` (${preview.jira_user_email})` : '';
          const tenantLabel = preview.jira_site_url || preview.jira_cloud_id;
          console.log('You are about to link the following Jira identity to YOUR ABCA account:');
          console.log();
          console.log(`  Jira user:    ${name}${email}`);
          console.log(`  Jira tenant:  ${tenantLabel}`);
          console.log();
          console.log('After linking, tasks triggered by this Jira user will be attributed to');
          console.log('your platform user (concurrency caps, billing, `bgagent list`).');
          console.log();
          const confirm = (await promptLine('Continue? [Y/n]')).trim().toLowerCase();
          if (confirm && confirm !== 'y' && confirm !== 'yes') {
            console.log('Aborted. The invite code is still valid until it expires.');
            return;
          }
        }

        const result = await client.jiraLink(code);
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log();
          console.log('✅ Jira account linked.');
          console.log(`  Linked at: ${result.linked_at}`);
        }
      }),
  );

  // ─── map ──────────────────────────────────────────────────────────────────
  jira.addCommand(
    new Command('map')
      .description('Map a Jira project to a GitHub repository (admin IAM required)')
      .argument('<cloud-id>', 'Atlassian tenant cloudId (UUID)')
      .argument('<project-key>', 'Jira project key (e.g. ENG)')
      .requiredOption('--repo <owner/repo>', 'GitHub repository the mapped project should route tasks to')
      .option('--label <label>', `Label that triggers a task (default: ${DEFAULT_LABEL_FILTER})`, DEFAULT_LABEL_FILTER)
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (cloudId: string, projectKey: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const tableName = await getStackOutput(region, opts.stackName, 'JiraProjectMappingTableName');
        if (!tableName) {
          console.error('Could not find JiraProjectMappingTableName in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) {
          console.error(`Invalid --repo value: ${opts.repo}. Expected owner/repo.`);
          process.exit(1);
        }

        if (!PROJECT_KEY_RE.test(projectKey)) {
          console.error(`Invalid Jira project key: ${projectKey}`);
          console.error('Project keys are uppercase, start with a letter, and contain letters/digits/underscore.');
          process.exit(1);
        }

        const now = new Date().toISOString();
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: {
            jira_project_identity: `${cloudId}#${projectKey}`,
            cloud_id: cloudId,
            project_key: projectKey,
            repo: opts.repo,
            label_filter: opts.label,
            status: 'active',
            onboarded_at: now,
            updated_at: now,
          },
        }));

        console.log(`✓ Mapped Jira project ${cloudId}#${projectKey} → ${opts.repo}`);
        console.log(`  Trigger label: ${opts.label}`);
      }),
  );

  return jira;
}
