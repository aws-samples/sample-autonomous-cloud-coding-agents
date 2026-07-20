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

const USER_MAPPING_TABLE = process.env.JIRA_USER_MAPPING_TABLE_NAME!;

interface LinkRequest {
  readonly code: string;
  /** Preview-only: return what would be linked without writing. */
  readonly dry_run?: boolean;
}

/**
 * POST /v1/jira/link — Complete Jira account linking, or preview it.
 *
 * Called from the CLI (`bgagent jira link <code>`) with a Cognito JWT.
 * Looks up the pending link record. With `dry_run: true`, returns the
 * Jira identity attached to the code without writing — the CLI uses
 * this to render a "you're about to link X" preview before the user
 * confirms. Without `dry_run`, writes the mapping and deletes the
 * pending record.
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

    // Codes from `bgagent jira invite-user` are case-sensitive (kebab-case
    // with a lowercase hex suffix); don't uppercase the incoming value.
    const code = body.code.trim();

    const pending = await ddb.send(new GetCommand({
      TableName: USER_MAPPING_TABLE,
      Key: { jira_identity: `pending#${code}` },
    }));

    if (!pending.Item || pending.Item.status !== 'pending') {
      return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Invalid or expired link code.', requestId);
    }

    const cloudId = pending.Item.jira_cloud_id as string;
    const siteUrl = (pending.Item.jira_site_url as string | undefined) ?? '';
    const jiraAccountId = pending.Item.jira_account_id as string;
    const jiraUserName = (pending.Item.jira_user_name as string | undefined) ?? '';
    const jiraUserEmail = (pending.Item.jira_user_email as string | undefined) ?? '';

    // Dry-run preview: return identity without writing.
    if (body.dry_run === true) {
      return successResponse(200, {
        dry_run: true,
        jira_cloud_id: cloudId,
        jira_site_url: siteUrl,
        jira_account_id: jiraAccountId,
        jira_user_name: jiraUserName,
        jira_user_email: jiraUserEmail,
      }, requestId);
    }

    const now = new Date().toISOString();

    await ddb.send(new PutCommand({
      TableName: USER_MAPPING_TABLE,
      Item: {
        jira_identity: `${cloudId}#${jiraAccountId}`,
        platform_user_id: userId,
        jira_cloud_id: cloudId,
        jira_account_id: jiraAccountId,
        linked_at: now,
        status: 'active',
        link_method: 'cli',
      },
    }));

    await ddb.send(new DeleteCommand({
      TableName: USER_MAPPING_TABLE,
      Key: { jira_identity: `pending#${code}` },
    }));

    logger.info('Jira account linked', {
      platform_user_id: userId,
      jira_cloud_id: cloudId,
      jira_account_id: jiraAccountId,
    });

    return successResponse(200, {
      message: 'Jira account linked successfully.',
      jira_cloud_id: cloudId,
      jira_site_url: siteUrl,
      jira_account_id: jiraAccountId,
      jira_user_name: jiraUserName,
      jira_user_email: jiraUserEmail,
      linked_at: now,
    }, requestId);
  } catch (err) {
    logger.error('Jira link handler failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
