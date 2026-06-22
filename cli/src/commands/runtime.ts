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
import { assertRepoFormat } from '../repo-lookup';
import { buildRuntimeStatusReport } from '../runtime-status';
import { getStackOutput } from '../stack-outputs';

const REPO_WIDTH = 36;
const COMPUTE_WIDTH = 12;

export function makeRuntimeCommand(): Command {
  const runtime = new Command('runtime')
    .description('Compute substrate status per onboarded blueprint (operator AWS credentials)');

  runtime.addCommand(
    new Command('status')
      .description('Show effective runtime/compute per blueprint and probe AgentCore control plane')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--repo <owner/repo>', 'Limit to a single repository')
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        if (opts.repo) assertRepoFormat(opts.repo);
        const { region, stackName } = resolveOperatorContext(opts);
        const [repoTableName, platformRuntimeArn] = await Promise.all([
          getStackOutput(region, stackName, 'RepoTableName'),
          getStackOutput(region, stackName, 'RuntimeArn'),
        ]);
        if (!repoTableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }

        const report = await buildRuntimeStatusReport(
          region,
          repoTableName,
          platformRuntimeArn,
          { repo: opts.repo },
        );

        if (opts.output === 'json') {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log('Runtime status is resolved per blueprint (RepoTable) with platform defaults.');
        console.log(`Platform default RuntimeArn: ${platformRuntimeArn ?? '(stack output missing)'}`);
        console.log();

        if (report.blueprints.length === 0) {
          console.log('No matching repositories found.');
          return;
        }

        console.log('Per-blueprint effective compute:');
        console.log(
          `${'REPO'.padEnd(REPO_WIDTH)} ${'STATUS'.padEnd(10)} `
          + `${'COMPUTE'.padEnd(COMPUTE_WIDTH)} RUNTIME_ARN (source)`,
        );
        for (const b of report.blueprints) {
          const runtimeLabel = b.runtime_arn
            ? `${b.runtime_arn} (${b.runtime_arn_source})`
            : b.compute_type === 'ecs'
              ? '(n/a — ECS uses platform cluster)'
              : '(missing)';
          console.log(
            `${b.repo.padEnd(REPO_WIDTH)} ${b.status.padEnd(10)} `
            + `${b.compute_type.padEnd(COMPUTE_WIDTH)} ${runtimeLabel}`,
          );
        }

        if (report.agentcore_runtimes.length > 0) {
          console.log('\nAgentCore control-plane probes (deduplicated by runtime ARN):');
          for (const r of report.agentcore_runtimes) {
            console.log(`\n  ${r.runtime_arn}`);
            console.log(`    repos: ${r.used_by_repos.join(', ')}`);
            if (r.probe_status === 'ok') {
              console.log(`    status: ${r.control_plane_status ?? 'unknown'}`);
              if (r.agent_runtime_name) console.log(`    name: ${r.agent_runtime_name}`);
              if (r.last_updated_at) console.log(`    last_updated_at: ${r.last_updated_at}`);
              if (r.failure_reason) console.log(`    failure_reason: ${r.failure_reason}`);
            } else {
              console.log(`    probe error: ${r.error}`);
            }
          }
        }

        if (report.ecs_substrates.length > 0) {
          console.log('\nECS compute substrates:');
          for (const ecs of report.ecs_substrates) {
            console.log(`  repos: ${ecs.used_by_repos.join(', ')}`);
            console.log(`  note: ${ecs.note}`);
          }
        }
      }),
  );

  return runtime;
}
