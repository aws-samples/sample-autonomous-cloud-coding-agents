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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CliError } from './errors';

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** RepoTable row shape used by operator CLI and github set-token. */
export interface RepoConfigRow {
  readonly repo: string;
  readonly status: 'active' | 'removed';
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

function documentClient(region: string): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
}

/** Validate owner/repo format (matches Blueprint construct). */
export function assertRepoFormat(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new CliError(`Invalid repo format: '${repo}'. Expected 'owner/repo'.`);
  }
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
    throw new CliError(
      `Repository '${repo}' is not onboarded. Register it with a Blueprint before querying repo config.`,
    );
  }

  return result.Item as RepoConfigRow;
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
      items.push(item as RepoConfigRow);
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
