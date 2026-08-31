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

import { type DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

/** Resolve a missing Jira cloudId only when exactly one active tenant exists. */
export async function resolveSoleActiveJiraTenant(
  ddb: DynamoDBDocumentClient,
  registryTableName: string | undefined,
): Promise<string | undefined> {
  if (!registryTableName) return undefined;
  const activeCloudIds: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: registryTableName,
      ProjectionExpression: 'jira_cloud_id, #s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExclusiveStartKey: lastKey,
      ConsistentRead: true,
    }));
    for (const item of page.Items ?? []) {
      if (item.status === 'active' && typeof item.jira_cloud_id === 'string') {
        activeCloudIds.push(item.jira_cloud_id);
      }
    }
    lastKey = page.LastEvaluatedKey;
    if (activeCloudIds.length > 1) break;
  } while (lastKey);

  if (activeCloudIds.length === 1) return activeCloudIds[0];
  logger.warn('Cannot infer Jira cloudId: registry does not have exactly one active tenant', {
    active_tenant_count: activeCloudIds.length,
  });
  return undefined;
}
