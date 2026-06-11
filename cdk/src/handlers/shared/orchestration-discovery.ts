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

/**
 * Orchestration discovery composer (issue #247, Mode A — PR A2).
 *
 * Ties together the three A2 primitives in one decision function the
 * webhook processor calls when a parent issue is labeled:
 *
 *   fetchSubIssueGraph  →  validateDag  →  seedOrchestration
 *
 * and returns a single discriminated outcome the caller acts on:
 *
 * - ``single_task``  — the issue has no sub-issues; the caller should
 *   fall through to today's one-issue→one-task path (NOT an error).
 * - ``seeded``       — a valid DAG was persisted; the reconciler (A3)
 *   will release children. Carries the orchestration id + initial
 *   ready (root) set so the caller / A3 can start them.
 * - ``rejected``     — the graph is invalid (cycle / dangling / dup).
 *   Carries a user-facing message for the terminal Linear comment;
 *   nothing is persisted.
 * - ``error``        — transient failure reaching Linear; the caller
 *   surfaces a retryable message and does NOT fall back to a single
 *   task (that would silently drop the epic structure).
 *
 * The DAG validation + persistence are pure/injected, so this composer
 * is fully unit-testable with a mock fetch + mock ddb.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import {
  linearGraphSource,
  type OrchestrationGraphSource,
} from './orchestration-graph-source';
import type { FetchSubIssueGraphOptions } from './linear-subissue-fetch';
import { validateDag } from './orchestration-dag';
import { withIntegrationNode } from './orchestration-integration-node';
import { deriveOrchestrationId, seedOrchestration, type OrchestrationReleaseContext } from './orchestration-store';

export interface DiscoverOrchestrationParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  /**
   * Resolved per-workspace OAuth access token (from resolveLinearOauthToken).
   * Used to build the default Linear graph source when ``graphSource`` is
   * not supplied. Ignored when ``graphSource`` is given.
   */
  readonly accessToken: string;
  readonly parentLinearIssueId: string;
  readonly linearWorkspaceId: string;
  readonly repo: string;
  /** ISO timestamp injected for testability. */
  readonly now: string;
  /** Optional TTL epoch seconds for the persisted rows. */
  readonly ttl?: number;
  /** Release context stamped on the meta row for the reconciler. */
  readonly releaseContext: OrchestrationReleaseContext;
  /** Test seam for the (default) Linear fetch. Ignored when ``graphSource`` is set. */
  readonly fetchOptions?: FetchSubIssueGraphOptions;
  /**
   * #247/#299 trigger-agnostic seam. The producer of the orchestration DAG.
   * When omitted, defaults to {@link linearGraphSource} over
   * ``accessToken`` + ``parentLinearIssueId`` (Mode A behaviour). A
   * declarative caller (CLI/API) or #299 Mode B planner passes its own
   * source so the SAME validate→seed→reconcile→rollup pipeline runs over a
   * graph produced any way.
   */
  readonly graphSource?: OrchestrationGraphSource;
}

export type DiscoverOrchestrationResult =
  | { readonly kind: 'single_task'; readonly parentLinearIssueId: string }
  | {
      readonly kind: 'seeded';
      readonly orchestrationId: string;
      readonly childCount: number;
      readonly rootSubIssueIds: readonly string[];
      readonly alreadyExisted: boolean;
    }
  | { readonly kind: 'rejected'; readonly reason: string; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Discover, validate, and persist a parent issue's sub-issue DAG.
 * Never throws — all failure modes are returned as discriminated
 * results so the webhook processor can map each to the right
 * user-facing behaviour.
 */
export async function discoverOrchestration(
  params: DiscoverOrchestrationParams,
): Promise<DiscoverOrchestrationResult> {
  const { ddb, tableName, accessToken, parentLinearIssueId, linearWorkspaceId, repo, now, ttl, releaseContext, fetchOptions, graphSource } = params;

  // ── 1. Produce the orchestration graph ───────────────────────────
  // Default to the Linear native source (Mode A); a declarative / planner
  // caller (#299) supplies its own graphSource. The downstream pipeline is
  // identical regardless of where the graph came from.
  const source = graphSource ?? linearGraphSource(accessToken, parentLinearIssueId, fetchOptions);
  const fetched = await source();
  if (fetched.kind === 'error') {
    return { kind: 'error', message: fetched.message };
  }
  if (fetched.kind === 'no_children') {
    logger.info('No orchestration graph — falling back to single task', {
      parent_linear_issue_id: parentLinearIssueId,
    });
    return { kind: 'single_task', parentLinearIssueId };
  }

  // ── 2. Validate the DAG (cycle / dangling / duplicate rejection) ─
  const validation = validateDag(fetched.children);
  if (!validation.ok) {
    logger.warn('Orchestration DAG rejected', {
      parent_linear_issue_id: parentLinearIssueId,
      reason: validation.reason,
      offending_ids: validation.offendingIds,
    });
    return { kind: 'rejected', reason: validation.reason, message: validation.message };
  }

  // ── 2b. #16: auto-integration node for fan-out. If the validated DAG has
  // >1 leaf, append a synthetic node depending on all leaves so a pure
  // fan-out still produces ONE combined result (the node is a diamond
  // fan-in, reusing A4's merge). No-op for linear chains / explicit
  // diamonds (≤1 leaf). The orchestration id is derived deterministically
  // from the parent issue, so we can name the synthetic node before seeding.
  const orchestrationId = deriveOrchestrationId(parentLinearIssueId);
  const augmented = withIntegrationNode(fetched.children, orchestrationId);
  let childrenToSeed = augmented.nodes;
  if (augmented.added) {
    // Re-validate defensively — appending a fan-in over leaves cannot
    // introduce a cycle/dangle/dup, but seeding an invalid graph would be
    // worse than skipping the synthetic node, so fail-safe to the
    // un-augmented graph if it ever does.
    const reValidation = validateDag(childrenToSeed);
    if (!reValidation.ok) {
      logger.error('Integration node produced an invalid DAG — seeding without it', {
        parent_linear_issue_id: parentLinearIssueId,
        reason: reValidation.reason,
      });
      childrenToSeed = fetched.children;
    } else {
      logger.info('Orchestration fan-out detected — added integration node', {
        parent_linear_issue_id: parentLinearIssueId,
        orchestration_id: orchestrationId,
        // the synthetic node is last; its predecessors are the leaves it merges
        leaf_count: childrenToSeed[childrenToSeed.length - 1].depends_on.length,
      });
    }
  }

  // ── 3. Persist (idempotent on replay) ────────────────────────────
  let seedResult;
  try {
    seedResult = await seedOrchestration({
      ddb,
      tableName,
      parentLinearIssueId,
      linearWorkspaceId,
      repo,
      children: childrenToSeed,
      now,
      releaseContext,
      ...(ttl !== undefined && { ttl }),
    });
  } catch (err) {
    logger.error('Failed to persist orchestration graph', {
      parent_linear_issue_id: parentLinearIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'Could not persist the orchestration graph. Please re-apply the trigger.' };
  }

  // Roots = layer 0 of the validated topological layering. The
  // reconciler (A3) releases these first.
  const rootSubIssueIds = validation.layers[0] ?? [];

  return {
    kind: 'seeded',
    orchestrationId: seedResult.orchestrationId,
    childCount: childrenToSeed.length,
    rootSubIssueIds,
    alreadyExisted: seedResult.alreadyExisted,
  };
}
