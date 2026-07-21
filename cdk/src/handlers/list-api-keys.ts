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
import { type ApiKeyRecord, toApiKeyDetail } from './shared/types';
import { decodePaginationToken, encodePaginationToken, parseLimit } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.API_KEY_TABLE_NAME!;

/** Default page size when the caller omits ``?limit=``. */
const DEFAULT_PAGE_LIMIT = 20;

/** Hard page-size ceiling. */
const MAX_PAGE_LIMIT = 100;

/**
 * Cap on DynamoDB `Query` round-trips per request. `Limit` is applied to
 * *scanned* items before `FilterExpression`, so filtering out revoked keys can
 * leave a page short; we page until it is full (below). This bounds the work a
 * caller with many revoked keys can trigger — the token still advances, so the
 * next request resumes rather than silently truncating.
 */
const MAX_QUERY_PAGES = 10;

/** GSI key attributes DynamoDB needs to resume a `UserIndex` query. */
function startKeyForRecord(record: ApiKeyRecord): Record<string, unknown> {
  return { key_id: record.key_id, user_id: record.user_id, created_at: record.created_at };
}

/**
 * GET /v1/api-keys — List API keys for the authenticated user.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const limit = parseLimit(event.queryStringParameters?.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const includeRevoked = event.queryStringParameters?.include_revoked === 'true';

    let filterExpression: string | undefined;
    const expressionAttributeValues: Record<string, unknown> = { ':uid': userId };

    if (!includeRevoked) {
      filterExpression = '#s = :active';
      expressionAttributeValues[':active'] = 'active';
    }

    // Accumulate until we have a full page of post-filter items (or run out).
    // Over-fetch one extra so we can tell whether a further page exists without
    // returning a short page that still advertises `has_more`.
    let startKey = decodePaginationToken(event.queryStringParameters?.next_token);
    const items: ApiKeyRecord[] = [];

    for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'UserIndex',
        KeyConditionExpression: 'user_id = :uid',
        ...(filterExpression && {
          FilterExpression: filterExpression,
          ExpressionAttributeNames: { '#s': 'status' },
        }),
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: limit + 1,
        ScanIndexForward: false,
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));

      items.push(...((result.Items ?? []) as ApiKeyRecord[]));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;

      if (items.length > limit) {
        // Enough for this page plus proof another item exists.
        break;
      }
      if (!startKey) {
        // Table exhausted — whatever we have is the final page.
        break;
      }
    }

    const pageItems = items.slice(0, limit);

    // Build the resume token:
    // - Trimmed (more accumulated than the page holds): resume from the last
    //   *returned* record. DynamoDB's LastEvaluatedKey points past the extra
    //   over-fetched items we dropped, so using it would skip them.
    // - Not trimmed but a scan cursor is still pending (we hit the page cap
    //   before filling the page): resume from that raw cursor so the caller can
    //   continue rather than being told, falsely, that the list is complete.
    let nextToken: string | null = null;
    if (items.length > limit) {
      nextToken = encodePaginationToken(startKeyForRecord(pageItems[pageItems.length - 1]));
    } else if (startKey) {
      nextToken = encodePaginationToken(startKey);
    }

    return paginatedResponse(pageItems.map(toApiKeyDetail), nextToken, requestId);
  } catch (err) {
    logger.error('Failed to list API keys', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
