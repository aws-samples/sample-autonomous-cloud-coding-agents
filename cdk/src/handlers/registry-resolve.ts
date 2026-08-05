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
 * Redact secret-bearing fields from a runtime payload before returning it on the
 * human-facing resolve response. An mcp_server payload may carry secrets in two
 * places: `headers` (e.g. `Authorization: Bearer …`) on http/sse transports, and
 * `command`/`args` on a `stdio` transport (tokens are routinely passed as CLI
 * args such as `--api-key=…` or embedded in the command string). This endpoint is
 * open to any authenticated caller (resolve/read is not group-gated,
 * REGISTRY.md §10), so returning either verbatim would turn the catalog into a
 * tenant-wide secret-read endpoint (#246 review). Header *keys* are retained as
 * discovery signal — a caller can see the server expects an `Authorization`
 * header without learning its value; `command`/`args` are masked wholesale
 * because their structure itself can encode secrets. The orchestrator does NOT go
 * through this handler: it resolves via the `RegistryClient` port directly and
 * receives the unredacted payload it needs to connect.
 */
function redactRuntimeForResponse(runtime: Record<string, unknown>): Record<string, unknown> {
  const out = { ...runtime };
  const headers = out.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(headers as Record<string, unknown>)) {
      redacted[key] = '***';
    }
    out.headers = redacted;
  }
  if (typeof out.command === 'string') {
    out.command = '***';
  }
  if (Array.isArray(out.args)) {
    out.args = (out.args as unknown[]).map(() => '***');
  }
  return out;
}

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
      runtime: redactRuntimeForResponse(asset.runtime as unknown as Record<string, unknown>),
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
