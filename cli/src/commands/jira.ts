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
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { loadConfig, loadCredentials } from '../config';
import { CliError } from '../errors';
import { formatJson } from '../format';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  fetchAccessibleResources,
  generatePkce,
  jiraOauthSecretName,
  StoredJiraOauthToken,
} from '../jira-oauth';
import { awaitOauthCallback, CALLBACK_URL } from '../oauth-callback-server';

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
 * Check whether the JiraWebhookSecret already holds a real signing secret
 * (vs CDK's autogenerated placeholder). Used to decide whether to prompt
 * for the webhook secret on subsequent setup runs.
 *
 * Atlassian's generic-webhook signing secrets are operator-chosen — they
 * have no fixed prefix like Linear's `lin_wh_`. We treat the placeholder
 * as a JSON-encoded value (CDK's default for autogenerated secrets) and
 * everything else as a real value.
 */
async function isWebhookSecretConfigured(
  client: SecretsManagerClient,
  secretArn: string,
): Promise<boolean> {
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    if (typeof value !== 'string' || value.length === 0) return false;
    // CDK's auto-generated secret is a JSON object string starting with `{`
    // — operator-set secrets (the Atlassian-side configured value) are bare
    // strings. Anything that doesn't look like the placeholder JSON is real.
    return !value.trim().startsWith('{');
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

function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Mute echo so secrets don't render in the terminal as the user types.
    const stdout = process.stdout as unknown as { write: (s: string) => boolean };
    const origWrite = stdout.write.bind(stdout);
    let muted = false;
    stdout.write = ((str: string) => {
      if (muted && str !== label) return true;
      return origWrite(str);
    }) as typeof stdout.write;
    rl.question(label, (answer) => {
      stdout.write = origWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
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
        console.log('       (an admin runs `bgagent jira invite-user` to issue you a code; this command');
        console.log('        is not yet implemented — populate the user-mapping row manually for now.)');
        console.log(`  3. Add the trigger label '${DEFAULT_LABEL_FILTER}' to a Jira issue in a mapped project.`);
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
