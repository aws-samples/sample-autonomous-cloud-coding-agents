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
import { validateDag } from './orchestration-dag';
import { type OrchestrationGraphSource } from './orchestration-graph-source';
import { withIntegrationNode } from './orchestration-integration-node';
import { deriveOrchestrationId, extendOrchestration, seedOrchestration, type OrchestrationReleaseContext } from './orchestration-store';

export interface DiscoverOrchestrationParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly parentIssueRef: string;
  readonly credentialsRef: string;
  readonly repo: string;
  /** ISO timestamp injected for testability. */
  readonly now: string;
  /** Optional TTL epoch seconds for the persisted rows. */
  readonly ttl?: number;
  /** Release context stamped on the meta row for the reconciler. */
  readonly releaseContext: OrchestrationReleaseContext;
  /**
   * The producer of the orchestration DAG — REQUIRED, so the caller always
   * states where the graph comes from. It used to be optional and fell back to
   * reading Linear, which meant a caller on any other surface silently made a
   * Linear API call for a graph that was never there. Pass a native source for a
   * surface with its own dependency model, or ``declarativeGraphSource`` when the
   * nodes are already in hand (a CLI/API request, or a planner's output). The
   * validate→seed→reconcile→rollup pipeline downstream is identical either way.
   */
  readonly graphSource: OrchestrationGraphSource;
}

export type DiscoverOrchestrationResult =
  | { readonly kind: 'single_task'; readonly parentIssueRef: string }
  | {
    readonly kind: 'seeded';
    readonly orchestrationId: string;
    readonly childCount: number;
    readonly rootSubIssueIds: readonly string[];
    readonly alreadyExisted: boolean;
  }
  | {
    // An already-seeded orchestration that was EXTENDED with sub-issues
    // added to the epic after the first seed (orchestration-extend). Carries
    // the new node ids + which are immediately releasable.
    readonly kind: 'extended';
    readonly orchestrationId: string;
    readonly addedSubIssueIds: readonly string[];
    readonly releasableSubIssueIds: readonly string[];
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
  const { ddb, tableName, parentIssueRef, credentialsRef, repo, now, ttl, releaseContext, graphSource } = params;

  // ── 1. Produce the orchestration graph ───────────────────────────
  // The caller states the source; this composer never reaches for a surface of
  // its own. The downstream pipeline is identical regardless of where the graph
  // came from.
  const fetched = await graphSource();
  if (fetched.kind === 'error') {
    return { kind: 'error', message: fetched.message };
  }
  if (fetched.kind === 'no_children') {
    logger.info('No orchestration graph — falling back to single task', {
      parent_issue_ref: parentIssueRef,
    });
    return { kind: 'single_task', parentIssueRef };
  }

  // ── 2. Validate the DAG (cycle / dangling / duplicate rejection) ─
  const validation = validateDag(fetched.children);
  if (!validation.ok) {
    logger.warn('Orchestration DAG rejected', {
      parent_issue_ref: parentIssueRef,
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
  const orchestrationId = deriveOrchestrationId(parentIssueRef);
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
        parent_issue_ref: parentIssueRef,
        reason: reValidation.reason,
      });
      childrenToSeed = fetched.children;
    } else {
      logger.info('Orchestration fan-out detected — added integration node', {
        parent_issue_ref: parentIssueRef,
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
      parentIssueRef,
      credentialsRef,
      repo,
      children: childrenToSeed,
      now,
      releaseContext,
      ...(ttl !== undefined && { ttl }),
    });
  } catch (err) {
    logger.error('Failed to persist orchestration graph', {
      parent_issue_ref: parentIssueRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'Could not persist the orchestration graph. Please re-apply the trigger.' };
  }

  // ── 3b. Already-seeded → EXTEND with any sub-issues added since the first
  // seed (orchestration-extend). seedOrchestration is frozen-at-first-seed, so
  // a re-trigger of an existing epic lands here; diff the current graph against
  // the persisted children and add genuinely-new nodes. A re-trigger with no
  // new nodes is a clean no-op (addedSubIssueIds empty).
  if (seedResult.alreadyExisted) {
    let extendResult;
    try {
      extendResult = await extendOrchestration({
        ddb,
        tableName,
        parentIssueRef,
        credentialsRef,
        repo,
        graph: childrenToSeed,
        now,
        ...(ttl !== undefined && { ttl }),
      });
    } catch (err) {
      logger.error('Failed to extend orchestration graph', {
        parent_issue_ref: parentIssueRef,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'error', message: 'Could not extend the orchestration graph. Please re-apply the trigger.' };
    }
    if (extendResult.rejected) {
      return { kind: 'rejected', reason: extendResult.rejected.reason, message: extendResult.rejected.message };
    }
    return {
      kind: 'extended',
      orchestrationId: extendResult.orchestrationId,
      addedSubIssueIds: extendResult.addedSubIssueIds,
      releasableSubIssueIds: extendResult.releasableSubIssueIds,
    };
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
