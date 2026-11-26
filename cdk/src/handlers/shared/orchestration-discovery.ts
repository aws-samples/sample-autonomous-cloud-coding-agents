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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { validateDag } from './orchestration-dag';
import { type OrchestrationGraphSource } from './orchestration-graph-source';
import { withIntegrationNode } from './orchestration-integration-node';
import { deriveOrchestrationId, extendOrchestration, OrchestrationIdCollisionError, seedOrchestration, type OrchestrationReleaseContext } from './orchestration-store';

export interface DiscoverOrchestrationParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly parentIssueRef: string;
  readonly credentialsRef: string;
  readonly repo: string;
  /** ISO timestamp. */
  readonly now: string;
  /** Optional TTL epoch seconds for the persisted rows. */
  readonly ttl?: number;
  /** Release context stamped on the meta row for the reconciler. */
  readonly releaseContext: OrchestrationReleaseContext;
  /**
   * The producer of the orchestration DAG. Pass a native source for a
   * surface with its own dependency model, or ``declarativeGraphSource`` when the
   * nodes are already in hand (a CLI/API request, or a planner's output).
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
 * results.
 */
export async function discoverOrchestration(
  params: DiscoverOrchestrationParams,
): Promise<DiscoverOrchestrationResult> {
  const { ddb, tableName, parentIssueRef, credentialsRef, repo, now, ttl, releaseContext, graphSource } = params;

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

  const validation = validateDag(fetched.children);
  if (!validation.ok) {
    logger.warn('Orchestration DAG rejected', {
      parent_issue_ref: parentIssueRef,
      reason: validation.reason,
      offending_ids: validation.offendingIds,
    });
    return { kind: 'rejected', reason: validation.reason, message: validation.message };
  }

  const orchestrationId = deriveOrchestrationId(parentIssueRef);
  const augmented = withIntegrationNode(fetched.children, orchestrationId);
  let childrenToSeed = augmented.nodes;
  if (augmented.added) {
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
        leaf_count: childrenToSeed[childrenToSeed.length - 1].depends_on.length,
      });
    }
  }

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
    if (err instanceof OrchestrationIdCollisionError) {
      return {
        kind: 'error',
        message: 'This issue maps to an orchestration that already belongs to a different issue or workspace, '
          + 'so I stopped rather than acting on the wrong graph. This needs an operator to look at it.',
      };
    }
    return { kind: 'error', message: 'Could not persist the orchestration graph. Please re-apply the trigger.' };
  }

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

  const rootSubIssueIds = validation.layers[0] ?? [];

  return {
    kind: 'seeded',
    orchestrationId: seedResult.orchestrationId,
    childCount: childrenToSeed.length,
    rootSubIssueIds,
    alreadyExisted: seedResult.alreadyExisted,
  };
}
