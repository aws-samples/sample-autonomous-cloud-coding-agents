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
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { type ApiKeyRecord, toApiKeyDetail } from './shared/types';
import { computeTtlEpoch } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.API_KEY_TABLE_NAME!;
const API_KEY_RETENTION_DAYS = Number(process.env.API_KEY_RETENTION_DAYS ?? '30');

/**
 * DELETE /v1/api-keys/{key_id} — Soft-revoke an API key.
 *
 * Mirrors webhook revocation: ownership mismatch returns 404 (not 403) so the
 * API is not an existence oracle for another user's key IDs.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const keyId = event.pathParameters?.key_id;
    if (!keyId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing key_id path parameter.', requestId);
    }

    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { key_id: keyId },
    }));

    const record = result.Item as ApiKeyRecord | undefined;
    if (!record || record.user_id !== userId) {
      return errorResponse(404, ErrorCode.API_KEY_NOT_FOUND, 'API key not found.', requestId);
    }

    if (record.status === 'revoked') {
      return errorResponse(409, ErrorCode.API_KEY_ALREADY_REVOKED, 'API key is already revoked.', requestId);
    }

    const now = new Date().toISOString();

    const updated = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { key_id: keyId },
      UpdateExpression: 'SET #s = :revoked, updated_at = :now, revoked_at = :now, #ttl = :ttl',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now, ':ttl': computeTtlEpoch(API_KEY_RETENTION_DAYS) },
      ReturnValues: 'ALL_NEW',
    }));

    logger.info('API key revoked', { key_id: keyId, user_id: userId, request_id: requestId });

    return successResponse(200, toApiKeyDetail(updated.Attributes as ApiKeyRecord), requestId);
  } catch (err) {
    logger.error('Failed to delete API key', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
