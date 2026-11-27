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
import constants from '../../../contracts/constants.json';
import { TaskStatus } from '../constructs/task-status';
import { logger } from './shared/logger';
import { errorResponse, successResponse } from './shared/response';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASKS = process.env.TASK_TABLE_NAME!;
const APPROVALS = process.env.TASK_APPROVALS_TABLE_NAME!;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 8192;
/** Matches the agent's CLEANUP_MARGIN_120S past an approval deadline. */
const APPROVAL_CLEANUP_MARGIN_S = 120;
/**
 * How far the worker's created_at may be from this Lambda's clock. SigV4 already
 * refuses a request signed more than 5 minutes off, and a create with its two
 * repeats takes under 80 s, so the hook's own timestamp is always inside it.
 */
const MAX_CLOCK_SKEW_S = 300;
const REQUEST_FIELDS = new Set([
  'task_id', 'request_id', 'tool_name', 'tool_input_preview', 'tool_input_sha256',
  'reason', 'severity', 'matching_rule_ids', 'status', 'created_at', 'timeout_s',
  'deadline_epoch', 'user_id', 'repo',
]);

interface RequestInput {
  readonly operation: 'create' | 'timeout';
  readonly task_id: string;
  readonly request_id: string;
  readonly approval?: Record<string, unknown>;
  readonly reason?: string;
}

function validShortText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validId(value: unknown): value is string {
  return validShortText(value) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/**
 * Epoch seconds of a created_at in the hook's `YYYY-MM-DDTHH:MM:SSZ` form, read
 * near this Lambda's clock, or NaN. The deadline and the retention follow from it.
 */
function createdEpoch(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return NaN;
  const created = Date.parse(value) / 1000;
  // Date.parse rolls 2026-02-30 over to 2 March: only a date that reads back the same is one.
  if (!Number.isFinite(created) || new Date(created * 1000).toISOString() !== value.replace('Z', '.000Z')) return NaN;
  return Math.abs(created - Date.now() / 1000) <= MAX_CLOCK_SKEW_S ? created : NaN;
}

/** Never copy decision, notification, retention or arbitrary caller fields. */
function validateRequest(input: RequestInput, task: Record<string, any>): Record<string, unknown> {
  const row = input.approval;
  if (!row || Object.keys(row).some(key => !REQUEST_FIELDS.has(key))
    || row.task_id !== input.task_id || row.request_id !== input.request_id
    || row.user_id !== task.user_id || row.repo !== (task.repo ?? '')
    || row.status !== 'PENDING'
    || !validShortText(row.tool_name) || typeof row.tool_input_preview !== 'string' || row.tool_input_preview.length > MAX_TEXT_LENGTH
    || typeof row.tool_input_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.tool_input_sha256)
    || typeof row.reason !== 'string' || row.reason.length > MAX_TEXT_LENGTH
    || !['low', 'medium', 'high'].includes(row.severity as string)
    || !Array.isArray(row.matching_rule_ids) || row.matching_rule_ids.length > 500
    || !row.matching_rule_ids.every(validShortText)
    || typeof row.timeout_s !== 'number' || !Number.isInteger(row.timeout_s)
    || row.timeout_s < constants.approval_timeout_s.min || row.timeout_s > constants.approval_timeout_s.max
    || row.deadline_epoch !== createdEpoch(row.created_at) + row.timeout_s) {
    throw new Error('APPROVAL_REQUEST_INVALID');
  }
  // Retention is set here, never by the worker: the gate deadline plus the
  // agent's cleanup margin, as the agent computed it before this writer existed.
  return { ...row, ttl: (row.deadline_epoch as number) + APPROVAL_CLEANUP_MARGIN_S };
}

/**
 * A worker that lost the response to a committed create repeats it with the same
 * request id. Report the first create's success to that repeat, and only to it:
 * the row exists for this task, user and tool input, and the task still waits on it.
 */
async function createCommitted(input: RequestInput, userId: string, error: unknown): Promise<boolean> {
  if ((error as { name?: string }).name !== 'TransactionCanceledException') return false;
  const request = await ddb.send(new GetCommand({
    TableName: APPROVALS, Key: { task_id: input.task_id, request_id: input.request_id }, ConsistentRead: true,
  }));
  const task = await ddb.send(new GetCommand({ TableName: TASKS, Key: { task_id: input.task_id }, ConsistentRead: true }));
  return request.Item?.user_id === userId
    && request.Item.tool_input_sha256 === input.approval?.tool_input_sha256
    && task.Item?.user_id === userId
    && task.Item.status === TaskStatus.AWAITING_APPROVAL
    && task.Item.awaiting_approval_request_id === input.request_id;
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
            // status_created_at moves with status, as on every other transition: the
            // stranded-approval sweep and `ops stuck-tasks` measure from it.
            UpdateExpression: 'SET #status = :awaiting, awaiting_approval_request_id = :request, status_created_at = :sca',
            ConditionExpression: '#status = :running AND user_id = :user',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':awaiting': TaskStatus.AWAITING_APPROVAL,
              ':running': TaskStatus.RUNNING,
              ':request': input.request_id,
              ':user': task.user_id,
              ':sca': `${TaskStatus.AWAITING_APPROVAL}#${new Date().toISOString()}`,
            },
          },
        }],
      })).catch(async (error: unknown) => {
        // A repeat of a create whose response the worker lost.
        if (!await createCommitted(input, task.user_id, error)) throw error;
      });
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
            ExpressionAttributeValues: { ':awaiting': TaskStatus.AWAITING_APPROVAL, ':request': input.request_id, ':user': task.user_id },
          },
        }],
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
