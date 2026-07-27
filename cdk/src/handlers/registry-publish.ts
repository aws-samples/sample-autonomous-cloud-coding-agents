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

import { ConflictException } from '@aws-sdk/client-bedrock-agentcore-control';
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
import type { PublishInput, RuntimePayload } from './shared/registry/types';
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
  if (!body.asset_version || !parseConstraint(body.asset_version) || parseConstraint(body.asset_version)!.op !== 'exact') {
    return 'asset_version must be an exact semver (MAJOR.MINOR.PATCH[-prerelease]).';
  }
  if (!body.discovery || typeof body.discovery !== 'object') {
    return 'discovery must be an object.';
  }
  if (!body.runtime || typeof body.runtime !== 'object') {
    return 'runtime must be an object.';
  }
  return null;
}
