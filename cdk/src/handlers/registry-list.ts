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
import * as semver from 'semver';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { REGISTRY_KIND_INDEX } from '../constructs/registry-assets-table';
import { PUBLISHABLE_KINDS, RESERVED_KINDS } from './shared/registry-descriptor';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryAssetKind, RegistryAssetRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.REGISTRY_ASSETS_TABLE_NAME!;

/**
 * GET /v1/registry/assets?kind=mcp_server — list assets of a kind
 * (REGISTRY.md §4.3). Queries the ``kind-index`` GSI, collapses versions to
 * one row per asset (highest approved/deprecated version), and excludes
 * ``removed`` unless ``?status=removed`` is requested.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    if (!extractUserId(event)) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const kind = event.queryStringParameters?.kind;
    if (!kind || (!PUBLISHABLE_KINDS.has(kind as RegistryAssetKind) && !RESERVED_KINDS.has(kind as RegistryAssetKind))) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Query parameter "kind" is required and must be a known asset kind.',
        requestId,
      );
    }
    const namespaceFilter = event.queryStringParameters?.namespace;

    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: REGISTRY_KIND_INDEX,
        KeyConditionExpression: 'kind = :kind',
        ExpressionAttributeValues: { ':kind': kind },
      }),
    );
    const rows = (result.Items ?? []) as unknown as RegistryAssetRecord[];

    // Collapse to one summary per (namespace/name), keeping the highest semver
    // version and its status. Exclude removed rows unless explicitly requested.
    const includeRemoved = event.queryStringParameters?.status === 'removed';
    const byAsset = new Map<string, RegistryAssetRecord>();
    for (const row of rows) {
      if (namespaceFilter && row.namespace !== namespaceFilter) continue;
      if (row.status === 'removed' && !includeRemoved) continue;
      const key = row.pk;
      const current = byAsset.get(key);
      if (!current || semver.gt(row.version, current.version)) {
        byAsset.set(key, row);
      }
    }

    const assets = [...byAsset.values()].map((r) => ({
      kind: r.kind,
      namespace: r.namespace,
      name: r.name,
      latest_version: r.version,
      status: r.status,
    }));

    logger.info('registry list', { kind, count: assets.length, request_id: requestId });
    return successResponse(200, { assets }, requestId);
  } catch (err) {
    logger.error('registry list failed', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
