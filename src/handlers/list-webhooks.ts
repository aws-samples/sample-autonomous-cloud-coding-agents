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
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse } from './shared/response';
import { type WebhookRecord, toWebhookDetail } from './shared/types';
import { decodePaginationToken, encodePaginationToken, parseLimit } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.WEBHOOK_TABLE_NAME!;

/**
 * GET /v1/webhooks — List webhooks for the authenticated user.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const limit = parseLimit(event.queryStringParameters?.limit, 20, 100);
    const startKey = decodePaginationToken(event.queryStringParameters?.next_token);
    const includeRevoked = event.queryStringParameters?.include_revoked === 'true';

    let filterExpression: string | undefined;
    let expressionAttributeValues: Record<string, unknown> = { ':uid': userId };

    if (!includeRevoked) {
      filterExpression = '#s = :active';
      expressionAttributeValues[':active'] = 'active';
    }

    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'UserIndex',
      KeyConditionExpression: 'user_id = :uid',
      ...(filterExpression && {
        FilterExpression: filterExpression,
        ExpressionAttributeNames: { '#s': 'status' },
      }),
      ExpressionAttributeValues: expressionAttributeValues,
      Limit: limit,
      ScanIndexForward: false,
      ...(startKey && { ExclusiveStartKey: startKey }),
    }));

    const items = (result.Items ?? []) as WebhookRecord[];
    const nextToken = encodePaginationToken(result.LastEvaluatedKey as Record<string, unknown> | undefined);

    return paginatedResponse(items.map(toWebhookDetail), nextToken, requestId);
  } catch (err) {
    logger.error('Failed to list webhooks', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
