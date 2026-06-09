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
 * Child-task release for orchestration (issue #247, Mode A — PR A3).
 *
 * The single path that turns an orchestration child row into a running
 * ABCA task. Used in two places:
 *   - seed time (the webhook processor / discovery): release the root
 *     children (layer 0) so the graph starts.
 *   - reconcile time (the TaskTable-stream reconciler): release children
 *     whose predecessors just all succeeded.
 *
 * Each release:
 *   1. createTaskCore(...) with channelSource 'linear' + orchestration
 *      metadata, idempotency-keyed on ``orchestration_id#sub_issue_id``
 *      so a duplicate stream event / webhook replay never double-creates.
 *   2. on 201, conditionally flip the row child_status blocked|ready →
 *      released and stamp child_task_id (the GSI then resolves the
 *      task back to its row on the child's terminal event).
 *
 * The conditional update (``child_status IN (blocked, ready)``) is the
 * second idempotency guard: if two reconcile invocations race the same
 * release, only one wins the status flip; createTaskCore's own
 * idempotency key means the loser doesn't create a second task either.
 */

import {
  type DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { createTaskCore as CreateTaskCoreFn } from './create-task-core';
import { logger } from './logger';
import type { OrchestrationChildRow } from './orchestration-store';

export interface ReleaseChildParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  /** The orchestration child row to release. */
  readonly row: OrchestrationChildRow;
  /** Platform user the child task is attributed to (parent's submitter). */
  readonly platformUserId: string;
  /** Linear OAuth secret ARN + slug for the agent's outbound Linear MCP. */
  readonly linearOauthSecretArn?: string;
  readonly linearWorkspaceSlug?: string;
  readonly linearProjectId?: string;
  /** The base branch this child stacks on (ADR-001). Defaults to main (root). */
  readonly baseBranch?: string;
  /** Injected createTaskCore (real handler in prod, mock in tests). */
  readonly createTaskCore: typeof CreateTaskCoreFn;
  /** ISO timestamp (injected for testability). */
  readonly now: string;
}

export type ReleaseChildResult =
  | { readonly kind: 'released'; readonly taskId: string }
  | { readonly kind: 'create_failed'; readonly statusCode: number; readonly body: string }
  | { readonly kind: 'already_released' }
  | { readonly kind: 'error'; readonly message: string };

/** Build the child task description from the sub-issue's identifier/title. */
function buildChildDescription(row: OrchestrationChildRow): string {
  const parts: string[] = [];
  if (row.linear_identifier && row.title) {
    parts.push(`${row.linear_identifier}: ${row.title}`);
  } else if (row.title) {
    parts.push(row.title);
  } else if (row.linear_identifier) {
    parts.push(row.linear_identifier);
  }
  return parts.join('\n') || `Linear sub-issue ${row.sub_issue_id}`;
}

/**
 * Release one orchestration child as an ABCA task. Idempotent: a
 * duplicate call (stream redelivery, racing reconcile) does not create a
 * second task, and the row flip to ``released`` is conditional.
 */
export async function releaseChild(params: ReleaseChildParams): Promise<ReleaseChildResult> {
  const { ddb, tableName, row, platformUserId, baseBranch, createTaskCore, now } = params;

  const channelMetadata: Record<string, string> = {
    linear_issue_id: row.sub_issue_id,
    linear_workspace_id: row.linear_workspace_id,
    orchestration_id: row.orchestration_id,
    orchestration_sub_issue_id: row.sub_issue_id,
    parent_linear_issue_id: row.parent_linear_issue_id,
  };
  if (row.linear_identifier) channelMetadata.linear_issue_identifier = row.linear_identifier;
  if (params.linearProjectId) channelMetadata.linear_project_id = params.linearProjectId;
  if (params.linearOauthSecretArn) channelMetadata.linear_oauth_secret_arn = params.linearOauthSecretArn;
  if (params.linearWorkspaceSlug) channelMetadata.linear_workspace_slug = params.linearWorkspaceSlug;

  // Deterministic idempotency key: same child never creates two tasks.
  const idempotencyKey = `${row.orchestration_id}#${row.sub_issue_id}`;

  let result;
  try {
    result = await createTaskCore(
      {
        repo: row.repo,
        task_description: buildChildDescription(row),
      },
      {
        userId: platformUserId,
        channelSource: 'linear',
        channelMetadata,
        idempotencyKey,
      },
      // requestId — reuse the idempotency key for trace correlation.
      idempotencyKey,
    );
  } catch (err) {
    logger.error('Orchestration child createTaskCore threw', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  // 201 = created; 200 = idempotent replay (task already existed). Both
  // mean "a task exists for this child" — treat alike.
  if (result.statusCode !== 201 && result.statusCode !== 200) {
    logger.warn('Orchestration child task creation returned non-success', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      status: result.statusCode,
    });
    return { kind: 'create_failed', statusCode: result.statusCode, body: result.body };
  }

  const taskId = extractTaskId(result.body);

  // Flip the row to released, conditionally — only from a not-yet-started
  // state. A racing release loses here (ConditionalCheckFailed) and
  // returns already_released; createTaskCore's idempotency key means the
  // loser created no second task.
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
      UpdateExpression: 'SET child_status = :released, child_task_id = :tid, updated_at = :now',
      ConditionExpression: 'child_status IN (:blocked, :ready)',
      ExpressionAttributeValues: {
        ':released': 'released',
        ':tid': taskId,
        ':now': now,
        ':blocked': 'blocked',
        ':ready': 'ready',
      },
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      logger.info('Orchestration child already released (idempotent race)', {
        orchestration_id: row.orchestration_id,
        sub_issue_id: row.sub_issue_id,
      });
      return { kind: 'already_released' };
    }
    logger.error('Failed to mark orchestration child released', {
      orchestration_id: row.orchestration_id,
      sub_issue_id: row.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  logger.info('Orchestration child released', {
    orchestration_id: row.orchestration_id,
    sub_issue_id: row.sub_issue_id,
    task_id: taskId,
    base_branch: baseBranch ?? 'main',
  });
  return { kind: 'released', taskId };
}

/** Pull the task_id out of a createTaskCore success body (best-effort). */
function extractTaskId(body: string): string {
  try {
    const parsed = JSON.parse(body) as { data?: { task_id?: string }; task_id?: string };
    return parsed.data?.task_id ?? parsed.task_id ?? '';
  } catch {
    return '';
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
