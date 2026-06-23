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
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { CliError } from '../errors';
import {
  isGithubTokenConfigured,
  putGithubToken,
  resolveGithubTokenSecretArn,
} from '../github-token';
import { DEFAULT_STACK_NAME } from '../operator-context';
import { promptSecret } from '../prompt-secret';
import { getStackOutput } from '../stack-outputs';

/** Width of the `═` banner rules printed around webhook-info output. */
const BANNER_WIDTH = 72;

export function makeGithubCommand(): Command {
  const github = new Command('github')
    .description('Manage GitHub integration (PAT storage, deployment-status webhook for preview-deploy screenshots)');

  github.addCommand(
    new Command('webhook-info')
      .description('Print the GitHub webhook URL + values to paste into a repo\'s webhook config')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
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

        const bar = '═'.repeat(BANNER_WIDTH);
        console.log(bar);
        console.log('GitHub webhook configuration (preview-deploy screenshot pipeline)');
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
          console.log('  bgagent github set-webhook-secret    # interactive prompt');
          console.log();
          console.log(`  Secret ARN: ${webhookSecretArn}`);
        } else {
          console.log('  (Stack output GitHubWebhookSecretArn not found — check `aws cloudformation describe-stacks`.)');
        }
        console.log();
        console.log('Note: deploy providers (Vercel, Amplify Hosting, Netlify, GitHub Actions');
        console.log('custom CD, etc.) post deployment_status events via the GitHub Deployments');
        console.log('API, so this single webhook covers every preview your provider builds.');
        console.log(bar);
      }),
  );

  github.addCommand(
    new Command('set-webhook-secret')
      .description('Mirror the GitHub webhook signing secret into Secrets Manager')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
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
        console.log('Test by triggering a preview deploy on the configured repo (push to a');
        console.log('PR-attached branch). The receiver Lambda log group should show a successful');
        console.log('HMAC verification on the next deployment_status event.');
      }),
  );

  github.addCommand(
    new Command('set-token')
      .description('Store a GitHub personal access token in Secrets Manager')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--repo <owner/repo>', 'Target a blueprint\'s per-repo token secret (when configured)')
      .option('--secret-arn <arn>', 'Write to an explicit Secrets Manager ARN (instead of stack outputs)')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const resolved = await resolveGithubTokenSecretArn({
          region,
          stackName,
          repo: opts.repo,
          secretArn: opts.secretArn,
        });

        if (resolved.repoUsesPlatformDefault) {
          console.log(
            `  ℹ Repository '${opts.repo}' has no credentials.githubTokenSecretArn override; `
            + 'using the platform default secret.',
          );
          console.log(
            '    To use a dedicated secret per blueprint, create a Secrets Manager secret, '
            + 'wire credentials.githubTokenSecretArn on the Blueprint, redeploy, then re-run with --repo.',
          );
          console.log();
        } else if (resolved.source === 'blueprint') {
          console.log(`  Target: per-blueprint secret for '${opts.repo}'`);
          console.log(`  Secret ARN: ${resolved.secretArn}`);
          console.log();
        } else if (resolved.source === 'platform') {
          console.log('  Target: platform default GitHub token secret');
          console.log(`  Secret ARN: ${resolved.secretArn}`);
          console.log();
        }

        const alreadyConfigured = await isGithubTokenConfigured(region, resolved.secretArn);
        if (alreadyConfigured) {
          console.log('  ⚠ A GitHub token is already configured in this secret. This command will OVERWRITE it.');
          console.log();
        }

        const token = (await promptSecret('GitHub personal access token: ')).trim();
        if (!token) {
          throw new CliError('GitHub personal access token is required.');
        }

        await putGithubToken(region, resolved.secretArn, token);
        console.log();
        console.log('✅ Stored GitHub personal access token.');
      }),
  );

  return github;
}
