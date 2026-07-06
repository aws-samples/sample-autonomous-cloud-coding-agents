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
import { DEFAULT_STACK_NAME, redactSecretArn, resolveOperatorContext } from '../operator-context';
import {
  buildRepoShowLines,
  formatRepoConfigForDisplay,
} from '../repo-display';
import {
  assertRepoFormat,
  listRepoConfigs,
  loadRepoConfig,
  type RepoConfigRow,
} from '../repo-lookup';
import { offboardRepo, onboardRepo } from '../repo-onboard';
import { buildRepoOnboardNotes } from '../repo-onboard-notes';
import { getStackOutput } from '../stack-outputs';

/**
 * Redact the per-repo secret ARN before a `RepoConfigRow` is serialized to JSON.
 * `repo show` redacts this field via {@link formatRepoConfigForDisplay}; the
 * `list`/`onboard`/`offboard` JSON paths emit raw rows, so they must apply the
 * same redaction to honor the command's "secret ARNs redacted" contract.
 */
function redactRepoRow(row: RepoConfigRow): RepoConfigRow {
  if (!row.github_token_secret_arn) {
    return row;
  }
  return { ...row, github_token_secret_arn: redactSecretArn(row.github_token_secret_arn) };
}

const REPO_COLUMN_WIDTH = 36;
const STATUS_COLUMN_WIDTH = 10;
const COMPUTE_COLUMN_WIDTH = 12;
const MODEL_COLUMN_WIDTH = 28;
const FIELD_LABEL_WIDTH = 28;

export function makeRepoCommand(): Command {
  const repo = new Command('repo')
    .description('Repository onboarding introspection (operator AWS credentials)');

  repo.addCommand(
    new Command('list')
      .description('List onboarded repositories from RepoTable')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--status <status>', 'Filter by status (active or removed)')
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const { region, stackName } = resolveOperatorContext(opts);
        const tableName = await getStackOutput(region, stackName, 'RepoTableName');
        if (!tableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }

        let repos = await listRepoConfigs(region, tableName);
        if (opts.status) {
          repos = repos.filter((r) => r.status === opts.status);
        }

        if (opts.output === 'json') {
          console.log(JSON.stringify({ repos: repos.map(redactRepoRow) }, null, 2));
          return;
        }

        if (repos.length === 0) {
          console.log('No repositories found.');
          return;
        }

        console.log(
          `${'REPO'.padEnd(REPO_COLUMN_WIDTH)} ${'STATUS'.padEnd(STATUS_COLUMN_WIDTH)} `
          + `${'COMPUTE'.padEnd(COMPUTE_COLUMN_WIDTH)} ${'MODEL'.padEnd(MODEL_COLUMN_WIDTH)} UPDATED`,
        );
        for (const r of repos) {
          console.log(
            `${r.repo.padEnd(REPO_COLUMN_WIDTH)} `
            + `${(r.status ?? '-').padEnd(STATUS_COLUMN_WIDTH)} `
            + `${(r.compute_type ?? '-').padEnd(COMPUTE_COLUMN_WIDTH)} `
            + `${(r.model_id ?? '-').padEnd(MODEL_COLUMN_WIDTH)} `
            + `${r.updated_at ?? '-'}`,
          );
        }
      }),
  );

  repo.addCommand(
    new Command('show')
      .description('Show full RepoConfig for a repository (secret ARNs redacted)')
      .argument('<owner/repo>', 'Repository identifier')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (repoId: string, opts) => {
        assertRepoFormat(repoId);
        const { region, stackName } = resolveOperatorContext(opts);
        const tableName = await getStackOutput(region, stackName, 'RepoTableName');
        if (!tableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }

        const config = await loadRepoConfig(region, tableName, repoId);
        const [platformTokenArn, runtimeArn] = await Promise.all([
          getStackOutput(region, stackName, 'GitHubTokenSecretArn'),
          getStackOutput(region, stackName, 'RuntimeArn'),
        ]);
        const display = formatRepoConfigForDisplay(config, {
          githubTokenSecretArn: platformTokenArn,
          runtimeArn,
        });

        if (opts.output === 'json') {
          console.log(JSON.stringify(display, null, 2));
          return;
        }

        console.log(`Repository: ${config.repo}`);
        console.log();
        console.log('Fields without a per-blueprint override inherit platform defaults at task time.');
        console.log();
        for (const line of buildRepoShowLines(display)) {
          console.log(`${line.key.padEnd(FIELD_LABEL_WIDTH)} ${line.text}`);
        }
      }),
  );

  repo.addCommand(
    new Command('onboard')
      .description('Register or re-activate a repository in RepoTable (operator path; CDK Blueprint is canonical)')
      .argument('<owner/repo>', 'Repository identifier')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--compute-type <type>', 'Compute substrate: agentcore or ecs')
      .option('--runtime-arn <arn>', 'Override AgentCore runtime ARN (agentcore only)')
      .option('--model <model-id>', 'Foundation model ID override')
      .option('--token-secret-arn <arn>', 'Per-repo GitHub token Secrets Manager ARN')
      .option('--max-turns <n>', 'Default max turns for tasks', parseInt)
      .option('--poll-interval <ms>', 'Default agent poll interval in milliseconds', parseInt)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (repoId: string, opts) => {
        assertRepoFormat(repoId);
        if (opts.computeType && opts.computeType !== 'agentcore' && opts.computeType !== 'ecs') {
          throw new CliError("--compute-type must be 'agentcore' or 'ecs'.");
        }

        const { region, stackName } = resolveOperatorContext(opts);
        const [tableName, platformRuntimeArn, platformGithubTokenSecretArn, computeSubstrate] = await Promise.all([
          getStackOutput(region, stackName, 'RepoTableName'),
          getStackOutput(region, stackName, 'RuntimeArn'),
          getStackOutput(region, stackName, 'GitHubTokenSecretArn'),
          getStackOutput(region, stackName, 'ComputeSubstrate'),
        ]);
        if (!tableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }
        // Refuse to onboard a repo as compute_type=ecs when the deployed stack did
        // NOT provision the ECS substrate — otherwise every task on this repo fails
        // at session start with "ECS compute strategy requires ECS_CLUSTER_ARN…".
        // Catch it here, at config time, with a fixable message. ComputeSubstrate is
        // null on stacks predating this output; treat that as "unknown" and only
        // hard-block on an explicit non-ecs value, so onboarding still works against
        // an older deploy (the runtime error remains the backstop there).
        if (opts.computeType === 'ecs' && computeSubstrate && computeSubstrate !== 'ecs') {
          throw new CliError(
            `Stack '${stackName}' was deployed without the ECS substrate (ComputeSubstrate=${computeSubstrate}), `
            + 'so a repo onboarded as --compute-type ecs would fail at task start. Redeploy the stack with '
            + '`--context compute_type=ecs` first (adds the Fargate substrate alongside AgentCore), then re-run this — '
            + 'or onboard with --compute-type agentcore.',
          );
        }

        const config = await onboardRepo(region, tableName, repoId, {
          computeType: opts.computeType,
          runtimeArn: opts.runtimeArn,
          modelId: opts.model,
          githubTokenSecretArn: opts.tokenSecretArn,
          maxTurns: opts.maxTurns,
          pollIntervalMs: opts.pollInterval,
        });
        const notes = buildRepoOnboardNotes({
          config,
          platformRuntimeArn,
          platformGithubTokenSecretArn,
        });

        if (opts.output === 'json') {
          console.log(JSON.stringify({ repo: redactRepoRow(config), notes }, null, 2));
          return;
        }

        console.log(`Repository '${repoId}' onboarded (status: ${config.status}).`);
        console.log();
        for (const note of notes) {
          console.log(note);
        }
      }),
  );

  repo.addCommand(
    new Command('offboard')
      .description('Soft-delete a repository (status=removed + TTL; operator path)')
      .argument('<owner/repo>', 'Repository identifier')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (repoId: string, opts) => {
        assertRepoFormat(repoId);
        const { region, stackName } = resolveOperatorContext(opts);
        const tableName = await getStackOutput(region, stackName, 'RepoTableName');
        if (!tableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }

        const config = await offboardRepo(region, tableName, repoId);

        if (opts.output === 'json') {
          console.log(JSON.stringify({ repo: redactRepoRow(config) }, null, 2));
          return;
        }

        console.log(`Repository '${repoId}' offboarded (status: ${config.status}).`);
        console.log('Existing Blueprint constructs will re-activate this repo on the next CDK deploy.');
      }),
  );

  return repo;
}
