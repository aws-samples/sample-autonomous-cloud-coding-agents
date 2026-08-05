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
import { formatApiKeyCreated, formatApiKeyDetail, formatApiKeyList, formatJson } from '../format';
import { API_KEY_SCOPES, ApiKeyScope } from '../types';

/**
 * Parse a comma-separated `--scopes` value into validated scope strings.
 * Throws (via commander's InvalidArgumentError) on an unknown scope so the
 * user sees the allowed set instead of a server 400.
 */
function parseScopes(value: string): ApiKeyScope[] {
  const known = new Set<string>(API_KEY_SCOPES);
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  const out: ApiKeyScope[] = [];
  for (const p of parts) {
    if (!known.has(p)) {
      throw new Error(`Unknown scope "${p}". Allowed: ${API_KEY_SCOPES.join(', ')}.`);
    }
    out.push(p as ApiKeyScope);
  }
  return out;
}

export function makeApiKeyCommand(): Command {
  const apiKey = new Command('api-key')
    .description('Manage platform API keys for headless / CI automation');

  apiKey.addCommand(
    new Command('create')
      .description('Create a new platform API key (requires `bgagent login`)')
      .requiredOption('--name <name>', 'Key name')
      .option('--scopes <list>', 'Comma-separated scopes (default: webhooks:manage)', parseScopes)
      .option('--expires-at <iso>', 'Optional ISO-8601 expiry timestamp')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const client = new ApiClient();
        const result = await client.createApiKey({
          name: opts.name,
          ...(opts.scopes && { scopes: opts.scopes }),
          ...(opts.expiresAt && { expires_at: opts.expiresAt }),
        });

        console.log(opts.output === 'json' ? formatJson(result) : formatApiKeyCreated(result));
      }),
  );

  apiKey.addCommand(
    new Command('list')
      .description('List platform API keys')
      .option('--include-revoked', 'Include revoked keys')
      .option('--limit <n>', 'Max number of keys to return', parseInt)
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const client = new ApiClient();
        const result = await client.listApiKeys({
          includeRevoked: opts.includeRevoked,
          limit: opts.limit,
        });

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(formatApiKeyList(result.data));
          if (result.pagination.has_more) {
            console.log('\n(More results available)');
          }
        }
      }),
  );

  apiKey.addCommand(
    new Command('revoke')
      .description('Revoke a platform API key')
      .argument('<key-id>', 'API key ID')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (keyId: string, opts) => {
        const client = new ApiClient();
        const result = await client.revokeApiKey(keyId);

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(formatApiKeyDetail(result));
          console.log(`\nAPI key ${result.key_id} revoked.`);
        }
      }),
  );

  return apiKey;
}
