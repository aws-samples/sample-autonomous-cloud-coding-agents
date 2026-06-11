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
import { VALID_APPROVAL_SCOPE_PREFIXES, parseApprovalScope } from './shared/approval-scope';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { ApprovalRequest, ApprovalResponse, ApprovalScope } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Validates the required table env vars at module load so a broken
// deployment fails loudly at cold start, matching the old behavior.
const DECISION_CONFIG = approvalDecisionConfigFromEnv();

/**
 * POST /v1/tasks/{task_id}/approve — User-in-the-loop approval decision.
 *
 * Flow (design §7.1):
 *   1. Auth — Cognito JWT `sub` → `caller_user_id` (verbatim).
 *   2. Parse + validate body (`request_id`, optional `scope`).
 *   3–6. Rate limit, atomic transition, cancel classification, and the
 *      audit event live in `shared/approval-decision.ts` —
 *      `processApprovalDecision` — shared with the Slack-button
 *      approvals path (issue #112) so the trust-critical core cannot
 *      drift between surfaces.
 *
 * Returns 202 with `{task_id, request_id, status: APPROVED, scope,
 * decided_at}` on success.
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

    // 3–5. Shared decision core (rate limit + atomic transition + audit).
    const outcome = await processApprovalDecision(ddb, DECISION_CONFIG, {
      taskId,
      requestId: request_id,
      callerUserId,
      decision: 'approve',
      scope,
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
        'Approval transaction cancelled for unknown reason.',
        requestId,
      );
    }
    const nowIso = outcome.decidedAt;

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
