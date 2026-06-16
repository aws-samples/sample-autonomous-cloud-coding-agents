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
 * Async event-sourced approval rows (issue #230 Phase 2).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { EventRule } from './event-governance-types';
import { logger } from './logger';
import type { TaskRecord } from './types';
import { TaskStatus } from '../../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_TABLE = process.env.TASK_TABLE_NAME;
const APPROVALS_TABLE = process.env.TASK_APPROVALS_TABLE_NAME;

const DEFAULT_APPROVAL_TIMEOUT_S = 3600;
const PREVIEW_MAX_LEN = 500;

function previewText(metadata: Readonly<Record<string, unknown>>, checkpoint: string): string {
  const prUrl = metadata.pr_url;
  if (typeof prUrl === 'string' && prUrl.length > 0) {
    return `PR already exists: ${prUrl}`.slice(0, PREVIEW_MAX_LEN);
  }
  return `Event gate at ${checkpoint}`.slice(0, PREVIEW_MAX_LEN);
}

/**
 * Create a PENDING approval for an async event rule. When the task is
 * RUNNING, atomically transitions to AWAITING_APPROVAL. Post-hoc gates
 * (e.g. after ``pr_created``) only persist the approval row.
 */
export async function createAsyncEventApproval(options: {
  readonly task: TaskRecord;
  readonly rule: EventRule;
  readonly eventType: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
}): Promise<string | undefined> {
  if (!APPROVALS_TABLE || !TASK_TABLE) return undefined;

  const requestId = options.requestId ?? ulid();
  const checkpoint = typeof options.metadata.checkpoint === 'string'
    ? options.metadata.checkpoint
    : options.rule.on;
  const reason = options.rule.reason
    ?? (options.rule.on === 'pr_created'
      ? 'Approval required after PR was opened (PR already exists).'
      : `Event rule ${options.rule.id} requires approval`);
  const timeoutS = options.rule.timeout_s ?? DEFAULT_APPROVAL_TIMEOUT_S;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + timeoutS * 1000).toISOString();

  const approvalItem: Record<string, unknown> = {
    task_id: options.task.task_id,
    request_id: requestId,
    user_id: options.task.user_id,
    status: 'PENDING',
    tool_name: `event:${checkpoint}`,
    tool_input_preview: previewText(options.metadata, checkpoint),
    severity: options.rule.severity ?? 'medium',
    reason,
    created_at: now,
    timeout_s: timeoutS,
    expires_at: expiresAt,
    matching_rule_ids: [options.rule.id],
    source: 'event',
    event_type: options.eventType,
    checkpoint,
    rule_id: options.rule.id,
    ...(options.rule.rule_pack_id && { rule_pack_id: options.rule.rule_pack_id }),
  };

  try {
    if (options.task.status === TaskStatus.RUNNING) {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: APPROVALS_TABLE,
              Item: approvalItem,
              ConditionExpression: 'attribute_not_exists(request_id)',
            },
          },
          {
            Update: {
              TableName: TASK_TABLE,
              Key: { task_id: options.task.task_id },
              UpdateExpression: 'SET #status = :awaiting, awaiting_approval_request_id = :rid, updated_at = :now',
              ConditionExpression: '#status = :running',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':awaiting': TaskStatus.AWAITING_APPROVAL,
                ':running': TaskStatus.RUNNING,
                ':rid': requestId,
                ':now': now,
              },
            },
          },
        ],
      }));
    } else {
      await ddb.send(new PutCommand({
        TableName: APPROVALS_TABLE,
        Item: approvalItem,
        ConditionExpression: 'attribute_not_exists(request_id)',
      }));
    }
    return requestId;
  } catch (err) {
    logger.warn('[event-governance] async require_approval skipped', {
      task_id: options.task.task_id,
      rule_id: options.rule.id,
      status: options.task.status,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
