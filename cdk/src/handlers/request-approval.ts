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

import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { workerLeaseKey } from './shared/microvm-continuation-types';
import { errorResponse, successResponse } from './shared/response';
import { makeDocClient } from './shared/ua';
import constants from '../../../contracts/constants.json';

const ddb = makeDocClient();
const TASKS = process.env.TASK_TABLE_NAME!;
const APPROVALS = process.env.TASK_APPROVALS_TABLE_NAME!;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 8192;
const REQUEST_FIELDS = new Set([
  'task_id', 'request_id', 'tool_name', 'tool_input_preview', 'tool_input_sha256',
  'reason', 'severity', 'matching_rule_ids', 'status', 'created_at', 'timeout_s',
  'deadline_epoch', 'user_id', 'repo',
]);

interface RequestInput {
  readonly operation: 'create' | 'timeout';
  readonly task_id: string;
  readonly request_id: string;
  readonly worker_attempt_id?: string;
  readonly approval?: Record<string, unknown>;
  readonly reason?: string;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Never copy decision, notification, retention or arbitrary caller fields. */
function validateRequest(input: RequestInput, task: Record<string, any>): Record<string, unknown> {
  const row = input.approval;
  if (!row || Object.keys(row).some(key => !REQUEST_FIELDS.has(key))
    || row.task_id !== input.task_id || row.request_id !== input.request_id
    || row.user_id !== task.user_id || row.repo !== (task.repo ?? '')
    || row.status !== 'PENDING'
    || !validId(row.tool_name) || typeof row.tool_input_preview !== 'string' || row.tool_input_preview.length > MAX_TEXT_LENGTH
    || typeof row.tool_input_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.tool_input_sha256)
    || typeof row.reason !== 'string' || row.reason.length > MAX_TEXT_LENGTH
    || !['low', 'medium', 'high'].includes(row.severity as string)
    || !Array.isArray(row.matching_rule_ids) || row.matching_rule_ids.length > 500
    || !row.matching_rule_ids.every(validId)
    || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
    || typeof row.timeout_s !== 'number' || !Number.isInteger(row.timeout_s)
    || row.timeout_s < 0 || row.timeout_s > constants.approval_timeout_s.max
    || (row.timeout_s === 0 ? row.deadline_epoch !== undefined
      : row.deadline_epoch !== Math.floor(Date.parse(row.created_at) / 1000) + row.timeout_s)) {
    throw new Error('APPROVAL_REQUEST_INVALID');
  }
  return row;
}

/**
 * Worker-callable writer: creates pending requests or records a non-human timeout.
 * Human decisions remain exclusively in approve/deny handlers. Workers have no
 * direct approvals-table write permission, including whole-row replacement.
 */
export async function recordWorkerRequest(input: RequestInput): Promise<Record<string, unknown>> {
  if (!input || !validId(input.task_id) || !validId(input.request_id)
    || !['create', 'timeout'].includes(input.operation)) {
    return { ok: false, code: 'APPROVAL_REQUEST_INVALID' };
  }
  try {
    const task = (await ddb.send(new GetCommand({
      TableName: TASKS, Key: { task_id: input.task_id }, ConsistentRead: true,
    }))).Item;
    if (!task || typeof task.user_id !== 'string') return { ok: false, code: 'APPROVAL_TASK_MISSING' };
    const lease = task.compute_type === 'lambda-microvm' ? [{
      ConditionCheck: {
        TableName: TASKS,
        Key: workerLeaseKey(input.task_id),
        ConditionExpression: 'lease_state = :active AND lease_attempt_id = :attempt AND lease_user_id = :user',
        ExpressionAttributeValues: {
          ':active': 'ACTIVE', ':attempt': input.worker_attempt_id ?? '', ':user': task.user_id,
        },
      },
    }] : [];
    if (input.operation === 'create') {
      const row = validateRequest(input, task);
      await ddb.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: APPROVALS,
            Item: row,
            ConditionExpression: 'attribute_not_exists(request_id)',
          },
        }, {
          Update: {
            TableName: TASKS,
            Key: { task_id: input.task_id },
            UpdateExpression: 'SET #status = :awaiting, awaiting_approval_request_id = :request',
            ConditionExpression: '#status = :running AND user_id = :user',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':awaiting': 'AWAITING_APPROVAL',
              ':running': 'RUNNING',
              ':request': input.request_id,
              ':user': task.user_id,
            },
          },
        }, ...lease],
      }));
    } else {
      // A worker may fail closed after a deadline or polling failure; it cannot
      // turn either into human DENIED/APPROVED or replace an existing decision.
      if (input.approval !== undefined || (input.reason !== undefined
        && (typeof input.reason !== 'string' || input.reason.length > MAX_TEXT_LENGTH))) {
        return { ok: false, code: 'APPROVAL_REQUEST_INVALID' };
      }
      await ddb.send(new TransactWriteCommand({
        TransactItems: [{
          Update: {
            TableName: APPROVALS,
            Key: { task_id: input.task_id, request_id: input.request_id },
            UpdateExpression: 'SET #status = :timeout, decided_at = :now'
              + (input.reason !== undefined ? ', deny_reason = :reason' : ''),
            ConditionExpression: '#status = :pending AND user_id = :user',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':timeout': 'TIMED_OUT',
              ':pending': 'PENDING',
              ':user': task.user_id,
              ':now': new Date().toISOString(),
              ...(input.reason !== undefined ? { ':reason': input.reason } : {}),
            },
          },
        }, {
          ConditionCheck: {
            TableName: TASKS,
            Key: { task_id: input.task_id },
            ConditionExpression: '#status = :awaiting AND awaiting_approval_request_id = :request AND user_id = :user',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':awaiting': 'AWAITING_APPROVAL', ':request': input.request_id, ':user': task.user_id },
          },
        }, ...lease],
      }));
    }
    return { ok: true };
  } catch (error) {
    const failure = error as { name?: string; message?: string; CancellationReasons?: { Code?: string }[] };
    if (failure.message === 'APPROVAL_REQUEST_INVALID') return { ok: false, code: failure.message };
    const reasons = failure.CancellationReasons?.map(reason => ({ Code: reason.Code }));
    logger.warn('Worker approval request was not recorded', {
      task_id: input.task_id,
      request_id: input.request_id,
      operation: input.operation,
      error_type: failure.name,
      cancellation_reasons: reasons,
    });
    return { ok: false, code: failure.name ?? 'APPROVAL_WRITE_FAILED', cancellation_reasons: reasons };
  }
}

/** IAM authorizes the signed task path before invoking this Lambda. */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext?.requestId ?? 'unknown';
  if (!event.requestContext?.identity?.userArn || !validId(event.pathParameters?.task_id)) {
    return errorResponse(403, 'APPROVAL_CALLER_UNAUTHENTICATED', 'IAM authentication required', requestId);
  }
  let input: RequestInput;
  try {
    input = JSON.parse(event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '');
  } catch {
    return errorResponse(400, 'APPROVAL_REQUEST_INVALID', 'Invalid JSON request', requestId);
  }
  if (!input || input.task_id !== event.pathParameters!.task_id) {
    return errorResponse(400, 'APPROVAL_TASK_MISMATCH', 'Task must match the signed path', requestId);
  }
  const result = await recordWorkerRequest(input);
  if (result.ok) return successResponse(200, result, requestId);
  const code = String(result.code);
  const statusCode = code === 'TransactionCanceledException' ? 409
    : code === 'APPROVAL_TASK_MISSING' ? 404 : code === 'APPROVAL_REQUEST_INVALID' ? 400 : 503;
  return errorResponse(statusCode, code, 'Approval write was not acknowledged', requestId, {
    cancellation_reasons: result.cancellation_reasons ?? [],
  });
}
