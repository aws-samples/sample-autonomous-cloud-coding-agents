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
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  assertRepoFormat,
  loadRepoConfig,
  parseRepoConfigRow,
  RepoConfigRow,
  RepoNotOnboardedError,
} from './repo-lookup';

/** TTL (days) for soft-deleted repo rows — matches Blueprint construct. */
export const REMOVED_REPO_TTL_DAYS = 30;

export interface OnboardRepoOptions {
  readonly computeType?: 'agentcore' | 'ecs';
  readonly runtimeArn?: string;
  readonly modelId?: string;
  readonly maxTurns?: number;
  readonly githubTokenSecretArn?: string;
  readonly pollIntervalMs?: number;
}

function documentClient(region: string): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
}

/** Register or re-activate a repository in RepoTable (operator path). */
export async function onboardRepo(
  region: string,
  tableName: string,
  repo: string,
  options: OnboardRepoOptions = {},
): Promise<RepoConfigRow> {
  assertRepoFormat(repo);
  const now = new Date().toISOString();
  const ddb = documentClient(region);

  let existing: RepoConfigRow | undefined;
  try {
    existing = await loadRepoConfig(region, tableName, repo);
  } catch (err) {
    // Only a genuinely absent row means "start from scratch". Any other failure
    // (table missing, AccessDenied, throttling) must propagate — swallowing it
    // would silently wipe the existing blueprint overrides carried forward below.
    if (!(err instanceof RepoNotOnboardedError)) {
      throw err;
    }
    existing = undefined;
  }

  const item: Record<string, unknown> = {
    repo,
    status: 'active',
    onboarded_at: existing?.onboarded_at ?? now,
    updated_at: now,
  };

  if (options.computeType) item.compute_type = options.computeType;
  else if (existing?.compute_type) item.compute_type = existing.compute_type;

  if (options.runtimeArn) item.runtime_arn = options.runtimeArn;
  else if (existing?.runtime_arn) item.runtime_arn = existing.runtime_arn;

  if (options.modelId) item.model_id = options.modelId;
  else if (existing?.model_id) item.model_id = existing.model_id;

  if (options.maxTurns !== undefined) item.max_turns = options.maxTurns;
  else if (existing?.max_turns !== undefined) item.max_turns = existing.max_turns;

  if (options.githubTokenSecretArn) {item.github_token_secret_arn = options.githubTokenSecretArn;} else if (existing?.github_token_secret_arn) {
    item.github_token_secret_arn = existing.github_token_secret_arn;
  }

  if (options.pollIntervalMs !== undefined) {item.poll_interval_ms = options.pollIntervalMs;} else if (existing?.poll_interval_ms !== undefined) {
    item.poll_interval_ms = existing.poll_interval_ms;
  }

  if (existing?.system_prompt_overrides) {
    item.system_prompt_overrides = existing.system_prompt_overrides;
  }
  if (existing?.egress_allowlist?.length) item.egress_allowlist = existing.egress_allowlist;
  if (existing?.cedar_policies?.length) item.cedar_policies = existing.cedar_policies;
  if (existing?.approval_gate_cap !== undefined) {
    item.approval_gate_cap = existing.approval_gate_cap;
  }
  if (existing?.max_budget_usd !== undefined) item.max_budget_usd = existing.max_budget_usd;

  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return parseRepoConfigRow(item);
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
