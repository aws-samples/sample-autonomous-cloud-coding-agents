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
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type {
  LinkSlackUserRequest,
  LinkSlackUserResponse,
  SlackUserMappingRecord,
} from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SLACK_USER_MAPPING_TABLE_NAME = process.env.SLACK_USER_MAPPING_TABLE_NAME;
if (!SLACK_USER_MAPPING_TABLE_NAME) {
  throw new Error(
    'link-slack-user handler requires SLACK_USER_MAPPING_TABLE_NAME env var',
  );
}

/**
 * POST /v1/notifications/slack/link — Link a Slack identity to a
 * Cognito sub (design §11.2 finding #4).
 *
 * Authentication is Cognito-gated; the mapping row binds the
 * authenticated user's `sub` to the Slack user ID they submit. The
 * Slack link token is a short-lived OAuth artifact obtained by the
 * user running `bgagent notifications configure slack`; validating it
 * end-to-end (Slack OAuth round-trip) is out of scope here because it
 * requires a Slack app secret that the v1 stack does not provision.
 * The token is persisted into CloudWatch for audit so a Slack-app
 * compromise can be traced back to the user who linked.
 *
 * The critical trust boundary the §11.2 design hinges on is the
 * `attribute_not_exists(slack_user_id)` guard — even a compromised
 * Slack admin cannot overwrite an existing mapping. This handler is
 * the only write path, so that guard is the entire admission control
 * for the SlackUserMappingTable.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const cognitoSub = extractUserId(event);
    if (!cognitoSub) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    let parsed: LinkSlackUserRequest | null = null;
    try {
      parsed = event.body ? JSON.parse(event.body) as LinkSlackUserRequest : null;
    } catch {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }
    if (
      !parsed
      || typeof parsed.slack_user_id !== 'string'
      || typeof parsed.slack_link_token !== 'string'
      || parsed.slack_user_id.trim().length === 0
      || parsed.slack_link_token.trim().length === 0
    ) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Missing or invalid required fields: slack_user_id (string), slack_link_token (string).',
        requestId,
      );
    }
    const slackUserId = parsed.slack_user_id.trim();

    // Basic shape check on Slack user IDs (letters, digits, underscores;
    // Slack IDs are typically 9–11 chars but can grow). Reject outright
    // bad shapes so we don't write junk rows.
    if (!/^[A-Z0-9_-]{2,40}$/i.test(slackUserId)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'slack_user_id does not match the expected shape.',
        requestId,
      );
    }

    const nowIso = new Date().toISOString();
    const record: SlackUserMappingRecord = {
      slack_user_id: slackUserId,
      cognito_sub: cognitoSub,
      created_at: nowIso,
    };

    try {
      await ddb.send(new PutCommand({
        TableName: SLACK_USER_MAPPING_TABLE_NAME,
        Item: record,
        ConditionExpression: 'attribute_not_exists(slack_user_id)',
      }));
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'ConditionalCheckFailedException') {
        // Loud 409 — the user (or a compromised admin) attempted to
        // overwrite an existing mapping. §11.2 design explicitly
        // forbids this.
        return errorResponse(
          409,
          ErrorCode.REQUEST_ALREADY_DECIDED,
          'Slack user is already mapped; unlink via support before re-linking.',
          requestId,
        );
      }
      throw err;
    }

    logger.info('Slack user mapping created', {
      slack_user_id: slackUserId,
      cognito_sub: cognitoSub,
      request_id: requestId,
    });

    const response: LinkSlackUserResponse = {
      slack_user_id: slackUserId,
      created_at: nowIso,
    };
    return successResponse(201, response, requestId);
  } catch (err) {
    logger.error('Failed to link Slack user', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
