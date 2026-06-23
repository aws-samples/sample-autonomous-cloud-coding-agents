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
 * Pending-plan persistence for the #299 Mode B approval gate (B4).
 *
 * When a ``bgagent:decompose`` issue produces a plan, Mode B posts it and WAITS
 * for ``@bgagent approve``/``reject`` — a SECOND, later webhook event. The plan
 * has to survive between the two events, so it is persisted as one row in the
 * existing ``OrchestrationTable``, keyed on the parent's derived
 * ``orchestration_id`` + a fixed ``#pending-plan`` sort key. The row carries a
 * TTL so an un-acted plan self-expires.
 *
 * This is deliberately a SEPARATE module from ``orchestration-store.ts`` (the
 * executor's store): a pending plan is pre-execution state, distinct from the
 * seeded child graph. It shares only ``deriveOrchestrationId`` so the same
 * parent maps to the same key in both phases.
 *
 * Idempotency: {@link putPendingPlan} is a create-once conditional write (a
 * webhook redelivery of the same ``:decompose`` event finds the row present and
 * is a no-op — the UX.20 redelivery-spam lesson). {@link consumePendingPlan} is
 * a conditional delete-and-return so two racing ``approve`` deliveries can't
 * both write back the sub-issues — only the delete winner proceeds.
 */

import {
  type DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import type { PlannedSubIssue } from './orchestration-decomposition-types';
import { deriveOrchestrationId } from './orchestration-store';

/** Sort key of the single pending-plan row for a parent's orchestration. */
export const PENDING_PLAN_SK = '#pending-plan';

/** The persisted pending plan awaiting approval. */
export interface PendingPlan {
  readonly orchestration_id: string;
  readonly parent_linear_issue_id: string;
  readonly linear_workspace_id: string;
  readonly repo: string;
  /** Linear project id — needed to rebuild the release context at approval. */
  readonly linear_project_id?: string;
  /** The proposed sub-issues (with index-based ``depends_on``). */
  readonly nodes: readonly PlannedSubIssue[];
  /** Platform user the eventual child tasks attribute to (the submitter). */
  readonly platform_user_id: string;
  /** The Linear comment id of the posted proposal (for the approve/reject reply target). */
  readonly proposal_comment_id?: string;
  readonly created_at: string;
}

export interface PutPendingPlanParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly parentLinearIssueId: string;
  readonly linearWorkspaceId: string;
  readonly repo: string;
  readonly nodes: readonly PlannedSubIssue[];
  readonly platformUserId: string;
  readonly linearProjectId?: string;
  readonly proposalCommentId?: string;
  readonly now: string;
  /** Absolute epoch-seconds expiry for the row (un-acted plans self-clean). */
  readonly ttlEpochSeconds: number;
}

/**
 * Persist a pending plan, create-once. Returns ``true`` only for the first
 * writer; a redelivery (row already present) returns ``false`` and writes
 * nothing — so the proposal is posted exactly once per ``:decompose`` event.
 */
export async function putPendingPlan(params: PutPendingPlanParams): Promise<boolean> {
  const orchestrationId = deriveOrchestrationId(params.parentLinearIssueId);
  try {
    await params.ddb.send(new PutCommand({
      TableName: params.tableName,
      Item: {
        orchestration_id: orchestrationId,
        sub_issue_id: PENDING_PLAN_SK,
        parent_linear_issue_id: params.parentLinearIssueId,
        linear_workspace_id: params.linearWorkspaceId,
        repo: params.repo,
        ...(params.linearProjectId !== undefined && { linear_project_id: params.linearProjectId }),
        nodes: params.nodes,
        platform_user_id: params.platformUserId,
        ...(params.proposalCommentId !== undefined && { proposal_comment_id: params.proposalCommentId }),
        created_at: params.now,
        ttl: params.ttlEpochSeconds,
      },
      // Create-once: a redelivery finds the row and the condition fails.
      ConditionExpression: 'attribute_not_exists(orchestration_id)',
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      logger.info('Pending plan already exists — skipping (idempotent redelivery)', {
        orchestration_id: orchestrationId,
      });
      return false;
    }
    throw err;
  }
}

/** Read a pending plan without consuming it (e.g. to render status). */
export async function getPendingPlan(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  parentLinearIssueId: string,
): Promise<PendingPlan | undefined> {
  const orchestrationId = deriveOrchestrationId(parentLinearIssueId);
  const res = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PENDING_PLAN_SK },
  }));
  if (!res.Item) return undefined;
  return parsePendingPlan(res.Item);
}

/**
 * Atomically take the pending plan: delete the row and return what it held.
 * The conditional delete (``attribute_exists``) means only the FIRST of two
 * racing ``approve`` deliveries wins — the loser gets ``undefined`` and must
 * not write back the sub-issues. Returns ``undefined`` when there is no pending
 * plan (already consumed, expired, or never existed).
 */
export async function consumePendingPlan(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  parentLinearIssueId: string,
): Promise<PendingPlan | undefined> {
  const orchestrationId = deriveOrchestrationId(parentLinearIssueId);
  try {
    const res = await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { orchestration_id: orchestrationId, sub_issue_id: PENDING_PLAN_SK },
      ConditionExpression: 'attribute_exists(orchestration_id)',
      ReturnValues: 'ALL_OLD',
    }));
    if (!res.Attributes) return undefined;
    return parsePendingPlan(res.Attributes);
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      logger.info('Pending plan already consumed/expired (race or replay) — no-op', {
        orchestration_id: orchestrationId,
      });
      return undefined;
    }
    throw err;
  }
}

/** Discard a pending plan (the ``reject`` path). Idempotent — absence is fine. */
export async function discardPendingPlan(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  parentLinearIssueId: string,
): Promise<void> {
  const orchestrationId = deriveOrchestrationId(parentLinearIssueId);
  await ddb.send(new DeleteCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PENDING_PLAN_SK },
  }));
}

/** Coerce a raw DDB item into a typed PendingPlan (best-effort, total). */
function parsePendingPlan(item: Record<string, unknown>): PendingPlan {
  return {
    orchestration_id: String(item.orchestration_id ?? ''),
    parent_linear_issue_id: String(item.parent_linear_issue_id ?? ''),
    linear_workspace_id: String(item.linear_workspace_id ?? ''),
    repo: String(item.repo ?? ''),
    ...(item.linear_project_id !== undefined && { linear_project_id: String(item.linear_project_id) }),
    nodes: Array.isArray(item.nodes) ? (item.nodes as PlannedSubIssue[]) : [],
    platform_user_id: String(item.platform_user_id ?? ''),
    ...(item.proposal_comment_id !== undefined && { proposal_comment_id: String(item.proposal_comment_id) }),
    created_at: String(item.created_at ?? ''),
  };
}
