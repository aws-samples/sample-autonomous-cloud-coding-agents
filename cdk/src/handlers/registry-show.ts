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
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryShowResponse, RegistryVersionSummary } from './shared/types';

/**
 * GET /v1/registry/records/{kind}/{namespace}/{name} — show every version of
 * one asset with its status/publisher/created_at.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const kind = event.pathParameters?.kind;
    const namespace = event.pathParameters?.namespace;
    const name = event.pathParameters?.name;
    if (!kind || !namespace || !name) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing kind/namespace/name path parameters.', requestId);
    }

    const client = makeRegistryClient();
    const records = (await client.listRecords({ kind, namespace })).filter((r) => r.name === name);
    if (records.length === 0) {
      return errorResponse(404, ErrorCode.REGISTRY_RECORD_NOT_FOUND, `No asset ${kind}/${namespace}/${name}.`, requestId);
    }

    const versions: RegistryVersionSummary[] = records
      .map((r) => ({
        version: r.version,
        status: r.status,
        created_at: r.createdAt ?? null,
        publisher: r.publisher ?? null,
      }))
      .sort((a, b) => {
        const av = parseVersion(a.version);
        const bv = parseVersion(b.version);
        if (!av || !bv) return 0;
        return compareVersions(bv, av); // highest first
      });

    const response: RegistryShowResponse = { kind, namespace, name, versions };
    return successResponse(200, response, requestId);
  } catch (err) {
    logger.error('registry show failed', { requestId, error: String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Failed to show asset.', requestId);
  }
}
