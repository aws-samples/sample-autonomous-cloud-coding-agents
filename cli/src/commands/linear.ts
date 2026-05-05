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

import * as readline from 'readline';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { loadConfig } from '../config';
import { formatJson } from '../format';

/** Default label that triggers an ABCA task when applied to a Linear issue. */
const DEFAULT_LABEL_FILTER = 'bgagent';

export function makeLinearCommand(): Command {
  const linear = new Command('linear')
    .description('Manage Linear integration');

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
      .description('Populate Linear webhook secret + personal API token in Secrets Manager')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const webhookSecretArn = await getStackOutput(region, opts.stackName, 'LinearWebhookSecretArn');
        const apiTokenSecretArn = await getStackOutput(region, opts.stackName, 'LinearApiTokenSecretArn');

        if (!webhookSecretArn || !apiTokenSecretArn) {
          console.error('Could not find Linear secret ARNs in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        const apiBaseUrl = config.api_url.replace(/\/+$/, '');
        console.log('Linear setup — see docs/guides/LINEAR_SETUP_GUIDE.md for the full walkthrough.\n');
        console.log('Required Linear config:');
        console.log('  1. Create a personal API key at https://linear.app/settings/account/security');
        console.log(`  2. Create a webhook at https://linear.app/settings/api — point it at: ${apiBaseUrl}/linear/webhook`);
        console.log('     - Subscribe to: Issues');
        console.log('     - Copy the signing secret from the webhook detail page\n');

        const webhookSecret = await promptSecret('Webhook signing secret: ');
        const apiToken = await promptSecret('Personal API key (lin_api_…): ');

        if (!webhookSecret || !apiToken) {
          console.error('\n✗ Both values are required. Try again.');
          process.exit(1);
        }
        if (!apiToken.startsWith('lin_api_')) {
          console.error('\n✗ Personal API keys start with "lin_api_". Check https://linear.app/settings/account/security.');
          process.exit(1);
        }

        const sm = new SecretsManagerClient({ region });
        await sm.send(new PutSecretValueCommand({ SecretId: webhookSecretArn, SecretString: webhookSecret }));
        console.log('  ✓ Stored webhook signing secret');
        await sm.send(new PutSecretValueCommand({ SecretId: apiTokenSecretArn, SecretString: apiToken }));
        console.log('  ✓ Stored personal API token\n');

        console.log('Next steps:');
        console.log('  1. Onboard a Linear project:');
        console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
        console.log('  2. In Linear, comment on an issue with "bgagent link" to receive a link code, then run:');
        console.log('       bgagent linear link <code>');
        console.log('  3. Add the "bgagent" label to a Linear issue in a mapped project — ABCA will pick it up.');
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
