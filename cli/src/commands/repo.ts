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

import { Command, Option } from 'commander';
import { assertComputeSubstrateDeployed, defaultComputeType } from '../compute-substrate';
import { CliError } from '../errors';
import { assertModelIdUsable } from '../model-id';
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
  type RepoSettings,
} from '../repo-lookup';
import { offboardRepo, onboardRepo } from '../repo-onboard';
import { buildRepoOnboardNotes } from '../repo-onboard-notes';
import { REPO_SETTINGS } from '../repo-settings';
import { getStackOutput, getStackOutputs } from '../stack-outputs';

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

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

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
        const {
          RepoTableName: tableName,
          GitHubTokenSecretArn: platformTokenArn,
          RuntimeArn: runtimeArn,
          ComputeSubstrate: computeSubstrate,
          ComputeDeploymentMode: computeDeploymentMode,
          ComputeTypes: computeTypes,
          BedrockGeoRegion: bedrockGeoRegion,
        } = await getStackOutputs(region, stackName, [
          'RepoTableName',
          'GitHubTokenSecretArn',
          'RuntimeArn',
          'ComputeSubstrate',
          'ComputeDeploymentMode',
          'ComputeTypes',
          'BedrockGeoRegion',
        ]);
        if (!tableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }

        const config = await loadRepoConfig(region, tableName, repoId);
        const display = formatRepoConfigForDisplay(config, {
          githubTokenSecretArn: platformTokenArn,
          runtimeArn,
          bedrockGeoRegion,
          deployment: { stackName, computeSubstrate, computeDeploymentMode, computeTypes },
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

  const columns = Object.keys(REPO_SETTINGS);
  const onboard = new Command('onboard')
    .description('Register a repository, or change its per-repo settings, in RepoTable (no deploy). '
      + 'Always activates the repository, also when only --unset is given.')
    .argument('<owner/repo>', 'Repository identifier')
    .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
    .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME);
  for (const setting of Object.values(REPO_SETTINGS)) {
    if (setting) onboard.option(setting.flag, setting.description);
  }
  repo.addCommand(
    onboard
      .option(
        '--unset <column>',
        `Remove a per-repo setting so that the platform default applies again: ${columns.join(', ')}. Repeatable`,
        collect,
        [] as readonly string[],
      )
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (repoId: string, opts) => {
        assertRepoFormat(repoId);
        const given: Record<string, unknown> = {};
        for (const [column, setting] of Object.entries(REPO_SETTINGS)) {
          if (!setting) continue;
          const option = new Option(setting.flag);
          const raw = opts[option.attributeName()];
          if (raw === undefined) continue;
          const value = setting.parse(raw);
          if (value === undefined) {
            throw new CliError(`${option.long} must not be empty (use --unset ${column} to remove the setting).`);
          }
          if (setting.maxBytes !== undefined) {
            const bytes = Buffer.byteLength(String(value));
            if (bytes > setting.maxBytes) {
              throw new CliError(`${option.long}: ${bytes} bytes exceed the limit of ${setting.maxBytes}.`);
            }
          }
          given[column] = value;
        }
        const set = given as RepoSettings;
        for (const column of opts.unset) {
          if (!columns.includes(column)) {
            throw new CliError(`--unset '${column}' is not a per-repo setting. Valid names: ${columns.join(', ')}.`);
          }
        }

        const { region, stackName } = resolveOperatorContext(opts);
        const {
          RepoTableName: tableName,
          RuntimeArn: platformRuntimeArn,
          GitHubTokenSecretArn: platformGithubTokenSecretArn,
          ComputeSubstrate: computeSubstrate,
          BedrockGeoRegion: deployedGeo,
          BedrockModelIds: grantedModelIds,
          ComputeDeploymentMode: computeDeploymentMode,
          ComputeTypes: computeTypes,
        } = await getStackOutputs(region, stackName, [
          'RepoTableName',
          'RuntimeArn',
          'GitHubTokenSecretArn',
          'ComputeSubstrate',
          'BedrockGeoRegion',
          'BedrockModelIds',
          'ComputeDeploymentMode',
          'ComputeTypes',
        ]);
        if (!tableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'RepoTableName'. Re-deploy the CDK stack.`,
          );
        }
        const deployment = { stackName, computeSubstrate, computeDeploymentMode, computeTypes };
        // Check explicit input early; onboardRepo also checks any stored override.
        assertComputeSubstrateDeployed({ ...deployment, computeType: set.compute_type });

        // Same reasoning as the substrate gate above: reuse an output already
        // fetched, and fail here rather than let a task die at turn 0 with an
        // AccessDenied that names nothing.
        //
        // The granted set is trimmed as the model id is — `resolveBedrockModelIds`
        // validates `trim().length` but stores the entry untrimmed, so an untrimmed
        // grant would make the exact-match check falsely reject a model it just listed.
        assertModelIdUsable({
          modelId: set.model_id,
          deployedGeo,
          stackName,
          ...(grantedModelIds && {
            grantedBareIds: grantedModelIds.split(',').map((m) => m.trim()).filter(Boolean),
          }),
        });

        const { config, previous } = await onboardRepo(region, tableName, repoId, { deployment, set, unset: opts.unset });
        const change = !previous ? 'onboarded' : previous.status === 'removed' ? 're-activated' : 'updated';
        const notes = buildRepoOnboardNotes({
          config,
          platformRuntimeArn,
          platformGithubTokenSecretArn,
          defaultComputeType: defaultComputeType(deployment),
        });

        if (opts.output === 'json') {
          console.log(JSON.stringify({ repo: redactRepoRow(config), change, notes }, null, 2));
          return;
        }

        console.log(`Repository '${repoId}' ${change} (status: ${config.status}).`);
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
