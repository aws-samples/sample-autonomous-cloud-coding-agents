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
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { loadConfig, loadCredentials } from '../config';
import { CliError } from '../errors';
import { formatJson } from '../format';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  generatePkce,
  linearOauthSecretName,
  StoredLinearOauthToken,
} from '../linear-oauth';
import { awaitOauthCallback, CALLBACK_URL } from '../oauth-callback-server';

/** Default label that triggers an ABCA task when applied to a Linear issue. */
const DEFAULT_LABEL_FILTER = 'bgagent';

/** Standard RFC 4122 UUID — Linear's `projects.nodes[].id` matches this shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render the printable Linear OAuth app config. Standalone export so
 * `bgagent linear setup` can call it inline (Phase 2.0b setup wizard
 * Step 2 — show the user what to paste into Linear's app form).
 */
export interface LinearAppTemplateOptions {
  readonly botName?: string;
  readonly developerName?: string;
  readonly developerUrl?: string;
  readonly description?: string;
  readonly awsCallbackUrl?: string;
}

export function renderLinearAppTemplate(opts: LinearAppTemplateOptions = {}): string {
  // Defaults match the upstream sample so unmodified `bgagent linear app-template`
  // produces a usable config without forcing every operator to invent strings.
  // Operators with custom branding override via flags.
  const botName = opts.botName ?? 'bgagent[bot]';
  const developerName = opts.developerName ?? 'ABCA';
  const developerUrl = opts.developerUrl ?? 'https://github.com/aws-samples/sample-autonomous-cloud-coding-agents';
  const description = opts.description ?? 'Autonomous Background Coding Agent';
  // The AWS-hosted callback is surfaced by `aws bedrock-agentcore-control
  // create-oauth2-credential-provider` once per workspace. If unknown at
  // template-render time, print a placeholder the operator must replace.
  const awsCallback = opts.awsCallbackUrl
    ?? '<paste callbackUrl from `aws bedrock-agentcore-control create-oauth2-credential-provider`>';

  const bar = '═'.repeat(72);
  return [
    bar,
    'Linear OAuth app template',
    bar,
    '',
    'Open https://linear.app/settings/api/applications/new and paste:',
    '',
    '  Application name:    bgagent',
    `  Developer name:      ${developerName}`,
    `  Developer URL:       ${developerUrl}`,
    `  Description:         ${description}`,
    '',
    '  Callback URLs (one per line, NO line wrapping):',
    `    ${awsCallback}`,
    '',
    `  GitHub username:     ${botName}      ← REQUIRED for actor=app`,
    '  Public:              OFF',
    '  Client credentials:  OFF',
    '  Webhooks:            ON              ← REQUIRED for actor=app',
    '    Webhook URL:       https://example.com/placeholder  ← any HTTPS URL',
    '    (You do NOT need to subscribe to any events for the OAuth flow itself)',
    '',
    'Click Save, copy the Client ID and Client Secret, then return here.',
    '',
    'Why these specific fields:',
    '  • GitHub username with [bot] suffix gates the actor=app agent flow.',
    '    Without it, Linear surfaces a misleading "Invalid redirect_uri" error.',
    '  • Webhooks toggle must be ON for the same reason; the URL value is unused',
    '    by the OAuth dance and can be a placeholder.',
    '  • Wildcard callback URLs are not accepted by Linear; list each URL fully.',
    bar,
  ].join('\n');
}

/**
 * Validate a Linear workspace slug. Used to keep the per-workspace
 * Secrets Manager secret name (`bgagent-linear-oauth-<slug>`) within
 * AWS's 64-char limit and to confirm the slug is the Linear `urlKey`
 * shape (Linear's `urlKey` matches `[a-zA-Z0-9_-]+`).
 */
const SLUG_RE = /^[a-zA-Z0-9_-]{4,50}$/;

/**
 * Open `url` in the user's default browser. Returns true on best-effort
 * success, false if no opener is available (e.g. headless SSH session) so
 * callers can fall back to printing the URL.
 *
 * Uses `child_process.execFile` directly rather than a dependency like
 * `open` — no need for a 200-line module to spawn one shell command.
 */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let opener: { cmd: string; args: string[] };
    if (process.platform === 'darwin') {
      opener = { cmd: 'open', args: [url] };
    } else if (process.platform === 'win32') {
      // `start` is a cmd.exe builtin; URLs need empty title arg + escaping.
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
 * Check whether the LinearWebhookSecret already holds a real Linear
 * signing secret (vs CDK's autogenerated placeholder). Used to decide
 * whether to prompt for the webhook secret on subsequent setup runs.
 *
 * Linear's webhook signing secrets start with `lin_wh_` — the placeholder
 * is a CDK-generated random JSON-encoded string that doesn't match.
 *
 * Returns true if a real secret is stored, false otherwise (including
 * any error fetching — best-effort; a re-prompt is harmless).
 */
export async function isWebhookSecretConfigured(
  client: SecretsManagerClient,
  secretArn: string,
): Promise<boolean> {
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    return typeof value === 'string' && value.startsWith('lin_wh_');
  } catch (err) {
    // Only treat "secret doesn't exist yet" as a clean false — any
    // other error (AccessDenied, KMS decrypt failure, throttling) is
    // actionable and we should surface it. A bare `catch { return
    // false }` here makes setup re-prompt for a webhook secret when
    // the real problem is IAM, which is a confusing UX for operators.
    const errorName = (err as { name?: string }).name;
    if (errorName === 'ResourceNotFoundException') {
      return false;
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
 * Generate an opaque, URL-safe `state` value for OAuth CSRF protection.
 * 32 bytes of crypto-randomness — enough that collisions and guesses
 * are not realistic concerns.
 */
function randomState(): string {
  // Lazy import to keep `crypto` out of module-load surface for non-OAuth
  // uses of this command file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return randomBytes(32).toString('base64url');
}

/**
 * Idempotent secret upsert: tries CreateSecret first; if the secret
 * already exists (re-running setup, rotating refresh token), falls
 * back to PutSecretValue. Returns the secret ARN regardless of which
 * branch ran.
 *
 * The Phase 2.0b-O2 design stores OAuth tokens at runtime (CLI creates
 * the secret, not CDK), so the wizard owns this lifecycle.
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
      // Tags help with cost allocation and the deletion-runbook discoverability.
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
 * Used by `bgagent linear add-workspace` so the operator doesn't have to
 * re-paste the same Linear OAuth app credentials they already typed during
 * the initial `bgagent linear setup`. Same Linear OAuth app can authorize
 * multiple workspaces — Linear scopes consent per-workspace, but the app's
 * client_id/client_secret are workspace-independent.
 *
 * Returns null when there's no existing active workspace, signalling that
 * the operator should run `bgagent linear setup` first.
 */
export async function findReusableOauthAppCredentials(
  ddb: DynamoDBDocumentClient,
  sm: SecretsManagerClient,
  registryTableName: string,
): Promise<{ clientId: string; clientSecret: string; sourceSlug: string } | null> {
  // Limit=1 keeps the scan cheap. The registry table is one row per
  // workspace install (small N) so a scan is acceptable here.
  const scan = await ddb.send(new ScanCommand({
    TableName: registryTableName,
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':active': 'active' },
    Limit: 1,
  }));
  const row = scan.Items?.[0];
  if (!row || !row.oauth_secret_arn || !row.workspace_slug) {
    return null;
  }
  const value = await sm.send(new GetSecretValueCommand({ SecretId: row.oauth_secret_arn as string }));
  if (!value.SecretString) {
    return null;
  }
  let parsed: Partial<StoredLinearOauthToken>;
  try {
    parsed = JSON.parse(value.SecretString) as Partial<StoredLinearOauthToken>;
  } catch {
    return null;
  }
  if (!parsed.client_id || !parsed.client_secret) {
    return null;
  }
  return {
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    sourceSlug: row.workspace_slug as string,
  };
}

export function makeLinearCommand(): Command {
  const linear = new Command('linear')
    .description('Manage Linear integration');

  linear.addCommand(
    new Command('app-template')
      .description('Print the field values to paste into Linear\'s OAuth app form')
      .option('--bot-name <name>', 'GitHub username for actor=app (must end with [bot])')
      .option('--developer-name <name>', 'Developer name shown on Linear\'s consent screen')
      .option('--developer-url <url>', 'Developer URL shown on Linear\'s consent screen')
      .option('--description <text>', 'App description shown on Linear\'s consent screen')
      .option('--aws-callback-url <url>', 'AWS-hosted callback URL from create-oauth2-credential-provider')
      .action((opts) => {
        if (opts.botName && !/\[bot\]$/.test(opts.botName)) {
          console.error(
            'Error: --bot-name must end with the literal "[bot]" suffix '
            + `(Linear requires this for actor=app). Got: ${opts.botName}`,
          );
          process.exit(1);
        }
        console.log(renderLinearAppTemplate({
          botName: opts.botName,
          developerName: opts.developerName,
          developerUrl: opts.developerUrl,
          description: opts.description,
          awsCallbackUrl: opts.awsCallbackUrl,
        }));
      }),
  );

  linear.addCommand(
    new Command('link')
      .description('Link your Linear account using a verification code')
      .argument('<code>', 'Verification code from Linear')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (code: string, opts) => {
        const client = new ApiClient();
        const result = await client.linearLink(code);

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log('Linear account linked successfully.');
          console.log(`  Workspace: ${result.linear_workspace_id}`);
          console.log(`  User:      ${result.linear_user_id}`);
          console.log(`  Linked at: ${result.linked_at}`);
        }
      }),
  );

  linear.addCommand(
    new Command('setup')
      .description('Authorize a Linear workspace via OAuth (Phase 2.0b — direct flow, Secrets Manager storage)')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--client-id <id>', 'Linear OAuth app Client ID (else prompted)')
      .option('--client-secret <secret>', 'Linear OAuth app Client Secret (else prompted; prefer interactive)')
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
      .option('--rotate-webhook-secret', 'Re-prompt for the webhook signing secret even if one is already configured')
      .option('--no-actor-app', 'Drop actor=app from the OAuth flow (diagnostic: isolates whether agent-install is blocking)')
      .action(async (slug: string, opts) => {
        if (!SLUG_RE.test(slug)) {
          throw new CliError(
            `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
            + 'This is the Linear urlKey, e.g. \'acme\' from linear.app/acme/...',
          );
        }
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        // ─── Stack outputs ─────────────────────────────────────────────
        const [
          workspaceRegistryTable,
          userMappingTable,
          webhookSecretArn,
        ] = await Promise.all([
          getStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
          getStackOutput(region, stackName, 'LinearUserMappingTableName'),
          getStackOutput(region, stackName, 'LinearWebhookSecretArn'),
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

        // ─── Resolve caller identity ──────────────────────────────────
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

        // ─── Linear OAuth app credentials ──────────────────────────────
        // Prompted up-front so the wizard doesn't get halfway through the
        // OAuth dance before realising it can't continue.
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

        // ─── Step 1: Generate PKCE + open browser to Linear consent ────
        const pkce = generatePkce();
        const state = randomState();
        // `opts.actorApp` is true by default; --no-actor-app sets it false.
        // Commander populates `opts.actorApp = false` when --no-actor-app is passed.
        const useActorApp = opts.actorApp !== false;
        const authorizationUrl = buildAuthorizationUrl({
          clientId,
          redirectUri: CALLBACK_URL,
          state,
          codeChallenge: pkce.codeChallenge,
          actorApp: useActorApp,
        });
        if (!useActorApp) {
          console.log('  ⚠ --no-actor-app: dropping actor=app for diagnosis. Token will not be agent-scoped.');
        }

        // The localhost callback server starts BEFORE we open the browser
        // so it's listening when Linear's redirect arrives.
        const callbackPromise = awaitOauthCallback();

        console.log();
        if (opts.browser !== false) {
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

        process.stdout.write('  → Waiting for browser callback...');
        const callback = await callbackPromise;
        console.log(' ✓');

        // Phase 2.0b Option 2 expects Linear to redirect with `code` +
        // `state`. If we got the AgentCore session_id shape, the user
        // likely configured an `actor=app` flow against an AgentCore
        // Identity provider — that path is parked, error out clearly.
        if (callback.kind !== 'direct-oauth') {
          throw new CliError(
            'Localhost callback returned an AgentCore session_id, not a direct OAuth code. '
            + 'Phase 2.0b Option 2 only supports the direct redirect — verify Linear\'s '
            + 'redirect URI is set to http://localhost:8080/oauth/callback and re-run.',
          );
        }
        if (callback.state !== state) {
          throw new CliError(
            `OAuth state mismatch (expected '${state}', got '${callback.state}'). `
            + 'Possible CSRF attack or stale tab — re-run setup.',
          );
        }

        // ─── Step 2: Exchange code for access token ───────────────────
        process.stdout.write('  → Exchanging code for access token...');
        const tokenResponse = await exchangeAuthorizationCode({
          code: callback.code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: CALLBACK_URL,
          clientId,
          clientSecret,
        });
        console.log(' ✓');

        // ─── Step 3: Fetch workspace identity ─────────────────────────
        process.stdout.write('  → Querying Linear viewer + organization...');
        const identity = await queryLinearIdentity(`Bearer ${tokenResponse.access_token}`);
        if (!identity) {
          throw new CliError(
            'Linear viewer query rejected the access token. This is unexpected — token was just issued. '
            + 'Re-run `bgagent linear setup` if Linear\'s API is recovering from a transient outage.',
          );
        }
        console.log(` ✓ (${identity.organization.name ?? identity.organization.urlKey ?? identity.organization.id})`);

        if (identity.organization.urlKey && identity.organization.urlKey !== slug) {
          console.log(
            `  ⚠ Slug '${slug}' does not match Linear's urlKey '${identity.organization.urlKey}'. `
            + 'Re-run with the correct slug to keep the registry key aligned with Linear.',
          );
        }

        // ─── Step 4: Persist token to per-workspace Secrets Manager ───
        process.stdout.write('  → Storing OAuth token...');
        const sm = new SecretsManagerClient({ region });
        const now = new Date().toISOString();
        const stored: StoredLinearOauthToken = {
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token ?? '',
          expires_at: computeExpiresAt(tokenResponse.expires_in),
          scope: tokenResponse.scope,
          // Co-located so Lambda-side refresh works without per-Lambda
          // env vars — one secret holds everything needed to renew.
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
        const secretName = linearOauthSecretName(slug);
        const oauthSecretArn = await upsertOauthSecret(sm, secretName, stored, slug);
        console.log(` ✓ (${secretName})`);

        // ─── Step 5: Persist registry + user-mapping rows ─────────────
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

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
          },
        }));
        console.log('  ✓ Recorded workspace in registry');

        await ddb.send(new PutCommand({
          TableName: userMappingTable!,
          Item: {
            linear_identity: `${identity.organization.id}#${identity.viewer.id}`,
            platform_user_id: cognitoSub,
            linear_workspace_id: identity.organization.id,
            linear_user_id: identity.viewer.id,
            linked_at: now,
            status: 'active',
            link_method: 'auto_setup_oauth',
          },
        }));
        const adminLabel = identity.viewer.name ?? identity.viewer.email ?? identity.viewer.id;
        console.log(`  ✓ Linked Linear user ${adminLabel} → platform user`);

        // ─── Step 6: Webhook signing secret (workspace-independent) ───
        const alreadyConfigured = await isWebhookSecretConfigured(sm, webhookSecretArn!);

        if (alreadyConfigured && !opts.rotateWebhookSecret) {
          console.log('  ✓ Webhook signing secret already configured (use --rotate-webhook-secret to update)');
        } else {
          const apiBaseUrl = config.api_url.replace(/\/+$/, '');
          console.log();
          console.log('  Webhook signing secret needed.');
          console.log('  In Linear → Settings → API → Webhooks, create a webhook pointing at:');
          console.log(`    ${apiBaseUrl}/linear/webhook`);
          console.log('  Subscribe to: Issues. Copy the signing secret from the webhook detail page.');
          console.log();
          const webhookSecret = await promptSecret('Webhook signing secret (lin_wh_…): ');
          if (!webhookSecret) {
            throw new CliError('Webhook signing secret is required.');
          }
          if (!webhookSecret.startsWith('lin_wh_')) {
            throw new CliError(
              'Webhook signing secrets start with \'lin_wh_\'. Got something different — re-check the Linear webhook detail page.',
            );
          }
          await sm.send(new PutSecretValueCommand({
            SecretId: webhookSecretArn!,
            SecretString: webhookSecret,
          }));
          console.log('  ✓ Stored webhook signing secret');
        }

        // ─── Done ──────────────────────────────────────────────────────
        console.log();
        console.log('✅ Setup complete.');
        console.log();
        console.log('Next steps:');
        console.log('  1. Onboard a Linear project to a GitHub repo:');
        console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
        console.log('  2. Add the `bgagent` label to a Linear issue in a mapped project.');
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
      .action(async (slug: string, opts) => {
        if (!SLUG_RE.test(slug)) {
          throw new CliError(
            `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
            + 'This is the Linear urlKey, e.g. \'acme\' from linear.app/acme/...',
          );
        }
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        // ─── Stack outputs ─────────────────────────────────────────────
        // Subset of `setup`'s outputs — webhook secret ARN is intentionally
        // NOT required here: add-workspace assumes the initial setup wizard
        // already installed it (one signing secret covers all workspaces
        // sharing the same Linear OAuth app + webhook receiver URL).
        const [
          workspaceRegistryTable,
          userMappingTable,
        ] = await Promise.all([
          getStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
          getStackOutput(region, stackName, 'LinearUserMappingTableName'),
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

        // ─── Resolve caller identity ──────────────────────────────────
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

        const sm = new SecretsManagerClient({ region });
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

        // ─── Linear OAuth app credentials ──────────────────────────────
        // Always prompt — never accept secrets via flags (shell history
        // leak). The auto-detected client_id from an existing active
        // workspace is offered as the default; user accepts with Enter
        // (single OAuth app shared across workspaces) or types a new id
        // (per-workspace OAuth app, e.g. when the existing app is
        // private to its origin workspace).
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

        // ─── PKCE + browser consent ────────────────────────────────────
        const pkce = generatePkce();
        const state = randomState();
        const useActorApp = opts.actorApp !== false;
        const authorizationUrl = buildAuthorizationUrl({
          clientId,
          redirectUri: CALLBACK_URL,
          state,
          codeChallenge: pkce.codeChallenge,
          actorApp: useActorApp,
        });
        if (!useActorApp) {
          console.log('  ⚠ --no-actor-app: dropping actor=app for diagnosis. Token will not be agent-scoped.');
        }

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
            + 'Verify Linear\'s redirect URI is set to http://localhost:8080/oauth/callback and re-run.',
          );
        }
        if (callback.state !== state) {
          throw new CliError(
            `OAuth state mismatch (expected '${state}', got '${callback.state}'). `
            + 'Possible CSRF attack or stale tab — re-run add-workspace.',
          );
        }

        // ─── Exchange code → fetch identity ────────────────────────────
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

        // ─── Refuse re-install of an already-onboarded workspace ───────
        // Different from `setup`, which is intentionally idempotent: the
        // explicit add-workspace verb implies "new workspace", and silently
        // overwriting a registry row could mask a wrong-account login.
        const dupCheck = await ddb.send(new ScanCommand({
          TableName: workspaceRegistryTable!,
          FilterExpression: 'linear_workspace_id = :id',
          ExpressionAttributeValues: { ':id': identity.organization.id },
          Limit: 1,
        }));
        if (dupCheck.Items && dupCheck.Items.length > 0) {
          throw new CliError(
            `Workspace '${slug}' (${identity.organization.id}) is already in the registry. `
            + 'Use `bgagent linear setup` to re-authorize an existing workspace, or remove the registry row manually before retrying.',
          );
        }

        // ─── Persist token to per-workspace SM ─────────────────────────
        process.stdout.write('  → Storing OAuth token...');
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
        const secretName = linearOauthSecretName(slug);
        const oauthSecretArn = await upsertOauthSecret(sm, secretName, stored, slug);
        console.log(` ✓ (${secretName})`);

        // ─── Persist registry + user-mapping rows ──────────────────────
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
          },
        }));
        console.log('  ✓ Recorded workspace in registry');

        await ddb.send(new PutCommand({
          TableName: userMappingTable!,
          Item: {
            linear_identity: `${identity.organization.id}#${identity.viewer.id}`,
            platform_user_id: cognitoSub,
            linear_workspace_id: identity.organization.id,
            linear_user_id: identity.viewer.id,
            linked_at: now,
            status: 'active',
            link_method: 'add_workspace_oauth',
          },
        }));
        const adminLabel = identity.viewer.name ?? identity.viewer.email ?? identity.viewer.id;
        console.log(`  ✓ Linked Linear user ${adminLabel} → platform user`);

        // ─── Done ──────────────────────────────────────────────────────
        console.log();
        console.log('✅ Workspace added.');
        console.log();
        console.log('Note: webhook signing secret was NOT prompted — it is shared across all');
        console.log('workspaces installed against the same Linear OAuth app. If this is the first');
        console.log('time installing in a new Linear team that has its own OAuth app, run');
        console.log('`bgagent linear setup` instead so the webhook signing secret gets configured.');
        console.log();
        console.log('Next: onboard a project from this workspace:');
        console.log('  bgagent linear onboard-project <linear-project-id> --repo owner/repo');
      }),
  );

  linear.addCommand(
    new Command('onboard-project')
      .description('Map a Linear project to a GitHub repository (admin IAM required)')
      .argument('<linear-project-id>', 'Linear project UUID')
      .requiredOption('--repo <owner/repo>', 'GitHub repository the mapped project should route tasks to')
      .option('--label <label>', `Label that triggers a task (default: ${DEFAULT_LABEL_FILTER})`, DEFAULT_LABEL_FILTER)
      .option('--team-id <id>', 'Optional Linear team UUID for the project (stored for debug)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (projectId: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const tableName = await getStackOutput(region, opts.stackName, 'LinearProjectMappingTableName');
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
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: {
            linear_project_id: projectId,
            repo: opts.repo,
            label_filter: opts.label,
            ...(opts.teamId && { team_id: opts.teamId }),
            status: 'active',
            onboarded_at: now,
            updated_at: now,
          },
        }));

        console.log(`✓ Mapped Linear project ${projectId} → ${opts.repo}`);
        console.log(`  Trigger label: ${opts.label}`);
        if (opts.teamId) {
          console.log(`  Team: ${opts.teamId}`);
        }
      }),
  );

  linear.addCommand(
    new Command('list-projects')
      .description('List Linear projects visible to the stored API token (with full UUIDs)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const apiTokenSecretArn = await getStackOutput(region, opts.stackName, 'LinearApiTokenSecretArn');
        if (!apiTokenSecretArn) {
          console.error('Could not find LinearApiTokenSecretArn in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        const sm = new SecretsManagerClient({ region });
        const secret = await sm.send(new GetSecretValueCommand({ SecretId: apiTokenSecretArn }));
        const apiToken = secret.SecretString;
        if (!apiToken || apiToken === ' ') {
          console.error('Linear API token is not populated. Run `bgagent linear setup` first.');
          process.exit(1);
        }

        let projects: Array<{ id: string; name: string; teams?: { nodes?: Array<{ id: string; name: string }> } }>;
        try {
          const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': apiToken,
            },
            body: JSON.stringify({
              query: '{ projects { nodes { id name teams { nodes { id name } } } } }',
            }),
          });
          if (!res.ok) {
            throw new Error(`Linear API returned ${res.status}`);
          }
          const body = await res.json() as { data?: { projects?: { nodes?: typeof projects } } };
          projects = body.data?.projects?.nodes ?? [];
        } catch (err) {
          console.error(`Failed to fetch Linear projects: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        if (opts.output === 'json') {
          console.log(formatJson(projects));
          return;
        }

        if (projects.length === 0) {
          console.log('No Linear projects visible to the stored API token.');
          return;
        }

        console.log(`Found ${projects.length} Linear project(s):\n`);
        for (const p of projects) {
          const team = p.teams?.nodes?.[0];
          console.log(`  ${p.name}`);
          console.log(`    id:   ${p.id}`);
          if (team) {
            console.log(`    team: ${team.name} (${team.id})`);
          }
          console.log('');
        }
        console.log('Onboard with:');
        console.log('  bgagent linear onboard-project <id> --repo owner/repo [--label abca]');
      }),
  );

  return linear;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function promptSecret(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    process.stderr.write(label);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();

      let value = '';

      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        for (const char of str) {
          if (char === '\n' || char === '\r') {
            cleanup();
            process.stderr.write('\n');
            resolve(value.trim());
            return;
          } else if (char === '\u0003') {
            cleanup();
            process.stderr.write('\n');
            reject(new Error('Cancelled.'));
            return;
          } else if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stderr.write('\b \b');
            }
          } else {
            value += char;
            process.stderr.write('*');
          }
        }
      };

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
      };

      process.stdin.on('data', onData);
    } else {
      rl.once('line', (line) => {
        rl.close();
        resolve(line.trim());
      });
      rl.once('close', () => reject(new Error('No input provided.')));
    }
  });
}

/**
 * Read a single line from stdin, with an optional default that's accepted on
 * empty input (Enter without typing). Visible echo — use only for non-secret
 * fields. For secrets, use `promptSecret`.
 *
 * Used by `bgagent linear add-workspace` to show the auto-detected client_id
 * as a default the user can override by typing a new value.
 */
function promptLine(label: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const display = defaultValue
    ? `${label} [${defaultValue}]: `
    : `${label}: `;
  return new Promise((resolve, reject) => {
    rl.question(display, (line) => {
      rl.close();
      const trimmed = line.trim();
      resolve(trimmed || defaultValue || '');
    });
    rl.once('close', () => reject(new Error('No input provided.')));
  });
}

// ─── Auto-link ───────────────────────────────────────────────────────────────

interface LinearViewer {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
}

interface LinearOrganization {
  readonly id: string;
  readonly name?: string;
  /** Linear urlKey, e.g. "acme" — Phase 2.0b: used as the workspace slug. */
  readonly urlKey?: string;
}

/**
 * Query the Linear `viewer` + `organization` GraphQL fields with whatever
 * Authorization header the caller hands us. Used both by the legacy
 * PAK-era auto-link (header value = bare `lin_api_…` token) and the
 * Phase 2.0b OAuth dance (header value = `Bearer <oauth-token>`).
 *
 * Returns null on any failure so callers can fall back to a warning
 * without blowing up the higher-level flow.
 */
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
    return null;
  }
}

/**
 * Query `viewer` + `organization` on the Linear API and write an active
 * LinearUserMapping row binding the token owner to the Cognito user running
 * the CLI. Skips gracefully on any failure — the admin can still link manually.
 *
 * Exported for test. Not part of the public CLI surface.
 */
export async function autoLinkTokenOwner(args: {
  region: string;
  apiToken: string;
  userMappingTable: string;
}): Promise<void> {
  let viewer: LinearViewer;
  let organization: LinearOrganization;
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': args.apiToken,
      },
      body: JSON.stringify({
        query: '{ viewer { id name email } organization { id name } }',
      }),
    });
    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status}`);
    }
    const body = await res.json() as { data?: { viewer?: LinearViewer; organization?: LinearOrganization } };
    if (!body.data?.viewer?.id || !body.data.organization?.id) {
      throw new Error('Linear API response missing viewer.id or organization.id');
    }
    viewer = body.data.viewer;
    organization = body.data.organization;
  } catch (err) {
    console.log(`  ⚠ Could not auto-link token owner: ${err instanceof Error ? err.message : String(err)}`);
    console.log('    The Linear API token is stored, but you are not yet linked as a platform user.');
    console.log('    Workarounds:');
    console.log('      • Re-run `bgagent linear setup` once Linear API is reachable (most common — transient failures).');
    console.log('      • If the failure persists, an admin can insert your linked identity directly into the');
    console.log(`        ${args.userMappingTable} DynamoDB table (linear_identity = "<workspaceId>#<viewerId>",`);
    console.log('        platform_user_id = your Cognito sub). See docs/guides/LINEAR_SETUP_GUIDE.md.');
    console.log('    `bgagent linear link <code>` is a v3 feature that requires Linear OAuth bot install (not in v1).');
    return;
  }

  let cognitoSub: string;
  try {
    cognitoSub = extractCognitoSub();
  } catch (err) {
    console.log(`  ⚠ Could not resolve your platform user (${err instanceof Error ? err.message : String(err)}).`);
    console.log('    Run `bgagent login`, then re-run `bgagent linear setup` to finish auto-linking.');
    return;
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));
  await ddb.send(new PutCommand({
    TableName: args.userMappingTable,
    Item: {
      linear_identity: `${organization.id}#${viewer.id}`,
      platform_user_id: cognitoSub,
      linear_workspace_id: organization.id,
      linear_user_id: viewer.id,
      linked_at: new Date().toISOString(),
      status: 'active',
      link_method: 'auto_setup',
    },
  }));

  const label = viewer.name ?? viewer.email ?? viewer.id;
  console.log(`  ✓ Linked Linear user ${label} (${organization.name ?? organization.id}) → platform user ${cognitoSub}`);
}

function extractCognitoSub(): string {
  const creds = loadCredentials();
  if (!creds?.id_token) {
    throw new Error('not authenticated — run `bgagent login`');
  }
  const parts = creds.id_token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed id_token in ~/.bgagent/credentials.json');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { sub?: string };
  if (!payload.sub) {
    throw new Error('id_token missing `sub` claim');
  }
  return payload.sub;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  try {
    const cfn = new CloudFormationClient({ region });
    const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = result.Stacks?.[0]?.Outputs ?? [];
    const output = outputs.find((o) => o.OutputKey === outputKey);
    return output?.OutputValue ?? null;
  } catch (err) {
    // Mirror cli/src/commands/slack.ts: swallow "stack does not exist" as null,
    // surface auth/other errors.
    const name = (err as Error)?.name ?? '';
    const message = (err as Error)?.message ?? '';
    if (name === 'ValidationError' && /does not exist/i.test(message)) {
      return null;
    }
    throw err;
  }
}
