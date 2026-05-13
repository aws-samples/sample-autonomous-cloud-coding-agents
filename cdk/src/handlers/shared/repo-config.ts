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
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

/**
 * Per-repository configuration written by the Blueprint CDK construct
 * and read at runtime by the task API gate and the orchestrator.
 */
export type ComputeType = 'agentcore' | 'ecs';

/** Runtime representation of a tool profile stored in RepoConfig. */
export interface StoredToolProfile {
  readonly capabilityTier?: 'default' | 'extended';
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly cedarPolicies?: readonly string[];
  readonly description?: string;
}

export interface RepoConfig {
  readonly repo: string;
  readonly status: 'active' | 'removed';
  readonly onboarded_at: string;
  readonly updated_at: string;
  readonly compute_type?: ComputeType;
  readonly runtime_arn?: string;
  readonly model_id?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly system_prompt_overrides?: string;
  readonly github_token_secret_arn?: string;
  readonly poll_interval_ms?: number;
  readonly egress_allowlist?: string[];
  readonly cedar_policies?: string[];
  /** JSON-serialized map of profile name → ToolProfile, written by Blueprint. */
  readonly tool_profiles?: string;
}

/**
 * Merged blueprint config used by the orchestrator. Combines per-repo
 * settings with platform defaults.
 */
export interface BlueprintConfig {
  readonly compute_type: ComputeType;
  readonly runtime_arn: string;
  readonly model_id?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly system_prompt_overrides?: string;
  readonly github_token_secret_arn?: string;
  readonly poll_interval_ms?: number;
  readonly egress_allowlist?: string[];
  readonly cedar_policies?: string[];
  /** Parsed tool profiles map (profile name → definition). */
  readonly tool_profiles?: Readonly<Record<string, StoredToolProfile>>;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Check if a repository is onboarded (active) in the RepoTable.
 * Used by the task API gate to reject tasks for non-onboarded repos.
 * @param repo - the "owner/repo" string.
 * @returns an object indicating whether the repo is onboarded.
 */
export async function checkRepoOnboarded(repo: string): Promise<{ onboarded: boolean }> {
  const tableName = process.env.REPO_TABLE_NAME;
  if (!tableName) {
    logger.warn('REPO_TABLE_NAME not configured — onboarding gate disabled, all repos allowed', { repo });
    return { onboarded: true };
  }

  try {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { repo },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }));

    if (!result.Item) {
      return { onboarded: false };
    }

    return { onboarded: result.Item.status === 'active' };
  } catch (err) {
    logger.error('Failed to check repo onboarding status', {
      repo,
      table: tableName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Unable to verify onboarding status for '${repo}': ${String(err)}`);
  }
}

/**
 * Load the full RepoConfig for a repository.
 * Used by the orchestrator to get per-repo settings.
 * @param repo - the "owner/repo" string.
 * @returns the RepoConfig record, or null if not found.
 */
export async function loadRepoConfig(repo: string): Promise<RepoConfig | null> {
  const tableName = process.env.REPO_TABLE_NAME;
  if (!tableName) {
    logger.warn('REPO_TABLE_NAME not configured — skipping repo config lookup', { repo });
    return null;
  }

  try {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { repo },
    }));

    if (!result.Item) {
      return null;
    }

    const config = result.Item as RepoConfig;
    if (config.status !== 'active') {
      logger.info('Repo config found but status is not active, ignoring', { repo, status: config.status });
      return null;
    }

    return config;
  } catch (err) {
    logger.error('Failed to load repo config', {
      repo,
      table: tableName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Unable to load repo config for '${repo}': ${String(err)}`);
  }
}

/**
 * Parse the tool_profiles JSON string from a RepoConfig into a typed map.
 * Returns an empty object if the field is absent or unparseable.
 */
export function parseToolProfiles(raw: string | undefined): Readonly<Record<string, StoredToolProfile>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn('tool_profiles is not a valid object, ignoring', { raw_type: typeof parsed });
      return {};
    }
    return parsed as Record<string, StoredToolProfile>;
  } catch (err) {
    logger.warn('Failed to parse tool_profiles JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Validate that a tool profile name exists in the given profiles map.
 * @param profileName - the profile name from the task request.
 * @param profiles - the parsed tool profiles from RepoConfig.
 * @returns true if the profile exists.
 */
export function isValidToolProfile(profileName: string, profiles: Readonly<Record<string, StoredToolProfile>>): boolean {
  return Object.prototype.hasOwnProperty.call(profiles, profileName);
}
