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
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { generateApiKey, validateScopes } from './shared/api-key';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { ApiKeyRecord, ApiKeyScope, CreateApiKeyRequest, CreateApiKeyResponse } from './shared/types';
import { isValidWebhookName, parseBody } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.API_KEY_TABLE_NAME!;

/** Default scope granted when the caller omits `scopes`. */
const DEFAULT_SCOPES: readonly ApiKeyScope[] = ['webhooks:manage'];

/**
 * POST /v1/api-keys — Mint a new platform API key for the authenticated user.
 * The plaintext key is returned once; only its hash is persisted.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const body = parseBody<CreateApiKeyRequest>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    if (!body.name || !isValidWebhookName(body.name)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid key name. Must be 1-64 alphanumeric characters, spaces, hyphens, or underscores.',
        requestId,
      );
    }

    let scopes: readonly ApiKeyScope[] = DEFAULT_SCOPES;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'scopes must be a non-empty array.', requestId);
      }
      const validated = validateScopes(body.scopes);
      if (!validated) {
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'scopes contains an unknown value.', requestId);
      }
      scopes = validated;
    }

    let expiresAt: string | undefined;
    if (body.expires_at !== undefined) {
      const parsed = Date.parse(body.expires_at);
      if (Number.isNaN(parsed)) {
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'expires_at must be an ISO-8601 timestamp.', requestId);
      }
      if (parsed <= Date.now()) {
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'expires_at must be in the future.', requestId);
      }
      expiresAt = new Date(parsed).toISOString();
    }

    const keyId = ulid();
    const { plaintext, keyHash } = generateApiKey(keyId);
    const now = new Date().toISOString();

    const record: ApiKeyRecord = {
      key_id: keyId,
      user_id: userId,
      name: body.name,
      key_hash: keyHash,
      scopes,
      status: 'active',
      created_at: now,
      updated_at: now,
      ...(expiresAt && { expires_at: expiresAt }),
    };

    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: 'attribute_not_exists(key_id)',
    }));

    logger.info('API key created', { key_id: keyId, user_id: userId, request_id: requestId });

    const response: CreateApiKeyResponse = {
      key_id: keyId,
      name: body.name,
      key: plaintext,
      scopes,
      expires_at: expiresAt ?? null,
      created_at: now,
    };

    return successResponse(201, response, requestId);
  } catch (err) {
    logger.error('Failed to create API key', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
