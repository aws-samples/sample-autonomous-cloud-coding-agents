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

import * as crypto from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateSecretCommand, DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { CreateWebhookRequest, CreateWebhookResponse, WebhookRecord } from './shared/types';
import { isValidWebhookName, parseBody } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sm = new SecretsManagerClient({});
const TABLE_NAME = process.env.WEBHOOK_TABLE_NAME!;
const SECRET_PREFIX = 'bgagent/webhook/';

/**
 * POST /v1/webhooks — Create a new webhook integration.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const body = parseBody<CreateWebhookRequest>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    if (!body.name || !isValidWebhookName(body.name)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid webhook name. Must be 1-64 alphanumeric characters, spaces, hyphens, or underscores.',
        requestId,
      );
    }

    const webhookId = ulid();
    const secret = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();

    // 1. Create secret in Secrets Manager (tags inline to avoid separate TagResource IAM action)
    const secretName = `${SECRET_PREFIX}${webhookId}`;
    await sm.send(new CreateSecretCommand({
      Name: secretName,
      SecretString: secret,
      Description: `Webhook secret for ${body.name} (${webhookId})`,
      Tags: [
        { Key: 'webhook_id', Value: webhookId },
        { Key: 'user_id', Value: userId },
      ],
    }));

    // 2. Write webhook record to DynamoDB (rollback secret on failure)
    const record: WebhookRecord = {
      webhook_id: webhookId,
      user_id: userId,
      name: body.name,
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    try {
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: record,
        ConditionExpression: 'attribute_not_exists(webhook_id)',
      }));
    } catch (ddbErr) {
      logger.error('DDB write failed after secret creation, rolling back secret', {
        webhook_id: webhookId,
        error: String(ddbErr),
        request_id: requestId,
      });
      try {
        await sm.send(new DeleteSecretCommand({
          SecretId: secretName,
          ForceDeleteWithoutRecovery: true,
        }));
      } catch (rollbackErr) {
        logger.error('Failed to rollback secret after DDB failure — orphaned secret', {
          webhook_id: webhookId,
          secret_name: secretName,
          error: String(rollbackErr),
          request_id: requestId,
        });
      }
      throw ddbErr;
    }

    logger.info('Webhook created', { webhook_id: webhookId, user_id: userId, request_id: requestId });

    const response: CreateWebhookResponse = {
      webhook_id: webhookId,
      name: body.name,
      secret,
      created_at: now,
    };

    return successResponse(201, response, requestId);
  } catch (err) {
    logger.error('Failed to create webhook', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
