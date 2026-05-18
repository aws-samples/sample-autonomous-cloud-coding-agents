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
  /**
   * Cedar HITL: per-blueprint override for the per-task approval-gate cap
   * (design decision #13, §4 step 5). Written by the Blueprint construct
   * when ``security.approvalGateCap`` is supplied. Read by
   * ``create-task-core`` at submit-time and persisted onto the TaskRecord
   * so mid-task blueprint edits do not shift the cap beneath a running
   * task. Absent when the blueprint did not configure it — the submit
   * path falls back to the platform default of 50.
   */
  readonly approval_gate_cap?: number;
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
  /**
   * Cedar HITL: per-blueprint approval-gate cap override. Surfaced from
   * RepoConfig so downstream consumers (admission, orchestrator payload)
   * can reason about cap-aware dispatching without a second RepoTable
   * GetItem. ``create-task-core`` is the authoritative resolver — this
   * field is informational for the runtime path.
   */
  readonly approval_gate_cap?: number;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Combined result of a single RepoTable GetItem used by the submit
 * path. ``onboarded`` mirrors the old ``checkRepoOnboarded`` contract
 * (true when a row exists with ``status=active``, false otherwise);
 * ``config`` is the full RepoConfig when onboarded, null otherwise.
 *
 * The submit flow previously issued TWO GetItems on the same key —
 * ``checkRepoOnboarded`` for the gate, then ``loadRepoConfig`` for
 * the blueprint cap. One call now covers both; the convenience
 * ``checkRepoOnboarded`` / ``loadRepoConfig`` helpers below delegate
 * to this so call sites that only want one answer stay readable.
 */
export interface RepoLookupResult {
  readonly onboarded: boolean;
  readonly config: RepoConfig | null;
}

/**
 * Single-GetItem repo lookup used by the task submit path (design
 * §7.3). Returns both the onboarding verdict and the full RepoConfig
 * so create-task-core can gate AND resolve the blueprint
 * approval-gate cap without issuing a second read.
 *
 * Semantics:
 *   - ``REPO_TABLE_NAME`` unset → ``{ onboarded: true, config: null }``
 *     (dev fallback; the onboarding gate is effectively disabled).
 *   - Row missing → ``{ onboarded: false, config: null }``.
 *   - Row present but ``status != 'active'`` → ``{ onboarded: false, config: null }``.
 *   - Row present with ``status = 'active'`` → ``{ onboarded: true, config }``.
 *
 * @param repo - the "owner/repo" string.
 */
export async function lookupRepo(repo: string): Promise<RepoLookupResult> {
  const tableName = process.env.REPO_TABLE_NAME;
  if (!tableName) {
    logger.warn('REPO_TABLE_NAME not configured — onboarding gate disabled, all repos allowed', { repo });
    return { onboarded: true, config: null };
  }

  try {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { repo },
    }));

    if (!result.Item) {
      return { onboarded: false, config: null };
    }

    const config = result.Item as RepoConfig;
    if (config.status !== 'active') {
      logger.info('Repo config found but status is not active, ignoring', { repo, status: config.status });
      return { onboarded: false, config: null };
    }

    return { onboarded: true, config };
  } catch (err) {
    logger.error('Failed to look up repo config', {
      repo,
      table: tableName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Unable to look up repo config for '${repo}': ${String(err)}`);
  }
}

/**
 * Check if a repository is onboarded (active) in the RepoTable.
 * Thin wrapper over ``lookupRepo`` for call sites that only need the
 * gate verdict (e.g. ``get-policies``). The submit path prefers
 * ``lookupRepo`` directly so it can reuse the RepoConfig payload
 * without a second GetItem.
 * @param repo - the "owner/repo" string.
 */
export async function checkRepoOnboarded(repo: string): Promise<{ onboarded: boolean }> {
  const { onboarded } = await lookupRepo(repo);
  return { onboarded };
}

/**
 * Load the full RepoConfig for a repository. Thin wrapper over
 * ``lookupRepo`` for call sites that only need the config (e.g. the
 * orchestrator). Returns null when the repo is not onboarded or the
 * table is unset; the submit path prefers ``lookupRepo`` directly.
 * @param repo - the "owner/repo" string.
 */
export async function loadRepoConfig(repo: string): Promise<RepoConfig | null> {
  const { config } = await lookupRepo(repo);
  return config;
}
