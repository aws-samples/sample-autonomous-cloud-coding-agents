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
import { saveConfig } from '../config';

export function makeConfigureCommand(): Command {
  return new Command('configure')
    .description('Configure the CLI with API endpoint and Cognito settings')
    .requiredOption('--api-url <url>', 'API Gateway base URL')
    .requiredOption('--region <region>', 'AWS region')
    .requiredOption('--user-pool-id <id>', 'Cognito User Pool ID')
    .requiredOption('--client-id <id>', 'Cognito App Client ID')
    .action((opts) => {
      saveConfig({
        api_url: opts.apiUrl,
        region: opts.region,
        user_pool_id: opts.userPoolId,
        client_id: opts.clientId,
      });
      console.log('Configuration saved.');
    });
}
