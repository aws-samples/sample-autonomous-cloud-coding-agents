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
import { formatJson, formatWebhookCreated, formatWebhookDetail, formatWebhookList } from '../format';

export function makeWebhookCommand(): Command {
  const webhook = new Command('webhook')
    .description('Manage webhook integrations');

  webhook.addCommand(
    new Command('create')
      .description('Create a new webhook')
      .requiredOption('--name <name>', 'Webhook name')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const client = new ApiClient();
        const result = await client.createWebhook({ name: opts.name });

        console.log(opts.output === 'json' ? formatJson(result) : formatWebhookCreated(result));
      }),
  );

  webhook.addCommand(
    new Command('list')
      .description('List webhooks')
      .option('--include-revoked', 'Include revoked webhooks')
      .option('--limit <n>', 'Max number of webhooks to return', parseInt)
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const client = new ApiClient();
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
    new Command('revoke')
      .description('Revoke a webhook')
      .argument('<webhook-id>', 'Webhook ID')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (webhookId: string, opts) => {
        const client = new ApiClient();
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
