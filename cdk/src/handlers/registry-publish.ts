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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractGroups, extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import {
  artifactKey,
  asDescriptor,
  KINDS_REQUIRING_ARTIFACT,
  publishPk,
  validatePublish,
  type PublishInput,
} from './shared/registry-descriptor';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { RegistryAssetKind, RegistryAssetRecord, RegistryAssetStatus } from './shared/types';
import { parseBody } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE_NAME = process.env.REGISTRY_ASSETS_TABLE_NAME!;
const BUCKET_NAME = process.env.REGISTRY_ARTIFACTS_BUCKET_NAME!;

/** Cognito group that may create records (lands in ``submitted``). */
export const PUBLISHER_GROUP = 'RegistryPublisher';
/** Cognito group that may approve/reject/deprecate and auto-approve on publish. */
export const APPROVER_GROUP = 'RegistryApprover';

/**
 * POST /v1/registry/assets — publish a new asset version (REGISTRY.md §4.1).
 *
 * Auth: caller must be in ``RegistryPublisher`` (or ``RegistryApprover``).
 * Record lands ``submitted`` unless the caller is an approver and passes
 * ``?auto_approve=true`` (dev), in which case it lands ``approved``.
 * Immutability: 409 on ``(kind, namespace, name, version)`` collision.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const groups = extractGroups(event);
    const isPublisher = groups.includes(PUBLISHER_GROUP);
    const isApprover = groups.includes(APPROVER_GROUP);
    if (!isPublisher && !isApprover) {
      return errorResponse(
        403,
        ErrorCode.FORBIDDEN,
        `Publishing requires membership in the ${PUBLISHER_GROUP} group.`,
        requestId,
      );
    }

    const body = parseBody<PublishInput>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    const violations = validatePublish(body);
    if (violations.length > 0) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Invalid publish request: ${violations.map((x) => `${x.field}: ${x.message}`).join('; ')}`,
        requestId,
      );
    }

    // Post-validation, the identity fields are known-good strings.
    const kind = body.kind as RegistryAssetKind;
    const namespace = body.namespace as string;
    const name = body.name as string;
    const version = body.version as string;
    const pk = publishPk(kind, namespace, name);

    // Auto-approve is a dev convenience gated on approver rights (REGISTRY.md §10).
    const autoApprove = event.queryStringParameters?.auto_approve === 'true' && isApprover;
    const status: RegistryAssetStatus = autoApprove ? 'approved' : 'submitted';
    const now = new Date().toISOString();

    // 1. Upload artifact (if the kind carries one). Keyed by the immutable
    //    (kind, ns, name, version) tuple; a 409 below prevents overwrite races
    //    for the DDB row, and the bucket is versioned so an artifact re-put is
    //    recoverable.
    let artifactRef: string | undefined;
    if (KINDS_REQUIRING_ARTIFACT.has(kind)) {
      artifactRef = artifactKey(kind, namespace, name, version);
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: artifactRef,
          Body: Buffer.from(body.artifact_b64 as string, 'base64'),
        }),
      );
    }

    // 2. Write the record with an immutability guard.
    const record: RegistryAssetRecord = {
      pk,
      sk: version,
      kind,
      namespace,
      name,
      version,
      descriptor: asDescriptor(body.descriptor),
      artifact_ref: artifactRef,
      status,
      publisher: userId,
      created_at: now,
      status_history: [{ status, actor: userId, at: now }],
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: record,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return errorResponse(
          409,
          ErrorCode.REGISTRY_VERSION_EXISTS,
          `${kind}/${namespace}/${name}@${version} already exists; publish a new version instead.`,
          requestId,
        );
      }
      throw err;
    }

    logger.info('registry asset published', {
      pk,
      version,
      status,
      publisher: userId,
      request_id: requestId,
    });

    return successResponse(
      201,
      {
        kind,
        namespace,
        name,
        version,
        status,
        artifact_ref: artifactRef,
        created_at: now,
      },
      requestId,
    );
  } catch (err) {
    logger.error('registry publish failed', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/** True when a DDB error is a ConditionalCheckFailedException (immutability hit). */
function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'ConditionalCheckFailedException'
  );
}
