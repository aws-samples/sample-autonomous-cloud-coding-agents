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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { approvalDecisionConfigFromEnv, processApprovalDecision } from './shared/approval-decision';
import { scanDenyReason } from './shared/deny-reason-scanner';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { DENY_REASON_MAX_LENGTH, type DenyRequest, type DenyResponse } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Validates the required table env vars at module load so a broken
// deployment fails loudly at cold start, matching the old behavior.
const DECISION_CONFIG = approvalDecisionConfigFromEnv();

/**
 * POST /v1/tasks/{task_id}/deny — User denies a pending approval.
 *
 * Same atomic cross-table pattern as `approve-task.ts`. The key
 * differences:
 *
 *   - `reason` (optional) runs through `scanDenyReason` BEFORE
 *     persistence so secrets (AWS keys, GitHub PATs, private keys)
 *     are never stored or read by the agent (design §7.2, §12.6).
 *   - Sanitized reason is truncated to `DENY_REASON_MAX_LENGTH`
 *     characters.
 *   - Response is 202 with `{task_id, request_id, status: DENIED,
 *     decided_at}`.
 *
 * The agent reads the sanitized reason on its next
 * `get_approval_row` poll and injects it via
 * `_denial_between_turns_hook` (see agent/src/hooks.py::
 * _denial_between_turns_hook).
 * @param event - API Gateway proxy event.
 * @returns API Gateway proxy result.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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

    let parsed: DenyRequest | null = null;
    try {
      parsed = event.body ? JSON.parse(event.body) as DenyRequest : null;
    } catch {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }
    if (!parsed || typeof parsed.request_id !== 'string' || parsed.decision !== 'deny') {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Missing or invalid required fields: request_id (string), decision ("deny").',
        requestId,
      );
    }
    const { request_id, reason: rawReason } = parsed;

    // Sanitize + truncate the reason BEFORE any further processing.
    // The agent and audit event will both see the scanned form; the
    // raw text is never persisted anywhere.
    const sanitizedReason = rawReason
      ? scanDenyReason(rawReason).slice(0, DENY_REASON_MAX_LENGTH)
      : '';

    // 3–5. Rate limit + atomic transition (§7.2) + audit live in the
    // shared decision core (`shared/approval-decision.ts`), reused by
    // the Slack-button approvals path (issue #112).
    const outcome = await processApprovalDecision(ddb, DECISION_CONFIG, {
      taskId,
      requestId: request_id,
      callerUserId,
      decision: 'deny',
      sanitizedReason,
    });
    if (outcome.kind === 'rate_limited') {
      return errorResponse(
        429,
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Rate limit exceeded: at most ${outcome.limit} approve/deny decisions per minute.`,
        requestId,
      );
    }
    if (outcome.kind === 'not_found') {
      return errorResponse(
        404,
        ErrorCode.REQUEST_NOT_FOUND,
        'Approval request not found or not owned by caller.',
        requestId,
      );
    }
    if (outcome.kind === 'not_awaiting') {
      return errorResponse(
        409,
        ErrorCode.TASK_NOT_AWAITING_APPROVAL,
        'Task is not currently awaiting approval for this request.',
        requestId,
      );
    }
    if (outcome.kind === 'transaction_unknown') {
      return errorResponse(
        503,
        ErrorCode.SERVICE_UNAVAILABLE,
        'Denial transaction cancelled for unknown reason.',
        requestId,
      );
    }
    const nowIso = outcome.decidedAt;

    logger.info('Denial recorded', {
      task_id: taskId,
      request_id,
      user_id: callerUserId,
      reason_length: sanitizedReason.length,
      request_id_header: requestId,
    });

    const response: DenyResponse = {
      task_id: taskId,
      request_id,
      status: 'DENIED',
      decided_at: nowIso,
    };
    return successResponse(202, response, requestId);
  } catch (err) {
    logger.error('Failed to record denial', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
