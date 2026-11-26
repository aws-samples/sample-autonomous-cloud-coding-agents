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

import { type DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

export type ReplyClaimOutcome =
  /** This caller owns the reply and must post it (or release the claim). */
  | { readonly won: true; readonly stamp: string }
  /**
   * Another caller already owns it (a redelivery of the same event), or the
   * claim write itself failed. Either way this caller must not reply.
   */
  | { readonly won: false };

/**
 * Claim the right to write a task's terminal reply, exactly once.
 *
 * ``stamp`` is recorded so {@link releaseReplyClaim} can prove the claim it
 * removes is still the one this caller made.
 */
export async function claimTerminalReply(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
  stamp: string,
): Promise<ReplyClaimOutcome> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: taskId },
      UpdateExpression: 'SET ack_replied_at = :now',
      ConditionExpression: 'attribute_not_exists(ack_replied_at)',
      ExpressionAttributeValues: { ':now': stamp },
    }));
    return { won: true, stamp };
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') {
      logger.warn('Terminal-reply claim write failed — not replying', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { won: false };
  }
}

/** How many times a failed terminal reply may be re-attempted. */
export const MAX_REPLY_ATTEMPTS = 3;

export type ReplyReleaseOutcome =
  /** The claim is free again; a redelivery may re-attempt the reply. */
  | 'released'
  /**
   * The retry budget is spent, so the claim was deliberately KEPT — no further
   * attempt will be made. The caller must still convey the outcome some other
   * way (the reaction on the trigger comment).
   */
  | 'exhausted'
  /** The claim is no longer this caller's, so another delivery owns the reply. */
  | 'not_ours';

/**
 * Give the claim back after failing to write the reply, so a later delivery of
 * the same event can try again — up to {@link MAX_REPLY_ATTEMPTS}.
 *
 * Conditional on the exact stamp this caller wrote. Never throws.
 */
export async function releaseReplyClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
  stamp: string,
): Promise<ReplyReleaseOutcome> {
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: taskId },
      UpdateExpression: 'REMOVE ack_replied_at SET ack_reply_attempts = if_not_exists(ack_reply_attempts, :zero) + :one',
      ConditionExpression:
        'ack_replied_at = :ours AND (attribute_not_exists(ack_reply_attempts) OR ack_reply_attempts < :max)',
      ExpressionAttributeValues: {
        ':ours': stamp, ':zero': 0, ':one': 1, ':max': MAX_REPLY_ATTEMPTS,
      },
      ReturnValues: 'UPDATED_NEW',
    }));
    logger.info('Released the terminal-reply claim after a failed reply — a retry may re-attempt', {
      task_id: taskId,
      attempt: (res.Attributes as { ack_reply_attempts?: number } | undefined)?.ack_reply_attempts,
      max_attempts: MAX_REPLY_ATTEMPTS,
    });
    return 'released';
  } catch (err) {
    const conditional = (err as { name?: string })?.name === 'ConditionalCheckFailedException';
    if (conditional) {
      const spent = await attemptsExhausted(ddb, tableName, taskId);
      if (spent) {
        logger.error('Giving up on a terminal reply after repeated failures — settling without it', {
          event: 'iteration_reply.attempts_exhausted',
          task_id: taskId,
          max_attempts: MAX_REPLY_ATTEMPTS,
        });
        return 'exhausted';
      }
      logger.info('Terminal-reply claim is no longer ours — another delivery owns the reply', {
        task_id: taskId,
      });
      return 'not_ours';
    }
    logger.warn('Could not release the terminal-reply claim', {
      event: 'iteration_reply.claim_release_failed',
      task_id: taskId,
      claim_no_longer_ours: conditional,
      ...(conditional ? {} : { error: err instanceof Error ? err.message : String(err) }),
    });
    return 'exhausted';
  }
}

async function attemptsExhausted(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
): Promise<boolean> {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { task_id: taskId },
      ProjectionExpression: 'ack_reply_attempts',
      ConsistentRead: true,
    }));
    const attempts = (res.Item as { ack_reply_attempts?: number } | undefined)?.ack_reply_attempts ?? 0;
    return attempts >= MAX_REPLY_ATTEMPTS;
  } catch {
    return true;
  }
}

/**
 * Has a terminal reply already been claimed for this task? Read
 * strongly-consistent. Fails OPEN (false) on a read error.
 *
 * The marker is stamped just BEFORE the reply it announces is rendered, so it
 * is necessary but not sufficient — the surface also compares the current body
 * (see the ``skipIfSettled`` reply option).
 */
export async function terminalReplyClaimed(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
): Promise<boolean> {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { task_id: taskId },
      ProjectionExpression: 'ack_replied_at',
      ConsistentRead: true,
    }));
    return Boolean((res.Item as { ack_replied_at?: string } | undefined)?.ack_replied_at);
  } catch (err) {
    logger.warn('Could not check whether the terminal reply already landed', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
