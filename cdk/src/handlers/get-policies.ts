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
import {
  BUILTIN_HARD_DENY_POLICIES,
  BUILTIN_SOFT_DENY_POLICIES,
} from './shared/builtin-policies';
import { CedarPolicyParseError, concatPolicies, parseRules } from './shared/cedar-policy';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { formatMinuteBucket } from './shared/rate-limit';
import { checkRepoOnboarded, loadRepoConfig } from './shared/repo-config';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { GetPoliciesResponse, PolicyRuleSummary } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_APPROVALS_TABLE_NAME = process.env.TASK_APPROVALS_TABLE_NAME;
const POLICIES_RATE_LIMIT_PER_MINUTE = Number(process.env.POLICIES_RATE_LIMIT_PER_MINUTE ?? '30');

// In-Lambda cache keyed by repo; 5 minutes. Keeps repeated `bgagent
// policies list` calls snappy without hitting DDB + re-parsing the
// policy set every time. Cold starts throw the cache away.
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  readonly response: GetPoliciesResponse;
  readonly expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * GET /v1/repos/{repo_id}/policies — List Cedar rules for a repo (§7.6).
 *
 * Response combines the built-in hard/soft policy sets with any
 * `cedar_policies` the repo's blueprint has registered. Each rule is
 * rendered as a `{rule_id, category, severity?, approval_timeout_s?,
 * summary}` envelope.
 *
 * Rate-limited 30/min/user — generous for UX (`bgagent policies list`
 * is an interactive lookup) but bounded so a runaway script cannot
 * hammer the shared Cedar parser.
 *
 * `repo_id` is URL-decoded from the path parameter (`owner%2Frepo`
 * encoding is common in CLI UX).
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

    // Rate-limit. Uses a synthetic row on the approvals table keyed on
    // `RATE#<user_id>#POLICIES` to avoid colliding with the approve /
    // pending counters.
    if (TASK_APPROVALS_TABLE_NAME) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const minuteBucket = formatMinuteBucket(new Date());
      try {
        await ddb.send(new UpdateCommand({
          TableName: TASK_APPROVALS_TABLE_NAME,
          Key: {
            task_id: `RATE#${userId}#POLICIES`,
            request_id: `MINUTE#${minuteBucket}`,
          },
          UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': POLICIES_RATE_LIMIT_PER_MINUTE,
            ':ttl': nowEpoch + 120,
          },
        }));
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        if (name === 'ConditionalCheckFailedException') {
          return errorResponse(
            429,
            ErrorCode.RATE_LIMIT_EXCEEDED,
            `Rate limit exceeded: at most ${POLICIES_RATE_LIMIT_PER_MINUTE} policy-list queries per minute.`,
            requestId,
          );
        }
        throw err;
      }
    }

    // Onboarding gate — same shape as ``POST /tasks`` (see
    // ``create-task-core.ts::checkRepoOnboarded``). Originally this
    // endpoint was lenient (loaded RepoConfig best-effort, fell
    // through to built-ins on miss) on the theory that the built-in
    // policy set is public and there was no info-leak concern. E2E
    // testing surfaced the UX cost: users typo-ing a repo name get a
    // 200 response with full built-ins and mistake it for proof the
    // repo is onboarded. Behavior now matches the task-submit path —
    // 422 REPO_NOT_ONBOARDED for any repo without an active
    // RepoConfig row. The built-in set is still discoverable via any
    // onboarded repo (e.g. ``scoropeza/agent-plugins``).
    const onboardingResult = await checkRepoOnboarded(repoId);
    if (!onboardingResult.onboarded) {
      return errorResponse(
        422,
        ErrorCode.REPO_NOT_ONBOARDED,
        `Repository '${repoId}' is not onboarded. Register it with a Blueprint before querying policies.`,
        requestId,
      );
    }

    // Cache check. Per-repo TTL of 5 min (IMPL-note — does not include
    // user_id because the policy set is not user-specific). Cache
    // lookup happens AFTER the onboarding gate so a miss on
    // ``does-not-exist/foo`` doesn't pollute the cache with a
    // lookalike-to-a-real-repo response.
    const cached = cache.get(repoId);
    if (cached && cached.expiresAt > Date.now()) {
      return successResponse(200, cached.response, requestId);
    }

    // Load blueprint config (optional — repos without custom policies
    // still get the built-in set).
    let blueprintCedarPolicies: readonly string[] = [];
    try {
      const repoConfig = await loadRepoConfig(repoId);
      if (repoConfig) {
        blueprintCedarPolicies = repoConfig.cedar_policies ?? [];
      }
    } catch (configErr) {
      logger.warn('Could not load repo config for policies endpoint — continuing with built-ins', {
        repo_id: repoId,
        error: configErr instanceof Error ? configErr.message : String(configErr),
      });
    }

    const blueprintText = blueprintCedarPolicies.join('\n');
    const hardText = BUILTIN_HARD_DENY_POLICIES;
    const softText = concatPolicies(BUILTIN_SOFT_DENY_POLICIES, blueprintText);

    let hardRules;
    let softRules;
    try {
      hardRules = parseRules(hardText);
      softRules = parseRules(softText);
    } catch (err) {
      if (err instanceof CedarPolicyParseError) {
        logger.error('Cedar parse failure for repo policies', {
          repo_id: repoId,
          message: err.message,
        });
        return errorResponse(
          503,
          ErrorCode.SERVICE_UNAVAILABLE,
          'Policy set for this repo is currently invalid.',
          requestId,
        );
      }
      throw err;
    }

    const response: GetPoliciesResponse = {
      repo_id: repoId,
      policies: {
        hard: hardRules
          .filter((r) => r.tier === 'hard')
          .map(toSummary),
        soft: softRules
          .filter((r) => r.tier === 'soft')
          .map(toSummary),
      },
    };

    cache.set(repoId, {
      response,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return successResponse(200, response, requestId);
  } catch (err) {
    logger.error('Failed to list policies', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

function toSummary(rule: ReturnType<typeof parseRules>[number]): PolicyRuleSummary {
  const out: {
    -readonly [K in keyof PolicyRuleSummary]?: PolicyRuleSummary[K];
  } = {
    rule_id: rule.rule_id,
    summary: rule.summary,
  };
  if (rule.category) out.category = rule.category;
  if (rule.severity) out.severity = rule.severity;
  if (rule.approval_timeout_s) out.approval_timeout_s = rule.approval_timeout_s;
  return out as PolicyRuleSummary;
}

/** Test-only cache reset — exposed for unit tests. */
export function _resetCacheForTests(): void {
  cache.clear();
}
