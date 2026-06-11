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

import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { logger } from './logger';
import { formatMinuteBucket } from './rate-limit';
import type { ApprovalScope } from './types';

/**
 * Core Cedar HITL approve/deny decision logic, shared by the HTTP
 * handlers (`approve-task.ts` / `deny-task.ts`) and the Slack
 * interactions handler (issue #112 — Slack-button approvals).
 *
 * Encapsulates exactly the parts that MUST behave identically no matter
 * which surface the decision arrives from:
 *
 *   1. Per-user per-minute rate limit (shared approve+deny counter).
 *   2. Atomic cross-table `TransactWriteItems`:
 *        - approval row `PENDING → APPROVED|DENIED`, guarded by
 *          ownership (`user_id = :caller`) AND `status = PENDING`;
 *        - no-op TaskTable update guarded by
 *          `status = AWAITING_APPROVAL AND awaiting_approval_request_id`.
 *   3. `approval_decision_recorded` audit event (best-effort).
 *
 * Deliberately NOT here (caller-owned, surface-specific):
 *   - authentication (Cognito JWT vs Slack signature + user mapping),
 *   - body validation, scope parsing, deny-reason secret-scanning,
 *   - response rendering (HTTP status codes vs Slack ephemeral text),
 *   - severity gating (Slack-only constraint — §11.2 finding #4).
 */

/** Outcome of a decision attempt, surface-agnostic. Callers map these
 *  to HTTP responses or Slack ephemeral messages. */
export type ApprovalDecisionOutcome =
  /** Decision committed; `decidedAt` is the transaction timestamp. */
  | { readonly kind: 'ok'; readonly decidedAt: string }
  /** Per-user per-minute approve+deny budget exhausted. */
  | { readonly kind: 'rate_limited'; readonly limit: number }
  /**
   * Approval row missing, owned by a different user, or already
   * decided. Collapsed into one outcome per §7.1 finding #6 — callers
   * must NOT distinguish these (existence oracle).
   */
  | { readonly kind: 'not_found' }
  /** Task row condition failed — not awaiting approval for this request. */
  | { readonly kind: 'not_awaiting' }
  /** Transaction cancelled for a reason we can't classify. */
  | { readonly kind: 'transaction_unknown' };

export interface ApprovalDecisionInput {
  readonly taskId: string;
  /** The approval request id (`request_id` on the approvals row). */
  readonly requestId: string;
  /** Platform user id the decision is attributed to (ownership-checked). */
  readonly callerUserId: string;
  readonly decision: 'approve' | 'deny';
  /** Approve-only. Callers validate via `parseApprovalScope` first. */
  readonly scope?: ApprovalScope;
  /** Deny-only. Callers run `scanDenyReason` + truncate BEFORE passing. */
  readonly sanitizedReason?: string;
}

export interface ApprovalDecisionConfig {
  readonly taskTableName: string;
  readonly approvalsTableName: string;
  readonly eventsTableName: string;
  readonly rateLimitPerMinute: number;
  readonly auditRetentionDays: number;
}

/** Build the config from the standard env vars the approval handlers
 *  already require. Throws when a required var is absent so a broken
 *  deployment fails loudly at first use. */
export function approvalDecisionConfigFromEnv(): ApprovalDecisionConfig {
  const taskTableName = process.env.TASK_TABLE_NAME;
  const approvalsTableName = process.env.TASK_APPROVALS_TABLE_NAME;
  const eventsTableName = process.env.TASK_EVENTS_TABLE_NAME;
  if (!taskTableName || !approvalsTableName || !eventsTableName) {
    throw new Error(
      'approval decision requires TASK_TABLE_NAME, TASK_APPROVALS_TABLE_NAME, and TASK_EVENTS_TABLE_NAME env vars',
    );
  }
  return {
    taskTableName,
    approvalsTableName,
    eventsTableName,
    rateLimitPerMinute: Number(process.env.APPROVE_RATE_LIMIT_PER_MINUTE ?? '30'),
    auditRetentionDays: Number(process.env.TASK_RETENTION_DAYS ?? '90'),
  };
}

/**
 * Record an approve/deny decision atomically. See module docstring for
 * the invariants. Never throws for the classified 4xx-equivalent
 * outcomes; infra errors (DDB unavailable, throttle outside the
 * transaction) propagate to the caller's 500 path.
 */
export async function processApprovalDecision(
  ddb: DynamoDBDocumentClient,
  config: ApprovalDecisionConfig,
  input: ApprovalDecisionInput,
): Promise<ApprovalDecisionOutcome> {
  const { taskId, requestId, callerUserId, decision } = input;
  const nowIso = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);

  // 1. Per-user per-minute rate limit. Synthetic row in the approvals
  // table keyed `RATE#<user_id>#APPROVE` / `MINUTE#<bucket>` — approve
  // and deny share the counter so the combined budget is the limit.
  const minuteBucket = formatMinuteBucket(new Date());
  try {
    await ddb.send(new UpdateCommand({
      TableName: config.approvalsTableName,
      Key: {
        task_id: `RATE#${callerUserId}#APPROVE`,
        request_id: `MINUTE#${minuteBucket}`,
      },
      UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':one': 1,
        ':max': config.rateLimitPerMinute,
        ':ttl': nowEpoch + 120,
      },
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'ConditionalCheckFailedException') {
      return { kind: 'rate_limited', limit: config.rateLimitPerMinute };
    }
    throw err;
  }

  // 2. Cross-table atomic transition (§7.1 / §7.2 pseudocode).
  interface ApprovalUpdateShape {
    readonly UpdateExpression: string;
    readonly ExpressionAttributeNames: Record<string, string>;
    readonly ExpressionAttributeValues: Record<string, unknown>;
  }
  const approvalUpdate: ApprovalUpdateShape = decision === 'approve'
    ? {
      UpdateExpression: 'SET #status = :decided, decided_at = :now, #scope = :scope',
      ExpressionAttributeNames: { '#status': 'status', '#scope': 'scope' },
      ExpressionAttributeValues: {
        ':decided': 'APPROVED',
        ':pending': 'PENDING',
        ':now': nowIso,
        ':scope': input.scope ?? 'this_call',
        ':caller': callerUserId,
      },
    }
    : {
      UpdateExpression: 'SET #status = :decided, decided_at = :now, deny_reason = :reason',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':decided': 'DENIED',
        ':pending': 'PENDING',
        ':now': nowIso,
        ':reason': input.sanitizedReason ?? '',
        ':caller': callerUserId,
      },
    };

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: config.approvalsTableName,
            Key: { task_id: taskId, request_id: requestId },
            ConditionExpression:
              'attribute_exists(request_id) AND #status = :pending AND user_id = :caller',
            ...approvalUpdate,
          },
        },
        {
          Update: {
            TableName: config.taskTableName,
            Key: { task_id: taskId },
            // No-op update on TaskTable; the purpose is the condition guard.
            UpdateExpression: 'SET last_decision_at = :now',
            ConditionExpression:
              '#status = :awaiting AND awaiting_approval_request_id = :rid',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':awaiting': 'AWAITING_APPROVAL',
              ':rid': requestId,
              ':now': nowIso,
            },
          },
        },
      ],
    }));
  } catch (err: unknown) {
    if (err instanceof TransactionCanceledException) {
      return classifyCancel(err);
    }
    throw err;
  }

  // 3. Audit event (IMPL-6). Failure to write the audit is logged but
  // does not fail the decision — it is already committed and the agent
  // will see it on its next poll regardless.
  const auditMetadata: Record<string, unknown> = decision === 'approve'
    ? {
      request_id: requestId,
      status: 'APPROVED',
      scope: input.scope ?? 'this_call',
      decided_at: nowIso,
      caller_user_id: callerUserId,
    }
    : {
      request_id: requestId,
      status: 'DENIED',
      reason: input.sanitizedReason ?? '',
      decided_at: nowIso,
      caller_user_id: callerUserId,
    };
  try {
    await ddb.send(new PutCommand({
      TableName: config.eventsTableName,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'approval_decision_recorded',
        timestamp: nowIso,
        ttl: nowEpoch + config.auditRetentionDays * 86400,
        metadata: auditMetadata,
      },
    }));
  } catch (auditErr) {
    logger.warn('approval_decision_recorded audit write failed (decision already committed)', {
      task_id: taskId,
      request_id: requestId,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  return { kind: 'ok', decidedAt: nowIso };
}

/**
 * Map a `TransactionCanceledException` to the surface-agnostic outcome.
 *
 * Per §7.1, the cancellation reasons are per-item (index 0 is the
 * approvals-row Update, index 1 is the task-row Update). DDB does not
 * say which sub-clause of a `ConditionExpression` failed, so the
 * approvals-row failure collapses {missing, wrong owner, already
 * decided} into `not_found` to prevent the existence oracle
 * (§7.1 finding #6).
 */
function classifyCancel(err: TransactionCanceledException): ApprovalDecisionOutcome {
  const reasons = err.CancellationReasons ?? [];
  if (reasons[0]?.Code === 'ConditionalCheckFailed') {
    return { kind: 'not_found' };
  }
  if (reasons[1]?.Code === 'ConditionalCheckFailed') {
    return { kind: 'not_awaiting' };
  }
  return { kind: 'transaction_unknown' };
}
