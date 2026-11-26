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

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './gateway';
import { logger } from './logger';
import { ErrorCode, errorResponse, successResponse } from './response';
import { makeDocClient } from './ua';
import { parseBody } from './validation';

const ddb = makeDocClient();

/** What differs between the account-link handlers of the surfaces. */
export interface LinkSpec {
  /** The surface's name in the log lines and in the success message. */
  readonly surface: string;
  readonly tableName: string;
  /** Partition key of the user-mapping table. */
  readonly identityAttr: string;
  /** Attribute of the workspace, site or team. The mapping's key is `<tenant>#<user>`. */
  readonly tenantAttr: string;
  /** Attribute of the surface's user id. */
  readonly userAttr: string;
  /** Attributes of the pending row that the response returns, in this order. */
  readonly responseAttrs: readonly string[];
  /** Fixed attributes of the mapping row. */
  readonly mappingExtras: Readonly<Record<string, string>>;
  /** Whether `dry_run: true` in the body previews the identity without linking. */
  readonly dryRun: boolean;
  readonly upperCaseCode: boolean;
}

/**
 * The handler of `POST /v1/<surface>/link`: the signed-in user redeems a pending link
 * code. It maps the surface identity stored with the code to that user and deletes the
 * pending row.
 */
export function makeLinkHandler(spec: LinkSpec): (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult> {
  return async (event) => {
    const requestId = ulid();

    try {
      const userId = extractUserId(event);
      if (!userId) {
        return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Authentication required.', requestId);
      }

      const body = parseBody<{ code: string; dry_run?: boolean }>(event.body ?? null);
      if (typeof body?.code !== 'string' || !body.code) {
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must include a "code" field.', requestId);
      }

      const code = spec.upperCaseCode ? body.code.trim().toUpperCase() : body.code.trim();
      const pendingKey = { [spec.identityAttr]: `pending#${code}` };

      const pending = (await ddb.send(new GetCommand({ TableName: spec.tableName, Key: pendingKey, ConsistentRead: true }))).Item;

      // DynamoDB TTL deletes lazily, so an expired code can still be in the table.
      if (!pending || pending.status !== 'pending'
        || typeof pending.ttl !== 'number' || pending.ttl < Math.floor(Date.now() / 1000)) {
        return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Invalid or expired link code.', requestId);
      }

      const tenant = pending[spec.tenantAttr] as string;
      const user = pending[spec.userAttr] as string;
      const fields = Object.fromEntries(spec.responseAttrs.map(
        (attr) => [attr, attr === spec.tenantAttr || attr === spec.userAttr ? pending[attr] : (pending[attr] ?? '')],
      ));

      if (spec.dryRun && body.dry_run === true) {
        return successResponse(200, { dry_run: true, ...fields }, requestId);
      }

      const now = new Date().toISOString();

      await ddb.send(new PutCommand({
        TableName: spec.tableName,
        Item: {
          [spec.identityAttr]: `${tenant}#${user}`,
          platform_user_id: userId,
          [spec.tenantAttr]: tenant,
          [spec.userAttr]: user,
          linked_at: now,
          ...spec.mappingExtras,
        },
      }));

      await ddb.send(new DeleteCommand({ TableName: spec.tableName, Key: pendingKey }));

      logger.info(`${spec.surface} account linked`, {
        platform_user_id: userId,
        [spec.tenantAttr]: tenant,
        [spec.userAttr]: user,
      });

      return successResponse(200, { message: `${spec.surface} account linked successfully.`, ...fields, linked_at: now }, requestId);
    } catch (err) {
      logger.error(`${spec.surface} link handler failed`, {
        error: err instanceof Error ? err.message : String(err),
        request_id: requestId,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
    }
  };
}
