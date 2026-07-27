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

import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { tryLoadConfig } from '../config';
import { CliError } from '../errors';
import { formatJson, formatWebhookCreated, formatWebhookDetail, formatWebhookList } from '../format';
import { DEFAULT_STACK_NAME, resolveOperatorContext } from '../operator-context';
import { loadActiveRepoConfig, listRepoConfigs } from '../repo-lookup';
import { getStackOutput } from '../stack-outputs';
import {
  buildSampleWebhookPayload,
  fetchWebhookSecret,
  sendWebhookTestRequest,
} from '../webhook-test';

export function makeWebhookCommand(): Command {
  const webhook = new Command('webhook')
    .description('Manage webhook integrations');

  webhook.addCommand(
    new Command('create')
      .description('Create a new webhook')
      .requiredOption('--name <name>', 'Webhook name')
      .option('--api-key <key>', 'Platform API key (skips Cognito; else uses BGAGENT_API_KEY or login)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const client = new ApiClient({ apiKey: opts.apiKey });
        const result = await client.createWebhook({ name: opts.name });

        console.log(opts.output === 'json' ? formatJson(result) : formatWebhookCreated(result));
      }),
  );

  webhook.addCommand(
    new Command('list')
      .description('List webhooks')
      .option('--include-revoked', 'Include revoked webhooks')
      .option('--limit <n>', 'Max number of webhooks to return', parseInt)
      .option('--api-key <key>', 'Platform API key (skips Cognito; else uses BGAGENT_API_KEY or login)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const client = new ApiClient({ apiKey: opts.apiKey });
        const result = await client.listWebhooks({
          includeRevoked: opts.includeRevoked,
          limit: opts.limit,
        });

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(formatWebhookList(result.data));
          if (result.pagination.has_more) {
            console.log('\n(More results available)');
          }
        }
      }),
  );

  webhook.addCommand(
    new Command('test')
      .description('Send a signed sample payload to POST /webhooks/tasks')
      .argument('<webhook-id>', 'Webhook integration ID')
      .option('--secret <secret>', 'Webhook HMAC secret (from create output)')
      .option('--fetch-secret', 'Read secret from Secrets Manager (operator AWS credentials)')
      .option('--region <region>', 'AWS region for --fetch-secret / --stack-name')
      .option('--stack-name <name>', 'CloudFormation stack for --repo lookup', DEFAULT_STACK_NAME)
      .option('--repo <owner/repo>', 'Target onboarded repo for the sample task')
      .option('--api-url <url>', 'API base URL (defaults to bgagent configure api_url or stack ApiUrl)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (webhookId: string, opts) => {
        if (!opts.secret && !opts.fetchSecret) {
          throw new CliError(
            'Provide --secret (from `webhook create`) or --fetch-secret (operator IAM).',
          );
        }

        let apiUrl = opts.apiUrl as string | undefined;
        if (!apiUrl) {
          const config = tryLoadConfig();
          apiUrl = config?.api_url;
        }
        if (!apiUrl && opts.stackName) {
          const { region, stackName } = resolveOperatorContext(opts);
          apiUrl = (await getStackOutput(region, stackName, 'ApiUrl')) ?? undefined;
        }
        if (!apiUrl) {
          throw new CliError(
            'API URL is required. Run `bgagent configure`, pass --api-url, or pass --stack-name.',
          );
        }

        let repo = opts.repo as string | undefined;
        if (repo) {
          // Operator named a repo explicitly: validate it against RepoTable as a
          // best effort. With --api-url + --secret + --repo this command needs no
          // AWS access at all, so a missing stack output or absent credentials
          // degrades to a warning rather than aborting the manual path — but we
          // never silently claim validation we didn't perform.
          try {
            const { region, stackName } = resolveOperatorContext(opts);
            const repoTable = await getStackOutput(region, stackName, 'RepoTableName');
            if (repoTable) {
              await loadActiveRepoConfig(region, repoTable, repo);
            } else {
              console.warn(
                `⚠ Could not read 'RepoTableName' from stack '${stackName}' — `
                + `sending the test for '${repo}' without verifying it is an active onboarded repo.`,
              );
            }
          } catch (err) {
            if (err instanceof CliError && err.message.includes('is onboarded but status')) {
              throw err; // The repo was found and is genuinely not active — surface it.
            }
            console.warn(
              `⚠ Could not verify '${repo}' against RepoTable (${err instanceof Error ? err.message : String(err)}) — `
              + 'sending the test anyway.',
            );
          }
        } else {
          const { region, stackName } = resolveOperatorContext(opts);
          const repoTable = await getStackOutput(region, stackName, 'RepoTableName');
          if (!repoTable) {
            throw new CliError(
              'Pass --repo or deploy the stack so an active repo can be resolved from RepoTable.',
            );
          }
          const activeRepos = (await listRepoConfigs(region, repoTable))
            .filter((r) => r.status === 'active');
          if (activeRepos.length === 0) {
            throw new CliError('No active repos in RepoTable. Pass --repo explicitly.');
          }
          repo = activeRepos[0].repo;
        }

        let secret = opts.secret as string | undefined;
        if (!secret && opts.fetchSecret) {
          const { region } = resolveOperatorContext(opts);
          secret = await fetchWebhookSecret(region, webhookId);
        }
        if (!secret) {
          throw new CliError('Webhook secret is required.');
        }

        const payload = buildSampleWebhookPayload(repo);
        const result = await sendWebhookTestRequest(apiUrl, webhookId, secret, payload);

        if (opts.output === 'json') {
          console.log(formatJson(result));
          return;
        }

        console.log(`Webhook test succeeded (HTTP ${result.http_status}).`);
        if (result.task_id) {
          console.log(`Task created: ${result.task_id}`);
          console.log('Cancel it with `bgagent cancel` if this was only a connectivity check.');
        }
      }),
  );

  webhook.addCommand(
    new Command('revoke')
      .description('Revoke a webhook')
      .argument('<webhook-id>', 'Webhook ID')
      .option('--api-key <key>', 'Platform API key (skips Cognito; else uses BGAGENT_API_KEY or login)')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (webhookId: string, opts) => {
        const client = new ApiClient({ apiKey: opts.apiKey });
        const result = await client.revokeWebhook(webhookId);

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(formatWebhookDetail(result));
          console.log(`\nWebhook ${result.webhook_id} revoked.`);
        }
      }),
  );

  return webhook;
}
