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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { createTaskCore } from './shared/create-task-core';
import { buildChannelMetadata, extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse } from './shared/response';
import type { CreateTaskRequest } from './shared/types';
import { parseBody } from './shared/validation';

/**
 * POST /v1/tasks — Create a new task (Cognito-authenticated).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract authenticated user
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Parse request body
    const body = parseBody<CreateTaskRequest>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    // 3. Extract idempotency key
    const idempotencyKey = event.headers['Idempotency-Key'] ?? event.headers['idempotency-key'];

    // 4. Delegate to shared core
    // Cognito-authed API path allows both execution modes: 'orchestrator'
    // (default, fire-and-forget via orchestrator Lambda) and 'interactive'
    // (rev 5 Branch A Path 1 — skip orchestrator; CLI will open SSE to
    // Runtime-JWT and run the pipeline same-process).
    return await createTaskCore(body, {
      userId,
      channelSource: 'api',
      channelMetadata: buildChannelMetadata(event),
      idempotencyKey: idempotencyKey ?? undefined,
    }, requestId, ['orchestrator', 'interactive']);
  } catch (err) {
    logger.error('Failed to create task', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
