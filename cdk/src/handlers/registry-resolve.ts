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
 * Project a runtime payload down to its known-safe discovery fields before
 * returning it on the human-facing resolve response. This endpoint is open to
 * any authenticated caller (resolve/read is not group-gated, REGISTRY.md §10),
 * and the runtime is an open `Record<string, unknown>` — a publisher can attach
 * arbitrary keys (`api_key`, `env`, a token in a `url` query string, …). A
 * denylist over a few field names is therefore fail-open by construction, so we
 * fail closed with an **allowlist**: only fields that are structurally
 * non-secret for the given kind are returned, everything else is dropped
 * (#246 review B1/B2). The orchestrator does NOT go through this handler — it
 * resolves via the `RegistryClient` port directly and receives the full,
 * unredacted payload it needs to connect.
 */
function redactRuntimeForResponse(
  kind: string,
  runtime: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'cedar_policy_module') {
    // Cedar policy source is not a secret (it is authored policy text).
    return typeof runtime.cedar_text === 'string' ? { cedar_text: runtime.cedar_text } : {};
  }
  if (kind === 'skill') {
    // Skills are prompt text + advisory tool hints — no secret surface.
    const out: Record<string, unknown> = {};
    if (typeof runtime.prompt_fragment === 'string') out.prompt_fragment = runtime.prompt_fragment;
    if (Array.isArray(runtime.tool_hints)) out.tool_hints = runtime.tool_hints;
    return out;
  }
  // mcp_server: return only the discovery-safe shape. transport/type + tool_prefix
  // are safe; `url` is reduced to its origin (scheme+host) so a token embedded in
  // the query string or path is never disclosed; header *keys* are retained as a
  // discovery signal with values masked; command/args and every other key (env,
  // api_key, …) are dropped.
  const out: Record<string, unknown> = {};
  if (typeof runtime.transport === 'string') out.transport = runtime.transport;
  if (typeof runtime.type === 'string') out.type = runtime.type;
  if (typeof runtime.tool_prefix === 'string') out.tool_prefix = runtime.tool_prefix;
  if (typeof runtime.url === 'string') {
    try {
      out.url = new URL(runtime.url).origin;
    } catch {
      out.url = '***';
    }
  }
  const headers = runtime.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const masked: Record<string, string> = {};
    for (const key of Object.keys(headers as Record<string, unknown>)) masked[key] = '***';
    out.headers = masked;
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
      runtime: redactRuntimeForResponse(asset.kind, asset.runtime as unknown as Record<string, unknown>),
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
