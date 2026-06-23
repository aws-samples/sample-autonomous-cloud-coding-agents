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

import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient } from './dynamo-clients';
import { CliError } from './errors';

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const REPO_STATUSES = ['active', 'removed'] as const;
export type RepoStatus = (typeof REPO_STATUSES)[number];

/** RepoTable row shape used by operator CLI and github set-token. */
export interface RepoConfigRow {
  readonly repo: string;
  readonly status: RepoStatus;
  readonly onboarded_at?: string;
  readonly updated_at?: string;
  readonly compute_type?: string;
  readonly runtime_arn?: string;
  readonly model_id?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly system_prompt_overrides?: string;
  readonly github_token_secret_arn?: string;
  readonly poll_interval_ms?: number;
  readonly egress_allowlist?: string[];
  readonly cedar_policies?: string[];
  readonly approval_gate_cap?: number;
}

/**
 * Thrown when a repo is absent from RepoTable (never registered via Blueprint
 * or operator onboard). Distinguished from infrastructure failures (table
 * missing, AccessDenied, throttling) so callers can safely treat only this as
 * "start from scratch" — see {@link onboardRepo}.
 */
export class RepoNotOnboardedError extends CliError {
  readonly repo: string;

  constructor(repo: string) {
    super(
      `Repository '${repo}' is not onboarded. Register it with a Blueprint before querying repo config.`,
    );
    this.name = 'RepoNotOnboardedError';
    this.repo = repo;
  }
}

/** Validate owner/repo format (matches Blueprint construct). */
export function assertRepoFormat(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new CliError(`Invalid repo format: '${repo}'. Expected 'owner/repo'.`);
  }
}

/**
 * Narrow a raw DynamoDB item to {@link RepoConfigRow}, validating the fields the
 * CLI branches on. RepoTable is written by CDK-controlled writers, but a schema
 * drift or hand-edited row should fail loudly here rather than flow through the
 * type system as a valid config.
 */
export function parseRepoConfigRow(item: Record<string, unknown>): RepoConfigRow {
  const repo = item.repo;
  if (typeof repo !== 'string') {
    throw new CliError(`RepoTable row is missing a string 'repo' key: ${JSON.stringify(item)}`);
  }
  const status = item.status;
  if (status !== 'active' && status !== 'removed') {
    throw new CliError(
      `RepoTable row for '${repo}' has unexpected status '${String(status)}' `
      + `(expected one of ${REPO_STATUSES.join(', ')}).`,
    );
  }
  return { ...(item as unknown as RepoConfigRow), repo, status };
}

/** Load a RepoConfig row from RepoTable (any status). */
export async function loadRepoConfig(
  region: string,
  tableName: string,
  repo: string,
): Promise<RepoConfigRow> {
  assertRepoFormat(repo);

  const ddb = documentClient(region);
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { repo },
  }));

  if (!result.Item) {
    throw new RepoNotOnboardedError(repo);
  }

  return parseRepoConfigRow(result.Item);
}

/** Load an active RepoConfig row from RepoTable. */
export async function loadActiveRepoConfig(
  region: string,
  tableName: string,
  repo: string,
): Promise<RepoConfigRow> {
  const config = await loadRepoConfig(region, tableName, repo);
  if (config.status !== 'active') {
    throw new CliError(
      `Repository '${repo}' is onboarded but status is '${config.status}'. Only active repos can be targeted.`,
    );
  }
  return config;
}

/** Scan RepoTable and return all repo configs. */
export async function listRepoConfigs(
  region: string,
  tableName: string,
): Promise<RepoConfigRow[]> {
  const ddb = documentClient(region);
  const items: RepoConfigRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    for (const item of result.Items ?? []) {
      items.push(parseRepoConfigRow(item));
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Count active repos in RepoTable. */
export async function countActiveRepos(region: string, tableName: string): Promise<number> {
  const repos = await listRepoConfigs(region, tableName);
  return repos.filter((r) => r.status === 'active').length;
}
