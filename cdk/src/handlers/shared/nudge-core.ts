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

import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { GuardrailScreeningError, screenWithGuardrail } from './context-hydration';
import { formatMinuteBucket } from './rate-limit';
import type { NudgeRecord } from './types';

/** TTL for stored nudge rows (days). */
const NUDGE_RETENTION_DAYS = 30;
const NUDGE_RETENTION_SECONDS = NUDGE_RETENTION_DAYS * 86400;
/** TTL for rate-limit counter rows (~2 minutes — only need the current minute bucket). */
const RATE_LIMIT_ROW_TTL_SECONDS = 120;

/** Outcome of {@link submitNudge}. Every non-``accepted`` kind is a refusal the caller must surface. */
export type SubmitNudgeResult =
  | { readonly kind: 'accepted'; readonly nudgeId: string; readonly submittedAt: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rate_limited'; readonly limitPerMinute: number }
  | { readonly kind: 'screening_unavailable'; readonly error: string };

export interface SubmitNudgeParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly nudgesTableName: string;
  readonly taskId: string;
  readonly userId: string;
  /** Already trimmed and length-validated by the caller. */
  readonly message: string;
  readonly rateLimitPerMinute: number;
}

/**
 * Screen → rate-limit → persist a steering message for a running task. The
 * agent runtime consumes it at its next between-turns seam.
 *
 * Shared by the REST nudge handler and the Linear agent-session ``prompted``
 * path so both entry points enforce the same guardrail (fail-closed) and the
 * same per-task per-minute budget. Ownership and task-state checks stay with
 * the caller — they differ per entry point (Cognito user vs. linked Linear
 * actor). Guardrail screening runs BEFORE the rate-limit counter so a blocked
 * message does not consume a slot.
 *
 * Throws only on unexpected DynamoDB errors.
 */
export async function submitNudge(params: SubmitNudgeParams): Promise<SubmitNudgeResult> {
  const { ddb, nudgesTableName, taskId, userId, message, rateLimitPerMinute } = params;
  const now = new Date();
  const nowIso = now.toISOString();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  try {
    const screenResult = await screenWithGuardrail(message, taskId);
    if (screenResult?.action === 'GUARDRAIL_INTERVENED') {
      const details = screenResult.assessments
        ?.map(a => `${a.filter_type}/${a.filter_name}${a.confidence ? ` (${a.confidence})` : ''}`)
        .join(', ');
      return { kind: 'blocked', reason: `Nudge message blocked by content policy${details ? ': ' + details : ''}` };
    }
  } catch (err) {
    if (err instanceof GuardrailScreeningError) {
      return { kind: 'screening_unavailable', error: err.message };
    }
    throw err;
  }

  // Per-task per-minute rate limit: a synthetic row in the nudges table
  // (PK = `RATE#<task_id>`, SK = `MINUTE#<yyyymmddhhmm>`) with a short TTL.
  try {
    await ddb.send(new UpdateCommand({
      TableName: nudgesTableName,
      Key: {
        task_id: `RATE#${taskId}`,
        nudge_id: `MINUTE#${formatMinuteBucket(now)}`,
      },
      UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':one': 1,
        ':max': rateLimitPerMinute,
        ':ttl': nowEpoch + RATE_LIMIT_ROW_TTL_SECONDS,
      },
    }));
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return { kind: 'rate_limited', limitPerMinute: rateLimitPerMinute };
    }
    throw err;
  }

  const nudgeId = ulid();
  const nudgeRecord: NudgeRecord = {
    task_id: taskId,
    nudge_id: nudgeId,
    user_id: userId,
    message,
    created_at: nowIso,
    consumed: false,
    ttl: nowEpoch + NUDGE_RETENTION_SECONDS,
  };
  await ddb.send(new PutCommand({
    TableName: nudgesTableName,
    Item: nudgeRecord,
  }));
  return { kind: 'accepted', nudgeId, submittedAt: nowIso };
}
