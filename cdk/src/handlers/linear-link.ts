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
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { parseBody } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_MAPPING_TABLE = process.env.LINEAR_USER_MAPPING_TABLE_NAME!;

interface LinkRequest {
  readonly code: string;
  /** Preview-only: return what would be linked without writing. */
  readonly dry_run?: boolean;
}

/**
 * POST /v1/linear/link — Complete Linear account linking, or preview it.
 *
 * Called from the CLI (`bgagent linear link <code>`) with a Cognito JWT.
 * Looks up the pending link record. With `dry_run: true`, returns the
 * Linear identity attached to the code without writing — the CLI uses
 * this to render a "you're about to link X (email: Y)" preview before
 * the teammate confirms. Without `dry_run`, writes the mapping and
 * deletes the pending record.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Authentication required.', requestId);
    }

    const body = parseBody<LinkRequest>(event.body ?? null);
    if (!body?.code) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must include a "code" field.', requestId);
    }

    // Codes from `bgagent linear invite-user` are case-sensitive
    // (see generateInviteCode in the CLI — `link-<8-char-hex>` shape,
    // hex is lowercase). Don't uppercase the incoming value — that
    // would break codes generated post-2.0b.
    const code = body.code.trim();

    const pending = await ddb.send(new GetCommand({
      TableName: USER_MAPPING_TABLE,
      Key: { linear_identity: `pending#${code}` },
    }));

    if (!pending.Item || pending.Item.status !== 'pending') {
      return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Invalid or expired link code.', requestId);
    }

    const workspaceId = pending.Item.linear_workspace_id as string;
    const workspaceSlug = (pending.Item.linear_workspace_slug as string | undefined) ?? '';
    const linearUserId = pending.Item.linear_user_id as string;
    const linearUserName = (pending.Item.linear_user_name as string | undefined) ?? '';
    const linearUserEmail = (pending.Item.linear_user_email as string | undefined) ?? '';

    // Dry-run preview: return identity without writing.
    if (body.dry_run === true) {
      return successResponse(200, {
        dry_run: true,
        linear_workspace_id: workspaceId,
        linear_workspace_slug: workspaceSlug,
        linear_user_id: linearUserId,
        linear_user_name: linearUserName,
        linear_user_email: linearUserEmail,
      }, requestId);
    }

    const now = new Date().toISOString();

    await ddb.send(new PutCommand({
      TableName: USER_MAPPING_TABLE,
      Item: {
        linear_identity: `${workspaceId}#${linearUserId}`,
        platform_user_id: userId,
        linear_workspace_id: workspaceId,
        linear_user_id: linearUserId,
        linked_at: now,
        status: 'active',
        link_method: 'cli',
      },
    }));

    await ddb.send(new DeleteCommand({
      TableName: USER_MAPPING_TABLE,
      Key: { linear_identity: `pending#${code}` },
    }));

    logger.info('Linear account linked', {
      platform_user_id: userId,
      linear_workspace_id: workspaceId,
      linear_user_id: linearUserId,
    });

    return successResponse(200, {
      message: 'Linear account linked successfully.',
      linear_workspace_id: workspaceId,
      linear_workspace_slug: workspaceSlug,
      linear_user_id: linearUserId,
      linear_user_name: linearUserName,
      linear_user_email: linearUserEmail,
      linked_at: now,
    }, requestId);
  } catch (err) {
    logger.error('Linear link handler failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
