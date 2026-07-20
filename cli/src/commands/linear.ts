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
  ListSecretsCommand,
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
import { generateInviteCode } from '../invite-code';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  generatePkce,
  LINEAR_OAUTH_SECRET_PREFIX,
  linearOauthSecretName,
  StoredLinearOauthToken,
} from '../linear-oauth';
import { awaitOauthCallback, CALLBACK_URL } from '../oauth-callback-server';
import { promptSecret } from '../prompt-secret';

/** Default label that triggers an ABCA task when applied to a Linear issue. */
const DEFAULT_LABEL_FILTER = 'bgagent';

/** Standard RFC 4122 UUID — Linear's `projects.nodes[].id` matches this shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Width of the `═` banner bars in printed setup output. */
const BANNER_WIDTH = 72;

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
  // Phase 2.0b-O2 (shipped) uses a localhost callback that
  // `bgagent linear setup` listens on for the one-time redirect. The
  // `awsCallbackUrl` option is retained for the parked Phase 2.0a flow
  // and (rare) operators forwarding the callback through a fixed
  // upstream URL — but the localhost default works for everyone running
  // setup interactively from their machine.
  const callbackUrl = opts.awsCallbackUrl ?? 'http://localhost:8080/oauth/callback';

  const bar = '═'.repeat(BANNER_WIDTH);
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
    `    ${callbackUrl}`,
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
  const STATE_BYTES = 32;
  return randomBytes(STATE_BYTES).toString('base64url');
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
    // Row points at an empty SM secret — broken state, but distinct from
    // "no active workspace." Surface it so the operator gets a useful
    // error instead of being told to run `setup` and creating a dup row.
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
    new Command('webhook-info')
      .description('Print the webhook URL + Linear settings for this stack')
      .action(() => {
        // Read-only convenience — surfaces the values an operator needs to
        // create a webhook subscription in Linear (URL, resource types,
        // followup command). Eliminates the "find the API URL in CFN
        // outputs" detour that the setup guide used to embed.
        const config = loadConfig();
        if (!config.api_url) {
          throw new CliError(
            'No API URL configured. Run `bgagent configure` first to point at a deployed stack.',
          );
        }
        const webhookUrl = `${config.api_url.replace(/\/+$/, '')}/linear/webhook`;
        const bar = '═'.repeat(BANNER_WIDTH);
        console.log(bar);
        console.log('Linear webhook configuration');
        console.log(bar);
        console.log();
        console.log('In Linear → Settings → API → Webhooks → + New webhook, paste:');
        console.log();
        console.log(`  URL:             ${webhookUrl}`);
        console.log('  Resource types:  Issues');
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

        // In text mode, do a dry-run preview FIRST so the user can
        // confirm what they're linking before any write hits DDB. The
        // safety rail that lets a teammate abort if the admin picked
        // the wrong row.
        //
        // In `--output json` mode there's no interactive prompt, so the
        // dry-run is wasted work — skip it and go straight to the real
        // link call. The single response object is what callers script
        // around.
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
      .description('Authorize a Linear workspace via OAuth (Phase 2.0b — direct flow, Secrets Manager storage)')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--client-id <id>', 'Linear OAuth app Client ID (else prompted)')
      .option('--client-secret <secret>', 'Linear OAuth app Client Secret (else prompted; prefer interactive)')
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
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

        // Best-effort: fetch team keys so the screenshot processor can
        // prefix-route Linear issue lookups (e.g. ABCA-42 → workspace
        // owning ABCA) instead of scanning every active workspace.
        const teamKeys = await queryLinearTeamKeys(`Bearer ${tokenResponse.access_token}`);
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
            ...(teamKeys.length > 0 ? { team_keys: teamKeys } : {}),
          },
        }));
        console.log(
          teamKeys.length > 0
            ? `  ✓ Recorded workspace in registry (team keys: ${teamKeys.join(', ')})`
            : '  ✓ Recorded workspace in registry',
        );

        // We deliberately do NOT auto-link a user-mapping row here.
        // With actor=app, Linear's `viewer` query returns the OAuth
        // app's bot user (a synthetic `<uuid>@oauthapp.linear.app`
        // identity), not the human admin who ran the wizard. Writing
        // that mapping creates the wrong row: the bot never applies
        // labels, the human applying labels is unmapped, and the
        // processor drops their tasks with "no linked platform user".
        // The admin self-link picker further down replaces that path.

        // ─── Step 6: Webhook signing secret (per-workspace + stack-wide) ───
        //
        // Webhook subscriptions in Linear are workspace-scoped, and Linear
        // generates a fresh signing secret per subscription. To verify
        // events from N workspaces we need N signing secrets, looked up
        // by orgId. We store the workspace's signing secret on its OAuth
        // bundle (per-workspace path) AND mirror to the stack-wide secret
        // (back-compat path) when (a) it's the first install (stack-wide
        // is empty), or (b) the user explicitly asked to rotate.
        //
        // The webhook receiver tries per-workspace first and falls back
        // to the stack-wide secret, so existing installs keep working
        // without re-onboarding. Multi-workspace installs need each
        // workspace to own its own per-workspace signing secret — only
        // the FIRST install can populate the stack-wide one usefully.
        // If stack-wide is already populated, this is either a re-run
        // of setup on the SAME workspace or the FIRST workspace of a
        // future multi-workspace install. Either way the stored value
        // is this workspace's signing secret — lift it into the
        // per-workspace bundle without prompting (auto-migration to
        // the new shape). Rotation is not setup's job: use
        // `bgagent linear update-webhook-secret <slug>` to rotate the
        // signing secret without re-running OAuth.
        const stackWideAlreadyConfigured = await isWebhookSecretConfigured(sm, webhookSecretArn!);
        let webhookSigningSecret: string | undefined;

        if (stackWideAlreadyConfigured) {
          console.log('  ✓ Webhook signing secret already configured stack-wide (mirroring to per-workspace)');
          try {
            const value = await sm.send(new GetSecretValueCommand({ SecretId: webhookSecretArn! }));
            if (value.SecretString && value.SecretString.startsWith('lin_wh_')) {
              webhookSigningSecret = value.SecretString;
            }
          } catch (err) {
            console.log(`  ⚠ Could not read stack-wide secret to mirror: ${err instanceof Error ? err.message : String(err)}`);
          }
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
          // First install: stamp BOTH stack-wide (back-compat fallback
          // for installs predating per-workspace signing) and the
          // per-workspace OAuth bundle (the verifier's primary path).
          await sm.send(new PutSecretValueCommand({
            SecretId: webhookSecretArn!,
            SecretString: webhookSecret,
          }));
          console.log('  ✓ Stored webhook signing secret (stack-wide back-compat)');
          webhookSigningSecret = webhookSecret;
        }

        // Mirror into the per-workspace OAuth secret so the receiver can
        // look it up by orgId. Re-upsert with the merged payload.
        if (webhookSigningSecret) {
          const merged: StoredLinearOauthToken = {
            ...stored,
            webhook_signing_secret: webhookSigningSecret,
            updated_at: new Date().toISOString(),
          };
          await upsertOauthSecret(sm, secretName, merged, slug);
          console.log('  ✓ Mirrored signing secret to per-workspace OAuth bundle');
        }

        // ─── Step 7: Self-link picker ──────────────────────────────────
        // With actor=app, Linear's `viewer` returns the bot user, not
        // you. We can't auto-link from the OAuth dance — instead we
        // show the workspace member list so you can pick yourself.
        // One extra question, no separate command. Teammate linking
        // is a different flow (`bgagent linear invite-user`).
        console.log();
        const linked = await runSelfLinkPicker({
          ddb,
          userMappingTable: userMappingTable!,
          accessToken: tokenResponse.access_token,
          workspaceId: identity.organization.id,
          slug,
          cognitoSub,
          linkMethod: 'auto_setup_oauth',
        });

        // ─── Done ──────────────────────────────────────────────────────
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
        // Fetch team keys for prefix-routing (see same call in `setup`).
        const teamKeys = await queryLinearTeamKeys(`Bearer ${tokenResponse.access_token}`);
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
            ...(teamKeys.length > 0 ? { team_keys: teamKeys } : {}),
          },
        }));
        console.log(
          teamKeys.length > 0
            ? `  ✓ Recorded workspace in registry (team keys: ${teamKeys.join(', ')})`
            : '  ✓ Recorded workspace in registry',
        );

        // No auto-link — see the same comment in `setup` above. With
        // actor=app, Linear's `viewer` returns the bot user; auto-
        // linking that maps the wrong UUID. The admin self-link picker
        // further down replaces that path.

        // ─── Per-workspace webhook signing secret ──────────────────────
        // Linear webhook subscriptions are workspace-scoped, with a fresh
        // signing secret per subscription. Each workspace needs to own
        // its own signing secret so the receiver can verify by orgId.
        // Always prompt — there's no shared secret we can reuse.
        const apiBaseUrl = config.api_url.replace(/\/+$/, '');
        console.log();
        console.log(`  Webhook signing secret needed for '${slug}'.`);
        console.log(`  In Linear (signed into '${slug}') → Settings → API → Webhooks, create a webhook pointing at:`);
        console.log(`    ${apiBaseUrl}/linear/webhook`);
        console.log('  Subscribe to: Issues. Copy the signing secret from the webhook detail page.');
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

        // Re-upsert the OAuth secret with the signing secret merged in.
        // We don't touch the stack-wide secret here — that's reserved
        // for the FIRST install (back-compat fallback).
        const merged: StoredLinearOauthToken = {
          ...stored,
          webhook_signing_secret: webhookSigningSecret,
          updated_at: new Date().toISOString(),
        };
        await upsertOauthSecret(sm, secretName, merged, slug);
        console.log('  ✓ Stored webhook signing secret on per-workspace OAuth bundle');

        // ─── Self-link picker (same as setup; see explanation there) ───
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

        // ─── Done ──────────────────────────────────────────────────────
        console.log();
        console.log('✅ Workspace added.');
        console.log();
        console.log('Next steps:');
        if (!linked) {
          console.log(`  1. Re-run \`bgagent linear add-workspace ${slug}\` to retry the self-link picker,`);
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
      .action(async (slug: string, opts) => {
        // Use case: rotation, recovery from misconfig, or first-time
        // configuration after Linear regenerated the signing secret.
        // The OAuth dance can't be re-run when the app is already
        // installed in the workspace (Linear returns access_denied),
        // so this command sidesteps it entirely — read the existing
        // OAuth bundle, swap the signing-secret field, write it back.
        if (!SLUG_RE.test(slug)) {
          throw new CliError(
            `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
            + 'This is the Linear urlKey, e.g. \'acme\' from linear.app/acme/...',
          );
        }
        const config = loadConfig();
        const region = opts.region || config.region;

        const sm = new SecretsManagerClient({ region });
        const secretName = linearOauthSecretName(slug);

        // ─── Read existing bundle ───────────────────────────────────
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
              + `Run \`bgagent linear setup ${slug}\` or \`bgagent linear add-workspace ${slug}\` first.`,
            );
          }
          if (err instanceof CliError) throw err;
          throw new CliError(
            `Could not read existing OAuth bundle: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!stored.access_token || !stored.workspace_id) {
          throw new CliError(
            `Secret '${secretName}' is missing required fields (access_token / workspace_id). `
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

        // ─── Prompt for new secret ──────────────────────────────────
        const webhookSigningSecret = (await promptSecret('  Webhook signing secret (lin_wh_…): ')).trim();
        if (!webhookSigningSecret) {
          throw new CliError('Webhook signing secret is required.');
        }
        if (!webhookSigningSecret.startsWith('lin_wh_')) {
          throw new CliError(
            'Webhook signing secrets start with \'lin_wh_\'. Got something different — re-check the Linear webhook detail page.',
          );
        }

        // ─── Write back ─────────────────────────────────────────────
        const merged: StoredLinearOauthToken = {
          ...stored,
          webhook_signing_secret: webhookSigningSecret,
          updated_at: new Date().toISOString(),
        };
        await upsertOauthSecret(sm, secretName, merged, slug);

        console.log();
        console.log(`✅ Updated webhook signing secret for '${slug}'.`);
        console.log();
        console.log('Next webhook event from this workspace will verify against the new secret.');
      }),
  );

  linear.addCommand(
    new Command('invite-user')
      .description('Generate a one-time code for a Linear teammate to redeem via `bgagent linear link <code>`')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (slug: string, opts) => {
        // Two-party handshake for linking a teammate:
        //   1. (here) Admin picks the teammate's Linear identity from
        //      the workspace member list. CLI writes a `pending#<code>`
        //      row to LinearUserMappingTable with 24h TTL and prints
        //      the code.
        //   2. Admin sends the code to the teammate (Slack/email/etc).
        //   3. Teammate runs `bgagent linear link <code>` from their
        //      own machine. Their Cognito-authenticated id_token
        //      supplies the platform-user half. They see the Linear
        //      name+email before confirming, so an admin who picked
        //      the wrong row can't silently misattribute.
        //
        // Self-linking the admin themselves is folded into `setup` /
        // `add-workspace` — no separate command for that case.
        if (!SLUG_RE.test(slug)) {
          throw new CliError(
            `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
            + 'This is the Linear urlKey, e.g. \'acme\' from linear.app/acme/...',
          );
        }
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const [workspaceRegistryTable, userMappingTable] = await Promise.all([
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

        const creds = loadCredentials();
        if (!creds?.id_token) {
          throw new CliError('Not authenticated — run `bgagent login` first.');
        }
        const callerCognitoSub = extractCognitoSub();

        // ─── Resolve workspace + OAuth secret arn ──────────────────────
        const sm = new SecretsManagerClient({ region });
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
        const registryScan = await ddb.send(new ScanCommand({
          TableName: workspaceRegistryTable!,
          FilterExpression: 'workspace_slug = :slug AND #status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':slug': slug, ':active': 'active' },
          Limit: 1,
        }));
        const registryRow = registryScan.Items?.[0];
        if (!registryRow) {
          throw new CliError(
            `Workspace '${slug}' is not in the registry (or status != 'active'). `
            + `Run \`bgagent linear setup ${slug}\` or \`bgagent linear add-workspace ${slug}\` first.`,
          );
        }
        const workspaceId = registryRow.linear_workspace_id as string;
        const oauthSecretArn = registryRow.oauth_secret_arn as string;

        // ─── Query Linear members ──────────────────────────────────────
        process.stdout.write('  → Querying Linear for workspace members...');
        const oauthSecret = await sm.send(new GetSecretValueCommand({ SecretId: oauthSecretArn }));
        const stored = JSON.parse(oauthSecret.SecretString ?? '{}') as { access_token?: string };
        if (!stored.access_token) {
          console.log(' ✗');
          throw new CliError(`OAuth secret '${oauthSecretArn}' has no access_token. Re-run setup.`);
        }
        const members = await queryLinearWorkspaceMembers(`Bearer ${stored.access_token}`);
        if (!members || members.length === 0) {
          console.log(' ✗');
          throw new CliError('Linear API returned no workspace members. Token may be expired or scope insufficient.');
        }
        const humans = members.filter((m) => !(m.email ?? '').endsWith('@oauthapp.linear.app'));
        console.log(` ✓ (${humans.length} member${humans.length === 1 ? '' : 's'})`);
        if (humans.length === 0) {
          throw new CliError('No human users found in this workspace. Add teammates in Linear first.');
        }

        // ─── Picker ───────────────────────────────────────────────────
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

        // ─── Write pending#<code> + print handoff ──────────────────────
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
      .description('List Linear projects visible to the OAuth-installed workspace (with full UUIDs)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--slug <slug>', 'Linear workspace slug (urlKey). If omitted, queries every active workspace in the registry.')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;
        const sm = new SecretsManagerClient({ region });

        // Resolve the set of workspace slugs to query. Either an
        // explicit `--slug` (one workspace) or every Linear workspace
        // we have an OAuth secret for (list every `bgagent-linear-oauth-*`).
        let slugs: string[];
        if (opts.slug) {
          slugs = [opts.slug];
        } else {
          // ListSecretsCommand caps at 100 results per page. Paginate
          // so a deployment with >100 Linear workspaces (or >100 SM
          // secrets matching the prefix filter) doesn't silently miss
          // installs after the first page.
          const collected: string[] = [];
          let nextToken: string | undefined;
          do {
            const listed = await sm.send(new ListSecretsCommand({
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
          slugs = collected;
          if (slugs.length === 0) {
            console.error('No Linear OAuth installs found. Run `bgagent linear setup <slug>` first.');
            process.exit(1);
          }
        }

        type ProjectRow = {
          slug: string;
          id: string;
          name: string;
          team?: string;
        };
        const rows: ProjectRow[] = [];

        for (const slug of slugs) {
          const secretName = linearOauthSecretName(slug);
          let accessToken: string;
          try {
            const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
            const stored = JSON.parse(resp.SecretString ?? '{}') as { access_token?: string };
            if (!stored.access_token) {
              console.error(`Secret ${secretName} is missing access_token; skipping.`);
              continue;
            }
            accessToken = stored.access_token;
          } catch (err) {
            console.error(`Failed to read ${secretName}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          try {
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
              console.error(`Linear API returned ${res.status} for workspace '${slug}'`);
              continue;
            }
            const body = await res.json() as {
              data?: { projects?: { nodes?: Array<{ id: string; name: string; teams?: { nodes?: Array<{ name: string }> } }> } };
            };
            for (const p of body.data?.projects?.nodes ?? []) {
              rows.push({
                slug,
                id: p.id,
                name: p.name,
                team: p.teams?.nodes?.[0]?.name,
              });
            }
          } catch (err) {
            console.error(`Failed to fetch projects for '${slug}': ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }

        if (opts.output === 'json') {
          console.log(formatJson(rows));
          return;
        }

        if (rows.length === 0) {
          // The Linear API call succeeded for every workspace (otherwise the
          // continue-on-error branches above would have logged), so the
          // workspaces are reachable — they just don't have any projects.
          // Surface that explicitly so the user doesn't read "No projects
          // visible" as an OAuth-scope or IAM problem and start chasing
          // ghosts.
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

  return linear;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

/**
 * Read a single line from stdin, with an optional default that's accepted on
 * empty input (Enter without typing). Visible echo — use only for non-secret
 * fields. For secrets, use `promptSecret`.
 *
 * Implemented with the same raw-mode stdin pattern as `promptSecret` (just
 * echoing the typed character instead of '*') so that chaining a promptLine
 * call followed by a promptSecret call works — `readline.createInterface`
 * + `rl.close()` would leave stdin in an EOF state and the next prompt
 * would reject immediately on its own readline `close` event.
 */
function promptLine(label: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const display = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
    process.stderr.write(display);

    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.once('line', (line) => {
        rl.close();
        resolve(line.trim() || defaultValue || '');
      });
      rl.once('close', () => reject(new Error('No input provided.')));
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    let value = '';

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const char of str) {
        if (char === '\n' || char === '\r') {
          cleanup();
          process.stderr.write('\n');
          resolve(value.trim() || defaultValue || '');
          return;
        } else if (char === '') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Cancelled.'));
          return;
        } else if (char === '' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else {
          value += char;
          process.stderr.write(char);
        }
      }
    };

    process.stdin.on('data', onData);
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

/** Workspace member surfaced by Linear's `users` GraphQL query. */
interface LinearWorkspaceMember {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
}

/**
 * Query the workspace's team keys (e.g. `["ABCA", "PLAT"]`). Persisted on
 * the registry row so the screenshot processor can prefix-route Linear
 * issue lookups to the owning workspace instead of scanning every
 * workspace's tokens. Returns an empty array on failure — callers persist
 * what they got and the lookup falls back to scanning if `team_keys` is
 * absent or stale.
 */
export async function queryLinearTeamKeys(authorizationHeader: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeader,
      },
      // first:100 caps at 100 teams. Workspaces with more are rare for
      // ABCA's target use case; pagination is a v1.x followup.
      body: JSON.stringify({
        query: '{ teams(first: 100) { nodes { key } } }',
      }),
    });
    if (!res.ok) return [];
    const body = await res.json() as { data?: { teams?: { nodes?: Array<{ key?: string }> } } };
    const keys = (body.data?.teams?.nodes ?? [])
      .map((t) => t.key)
      .filter((k): k is string => typeof k === 'string' && k.length > 0)
      .map((k) => k.toUpperCase());
    return Array.from(new Set(keys)).sort();
  } catch {
    return [];
  }
}

/**
 * Query the workspace's human members. Used by the inline self-link picker
 * in `setup` / `add-workspace` — surfaces the list of Linear users the
 * OAuth bot can see, so the admin can pick the right human without typing
 * UUIDs.
 *
 * Returns null on API failure (logged + caller throws CliError). Filters
 * out the synthetic `@oauthapp.linear.app` bot user happens at the call
 * site since it's policy ("don't pick the bot") not a transport concern.
 */
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
        // first:100 caps the picker at the first 100 members. Workspaces
        // larger than that are rare for ABCA's target use case (small
        // dev teams); pagination is a v1.x followup if it ever bites.
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

/**
 * Run the self-link picker inline at the end of `setup` / `add-workspace`.
 * Lists workspace humans, asks the caller to pick themselves, writes the
 * mapping row using their own Cognito sub. Returns true on success, false
 * if the user aborts (so the caller can print a follow-up reminder).
 *
 * This is the "good UX so admins don't have a separate command" path.
 * Teammate linking is a different command (`invite-user` + `link <code>`).
 */
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
    console.log(`    Re-run \`bgagent linear ${args.linkMethod === 'add-workspace' ? 'add-workspace' : 'setup'} ${args.slug}\` and answer "y" at the self-link prompt, or label an issue and follow the warning.`);
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
    return null; // nosemgrep: ts-silent-success-masking -- auto-link is optional setup UX; null skips gracefully so admin can link manually
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
      return null; // nosemgrep: ts-silent-success-masking -- "stack does not exist" is the not-deployed-yet contract; auth/other errors rethrow below
    }
    throw err;
  }
}
