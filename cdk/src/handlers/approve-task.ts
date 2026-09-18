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

import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ulid } from 'ulid';
import { VALID_APPROVAL_SCOPE_PREFIXES, parseApprovalScope } from './shared/approval-scope';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { APPROVAL_AUDIT_TIMEOUT_MS, approvalPostCommitOptions, wakeMicrovmAfterApproval } from './shared/microvm-approval-wake';
import { microvmErrorIdentity } from './shared/microvm-control';
import { formatMinuteBucket, RATE_LIMIT_ROW_TTL_SECONDS } from './shared/rate-limit';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { ApprovalRequest, ApprovalResponse, ApprovalScope } from './shared/types';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME;
const TASK_APPROVALS_TABLE_NAME = process.env.TASK_APPROVALS_TABLE_NAME;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME;
if (!TASK_TABLE_NAME || !TASK_APPROVALS_TABLE_NAME || !EVENTS_TABLE_NAME) {
  throw new Error(
    'approve-task handler requires TASK_TABLE_NAME, TASK_APPROVALS_TABLE_NAME, and TASK_EVENTS_TABLE_NAME env vars',
  );
}
const APPROVE_RATE_LIMIT_PER_MINUTE = Number(process.env.APPROVE_RATE_LIMIT_PER_MINUTE ?? '30');
const AUDIT_EVENT_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

/**
 * POST /v1/tasks/{task_id}/approve — User-in-the-loop approval decision.
 *
 * Flow (design §7.1):
 *   1. Auth — Cognito JWT `sub` → `caller_user_id` (verbatim).
 *   2. Parse + validate body (`request_id`, optional `scope`).
 *   3. Per-user per-minute rate limit (30/min).
 *   4. Atomic cross-table `TransactWriteItems`:
 *        - Update approval row: `status PENDING → APPROVED`, guarded by
 *          `user_id = :caller` (ownership) AND `status = :pending`.
 *        - No-op update on TaskTable guarded by
 *          `status = AWAITING_APPROVAL AND awaiting_approval_request_id = :rid`.
 *   5. On `TransactionCanceledException`, inspect per-item reasons to
 *      distinguish 404 vs 409 variants (prevents enumeration via the
 *      404 collapse on ownership mismatch — finding #6).
 *   6. Write `approval_decision_recorded` audit event to
 *      `TaskEventsTable` (IMPL-6).
 *
 * Returns 202 with `{task_id, request_id, status: APPROVED, scope,
 * decided_at}` on success.
 * @param event - API Gateway proxy event.
 * @returns API Gateway proxy result.
 */
export async function handler(
  event: APIGatewayProxyEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>,
): Promise<APIGatewayProxyResult> {
  const invocationStartedMs = Date.now();
  const requestId = ulid();

  try {
    // 1. Auth
    const callerUserId = extractUserId(event);
    if (!callerUserId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Path + body
    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    let parsed: ApprovalRequest | null = null;
    try {
      parsed = event.body ? JSON.parse(event.body) as ApprovalRequest : null;
    } catch {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }
    if (!parsed || typeof parsed.request_id !== 'string' || parsed.decision !== 'approve') {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Missing or invalid required fields: request_id (string), decision ("approve").',
        requestId,
      );
    }
    const { request_id, scope: rawScope } = parsed;
    // `this_call` default (§7.1 example) keeps approve bodies minimal
    // for callers who want one-shot approval.
    const scope: ApprovalScope = rawScope ?? 'this_call';
    const scopeCheck = parseApprovalScope(scope);
    if (!scopeCheck.ok) {
      // Security-relevant: malformed scopes can indicate probing,
      // CLI version mismatches, or downstream contract drift. Logged
      // with the structured fields a CloudWatch Insights query needs
      // to triage (task_id + user_id + raw_scope + parser-error).
      logger.warn('Approval scope validation failed', {
        task_id: taskId,
        user_id: callerUserId,
        raw_scope: scope,
        error: scopeCheck.message,
        request_id: requestId,
      });
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Invalid scope: ${scopeCheck.message}. Valid prefixes: ${VALID_APPROVAL_SCOPE_PREFIXES.join(', ')}.`,
        requestId,
      );
    }

    const nowIso = new Date().toISOString();
    const nowEpoch = Math.floor(Date.now() / 1000);

    // 3. Per-user per-minute rate limit, shared with deny. The approvals-table
    // partition key is RATE#<user_id>#APPROVE; the sort key is MINUTE#<bucket>.
    // TTL makes old counters eligible for eventual cleanup, not deletion at
    // an exact time. Each minute uses its own counter regardless of that delay.
    const minuteBucket = formatMinuteBucket(new Date());
    try {
      await ddb.send(new UpdateCommand({
        TableName: TASK_APPROVALS_TABLE_NAME,
        Key: {
          task_id: `RATE#${callerUserId}#APPROVE`,
          request_id: `MINUTE#${minuteBucket}`,
        },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':max': APPROVE_RATE_LIMIT_PER_MINUTE,
          ':ttl': nowEpoch + RATE_LIMIT_ROW_TTL_SECONDS,
        },
      }));
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'ConditionalCheckFailedException') {
        return errorResponse(
          429,
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: at most ${APPROVE_RATE_LIMIT_PER_MINUTE} approve/deny decisions per minute.`,
          requestId,
        );
      }
      throw err;
    }

    // 4. Cross-table atomic transition (§7.1 pseudocode).
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TASK_APPROVALS_TABLE_NAME,
              Key: { task_id: taskId, request_id },
              UpdateExpression:
                'SET #status = :approved, decided_at = :now, #scope = :scope',
              ConditionExpression:
                'attribute_exists(request_id) AND #status = :pending AND user_id = :caller '
                  + 'AND (attribute_not_exists(deadline_epoch) OR deadline_epoch > :epoch)',
              ExpressionAttributeNames: {
                '#status': 'status',
                '#scope': 'scope',
              },
              ExpressionAttributeValues: {
                ':approved': 'APPROVED',
                ':pending': 'PENDING',
                ':now': nowIso,
                ':scope': scope,
                ':caller': callerUserId,
                ':epoch': nowEpoch,
              },
            },
          },
          {
            Update: {
              TableName: TASK_TABLE_NAME,
              Key: { task_id: taskId },
              // No-op update on TaskTable; the purpose is the condition guard.
              UpdateExpression: 'SET last_decision_at = :now',
              ConditionExpression:
                '#status = :awaiting AND awaiting_approval_request_id = :rid',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':awaiting': 'AWAITING_APPROVAL',
                ':rid': request_id,
                ':now': nowIso,
              },
            },
          },
        ],
      }));
    } catch (err: unknown) {
      if (err instanceof TransactionCanceledException) {
        return classifyCancel(err, requestId);
      }
      throw err;
    }

    const postCommit = approvalPostCommitOptions(invocationStartedMs, context);
    // 5. Audit event (IMPL-6). Failure to write the audit is logged
    // but does not fail the request — the decision is already
    // committed on TaskApprovalsTable. A sleeping worker is also recovered by
    // the durable supervisor if this request cannot finish its optional wake.
    try {
      const abortSignal = AbortSignal.any([postCommit.abortSignal!, AbortSignal.timeout(APPROVAL_AUDIT_TIMEOUT_MS)]);
      abortSignal.throwIfAborted();
      await ddb.send(new PutCommand({
        TableName: EVENTS_TABLE_NAME,
        Item: {
          task_id: taskId,
          event_id: ulid(),
          event_type: 'approval_decision_recorded',
          timestamp: nowIso,
          ttl: nowEpoch + AUDIT_EVENT_RETENTION_DAYS * 86400,
          metadata: {
            request_id,
            status: 'APPROVED',
            scope,
            decided_at: nowIso,
            caller_user_id: callerUserId,
          },
        },
      }), { abortSignal });
    } catch (auditErr) {
      logger.warn('approval_decision_recorded audit write failed (decision already committed)', {
        task_id: taskId,
        request_id,
        ...microvmErrorIdentity(auditErr),
      });
    }

    // Wake is best-effort after commit. Even an unexpected helper failure must
    // not turn an accepted human decision into an HTTP failure.
    try {
      await wakeMicrovmAfterApproval({
        taskId,
        userId: callerUserId,
        requestId: request_id,
        decision: 'APPROVED',
        options: postCommit,
        emitEvent: async (eventType, metadata, options) => {
          options.abortSignal?.throwIfAborted();
          await ddb.send(new PutCommand({
            TableName: EVENTS_TABLE_NAME,
            Item: {
              task_id: taskId,
              user_id: callerUserId,
              event_id: ulid(),
              event_type: eventType,
              timestamp: new Date().toISOString(),
              ttl: nowEpoch + AUDIT_EVENT_RETENTION_DAYS * 86400,
              metadata,
            },
          }), options);
        },
      });
    } catch (wakeError) {
      logger.warn('MicroVM wake helper failed after decision commit', {
        task_id: taskId, request_id, ...microvmErrorIdentity(wakeError),
      });
    }

    logger.info('Approval recorded', {
      task_id: taskId,
      request_id,
      user_id: callerUserId,
      scope,
      request_id_header: requestId,
    });

    const response: ApprovalResponse = {
      task_id: taskId,
      request_id,
      status: 'APPROVED',
      scope,
      decided_at: nowIso,
    };
    return successResponse(202, response, requestId);
  } catch (err) {
    logger.error('Failed to record approval', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/**
 * Map a `TransactionCanceledException` to the correct 4xx response.
 *
 * Per §7.1, the cancellation reasons are per-item (index 0 is the
 * approvals-row Update, index 1 is the task-row Update). We read them
 * to classify the failed item:
 * - approvals item cancelled → 404 for missing, wrong-owner or already-decided rows
 * - task-row item cancelled only → task not in AWAITING_APPROVAL → 409
 *
 * DDB does not return which sub-clause of the `ConditionExpression`
 * failed. This transaction does not request the old item on condition failure,
 * so an approvals-row failure cannot distinguish those three cases. It takes
 * precedence even when the task-row condition also fails. Returning 404 for all
 * three avoids revealing another user's approval. In particular, a late decision
 * after an approval timeout returns REQUEST_NOT_FOUND, not ALREADY_DECIDED.
 */
function classifyCancel(
  err: TransactionCanceledException,
  requestId: string,
): APIGatewayProxyResult {
  const reasons = err.CancellationReasons ?? [];
  const approvalsReason = reasons[0]?.Code;
  const taskReason = reasons[1]?.Code;

  if (approvalsReason === 'ConditionalCheckFailed') {
    // Collapse all approvals-row failures into REQUEST_NOT_FOUND per
    // §7.1 finding #6 (no existence oracle). The less-specific code
    // avoids leaking whether the row exists, belongs to a different
    // user, or has already been decided.
    return errorResponse(
      404,
      ErrorCode.REQUEST_NOT_FOUND,
      'Approval request not found or not owned by caller.',
      requestId,
    );
  }
  if (taskReason === 'ConditionalCheckFailed') {
    return errorResponse(
      409,
      ErrorCode.TASK_NOT_AWAITING_APPROVAL,
      'Task is not currently awaiting approval for this request.',
      requestId,
    );
  }
  // Defensive fallback — propagate 503 since the cause is unexplained.
  return errorResponse(
    503,
    ErrorCode.SERVICE_UNAVAILABLE,
    'Approval transaction cancelled for unknown reason.',
    requestId,
  );
}
