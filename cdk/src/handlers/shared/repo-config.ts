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

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ComputeBackend } from './compute-backend';
import { logger } from './logger';
import { makeDocClient } from './ua';

export type ComputeType = ComputeBackend;

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
  /**
   * Token budget of the memory context that hydration loads for this repo.
   * When absent, hydration applies the platform default.
   */
  readonly memory_token_budget?: number;
  readonly system_prompt_overrides?: string;
  readonly github_token_secret_arn?: string;
  readonly poll_interval_ms?: number;
  /**
   * Per-repo build/lint verification commands. The agent runs these to gate
   * build/lint regressions before opening a PR; default to
   * ``mise run build`` / ``mise run lint`` when unset.
   */
  readonly build_command?: string;
  readonly lint_command?: string;
  readonly egress_allowlist?: string[];
  readonly cedar_policies?: string[];
  /**
   * Cedar HITL: per-blueprint override for the per-task approval-gate cap.
   * Read at submit-time and persisted onto the TaskRecord. When absent, the
   * submit path falls back to the platform default.
   */
  readonly approval_gate_cap?: number;
  /**
   * Registry ``registry://`` refs for MCP servers pinned by the
   * blueprint. Resolved by the orchestrator at task start and merged into the
   * agent's ``.mcp.json``.
   */
  readonly mcp_servers?: string[];
  /** Registry Cedar policy module refs; resolved cedar_text is merged
   *  into the ``cedar_policies`` payload. */
  readonly cedar_policy_modules?: string[];
  /** Registry skill refs; resolved prompt fragments append to the
   *  system prompt. */
  readonly skills?: string[];
}

/**
 * Merged blueprint config used by the orchestrator. Combines per-repo
 * settings with platform defaults.
 */
export interface BlueprintConfig {
  readonly compute_type: ComputeType;
  readonly runtime_arn?: string;
  readonly model_id?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  /** Per-repo memory token budget; hydration applies the platform default when unset. */
  readonly memory_token_budget?: number;
  readonly system_prompt_overrides?: string;
  readonly github_token_secret_arn?: string;
  readonly poll_interval_ms?: number;
  /** Per-repo build/lint verification commands. Default mise when unset. */
  readonly build_command?: string;
  readonly lint_command?: string;
  readonly egress_allowlist?: string[];
  readonly cedar_policies?: string[];
  /**
   * Cedar HITL: per-blueprint approval-gate cap override. Informational for
   * the runtime path: ``create-task-core`` is the authoritative resolver.
   */
  readonly approval_gate_cap?: number;
  readonly mcp_servers?: string[];
  readonly cedar_policy_modules?: string[];
  readonly skills?: string[];
}

const ddb = makeDocClient();

/**
 * ``onboarded`` is true when a row exists with ``status=active``, false
 * otherwise; ``config`` is the full RepoConfig when onboarded, null otherwise.
 */
export interface RepoLookupResult {
  readonly onboarded: boolean;
  readonly config: RepoConfig | null;
}

/**
 * Single-GetItem repo lookup. Returns both the onboarding verdict and the
 * full RepoConfig.
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
 * @param repo - the "owner/repo" string.
 */
export async function checkRepoOnboarded(repo: string): Promise<{ onboarded: boolean }> {
  const { onboarded } = await lookupRepo(repo);
  return { onboarded };
}

/**
 * Load the full RepoConfig for a repository. Returns null when the repo
 * is not onboarded or the table is unset.
 * @param repo - the "owner/repo" string.
 */
export async function loadRepoConfig(repo: string): Promise<RepoConfig | null> {
  const { config } = await lookupRepo(repo);
  return config;
}
