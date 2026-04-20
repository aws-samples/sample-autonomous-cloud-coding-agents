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

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { loadConfig } from '../config';
import { formatJson } from '../format';

export function makeSlackCommand(): Command {
  const slack = new Command('slack')
    .description('Manage Slack integration');

  slack.addCommand(
    new Command('link')
      .description('Link your Slack account using a verification code from /bgagent link')
      .argument('<code>', 'Verification code from Slack')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (code: string, opts) => {
        const client = new ApiClient();
        const result = await client.slackLink(code);

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log('Slack account linked successfully.');
          console.log(`  Workspace: ${result.slack_team_id}`);
          console.log(`  User:      ${result.slack_user_id}`);
          console.log(`  Linked at: ${result.linked_at}`);
        }
      }),
  );

  slack.addCommand(
    new Command('setup')
      .description('Create a Slack App and store credentials (interactive)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        // Step 1: Fetch the manifest JSON from stack outputs.
        console.log('Fetching Slack App manifest from stack outputs...\n');
        let manifestJson = await getStackOutput(region, opts.stackName, 'SlackAppManifestJson');

        if (!manifestJson) {
          console.log('Stack has not been deployed yet.');
          const shouldDeploy = await promptConfirm('Deploy now? (y/n) ');
          if (shouldDeploy) {
            console.log('\nDeploying stack (this may take a few minutes)...\n');
            try {
              const repoRoot = findRepoRoot();
              console.log(`Deploying from ${repoRoot}\n`);
              execSync('MISE_EXPERIMENTAL=1 mise run //cdk:deploy', {
                cwd: repoRoot,
                stdio: 'inherit',
              });
              console.log('');
              manifestJson = await getStackOutput(region, opts.stackName, 'SlackAppManifestJson');
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`\nDeploy failed: ${msg}`);
              process.exit(1);
            }
          }
        }

        if (manifestJson) {
          const createUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson).replace(/%2F/g, '/')}`;
          console.log('Open this URL to create your Slack App (all settings pre-filled):');
          console.log(`  ${createUrl}\n`);
        } else {
          console.log('Create the app manually at https://api.slack.com/apps\n');
        }

        // Step 2: Fetch secret ARNs from stack outputs (CDK creates the placeholders).
        const arns = await fetchSecretArns(region, opts.stackName);

        // Step 3: Prompt for credentials and store.
        const clientId = await promptAndStoreCredentials(region, arns);

        // Step 4: Next steps.
        const hasEvents = manifestJson?.includes('event_subscriptions') ?? false;
        const hasInteractivity = manifestJson?.includes('interactivity') ?? false;

        console.log('Next steps:\n');

        let step = 1;
        if (!hasEvents) {
          const apiBaseMatch = manifestJson?.match(/https:\/\/[^/]+\/[^/]+/);
          const apiBaseUrl = apiBaseMatch ? apiBaseMatch[0] : '<your-api-url>';
          console.log(`  ${step}. In the Slack App dashboard, go to "Event Subscriptions":`);
          console.log('     - Toggle ON');
          console.log(`     - Request URL: ${apiBaseUrl}/slack/events`);
          console.log('     - Subscribe to bot events: app_mention, message.im, app_uninstalled, tokens_revoked');
          console.log('     - Save Changes\n');
          step++;
        }
        if (!hasInteractivity) {
          const apiBaseMatch = manifestJson?.match(/https:\/\/[^/]+\/[^/]+/);
          const apiBaseUrl = apiBaseMatch ? apiBaseMatch[0] : '<your-api-url>';
          console.log(`  ${step}. Go to "Interactivity & Shortcuts":`);
          console.log('     - Toggle ON');
          console.log(`     - Request URL: ${apiBaseUrl}/slack/interactions`);
          console.log('     - Save Changes\n');
          step++;
        }
        if (hasEvents) {
          console.log(`  ${step}. In the Slack App dashboard, go to "Event Subscriptions":`);
          console.log('     - The Request URL may show "Your URL didn\'t respond" — click Retry');
          console.log('     - Wait for the green "Verified" checkmark');
          console.log('     - Click Save Changes\n');
          step++;
        }
        // Build the OAuth install URL using the client ID and redirect URI from the manifest.
        const redirectMatch = manifestJson?.match(/"redirect_urls":\["([^"]+)"\]/);
        const redirectUri = redirectMatch ? redirectMatch[1] : '';
        const scopes = 'app_mentions:read,commands,chat:write,chat:write.public,channels:read,groups:read,im:history,im:write,users:read,reactions:write';
        const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

        console.log(`  ${step}. Install the app to your workspace using this link:\n`);
        console.log(`     ${installUrl}\n`);
        console.log('     (Do NOT use the "Install App" button in the dashboard — it won\'t connect to your backend)\n');
        step++;
        console.log(`  ${step}. In Slack, run /bgagent link, then in your terminal: bgagent slack link <code>\n`);
        step++;
        console.log(`  ${step}. Try @Shoof in a channel to submit a task\n`);
        console.log('If @Shoof does not respond, delete the app and re-run `bgagent slack setup`.');
      }),
  );

  return slack;
}

// ─── Shared credential logic ─────────────────────────────────────────────────

interface SecretArns {
  signingSecretArn: string;
  clientSecretArn: string;
  clientIdSecretArn: string;
}

async function fetchSecretArns(region: string, stackName: string): Promise<SecretArns> {
  const signingSecretArn = await getStackOutput(region, stackName, 'SlackSigningSecretArn');
  const clientSecretArn = await getStackOutput(region, stackName, 'SlackClientSecretArn');
  const clientIdSecretArn = await getStackOutput(region, stackName, 'SlackClientIdSecretArn');

  if (!signingSecretArn || !clientSecretArn || !clientIdSecretArn) {
    console.error('Could not find Slack secret ARNs in stack outputs. Deploy the stack first.');
    process.exit(1);
  }

  return { signingSecretArn, clientSecretArn, clientIdSecretArn };
}

async function promptAndStoreCredentials(region: string, arns: SecretArns): Promise<string> {
  for (;;) {
    console.log('Enter the credentials from Basic Information → App Credentials:\n');

    const signingSecret = await promptSecret('Signing Secret: ');
    const clientSecret = await promptSecret('Client Secret:  ');
    const clientId = await promptVisible('Client ID:      ');

    if (!signingSecret || !clientSecret || !clientId) {
      console.error('\n✗ All three values are required. Try again.\n');
      continue;
    }

    let valid = true;
    if (!/^[0-9a-f]{32}$/i.test(signingSecret)) {
      console.error('\n✗ Signing Secret must be 32 hex characters.');
      valid = false;
    }
    if (!/^[0-9a-f]{32}$/i.test(clientSecret)) {
      console.error('✗ Client Secret must be 32 hex characters.');
      valid = false;
    }
    if (!/^\d+\.\d+$/.test(clientId)) {
      console.error('✗ Client ID should be numeric (e.g. 12345.67890).');
      valid = false;
    }
    if (!valid) {
      console.error('\nCheck Basic Information → App Credentials and try again.\n');
      continue;
    }

    // Store in Secrets Manager.
    console.log('');
    const sm = new SecretsManagerClient({ region });

    const secrets = [
      { id: arns.signingSecretArn, value: signingSecret, label: 'signing secret' },
      { id: arns.clientSecretArn, value: clientSecret, label: 'client secret' },
      { id: arns.clientIdSecretArn, value: clientId, label: 'client ID' },
    ];

    for (const secret of secrets) {
      await sm.send(new PutSecretValueCommand({
        SecretId: secret.id,
        SecretString: secret.value,
      }));
      console.log(`  ✓ Stored ${secret.label}`);
    }

    console.log('\nCredentials stored. They are verified automatically:');
    console.log('  - Client ID & Secret: when you install the app to your workspace');
    console.log('  - Signing Secret: when @Shoof receives its first message\n');

    return clientId;
  }
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

function promptConfirm(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}

function promptVisible(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.question(label, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findRepoRoot(): string {
  const startDirs = [
    process.cwd(),
    path.resolve(__dirname, '..', '..', '..'),
  ];

  for (const start of startDirs) {
    let dir = start;
    while (true) {
      if (fs.existsSync(path.join(dir, 'mise.toml')) && fs.existsSync(path.join(dir, 'cdk', 'cdk.json'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error('Could not find project root. Run this command from the repository directory.');
}

async function getStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  try {
    const cfn = new CloudFormationClient({ region });
    const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = result.Stacks?.[0]?.Outputs ?? [];
    const output = outputs.find((o) => o.OutputKey === outputKey);
    return output?.OutputValue ?? null;
  } catch {
    return null;
  }
}
