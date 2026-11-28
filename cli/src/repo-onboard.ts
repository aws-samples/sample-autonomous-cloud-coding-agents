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

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { assertComputeSubstrateDeployed, defaultComputeType, type ComputeDeployment } from './compute-substrate';
import { documentClient } from './dynamo-clients';
import { CliError } from './errors';
import {
  LambdaMicrovmProbeClientFactory,
  requireLambdaMicrovmAvailability,
} from './lambda-microvm-availability';
import {
  assertRepoFormat,
  loadRepoConfig,
  parseRepoConfigRow,
  RepoConfigRow,
  RepoNotOnboardedError,
  RepoSettings,
} from './repo-lookup';

/** TTL (days) for soft-deleted repo rows — matches Blueprint construct. */
export const REMOVED_REPO_TTL_DAYS = 30;

export interface OnboardRepoOptions {
  readonly deployment?: ComputeDeployment;
  /** Columns to write; a column whose value is undefined is not written. */
  readonly set?: RepoSettings;
  /** Columns to remove from the row. */
  readonly unset?: readonly (keyof RepoSettings)[];
}

export interface OnboardRepoDependencies {
  /** Override for deterministic/offline tests; production uses the regional AWS client. */
  readonly lambdaMicrovmClientFactory?: LambdaMicrovmProbeClientFactory;
}

/**
 * Register a repository in RepoTable, or change or re-activate its row (operator path).
 * The write names `status`, the two timestamps, `ttl` and the columns of `set` and `unset`; no other attribute changes.
 */
export async function onboardRepo(
  region: string,
  tableName: string,
  repo: string,
  options: OnboardRepoOptions = {},
  dependencies: OnboardRepoDependencies = {},
): Promise<{ config: RepoConfigRow; previous?: RepoConfigRow }> {
  assertRepoFormat(repo);
  const set = options.set ?? {};
  // DynamoDB refuses an expression that names one attribute twice.
  const unset = [...new Set(options.unset)];
  for (const column of unset) {
    if (set[column] !== undefined) {
      throw new CliError(`'${column}' cannot be set and unset in one command.`);
    }
  }
  const now = new Date().toISOString();
  const ddb = documentClient(region);

  let existing: RepoConfigRow | undefined;
  try {
    existing = await loadRepoConfig(region, tableName, repo);
  } catch (err) {
    // Only a genuinely absent row means "start from scratch". Any other failure
    // (table missing, AccessDenied, throttling) must propagate: the checks below
    // read the stored row, and the caller reports the change from it.
    if (!(err instanceof RepoNotOnboardedError)) {
      throw err;
    }
    existing = undefined;
  }

  if (unset.length > 0 && !existing) {
    throw new RepoNotOnboardedError(repo);
  }

  const stored = unset.includes('compute_type') ? undefined : existing?.compute_type;
  const effectiveComputeType = set.compute_type ?? stored
    ?? (options.deployment ? defaultComputeType(options.deployment) : 'agentcore');
  if (options.deployment) {
    assertComputeSubstrateDeployed({ ...options.deployment, computeType: effectiveComputeType });
  }
  if (set.runtime_arn && effectiveComputeType !== 'agentcore') {
    throw new CliError('--runtime-arn applies only to the agentcore backend');
  }
  if (effectiveComputeType === 'lambda-microvm') {
    await requireLambdaMicrovmAvailability(region, dependencies.lambdaMicrovmClientFactory);
  }

  const written = Object.entries(set).filter(([, value]) => value !== undefined);
  const named = ['status', 'updated_at', 'onboarded_at', 'ttl', ...written.map(([column]) => column), ...unset];
  const result = await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { repo },
    UpdateExpression: 'SET #status = :active, #updated_at = :now, #onboarded_at = if_not_exists(#onboarded_at, :now)'
      + written.map(([column]) => `, #${column} = :${column}`).join('')
      + ' REMOVE #ttl'
      + unset.map((column) => `, #${column}`).join(''),
    ExpressionAttributeNames: Object.fromEntries(named.map((column) => [`#${column}`, column])),
    ExpressionAttributeValues: {
      ':active': 'active',
      ':now': now,
      ...Object.fromEntries(written.map(([column, value]) => [`:${column}`, value])),
    },
    ReturnValues: 'ALL_NEW',
  }));

  return { config: parseRepoConfigRow(result.Attributes ?? {}), previous: existing };
}

/** Soft-delete a repository (Blueprint delete semantics). */
export async function offboardRepo(
  region: string,
  tableName: string,
  repo: string,
): Promise<RepoConfigRow> {
  assertRepoFormat(repo);
  await loadRepoConfig(region, tableName, repo);

  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + REMOVED_REPO_TTL_DAYS * 86400;
  const ddb = documentClient(region);

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { repo },
    UpdateExpression: 'SET #status = :removed, #updated = :now, #ttl = :ttl',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updated': 'updated_at',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':removed': 'removed',
      ':now': now,
      ':ttl': ttl,
    },
  }));

  return loadRepoConfig(region, tableName, repo);
}
