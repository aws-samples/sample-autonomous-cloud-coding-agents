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
import { decodeBundle } from './admin';
import { saveConfig, tryLoadConfig } from '../config';
import { CliError } from '../errors';
import { CliConfig } from '../types';

/**
 * All four core fields (api-url, region, user-pool-id, client-id) are required
 * the first time — subsequent invocations may update a subset. `--from-bundle`
 * accepts a base64 string (printed by `bgagent admin invite-user`) carrying
 * all four fields at once, so a teammate joining a deployment can run a
 * single command instead of typing four flags.
 */
export function makeConfigureCommand(): Command {
  return new Command('configure')
    .description('Configure the CLI with API endpoint and Cognito settings')
    .option('--api-url <url>', 'API Gateway base URL')
    .option('--region <region>', 'AWS region')
    .option('--user-pool-id <id>', 'Cognito User Pool ID')
    .option('--client-id <id>', 'Cognito App Client ID')
    .option('--from-bundle <base64>', 'Base64 config bundle from `bgagent admin invite-user`')
    .action((opts) => {
      // --from-bundle is mutually exclusive with the individual flags. Mixing
      // them risks silent overrides; refuse instead of guessing precedence.
      const individualFlagsProvided = opts.apiUrl || opts.region || opts.userPoolId || opts.clientId;
      if (opts.fromBundle && individualFlagsProvided) {
        throw new CliError(
          '--from-bundle is mutually exclusive with --api-url / --region / --user-pool-id / --client-id.',
        );
      }

      const existing = tryLoadConfig();
      let providedFields: Partial<CliConfig>;
      if (opts.fromBundle) {
        providedFields = decodeBundle(opts.fromBundle);
      } else {
        providedFields = {
          ...(opts.apiUrl !== undefined ? { api_url: opts.apiUrl } : {}),
          ...(opts.region !== undefined ? { region: opts.region } : {}),
          ...(opts.userPoolId !== undefined ? { user_pool_id: opts.userPoolId } : {}),
          ...(opts.clientId !== undefined ? { client_id: opts.clientId } : {}),
        };
      }
      const merged: Partial<CliConfig> = {
        ...(existing ?? {}),
        ...providedFields,
      };

      // All four core fields must be present after merge — enforces first-time
      // configure requires the full quartet while later updates may be partial.
      const missing: string[] = [];
      if (!merged.api_url) missing.push('--api-url');
      if (!merged.region) missing.push('--region');
      if (!merged.user_pool_id) missing.push('--user-pool-id');
      if (!merged.client_id) missing.push('--client-id');
      if (missing.length > 0) {
        throw new CliError(
          `Missing required configuration: ${missing.join(', ')}. `
          + 'Provide all four core fields on the first `bgagent configure` call '
          + '(or use `--from-bundle` from `bgagent admin invite-user`).',
        );
      }

      // If the user ran `bgagent configure` with no flags while a complete
      // config already existed, there is nothing to save — don't print the
      // misleading "Configuration saved." message.
      if (existing !== null && Object.keys(providedFields).length === 0) {
        console.log('No configuration changes — all flags were omitted.');
        return;
      }

      saveConfig(merged as CliConfig);
      console.log('Configuration saved.');
    });
}
