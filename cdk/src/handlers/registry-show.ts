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
import { publishPk, PUBLISHABLE_KINDS, RESERVED_KINDS } from './shared/registry-descriptor';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryAssetKind, RegistryAssetRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.REGISTRY_ASSETS_TABLE_NAME!;

/**
 * GET /v1/registry/assets/{kind}/{namespace}/{name} — show every version of a
 * single asset (REGISTRY.md §4.4). Single Query on the partition; versions are
 * returned newest-semver-first.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    if (!extractUserId(event)) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const kind = event.pathParameters?.kind;
    const namespace = event.pathParameters?.namespace;
    const name = event.pathParameters?.name;
    if (!kind || !namespace || !name) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Path must be /registry/assets/{kind}/{namespace}/{name}.', requestId);
    }
    if (!PUBLISHABLE_KINDS.has(kind as RegistryAssetKind) && !RESERVED_KINDS.has(kind as RegistryAssetKind)) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, `Unknown asset kind ${kind}.`, requestId);
    }

    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': publishPk(kind, namespace, name) },
      }),
    );
    const rows = (result.Items ?? []) as unknown as RegistryAssetRecord[];

    if (rows.length === 0) {
      return errorResponse(
        404,
        ErrorCode.REGISTRY_ASSET_NOT_FOUND,
        `No asset ${kind}/${namespace}/${name}.`,
        requestId,
      );
    }

    const versions = rows
      .slice()
      .sort((a, b) => semver.rcompare(a.version, b.version))
      .map((r) => ({
        version: r.version,
        status: r.status,
        created_at: r.created_at,
        publisher: r.publisher,
      }));

    logger.info('registry show', { kind, namespace, name, versions: versions.length, request_id: requestId });
    return successResponse(200, { kind, namespace, name, versions }, requestId);
  } catch (err) {
    logger.error('registry show failed', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
