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
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { type WebhookRecord, toWebhookDetail } from './shared/types';
import { computeTtlEpoch } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sm = new SecretsManagerClient({});
const TABLE_NAME = process.env.WEBHOOK_TABLE_NAME!;
const SECRET_PREFIX = 'bgagent/webhook/';
const WEBHOOK_RETENTION_DAYS = Number(process.env.WEBHOOK_RETENTION_DAYS ?? '30');

/**
 * DELETE /v1/webhooks/{webhook_id} — Soft-revoke a webhook.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const webhookId = event.pathParameters?.webhook_id;
    if (!webhookId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing webhook_id path parameter.', requestId);
    }

    // 1. Fetch webhook record
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { webhook_id: webhookId },
    }));

    const record = result.Item as WebhookRecord | undefined;
    if (!record) {
      return errorResponse(404, ErrorCode.WEBHOOK_NOT_FOUND, 'Webhook not found.', requestId);
    }

    // 2. Verify ownership
    if (record.user_id !== userId) {
      return errorResponse(404, ErrorCode.WEBHOOK_NOT_FOUND, 'Webhook not found.', requestId);
    }

    // 3. Check if already revoked
    if (record.status === 'revoked') {
      return errorResponse(409, ErrorCode.WEBHOOK_ALREADY_REVOKED, 'Webhook is already revoked.', requestId);
    }

    const now = new Date().toISOString();

    // 4. Soft-revoke in DynamoDB
    const updated = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { webhook_id: webhookId },
      UpdateExpression: 'SET #s = :revoked, updated_at = :now, revoked_at = :now, #ttl = :ttl',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now, ':ttl': computeTtlEpoch(WEBHOOK_RETENTION_DAYS) },
      ReturnValues: 'ALL_NEW',
    }));

    // 5. Schedule secret deletion (7-day recovery window)
    try {
      await sm.send(new DeleteSecretCommand({
        SecretId: `${SECRET_PREFIX}${webhookId}`,
        RecoveryWindowInDays: 7,
      }));
    } catch (smErr: unknown) {
      const errName = (smErr as { name?: string })?.name;
      if (errName === 'ResourceNotFoundException') {
        logger.info('Webhook secret already deleted', { webhook_id: webhookId });
      } else {
        logger.error('Failed to schedule secret deletion — secret may still exist', {
          error: String(smErr),
          error_name: errName,
          webhook_id: webhookId,
          request_id: requestId,
        });
      }
    }

    logger.info('Webhook revoked', { webhook_id: webhookId, user_id: userId, request_id: requestId });

    return successResponse(200, toWebhookDetail(updated.Attributes as WebhookRecord), requestId);
  } catch (err) {
    logger.error('Failed to delete webhook', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
