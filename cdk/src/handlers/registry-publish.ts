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

import { ConflictException } from '@aws-sdk/client-agent-registry-control';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId, userInGroup } from './shared/gateway';
import { logger } from './shared/logger';
import {
  REGISTRY_APPROVER_GROUP,
  REGISTRY_PUBLISHER_GROUP,
  makeRegistryClient,
} from './shared/registry/factory';
import { REGISTRY_KINDS, RESERVED_KINDS, parseConstraint } from './shared/registry/ref';
import { RegistryPublishIncompleteError, type PublishInput, type RuntimePayload } from './shared/registry/types';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryPublishRequest, RegistryRecordResponse } from './shared/types';

const NAMESPACE_RE = /^[a-z][a-z0-9-]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * POST /v1/registry/records — publish an asset record.
 *
 * Auth: caller must be a `RegistryPublisher`. `auto_approve` additionally
 * requires `RegistryApprover` (it drives the record all the way to APPROVED).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }
    if (!userInGroup(event, REGISTRY_PUBLISHER_GROUP)) {
      return errorResponse(403, ErrorCode.FORBIDDEN, `Publishing requires the ${REGISTRY_PUBLISHER_GROUP} group.`, requestId);
    }

    const body = parseBody(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    const validationError = validate(body);
    if (validationError) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, validationError, requestId);
    }

    if (body.auto_approve && !userInGroup(event, REGISTRY_APPROVER_GROUP)) {
      return errorResponse(403, ErrorCode.FORBIDDEN, `auto_approve requires the ${REGISTRY_APPROVER_GROUP} group.`, requestId);
    }

    const input: PublishInput = {
      kind: body.kind,
      namespace: body.namespace,
      name: body.name,
      version: body.asset_version,
      discovery: body.discovery,
      runtime: body.runtime as unknown as RuntimePayload,
      publisher: userId,
      custom: body.custom,
      autoApprove: body.auto_approve,
    };

    const client = makeRegistryClient();
    const record = await client.publish(input);

    const response: RegistryRecordResponse = {
      kind: record.kind,
      namespace: record.namespace,
      name: record.name,
      version: record.version,
      status: record.status,
      storage_mode: record.storageMode,
    };
    return successResponse(201, response, requestId);
  } catch (err) {
    if (err instanceof ConflictException) {
      return errorResponse(409, ErrorCode.REGISTRY_VERSION_EXISTS, 'A record with these coordinates already exists.', requestId);
    }
    if (err instanceof RegistryPublishIncompleteError) {
      logger.error('registry publish incomplete', { requestId, recordId: err.recordId, error: String(err.cause) });
      return errorResponse(
        502,
        ErrorCode.REGISTRY_PUBLISH_INCOMPLETE,
        `${err.message} (record id: ${err.recordId})`,
        requestId,
      );
    }
    logger.error('registry publish failed', { requestId, error: String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Failed to publish record.', requestId);
  }
}

function parseBody(raw: string | null): RegistryPublishRequest | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RegistryPublishRequest;
  } catch {
    return null;
  }
}

/** Returns an error message, or null when the request is well-formed. */
function validate(body: RegistryPublishRequest): string | null {
  if (RESERVED_KINDS.includes(body.kind as (typeof RESERVED_KINDS)[number])) {
    return `kind '${body.kind}' is reserved and cannot be published yet (no loader).`;
  }
  if (!REGISTRY_KINDS.includes(body.kind as (typeof REGISTRY_KINDS)[number])) {
    return `unknown kind '${body.kind}' (expected one of: ${REGISTRY_KINDS.join(', ')}).`;
  }
  if (!body.namespace || !NAMESPACE_RE.test(body.namespace)) {
    return 'namespace must match [a-z][a-z0-9-]*.';
  }
  if (!body.name || !NAME_RE.test(body.name)) {
    return 'name must match [a-z0-9][a-z0-9._-]*.';
  }
  const constraint = body.asset_version ? parseConstraint(body.asset_version) : null;
  if (!constraint || constraint.op !== 'exact') {
    return 'asset_version must be an exact semver (MAJOR.MINOR.PATCH[-prerelease]).';
  }
  if (!isPlainObject(body.discovery)) {
    return 'discovery must be a JSON object.';
  }
  if (!isPlainObject(body.runtime)) {
    return 'runtime must be a JSON object.';
  }
  // The flags are typed boolean? — enforce it so a truthy string like
  // `custom: "false"` can't silently flip storage mode (#246 review nit).
  if (body.custom !== undefined && typeof body.custom !== 'boolean') {
    return 'custom, when present, must be a boolean.';
  }
  if (body.auto_approve !== undefined && typeof body.auto_approve !== 'boolean') {
    return 'auto_approve, when present, must be a boolean.';
  }
  return validateRuntime(body.kind, body.runtime);
}

/** True only for a non-null, non-array object — rejects arrays, which `typeof`
 *  reports as 'object' and which no runtime payload should ever be. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Enforce the discriminated runtime contract per kind (#246 review). Previously
 * `runtime` was only checked as `typeof object`, so arrays, `{}`, and wrong-kind
 * payloads published a 201 that later resolved into a loader that silently
 * skipped it — while the task audit still claimed the pin was used. Reject those
 * at publish so a published record's runtime is always loadable.
 */
/** Keys each kind's runtime may carry. Publishing any other key is rejected so
 *  the payload is closed at the gateway — a publisher cannot smuggle an
 *  `api_key`/`env`/… field that a denylist-based reader would later leak
 *  (#246 review B2). Kept in sync with the allowlist in registry-resolve.ts. */
const ALLOWED_RUNTIME_KEYS: Record<string, ReadonlySet<string>> = {
  mcp_server: new Set(['transport', 'url', 'command', 'args', 'headers', 'tool_prefix']),
  cedar_policy_module: new Set(['cedar_text']),
  skill: new Set(['prompt_fragment', 'tool_hints']),
};

function validateRuntime(kind: string, runtime: Record<string, unknown>): string | null {
  const allowed = ALLOWED_RUNTIME_KEYS[kind];
  if (allowed) {
    const unknown = Object.keys(runtime).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      return `${kind} runtime has unsupported field(s): ${unknown.join(', ')}. `
        + `Allowed: ${[...allowed].join(', ')}. Credentials must be referenced (e.g. a Secrets Manager ARN), not inlined.`;
    }
  }
  switch (kind) {
    case 'mcp_server': {
      const transport = runtime.transport;
      if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
        return "mcp_server runtime.transport must be one of 'http', 'sse', 'stdio'.";
      }
      if (transport === 'stdio') {
        if (typeof runtime.command !== 'string' || !runtime.command) {
          return "mcp_server runtime.command (non-empty string) is required for transport 'stdio'.";
        }
      } else if (typeof runtime.url !== 'string' || !runtime.url) {
        return `mcp_server runtime.url (non-empty string) is required for transport '${transport}'.`;
      }
      if (runtime.headers !== undefined && !isPlainObject(runtime.headers)) {
        return 'mcp_server runtime.headers, when present, must be a JSON object.';
      }
      return null;
    }
    case 'cedar_policy_module':
      if (typeof runtime.cedar_text !== 'string' || !runtime.cedar_text.trim()) {
        return 'cedar_policy_module runtime.cedar_text (non-empty string) is required.';
      }
      return null;
    case 'skill':
      if (typeof runtime.prompt_fragment !== 'string' || !runtime.prompt_fragment.trim()) {
        return 'skill runtime.prompt_fragment (non-empty string) is required.';
      }
      if (runtime.tool_hints !== undefined && !Array.isArray(runtime.tool_hints)) {
        return 'skill runtime.tool_hints, when present, must be an array.';
      }
      return null;
    default:
      // Unknown kinds are already rejected above; defensive fallthrough.
      return `no runtime contract defined for kind '${kind}'.`;
  }
}
