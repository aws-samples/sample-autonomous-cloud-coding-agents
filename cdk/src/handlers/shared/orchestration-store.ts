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
 * Persistence for the orchestration DAG (issue #247, Mode A — PR A2).
 * Writes one row per sub-issue to ``OrchestrationTable`` (PK
 * ``orchestration_id``, SK ``sub_issue_id``) after the graph has been
 * fetched (``linear-subissue-fetch``) and validated
 * (``orchestration-dag``).
 *
 * Idempotency (AC: idempotent on webhook replay): the
 * ``orchestration_id`` is *derived deterministically* from the parent
 * Linear issue id (not random), and rows are written with a
 * ``attribute_not_exists`` condition on first write. A replay of the
 * same parent trigger therefore re-derives the same id and the
 * conditional writes no-op instead of duplicating children. The
 * reconciler (A3) owns child-status transitions; this module only seeds
 * the initial ``blocked`` / ``ready`` rows.
 */

import * as crypto from 'crypto';
import {
  type DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import type { SubIssueNode } from './linear-subissue-fetch';

/** Orchestration-local lifecycle marker on each sub-issue row. */
export type ChildStatus =
  | 'ready' // no predecessors / all predecessors succeeded — releasable
  | 'blocked' // waiting on predecessors
  | 'released' // child task created
  | 'succeeded'
  | 'failed'
  | 'skipped'; // a predecessor failed; this child will never start

/** One persisted sub-issue row. */
export interface OrchestrationChildRow {
  readonly orchestration_id: string;
  readonly sub_issue_id: string;
  readonly parent_linear_issue_id: string;
  readonly linear_workspace_id: string;
  readonly repo: string;
  readonly depends_on: readonly string[];
  readonly child_status: ChildStatus;
  /**
   * The ABCA ``task_id`` created for this child once released. Stamped by
   * ``releaseChild`` alongside the ``child_status → released`` flip;
   * absent until the child is released. The ``ChildTaskIndex`` GSI is
   * keyed on this so the reconciler resolves a terminal task back to its
   * orchestration row.
   */
  readonly child_task_id?: string;
  /**
   * The released child task's head branch (#247 A4). Persisted on the
   * release flip so a DEPENDENT child can stack on / merge it. Absent
   * until released.
   */
  readonly child_branch_name?: string;
  /** Linear human identifier, when known (e.g. ``ENG-42``). */
  readonly linear_identifier?: string;
  /** Sub-issue title, used to build the child task description. */
  readonly title?: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** TTL epoch (seconds) for eventual cleanup. */
  readonly ttl?: number;
}

/**
 * Release context persisted on the parent-meta row so the reconciler can
 * release downstream children WITHOUT re-resolving auth (the webhook
 * already resolved the platform user + Linear OAuth at seed time). The
 * reconciler runs off the TaskTable stream and has no Linear webhook
 * payload to re-derive these from.
 */
export interface OrchestrationReleaseContext {
  /** Platform user the children are attributed to (parent's submitter). */
  readonly platform_user_id: string;
  /** Linear OAuth secret ARN for the agent's outbound Linear MCP. */
  readonly linear_oauth_secret_arn?: string;
  readonly linear_workspace_slug?: string;
  readonly linear_project_id?: string;
}

export interface SeedOrchestrationParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly parentLinearIssueId: string;
  readonly linearWorkspaceId: string;
  readonly repo: string;
  readonly children: readonly SubIssueNode[];
  /** ISO timestamp for created_at/updated_at (injected for testability). */
  readonly now: string;
  /** Optional TTL epoch seconds. */
  readonly ttl?: number;
  /** Release context stamped on the meta row for the reconciler. */
  readonly releaseContext: OrchestrationReleaseContext;
}

export interface SeedOrchestrationResult {
  readonly orchestrationId: string;
  readonly rowsWritten: number;
  /** True when an existing orchestration was found (replay) — no new rows. */
  readonly alreadyExisted: boolean;
}

/**
 * Deterministically derive the ``orchestration_id`` from the parent
 * Linear issue id. Same parent → same id, which is what makes webhook
 * replay idempotent. Prefixed + hashed so the id is opaque and
 * fixed-length regardless of the Linear id format.
 */
export function deriveOrchestrationId(parentLinearIssueId: string): string {
  const hash = crypto.createHash('sha256').update(parentLinearIssueId).digest('hex').slice(0, 32);
  return `orch_${hash}`;
}

/** Marker SK for the parent-meta row (sorts before any UUID sub_issue_id). */
const PARENT_META_SK = '#meta';

/**
 * Seed ``OrchestrationTable`` with one row per sub-issue plus a parent
 * meta row. Idempotent: if the parent meta row already exists (replay),
 * returns ``alreadyExisted: true`` and writes nothing.
 *
 * Initial ``child_status``: ``ready`` when ``depends_on`` is empty
 * (a root — the reconciler releases these immediately), else
 * ``blocked``.
 */
export async function seedOrchestration(
  params: SeedOrchestrationParams,
): Promise<SeedOrchestrationResult> {
  const { ddb, tableName, parentLinearIssueId, linearWorkspaceId, repo, children, now, ttl, releaseContext } = params;
  const orchestrationId = deriveOrchestrationId(parentLinearIssueId);

  // Idempotency gate: a prior run for this parent already seeded rows.
  const existing = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
  }));
  if (existing.Item) {
    logger.info('Orchestration already seeded — skipping (idempotent replay)', {
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
    });
    return { orchestrationId, rowsWritten: 0, alreadyExisted: true };
  }

  const childRows: OrchestrationChildRow[] = children.map((c) => ({
    orchestration_id: orchestrationId,
    sub_issue_id: c.id,
    parent_linear_issue_id: parentLinearIssueId,
    linear_workspace_id: linearWorkspaceId,
    repo,
    depends_on: c.depends_on,
    child_status: c.depends_on.length === 0 ? 'ready' : 'blocked',
    ...(c.identifier !== undefined && { linear_identifier: c.identifier }),
    ...(c.title !== undefined && { title: c.title }),
    created_at: now,
    updated_at: now,
    ...(ttl !== undefined && { ttl }),
  }));

  const metaRow = {
    orchestration_id: orchestrationId,
    sub_issue_id: PARENT_META_SK,
    parent_linear_issue_id: parentLinearIssueId,
    linear_workspace_id: linearWorkspaceId,
    repo,
    child_count: children.length,
    // Release context for the reconciler (downstream releases run off the
    // TaskTable stream with no Linear webhook payload to re-derive these).
    platform_user_id: releaseContext.platform_user_id,
    ...(releaseContext.linear_oauth_secret_arn !== undefined && {
      linear_oauth_secret_arn: releaseContext.linear_oauth_secret_arn,
    }),
    ...(releaseContext.linear_workspace_slug !== undefined && {
      linear_workspace_slug: releaseContext.linear_workspace_slug,
    }),
    ...(releaseContext.linear_project_id !== undefined && {
      linear_project_id: releaseContext.linear_project_id,
    }),
    created_at: now,
    updated_at: now,
    ...(ttl !== undefined && { ttl }),
  };

  // BatchWrite in chunks of 25 (DDB limit). The meta row goes last so a
  // partial failure can't leave a meta row claiming a fully-seeded
  // orchestration when child rows are missing — a replay re-derives the
  // same id, sees no meta row, and re-seeds.
  const allRows: Array<Record<string, unknown>> = [
    ...childRows.map((r) => ({ ...r })),
    { ...metaRow },
  ];
  let rowsWritten = 0;
  for (let i = 0; i < allRows.length; i += 25) {
    const chunk = allRows.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })),
      },
    }));
    rowsWritten += chunk.length;
  }

  logger.info('Orchestration seeded', {
    orchestration_id: orchestrationId,
    parent_linear_issue_id: parentLinearIssueId,
    child_count: children.length,
    rows_written: rowsWritten,
  });

  return { orchestrationId, rowsWritten, alreadyExisted: false };
}

/**
 * Claim the right to post the parent rollup comment exactly once (#247
 * A5). The orchestration can reach "all children terminal" on more than
 * one TaskTable-stream event (the last child's record often gets two
 * MODIFYs — e.g. status→COMPLETED then pr_url/build_passed written — both
 * observing all-terminal), which without a guard posts the rollup twice.
 *
 * Conditionally stamps ``rollup_posted_at`` on the parent-meta row. The
 * first caller wins (returns true → post the comment); a racing/repeat
 * caller loses the conditional write (returns false → skip). Mirrors the
 * release-flip idempotency pattern.
 */
export async function claimRollup(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  now: string,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
      UpdateExpression: 'SET rollup_posted_at = :now',
      ConditionExpression: 'attribute_not_exists(rollup_posted_at)',
      ExpressionAttributeValues: { ':now': now },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Sort-key of the parent-meta row. Exported so the reconciler can
 *  separate it from child rows after a Query. */
export const ORCHESTRATION_META_SK = PARENT_META_SK;

/** Parsed parent-meta row, including the reconciler's release context. */
export interface OrchestrationMeta {
  readonly orchestration_id: string;
  readonly parent_linear_issue_id: string;
  readonly linear_workspace_id: string;
  readonly repo: string;
  readonly child_count: number;
  readonly release_context: OrchestrationReleaseContext;
}

/** All rows for one orchestration: the meta row + every child row. */
export interface OrchestrationSnapshot {
  readonly meta: OrchestrationMeta;
  readonly children: readonly OrchestrationChildRow[];
}

/**
 * Load every row for an orchestration (meta + children) in one Query.
 * Returns null when the orchestration id has no rows (e.g. TTL-reaped).
 * The reconciler calls this after resolving a terminal child's
 * orchestration via the ChildTaskIndex GSI.
 */
export async function loadOrchestration(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
): Promise<OrchestrationSnapshot | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'orchestration_id = :oid',
    ExpressionAttributeValues: { ':oid': orchestrationId },
  }));
  const items = (res.Items ?? []) as Array<Record<string, unknown>>;
  if (items.length === 0) return null;

  const metaItem = items.find((i) => i.sub_issue_id === PARENT_META_SK);
  if (!metaItem) {
    logger.warn('Orchestration rows present but meta row missing', { orchestration_id: orchestrationId });
    return null;
  }

  const children = items
    .filter((i) => i.sub_issue_id !== PARENT_META_SK)
    .map((i) => i as unknown as OrchestrationChildRow);

  const meta: OrchestrationMeta = {
    orchestration_id: orchestrationId,
    parent_linear_issue_id: metaItem.parent_linear_issue_id as string,
    linear_workspace_id: metaItem.linear_workspace_id as string,
    repo: metaItem.repo as string,
    child_count: (metaItem.child_count as number) ?? children.length,
    release_context: {
      platform_user_id: metaItem.platform_user_id as string,
      ...(metaItem.linear_oauth_secret_arn !== undefined && {
        linear_oauth_secret_arn: metaItem.linear_oauth_secret_arn as string,
      }),
      ...(metaItem.linear_workspace_slug !== undefined && {
        linear_workspace_slug: metaItem.linear_workspace_slug as string,
      }),
      ...(metaItem.linear_project_id !== undefined && {
        linear_project_id: metaItem.linear_project_id as string,
      }),
    },
  };

  return { meta, children };
}
