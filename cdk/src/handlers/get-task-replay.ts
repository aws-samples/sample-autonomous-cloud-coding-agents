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
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { coerceNumericOrNull } from './shared/numeric';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { EventRecord, ReplayBundle, TaskRecord, VerificationReport } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;

/**
 * Hard cap on events embedded in one bundle. A replay is a single-shot
 * aggregate, not a paginated feed, so we bound the response rather than expose
 * a cursor: an 8-hour task emits on the order of hundreds-to-low-thousands of
 * events, and DynamoDB Query pages at 1 MB. We page until this cap, then stop
 * and flag truncation so the bundle never grows unbounded (a runaway task can't
 * produce a multi-MB Lambda response). Callers needing the full tail use the
 * paginated ``GET /tasks/{id}/events`` endpoint.
 */
export const MAX_REPLAY_EVENTS = 5000;

/**
 * ``GET /v1/tasks/{task_id}/replay`` — operator replay bundle (#515).
 *
 * Aggregates EXISTING telemetry for a task (TaskRecord fields + chronological
 * TaskEvents) into one JSON; introduces no new persistence. Auth is identical
 * to ``GET /tasks/{task_id}``: Cognito-authenticated and owner-scoped.
 *
 * Response shape (200): ``{ data: ReplayBundle }``.
 *
 * Errors:
 *  - 401 UNAUTHORIZED — Cognito auth missing
 *  - 400 VALIDATION_ERROR — missing ``task_id`` path parameter
 *  - 403 FORBIDDEN — caller does not own this task
 *  - 404 TASK_NOT_FOUND — task_id not in the table
 *  - 500 INTERNAL_ERROR — DDB failure
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!result.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }

    const record = result.Item as TaskRecord;
    if (record.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }

    const events = await collectEvents(taskId, requestId);
    const bundle = assembleBundle(record, events);
    return successResponse(200, bundle, requestId);
  } catch (err) {
    logger.error('Failed to build task replay bundle', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/**
 * Query all TaskEvents for a task in chronological order (ULID ``event_id`` sort
 * key ascending), paging across DynamoDB 1 MB boundaries up to
 * {@link MAX_REPLAY_EVENTS}. Logs a WARN if the cap truncates the tail so a
 * silently-clipped replay is never mistaken for a complete one.
 */
async function collectEvents(taskId: string, requestId: string): Promise<EventRecord[]> {
  const events: EventRecord[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const remaining = MAX_REPLAY_EVENTS - events.length;
    const page = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE_NAME,
      KeyConditionExpression: 'task_id = :tid',
      ExpressionAttributeValues: { ':tid': taskId },
      ScanIndexForward: true, // chronological (ULID event_id is time-ordered)
      Limit: remaining,
      ExclusiveStartKey: startKey,
    }));
    events.push(...((page.Items ?? []) as EventRecord[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey && events.length < MAX_REPLAY_EVENTS);

  if (startKey) {
    logger.warn('Replay event list truncated at MAX_REPLAY_EVENTS', {
      task_id: taskId,
      max_events: MAX_REPLAY_EVENTS,
      request_id: requestId,
    });
  }
  return events;
}

/**
 * Assemble the {@link ReplayBundle} from a task record + its events. Numeric
 * coercion mirrors ``toTaskDetail`` (cost_usd is persisted as a string by the
 * agent). ``collected_at`` is stamped server-side. Absent telemetry is
 * null/empty, never omitted, so the schema is stable for consumers.
 */
export function assembleBundle(record: TaskRecord, events: EventRecord[]): ReplayBundle {
  // Reuse the shared coercion (cost_usd is persisted as a string by the agent),
  // matching toTaskDetail — it logs when a persisted numeric is unparseable, so
  // a corrupt cost is observable rather than silently nulled.
  const costNum = coerceNumericOrNull(record.cost_usd, { task_id: record.task_id, field: 'cost_usd' }, logger);

  // Verification is non-null only when at least one gate result was persisted.
  const hasVerification = record.build_passed != null || record.lint_passed != null;
  const verification: VerificationReport | null = hasVerification
    ? { build_passed: record.build_passed ?? null, lint_passed: record.lint_passed ?? null }
    : null;

  return {
    task_id: record.task_id,
    workflow_ref: record.workflow_ref ?? null,
    resolved_workflow: record.resolved_workflow ?? null,
    prompt_version: record.prompt_version ?? null,
    events,
    verification,
    trace_uri: record.trace_s3_uri ?? null,
    otel_trace_id: record.otel_trace_id ?? null,
    session_id: record.session_id ?? null,
    cost_usd: costNum,
    collected_at: new Date().toISOString(),
  };
}
