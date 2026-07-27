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
import { parseRef } from './shared/registry/ref';
import { RegistryResolutionError } from './shared/registry/types';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryResolveResponse } from './shared/types';

/**
 * GET /v1/registry/resolve?ref=registry://kind/namespace/name@constraint
 *
 * Resolves a pinned ref to a single APPROVED (or DEPRECATED+warn) asset.
 * Fail-closed: any unresolved ref returns 422 with a specific reason.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const refStr = event.queryStringParameters?.ref;
    if (!refStr) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing ref query parameter.', requestId);
    }

    const parsed = parseRef(refStr);
    if (!parsed.ok) {
      return errorResponse(422, ErrorCode.REGISTRY_RESOLUTION_FAILED, `${parsed.reason}: ${parsed.message}`, requestId);
    }

    const client = makeRegistryClient();
    const asset = await client.resolve(parsed.ref);

    const response: RegistryResolveResponse = {
      kind: asset.kind,
      namespace: asset.namespace,
      name: asset.name,
      version: asset.version,
      runtime: asset.runtime as unknown as Record<string, unknown>,
      warnings: asset.warnings,
    };
    return successResponse(200, response, requestId);
  } catch (err) {
    if (err instanceof RegistryResolutionError) {
      return errorResponse(422, ErrorCode.REGISTRY_RESOLUTION_FAILED, `${err.reason}: ${err.message}`, requestId);
    }
    logger.error('registry resolve failed', { requestId, error: String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Failed to resolve ref.', requestId);
  }
}
