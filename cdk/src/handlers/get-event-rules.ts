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
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { listBuiltinEventRulePacks, resolveEventRules } from './shared/event-rule-pack-resolver';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { formatMinuteBucket, RATE_LIMIT_ROW_TTL_SECONDS } from './shared/rate-limit';
import { checkRepoOnboarded, loadRepoConfig } from './shared/repo-config';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { EventRule, GetEventRulesResponse } from './shared/types';
import { getWorkflowDescriptor } from './shared/workflows';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_APPROVALS_TABLE_NAME = process.env.TASK_APPROVALS_TABLE_NAME;
const POLICIES_RATE_LIMIT_PER_MINUTE = Number(process.env.POLICIES_RATE_LIMIT_PER_MINUTE ?? '30');

const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;
const cache = new Map<string, { response: GetEventRulesResponse; expiresAt: number }>();

function summarizeRule(rule: EventRule): {
  readonly rule_id: string;
  readonly on: string;
  readonly action: string;
  readonly mode: string;
  readonly evaluation: string;
  readonly reason?: string;
} {
  return {
    rule_id: rule.id,
    on: rule.on,
    action: rule.action,
    mode: rule.mode,
    evaluation: rule.evaluation,
    ...(rule.reason && { reason: rule.reason }),
  };
}

/**
 * GET /v1/repos/{repo_id}/event-rules — list resolved event governance rules.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const rawRepoId = event.pathParameters?.repo_id;
    if (!rawRepoId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing repo_id path parameter.', requestId);
    }
    const repoId = decodeURIComponent(rawRepoId);

    if (TASK_APPROVALS_TABLE_NAME) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const minuteBucket = formatMinuteBucket(new Date());
      try {
        await ddb.send(new UpdateCommand({
          TableName: TASK_APPROVALS_TABLE_NAME,
          Key: {
            task_id: `RATE#${userId}#EVENT_RULES`,
            request_id: `MINUTE#${minuteBucket}`,
          },
          UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': POLICIES_RATE_LIMIT_PER_MINUTE,
            ':ttl': nowEpoch + RATE_LIMIT_ROW_TTL_SECONDS,
          },
        }));
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        if (name === 'ConditionalCheckFailedException') {
          return errorResponse(
            429,
            ErrorCode.RATE_LIMIT_EXCEEDED,
            `Rate limit exceeded: at most ${POLICIES_RATE_LIMIT_PER_MINUTE} event-rules queries per minute.`,
            requestId,
          );
        }
        throw err;
      }
    }

    const cached = cache.get(repoId);
    if (cached && cached.expiresAt > Date.now()) {
      return successResponse(200, cached.response, requestId);
    }

    const onboardingResult = await checkRepoOnboarded(repoId);
    if (!onboardingResult.onboarded) {
      return errorResponse(
        422,
        ErrorCode.REPO_NOT_ONBOARDED,
        `Repository '${repoId}' is not onboarded. Register it with a Blueprint before querying event rules.`,
        requestId,
      );
    }

    const repoConfig = await loadRepoConfig(repoId);
    const workflowRef = event.queryStringParameters?.workflow_ref;
    const workflow = workflowRef ? getWorkflowDescriptor(workflowRef) : undefined;
    const packRef = repoConfig?.event_rule_pack ?? workflow?.eventRulePack;
    const resolved = resolveEventRules({
      inlineRules: repoConfig?.event_rules,
      packRef,
    });

    const response: GetEventRulesResponse = {
      repo_id: repoId,
      event_rule_pack: packRef,
      rules: resolved.map(summarizeRule),
      registry_packs: listBuiltinEventRulePacks(),
    };

    cache.set(repoId, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    return successResponse(200, response, requestId);
  } catch (err) {
    logger.error('get-event-rules failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/** Test seam — clear the in-memory response cache between cases. */
export function _resetCacheForTests(): void {
  cache.clear();
}
