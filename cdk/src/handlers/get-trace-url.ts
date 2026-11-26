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

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { TRACE_OBJECT_KEY_PREFIX } from './shared/storage-names';
import type { TaskRecord } from './shared/types';
import { makeClient, makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const s3 = makeClient(S3Client);
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const TRACE_BUCKET_NAME = process.env.TRACE_ARTIFACTS_BUCKET_NAME!;

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
 *    the upload has not yet completed, or the artifact no longer exists
 *    (the bucket's lifecycle rule expires traces)
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

    if (parsed.bucket !== TRACE_BUCKET_NAME) {
      logger.error('TaskRecord.trace_s3_uri bucket does not match TRACE_ARTIFACTS_BUCKET_NAME', {
        task_id: taskId,
        record_bucket: parsed.bucket,
        expected_bucket: TRACE_BUCKET_NAME,
        request_id: requestId,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Trace URI references an unexpected bucket.', requestId);
    }

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

    try {
      await s3.send(new HeadObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }));
    } catch (err) {
      // S3 SDK v3 returns either ``NotFound`` or ``NoSuchKey`` for a missing
      // key, depending on operation. To a caller that holds ``s3:GetObject``
      // without ``s3:ListBucket``, as this role does, S3 answers 403, not
      // 404 (HeadObject API reference, "Permissions").
      const name = (err as { name?: string })?.name;
      const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || httpStatus === 404 || httpStatus === 403) {
        logger.warn('Trace artifact S3 object not found at HEAD time', {
          task_id: taskId,
          bucket: parsed.bucket,
          key: parsed.key,
          http_status: httpStatus,
          request_id: requestId,
        });
        return errorResponse(
          404,
          ErrorCode.TRACE_NOT_AVAILABLE,
          'Task did not run with --trace, or the trace has not been uploaded yet.',
          requestId,
        );
      }
      logger.error('HeadObject failed for trace artifact', {
        task_id: taskId,
        bucket: parsed.bucket,
        key: parsed.key,
        error: err instanceof Error ? err.message : String(err),
        error_name: name,
        request_id: requestId,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
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
