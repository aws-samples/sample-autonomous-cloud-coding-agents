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

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { CliError } from '../errors';

export function makeGithubCommand(): Command {
  const github = new Command('github')
    .description('Manage GitHub integration (deployment-status webhook for Vercel preview screenshots)');

  github.addCommand(
    new Command('webhook-info')
      .description('Print the GitHub webhook URL + values to paste into a repo\'s webhook config')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (opts) => {
        // Read-only convenience — surfaces the values an operator needs
        // to wire a GitHub repo's webhook to the screenshot pipeline.
        // Mirrors `bgagent linear webhook-info` so the docs don't have
        // to embed stack-specific URLs.
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const [webhookUrl, webhookSecretArn] = await Promise.all([
          getStackOutput(region, stackName, 'GitHubWebhookUrl'),
          getStackOutput(region, stackName, 'GitHubWebhookSecretArn'),
        ]);

        if (!webhookUrl) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'GitHubWebhookUrl'. `
            + 'Re-deploy with the screenshot CDK changes (mise //cdk:deploy).',
          );
        }

        const bar = '═'.repeat(72);
        console.log(bar);
        console.log('GitHub webhook configuration (Vercel preview screenshot pipeline)');
        console.log(bar);
        console.log();
        console.log('In GitHub, on the repo whose previews should generate screenshots:');
        console.log('  Settings → Webhooks → Add webhook, paste:');
        console.log();
        console.log(`  Payload URL:   ${webhookUrl}`);
        console.log('  Content type:  application/json');
        console.log('  Secret:        (generate any random string and paste it both here AND below)');
        console.log('  Events:        Let me select individual events → Deployment statuses');
        console.log();
        console.log('Save the webhook in GitHub, then mirror the same secret into AWS so the');
        console.log('receiver can verify the HMAC:');
        console.log();
        if (webhookSecretArn) {
          console.log(`  bgagent github set-webhook-secret    # interactive prompt`);
          console.log();
          console.log(`  Secret ARN: ${webhookSecretArn}`);
        } else {
          console.log('  (Stack output GitHubWebhookSecretArn not found — check `aws cloudformation describe-stacks`.)');
        }
        console.log();
        console.log('Note: Vercel posts deployment_status events via the GitHub Deployments API,');
        console.log('so this single webhook covers all Vercel-connected previews on the repo.');
        console.log(bar);
      }),
  );

  github.addCommand(
    new Command('set-webhook-secret')
      .description('Mirror the GitHub webhook signing secret into Secrets Manager')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (opts) => {
        // Companion to `webhook-info`: after the operator pastes the
        // webhook config into GitHub, this command captures the
        // signing secret they generated and stores it where the
        // receiver Lambda reads it. No-frills wrapper around
        // PutSecretValue — but operators were copy-pasting aws CLI
        // before, which is more error-prone (wrong --secret-id format,
        // no validation that the stack output even exists).
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const webhookSecretArn = await getStackOutput(region, stackName, 'GitHubWebhookSecretArn');
        if (!webhookSecretArn) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'GitHubWebhookSecretArn'. `
            + 'Re-deploy with the screenshot CDK changes (mise //cdk:deploy).',
          );
        }

        const sm = new SecretsManagerClient({ region });

        // Show whether a secret is already configured so the operator
        // doesn't accidentally rotate it without realising. Linear's
        // signing secrets start with `lin_wh_` — GitHub's are
        // free-form (operator-chosen), so we can't pattern-match.
        // Just check whether *anything* is there.
        let alreadyConfigured = false;
        try {
          const cur = await sm.send(new GetSecretValueCommand({ SecretId: webhookSecretArn }));
          if (cur.SecretString && cur.SecretString.length > 0 && !cur.SecretString.startsWith('{')) {
            // CDK seeds a JSON-blob placeholder; a real GitHub secret
            // wouldn't start with `{`. Crude but good enough.
            alreadyConfigured = true;
          }
        } catch (err) {
          if ((err as { name?: string }).name !== 'ResourceNotFoundException') {
            throw err;
          }
        }
        if (alreadyConfigured) {
          console.log('  ⚠ A signing secret is already configured. This command will OVERWRITE it.');
          console.log('  Make sure the new value matches what you pasted into GitHub.');
          console.log();
        }

        const secret = (await promptSecret('GitHub webhook signing secret: ')).trim();
        if (!secret) {
          throw new CliError('Webhook signing secret is required.');
        }

        await sm.send(new PutSecretValueCommand({
          SecretId: webhookSecretArn,
          SecretString: secret,
        }));
        console.log();
        console.log('✅ Stored webhook signing secret.');
        console.log();
        console.log('Test by triggering a Vercel preview deploy on the configured repo. The');
        console.log('receiver Lambda log group should show a successful HMAC verification on');
        console.log('the next deployment_status event.');
      }),
  );

  return github;
}

// ─── Stack-output helper ─────────────────────────────────────────────────────

async function getStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  const cf = new CloudFormationClient({ region });
  try {
    const result = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = result.Stacks?.[0];
    if (!stack) return null;
    return stack.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue ?? null;
  } catch (err) {
    throw new CliError(
      `Could not describe stack '${stackName}' in ${region}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Secret prompt (raw-mode, masked) ────────────────────────────────────────

function promptSecret(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(label);

    if (!process.stdin.isTTY) {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString();
      });
      process.stdin.on('end', () => resolve(buf.trim()));
      process.stdin.on('error', reject);
      return;
    }

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
          process.stderr.write('*');
        }
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}
