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

// SPDX-License-Identifier: MIT-0

import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { ulid } from 'ulid';
import { logger } from './logger';
import { APPROVAL_AUDIT_TIMEOUT_MS, approvalPostCommitOptions, wakeMicrovmAfterApproval } from './microvm-approval-wake';
import { microvmErrorIdentity } from './microvm-control';

export interface DecisionPostCommitInput {
  readonly ddb: DynamoDBDocumentClient;
  readonly eventsTableName: string;
  readonly taskId: string;
  readonly callerUserId: string;
  readonly requestId: string;
  readonly decision: 'APPROVED' | 'DENIED';
  /** Decision-specific audit fields (approve: `scope`; deny: `reason`). */
  readonly auditMetadata: Record<string, unknown>;
  readonly decidedAt: string;
  readonly nowEpoch: number;
  readonly retentionDays: number;
  readonly invocationStartedMs: number;
  readonly context?: Pick<Context, 'getRemainingTimeInMillis'>;
}

/**
 * Shared approve/deny tail after the decision transaction commits: write the
 * `approval_decision_recorded` audit event, then attempt the optional MicroVM
 * wake. Neither step may fail the request — the human decision is already
 * committed on TaskApprovalsTable, and the durable supervisor recovers a
 * sleeping worker if the wake cannot finish here.
 */
export async function recordDecisionPostCommit(input: DecisionPostCommitInput): Promise<void> {
  const postCommit = approvalPostCommitOptions(input.invocationStartedMs, input.context);
  const ttl = input.nowEpoch + input.retentionDays * 86400;
  try {
    const abortSignal = AbortSignal.any([postCommit.abortSignal!, AbortSignal.timeout(APPROVAL_AUDIT_TIMEOUT_MS)]);
    abortSignal.throwIfAborted();
    await input.ddb.send(new PutCommand({
      TableName: input.eventsTableName,
      Item: {
        task_id: input.taskId,
        event_id: ulid(),
        event_type: 'approval_decision_recorded',
        timestamp: input.decidedAt,
        ttl,
        metadata: {
          request_id: input.requestId,
          status: input.decision,
          ...input.auditMetadata,
          decided_at: input.decidedAt,
          caller_user_id: input.callerUserId,
        },
      },
    }), { abortSignal });
  } catch (auditErr) {
    logger.warn('approval_decision_recorded audit write failed (decision already committed)', {
      task_id: input.taskId,
      request_id: input.requestId,
      ...microvmErrorIdentity(auditErr),
    });
  }

  try {
    await wakeMicrovmAfterApproval({
      taskId: input.taskId,
      userId: input.callerUserId,
      requestId: input.requestId,
      decision: input.decision,
      options: postCommit,
      emitEvent: async (eventType, metadata, options) => {
        options.abortSignal?.throwIfAborted();
        await input.ddb.send(new PutCommand({
          TableName: input.eventsTableName,
          Item: {
            task_id: input.taskId,
            user_id: input.callerUserId,
            event_id: ulid(),
            event_type: eventType,
            timestamp: new Date().toISOString(),
            ttl,
            metadata,
          },
        }), options);
      },
    });
  } catch (wakeError) {
    logger.warn('MicroVM wake helper failed after decision commit', {
      task_id: input.taskId, request_id: input.requestId, ...microvmErrorIdentity(wakeError),
    });
  }
}
