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
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { TRACE_OBJECT_KEY_PREFIX } from '../constructs/trace-artifacts-bucket';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { TaskRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const TRACE_BUCKET_NAME = process.env.TRACE_ARTIFACTS_BUCKET_NAME!;

/**
 * Presigned URL TTL. 15 minutes is long enough for a multi-MB trajectory
 * download on a slow link, short enough to bound the window for a leaked
 * URL to be useful. Also short enough that the caller's Cognito session
 * is still valid — if a user wants a fresh URL, they re-issue via
 * ``bgagent trace download``.
 */
export const TRACE_URL_TTL_SECONDS = 900;

/**
 * ``GET /v1/tasks/{task_id}/trace`` — return a presigned S3 URL for the
 * ``--trace`` trajectory dump.
 *
 * Response shape (200):
 * ```
 * { data: { url: string, expires_at: string } }
 * ```
 *
 * Errors:
 *  - 401 UNAUTHORIZED — Cognito auth missing
 *  - 400 VALIDATION_ERROR — missing ``task_id`` path parameter
 *  - 403 FORBIDDEN — caller does not own this task
 *  - 404 TASK_NOT_FOUND — task_id not in the table
 *  - 404 TRACE_NOT_AVAILABLE — task exists but was not submitted with ``--trace``,
 *    or the upload has not yet completed
 *  - 500 INTERNAL_ERROR — DDB or S3 presign failure
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

    const s3Uri = record.trace_s3_uri;
    if (!s3Uri) {
      // Covers two cases with one status code — the CLI can't disambiguate
      // "never enabled" from "not yet uploaded" without racing the agent,
      // and the user-facing remedy is the same: re-submit with --trace (or
      // wait for the task to reach terminal).
      return errorResponse(
        404,
        ErrorCode.TRACE_NOT_AVAILABLE,
        'Task did not run with --trace, or the trace has not been uploaded yet.',
        requestId,
      );
    }

    const parsed = parseS3Uri(s3Uri);
    if (!parsed) {
      logger.error('TaskRecord.trace_s3_uri is not a valid s3:// URI', {
        task_id: taskId,
        trace_s3_uri: s3Uri,
        request_id: requestId,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Trace URI is malformed.', requestId);
    }

    // Defense in depth: refuse to presign URLs for objects in a bucket
    // we don't own. Prevents a DDB-injection attack that spoofs a
    // ``trace_s3_uri`` pointing at an attacker-controlled bucket from
    // turning this handler into an open URL signer.
    if (parsed.bucket !== TRACE_BUCKET_NAME) {
      logger.error('TaskRecord.trace_s3_uri bucket does not match TRACE_ARTIFACTS_BUCKET_NAME', {
        task_id: taskId,
        record_bucket: parsed.bucket,
        expected_bucket: TRACE_BUCKET_NAME,
        request_id: requestId,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Trace URI references an unexpected bucket.', requestId);
    }

    // Second defense-in-depth guard: the object key must live under the
    // caller's own user prefix. The agent writes with
    // ``traces/<user_id>/<task_id>.jsonl.gz`` by construction; an
    // ownership-check mismatch here signals either a stale record or a
    // cross-user write that escaped the runtime's per-prefix policy.
    //
    // Note: the comparator is the CALLER's ``userId`` (from Cognito),
    // NOT ``record.user_id``. That is the stronger invariant: it defends
    // against a compromised agent pointing one user's record at another
    // user's artifact. ``record.user_id !== userId`` already short-
    // circuited cross-user RECORD access above; this guard additionally
    // prevents cross-user ARTIFACT access when the record is legitimately
    // owned by the caller but ``trace_s3_uri`` was tampered with to
    // point elsewhere. Do NOT "simplify" by using ``record.user_id``.
    const expectedKeyPrefix = `${TRACE_OBJECT_KEY_PREFIX}${userId}/`;
    if (!parsed.key.startsWith(expectedKeyPrefix)) {
      logger.error('TaskRecord.trace_s3_uri key is not under the caller\'s user prefix', {
        task_id: taskId,
        user_id: userId,
        record_key: parsed.key,
        expected_prefix: expectedKeyPrefix,
        request_id: requestId,
      });
      return errorResponse(403, ErrorCode.FORBIDDEN, 'Trace artifact is not owned by the caller.', requestId);
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
      { expiresIn: TRACE_URL_TTL_SECONDS },
    );

    const expiresAt = new Date(Date.now() + TRACE_URL_TTL_SECONDS * 1000).toISOString();

    return successResponse(200, { url, expires_at: expiresAt }, requestId);
  } catch (err) {
    logger.error('Failed to issue trace download URL', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/**
 * Parse an ``s3://bucket/key`` URI into its components. Returns ``null``
 * if the string is malformed.
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  if (!uri.startsWith('s3://')) return null;
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!bucket || !key) return null;
  return { bucket, key };
}
