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
 * How many times a failed terminal reply may be re-attempted.
 *
 * Bounded, and the bound is load-bearing rather than cautious. Releasing the
 * claim is itself a write to the task record, and the reconciler consumes that
 * table's stream — so a release re-wakes the very handler that performed it. When
 * the reply cannot ever succeed (its comment was deleted, the issue is gone) an
 * unbounded release therefore spins: release → stream event → retry → fail →
 * release. Observed live at ~900 iterations in six minutes before this bound
 * existed. Small on purpose: a reply that fails three times is not failing for a
 * reason another attempt fixes.
 */
export const MAX_REPLY_ATTEMPTS = 3;

/** What happened when a failed reply tried to hand its claim back. */
export type ReplyReleaseOutcome =
  /** The claim is free again; a redelivery may re-attempt the reply. */
  | 'released'
  /**
   * The retry budget is spent, so the claim was deliberately KEPT — no further
   * attempt will be made. The caller must still convey the outcome some other
   * way (the reaction on the trigger comment), because the reply itself is now
   * never going to say it.
   */
  | 'exhausted'
  /** The claim is no longer this caller's, so another delivery owns the reply. */
  | 'not_ours';

/**
 * Give the claim back after failing to write the reply, so a later delivery of
 * the same event can try again — up to {@link MAX_REPLY_ATTEMPTS}.
 *
 * Without any release a failed reply is permanent in two ways: no redelivery may
 * re-attempt it, and the progress and heartbeat writers — which read this same
 * attribute as "an outcome has landed" — also stand down, leaving the reply
 * stuck on its last progress text. Without a BOUND on the release, a
 * never-succeeding reply spins instead (see {@link MAX_REPLY_ATTEMPTS}). Both
 * failure modes are worse than one unanswered reply, so the release is bounded
 * and the attempt count lives on the record next to the claim.
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
): Promise<ReplyReleaseOutcome> {
  try {
    // Count the attempt in the SAME write that frees the claim, so the budget
    // can't be lost between the two (which would restore the unbounded spin).
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
    // Losing the release leaves the reply un-retryable, which is the bug this
    // exists to prevent — so log loudly. Never throw: the caller is on a
    // best-effort feedback path.
    const conditional = (err as { name?: string })?.name === 'ConditionalCheckFailedException';
    if (conditional) {
      // Two causes, and they need different handling by the caller: either the
      // budget is spent (the claim stays, so nothing retries and the outcome must
      // be conveyed another way) or the claim is no longer ours (another delivery
      // owns the reply and nothing is stuck). Distinguish by re-reading.
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
    // An infra failure (throttle, AccessDenied) leaves the claim held. Reported as
    // exhausted so the caller settles the comment rather than assuming a retry
    // that may never come.
    return 'exhausted';
  }
}

/**
 * Has this task's reply used up its retry budget? Read strongly-consistent: the
 * increment it is checking was written moments ago by a sibling invocation.
 *
 * Treats an unreadable record as exhausted — the caller then settles the comment
 * instead of leaving a request looking unanswered while it waits for a retry it
 * cannot confirm.
 */
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
