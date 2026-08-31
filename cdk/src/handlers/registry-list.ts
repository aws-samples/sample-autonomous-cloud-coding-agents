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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { makeRegistryClient } from './shared/registry/factory';
import { compareVersions, parseVersion } from './shared/registry/resolver';
import type { RegistryRecord } from './shared/registry/types';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryListEntry } from './shared/types';

/**
 * GET /v1/registry/records?kind=&namespace= — list assets (grouped by
 * kind/namespace/name, one row per asset with its latest version).
 * Excludes tombstoned/never-approved noise by reporting the latest version
 * present regardless of status (status column tells the caller the rest).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const kind = event.queryStringParameters?.kind;
    const namespace = event.queryStringParameters?.namespace;

    const client = makeRegistryClient();
    const records = await client.listRecords({ kind, namespace });

    const entries = groupLatest(records);
    return successResponse(200, { assets: entries }, requestId);
  } catch (err) {
    logger.error('registry list failed', { requestId, error: String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Failed to list records.', requestId);
  }
}

/** Collapse per-version records into one entry per asset at its highest version. */
function groupLatest(records: readonly RegistryRecord[]): RegistryListEntry[] {
  const byAsset = new Map<string, RegistryRecord>();
  for (const r of records) {
    const key = `${r.kind}/${r.namespace}/${r.name}`;
    const current = byAsset.get(key);
    if (!current) {
      byAsset.set(key, r);
      continue;
    }
    const a = parseVersion(r.version);
    const b = parseVersion(current.version);
    if (a && b && compareVersions(a, b) > 0) byAsset.set(key, r);
  }
  return [...byAsset.values()].map((r) => ({
    kind: r.kind,
    namespace: r.namespace,
    name: r.name,
    latest_version: r.version || null,
    status: r.status,
  }));
}
