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

/**
 * The once-only claim on a comment-iteration's terminal reply.
 *
 * One maturing reply per iteration matures 👀 → 🔄 → ✅/💬/❌, and three
 * independent writers edit it: the terminal settle (the reconciler for an
 * orchestration iteration, the fan-out dispatcher for a standalone one), the
 * progress milestone, and the liveness heartbeat. Their stream records are
 * redelivered — the cascade source's was observed arriving 3× live — so the
 * terminal writers coordinate through a single conditional attribute on the
 * iteration task's own record: whoever writes ``ack_replied_at`` first owns the
 * reply, and the losers skip.
 *
 * That protocol lived as copy-pasted conditional expressions in each writer,
 * where one of them dropping a step went unnoticed: a terminal writer claimed,
 * its edit failed, and the claim stayed taken — so no redelivery could retry it
 * AND the progress writers read the claim as "already settled" and stood down
 * too, freezing the reply at "👀 On it" with no outcome ever shown. Keeping the
 * three operations together makes the claim/release pairing visible.
 */

import { type DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

/** Outcome of trying to become the one writer of a task's terminal reply. */
export type ReplyClaimOutcome =
  /** This caller owns the reply and must post it (or release the claim). */
  | { readonly won: true; readonly stamp: string }
  /**
   * Another caller already owns it (a redelivery of the same event), or the
   * claim write itself failed. Either way this caller must not reply: on a lost
   * race a reply would duplicate, and on an error we cannot know whether the
   * write landed, so replying could duplicate too.
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

/**
 * Give the claim back after failing to write the reply, so a later delivery of
 * the same event can try again.
 *
 * Without this a failed reply is permanent in two ways: no redelivery may
 * re-attempt it, and the progress and heartbeat writers — which read this same
 * attribute as "an outcome has landed" — also stand down, leaving the reply
 * stuck on its last progress text.
 *
 * Conditional on the exact stamp this caller wrote. A blind delete would, in the
 * interleaving where this release is delayed past another delivery's successful
 * claim-and-reply, strip that writer's claim and let a third delivery reply
 * again — turning one lost reply into a duplicated one.
 *
 * Re-attempting is safe for the usual case, an EDIT of an existing reply, which
 * converges on the same body. Where there was no reply id to edit and the reply
 * had to be created, a create whose response was lost in transit could be
 * created twice — accepted, because a duplicated reply is noise whereas a
 * missing one leaves the human's request looking unanswered.
 */
export async function releaseReplyClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
  stamp: string,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: taskId },
      UpdateExpression: 'REMOVE ack_replied_at',
      ConditionExpression: 'ack_replied_at = :ours',
      ExpressionAttributeValues: { ':ours': stamp },
    }));
    logger.info('Released the terminal-reply claim after a failed reply — a retry may re-attempt', {
      task_id: taskId,
    });
  } catch (err) {
    // Losing the release leaves the reply un-retryable, which is the bug this
    // exists to prevent — so log loudly. Never throw: the caller is on a
    // best-effort feedback path.
    const conditional = (err as { name?: string })?.name === 'ConditionalCheckFailedException';
    logger.warn('Could not release the terminal-reply claim', {
      event: 'iteration_reply.claim_release_failed',
      task_id: taskId,
      // A failed condition means the claim is no longer ours — another delivery
      // has taken it and will do the reply, so nothing is stuck.
      claim_no_longer_ours: conditional,
      ...(conditional ? {} : { error: err instanceof Error ? err.message : String(err) }),
    });
  }
}

/**
 * Has a terminal reply already been claimed for this task?
 *
 * For the PROGRESS writers, which must not render "working" over an outcome.
 * Read strongly-consistent, because the whole point is to observe a write
 * another Lambda may have made moments ago — an eventually-consistent read is
 * precisely how a stale progress edit slips past.
 *
 * Fails OPEN (false) on a read error: a missed progress edit is cosmetic, while
 * suppressing progress on a task that never settled would leave the reply frozen
 * at "On it". Note this marker is stamped just BEFORE the reply it announces is
 * rendered, so it is necessary but not sufficient — the surface also compares
 * the current body (see the ``skipIfSettled`` reply option).
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
