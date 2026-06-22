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
import { CliError } from '../errors';
import { DEFAULT_STACK_NAME, resolveOperatorContext } from '../operator-context';
import { doctorChecksPassed, runPlatformDoctor } from '../platform-doctor';
import { listStackOutputs } from '../stack-outputs';

/** Stack outputs most operators need during setup (shown first in text mode). */
const HIGHLIGHT_OUTPUT_KEYS = [
  'ApiUrl',
  'UserPoolId',
  'AppClientId',
  'GitHubTokenSecretArn',
  'RepoTableName',
  'RuntimeArn',
];

const OUTPUT_KEY_COLUMN_WIDTH = 28;

export function makePlatformCommand(): Command {
  const platform = new Command('platform')
    .description('Platform introspection and smoke checks (operator AWS credentials)');

  platform.addCommand(
    new Command('outputs')
      .description('Print CloudFormation stack outputs (ApiUrl, UserPoolId, etc.)')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const { region, stackName } = resolveOperatorContext(opts);
        const outputs = await listStackOutputs(region, stackName);

        if (outputs.length === 0) {
          throw new CliError(`Stack '${stackName}' has no outputs in ${region}.`);
        }

        if (opts.output === 'json') {
          console.log(JSON.stringify({ region, stack_name: stackName, outputs }, null, 2));
          return;
        }

        console.log(`Stack: ${stackName} (${region})`);
        console.log();

        const highlighted = HIGHLIGHT_OUTPUT_KEYS
          .map((key) => outputs.find((o) => o.key === key))
          .filter((o): o is NonNullable<typeof o> => Boolean(o));
        const highlightedKeys = new Set(highlighted.map((o) => o.key));
        const rest = outputs.filter((o) => !highlightedKeys.has(o.key));

        if (highlighted.length > 0) {
          console.log('Key outputs:');
          for (const o of highlighted) {
            console.log(`  ${o.key.padEnd(OUTPUT_KEY_COLUMN_WIDTH)} ${o.value}`);
          }
          console.log();
        }

        if (rest.length > 0) {
          console.log('All outputs:');
          for (const o of rest) {
            console.log(`  ${o.key.padEnd(OUTPUT_KEY_COLUMN_WIDTH)} ${o.value}`);
          }
        }
      }),
  );

  platform.addCommand(
    new Command('doctor')
      .description('Smoke-check API, Cognito, GitHub token, Bedrock model, and onboarded repos')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const { region, stackName } = resolveOperatorContext(opts);
        const results = await runPlatformDoctor({ region, stackName });
        const passed = doctorChecksPassed(results);

        if (opts.output === 'json') {
          console.log(JSON.stringify({
            region,
            stack_name: stackName,
            passed,
            checks: results,
          }, null, 2));
        } else {
          console.log(`Platform doctor — ${stackName} (${region})`);
          console.log();
          for (const check of results) {
            const icon = check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
            console.log(`${icon} ${check.label}`);
            console.log(`   ${check.detail}`);
          }
          console.log();
          console.log(passed ? 'All checks passed (warnings may still need attention).' : 'One or more checks failed.');
        }

        if (!passed) {
          throw new CliError('Platform doctor found failing checks.', 1);
        }
      }),
  );

  return platform;
}
