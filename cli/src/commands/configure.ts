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
import { fetchConfigureBundleFromStack, resolveOperatorRegion } from '../stack-outputs';
import { CliConfig } from '../types';

/**
 * All four core fields (api-url, region, user-pool-id, client-id) are required
 * the first time — subsequent invocations may update a subset. `--from-bundle`
 * accepts a base64 string (printed by `bgagent admin invite-user`) carrying
 * all four fields at once. `--stack-name` reads the same fields from
 * CloudFormation (same outputs as `bgagent platform outputs`).
 */
export function makeConfigureCommand(): Command {
  return new Command('configure')
    .description('Configure the CLI with API endpoint and Cognito settings')
    .option('--api-url <url>', 'API Gateway base URL')
    .option('--region <region>', 'AWS region')
    .option('--user-pool-id <id>', 'Cognito User Pool ID')
    .option('--client-id <id>', 'Cognito App Client ID')
    .option('--from-bundle <base64>', 'Base64 config bundle from `bgagent admin invite-user`')
    .option(
      '--stack-name <name>',
      'Read ApiUrl, UserPoolId, and AppClientId from CloudFormation stack outputs',
    )
    .action(async (opts) => {
      const individualFlagsProvided = opts.apiUrl || opts.region || opts.userPoolId || opts.clientId;
      if (opts.fromBundle && (individualFlagsProvided || opts.stackName)) {
        throw new CliError(
          '--from-bundle is mutually exclusive with --api-url / --region / --user-pool-id / --client-id / --stack-name.',
        );
      }

      const existing = tryLoadConfig();
      let providedFields: Partial<CliConfig>;

      if (opts.fromBundle) {
        providedFields = decodeBundle(opts.fromBundle);
      } else if (opts.stackName) {
        const region = resolveOperatorRegion(
          { region: opts.region },
          existing?.region,
        );
        const stackName = opts.stackName;
        providedFields = await fetchConfigureBundleFromStack(region, stackName);
        providedFields = {
          ...providedFields,
          ...(opts.region !== undefined ? { region: opts.region } : {}),
          ...(opts.apiUrl !== undefined ? { api_url: opts.apiUrl } : {}),
          ...(opts.userPoolId !== undefined ? { user_pool_id: opts.userPoolId } : {}),
          ...(opts.clientId !== undefined ? { client_id: opts.clientId } : {}),
        };
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

      const missing: string[] = [];
      if (!merged.api_url) missing.push('--api-url');
      if (!merged.region) missing.push('--region');
      if (!merged.user_pool_id) missing.push('--user-pool-id');
      if (!merged.client_id) missing.push('--client-id');
      if (missing.length > 0) {
        const stackHint = opts.stackName
          ? ''
          : ' Pass `--stack-name backgroundagent-dev` (with `--region`) to read values from CloudFormation, '
            + 'or use `--from-bundle` from `bgagent admin invite-user`.';
        throw new CliError(
          `Missing required configuration: ${missing.join(', ')}. `
          + 'Provide all four core fields on the first `bgagent configure` call'
          + stackHint,
        );
      }

      if (existing !== null && Object.keys(providedFields).length === 0) {
        console.log('No configuration changes — all flags were omitted.');
        return;
      }

      saveConfig(merged as CliConfig);
      console.log('Configuration saved.');
    });
}
