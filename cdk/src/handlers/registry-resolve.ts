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

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { artifactKey, KINDS_REQUIRING_ARTIFACT } from './shared/registry-descriptor';
import {
  parseRef,
  RegistryResolutionError,
  resolveRef,
} from './shared/registry-resolver';
import { ErrorCode, errorResponse, successResponse } from './shared/response';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.REGISTRY_ARTIFACTS_BUCKET_NAME!;

/** Presigned artifact URL lifetime (seconds). */
const ARTIFACT_URL_TTL_SECONDS = 300;

/**
 * GET /v1/registry/resolve?ref=registry://... — resolve a ref to a pinned
 * asset (REGISTRY.md §4.2). Returns the descriptor, the concrete version, a
 * short-lived presigned artifact URL (for kinds with an artifact), and any
 * warnings. Fails 422 with a specific reason on any unresolved ref.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // Resolve/read is available to any authenticated caller (REGISTRY.md §10).
    if (!extractUserId(event)) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const ref = event.queryStringParameters?.ref;
    if (!ref) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Query parameter "ref" is required.', requestId);
    }

    let resolved;
    try {
      resolved = await resolveRef(ref);
    } catch (err) {
      if (err instanceof RegistryResolutionError) {
        return errorResponse(
          422,
          ErrorCode.REGISTRY_RESOLUTION_FAILED,
          `Could not resolve ${ref}: ${err.reason}.`,
          requestId,
        );
      }
      throw err;
    }

    // Presign the artifact for kinds that have one, so a caller can fetch bytes
    // directly without a second round-trip.
    let artifactUrl: string | undefined;
    if (KINDS_REQUIRING_ARTIFACT.has(resolved.kind)) {
      const key = artifactKey(resolved.kind, resolved.namespace, resolved.name, resolved.version);
      artifactUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
        { expiresIn: ARTIFACT_URL_TTL_SECONDS },
      );
    }

    logger.info('registry ref resolved via API', {
      ref,
      version: resolved.version,
      warnings: resolved.warnings,
      request_id: requestId,
    });

    return successResponse(200, { ...resolved, artifact_url: artifactUrl }, requestId);
  } catch (err) {
    logger.error('registry resolve failed', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

// parseRef is imported to keep the grammar entry point discoverable alongside
// the handler; the resolver uses it internally. Re-export for callers/tests.
export { parseRef };
