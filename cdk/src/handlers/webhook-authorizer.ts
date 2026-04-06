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
import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { logger } from './shared/logger';
import type { WebhookRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.WEBHOOK_TABLE_NAME!;

function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      }],
    },
    ...(context && { context }),
  };
}

/**
 * Lambda REQUEST authorizer for webhook task creation.
 *
 * Verifies the webhook exists and is active. HMAC-SHA256 signature verification
 * is performed in the downstream handler because API Gateway REST API v1
 * does NOT pass the request body to REQUEST authorizers.
 */
export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const webhookId = event.headers?.['X-Webhook-Id'] ?? event.headers?.['x-webhook-id'];
  const signature = event.headers?.['X-Webhook-Signature'] ?? event.headers?.['x-webhook-signature'];
  const methodArn = event.methodArn;

  try {
    if (!webhookId || !signature) {
      logger.warn('Missing webhook headers');
      return generatePolicy('anonymous', 'Deny', methodArn);
    }

    // 1. Look up webhook record
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { webhook_id: webhookId },
    }));

    const record = result.Item as WebhookRecord | undefined;
    if (!record || record.status !== 'active') {
      logger.warn('Webhook not found or revoked', { webhook_id: webhookId });
      return generatePolicy(webhookId, 'Deny', methodArn);
    }

    // 2. Return Allow with user context — signature verification deferred to handler
    return generatePolicy(record.user_id, 'Allow', methodArn, {
      userId: record.user_id,
      webhookId: record.webhook_id,
    });
  } catch (err) {
    logger.error('Webhook authorizer unexpected error', {
      error: String(err),
      webhook_id: webhookId ?? 'unknown',
    });
    return generatePolicy(webhookId ?? 'unknown', 'Deny', methodArn);
  }
}
