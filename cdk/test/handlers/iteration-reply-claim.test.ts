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

// The conditional-write semantics of the once-only reply claim, on their own.
// Both handlers that use it are tested end-to-end elsewhere; this pins the
// expressions themselves, because getting a condition subtly wrong here is
// invisible in a mocked handler test but decides whether a human's request ends
// up answered once, twice, or never.

import {
  claimTerminalReply,
  MAX_REPLY_ATTEMPTS,
  releaseReplyClaim,
  terminalReplyClaimed,
} from '../../src/handlers/shared/iteration-reply-claim';
import { logger } from '../../src/handlers/shared/logger';

const send = jest.fn();
const ddb = { send } as unknown as Parameters<typeof claimTerminalReply>[0];

const TABLE = 'TaskTable';
const TASK = 'iter-task-1';
const STAMP = '2026-07-26T01:14:04.301Z';

/** The rejection DynamoDB raises when a ConditionExpression is not satisfied. */
function conditionalFailure(): Error {
  const err = new Error('The conditional request failed');
  (err as { name?: string }).name = 'ConditionalCheckFailedException';
  return err;
}

/** The command input of the Nth send call. */
function inputOf(call: number): Record<string, unknown> {
  return (send.mock.calls[call][0] as { input: Record<string, unknown> }).input;
}

// Spied rather than module-mocked (the repo's idiom) so the assertions read the
// same logger the code under test writes to.
let warnSpy: jest.SpyInstance;
let infoSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  send.mockResolvedValue({});
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

/** Structured fields of the Nth warn call. */
function warnFields(call = 0): Record<string, unknown> {
  return warnSpy.mock.calls[call][1] as Record<string, unknown>;
}

describe('claimTerminalReply', () => {
  test('the first caller wins and gets its stamp back for a later release', async () => {
    const outcome = await claimTerminalReply(ddb, TABLE, TASK, STAMP);

    expect(outcome).toEqual({ won: true, stamp: STAMP });
    expect(inputOf(0)).toMatchObject({
      TableName: TABLE,
      Key: { task_id: TASK },
      UpdateExpression: 'SET ack_replied_at = :now',
      // Only-if-absent is what makes this once-only across redeliveries.
      ConditionExpression: 'attribute_not_exists(ack_replied_at)',
      ExpressionAttributeValues: { ':now': STAMP },
    });
  });

  test('a caller that loses the race does NOT win, and stays quiet about it', async () => {
    send.mockRejectedValueOnce(conditionalFailure());

    expect(await claimTerminalReply(ddb, TABLE, TASK, STAMP)).toEqual({ won: false });
    // Losing is the expected outcome for every redelivery, so it must not warn —
    // otherwise the logs cry wolf on healthy runs.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('a claim write that ERRORS does not win either — replying could duplicate', async () => {
    // The write may or may not have landed, so the safe read is "not mine".
    send.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));

    expect(await claimTerminalReply(ddb, TABLE, TASK, STAMP)).toEqual({ won: false });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('releaseReplyClaim', () => {
  test('frees the claim and counts the attempt in ONE write', async () => {
    send.mockResolvedValueOnce({ Attributes: { ack_reply_attempts: 1 } });

    expect(await releaseReplyClaim(ddb, TABLE, TASK, STAMP)).toBe('released');

    const input = inputOf(0);
    expect(input.UpdateExpression).toContain('REMOVE ack_replied_at');
    // Counting in the same write is what keeps the budget honest: a separate
    // increment could be lost between the two and restore the unbounded spin.
    expect(input.UpdateExpression).toContain('ack_reply_attempts');
    // A blind REMOVE would, when this release is delayed past another delivery's
    // successful claim-and-reply, strip that writer's claim and let a third
    // delivery reply again — one lost reply becoming a duplicated one.
    expect(input.ConditionExpression).toContain('ack_replied_at = :ours');
    // And the budget is enforced by the condition, not by a later read.
    expect(input.ConditionExpression).toContain('ack_reply_attempts < :max');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':max']).toBe(MAX_REPLY_ATTEMPTS);
  });

  test('a spent budget reports EXHAUSTED, so the caller settles instead of waiting', async () => {
    // The live failure this bound prevents: releasing the claim writes to the task
    // record, and the reconciler consumes that record's stream — so a release
    // re-wakes the handler that performed it. With a reply that can never succeed
    // (its comment was deleted) that spun ~900 times in six minutes.
    send
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { ack_reply_attempts: MAX_REPLY_ATTEMPTS } });

    expect(await releaseReplyClaim(ddb, TABLE, TASK, STAMP)).toBe('exhausted');
  });

  test('a claim that is no longer OURS is distinguished from a spent budget', async () => {
    // Both surface as a failed condition but need opposite handling: another
    // delivery owning the reply means nothing is stuck, so the caller must NOT
    // settle over it.
    send
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { ack_reply_attempts: 1 } });

    expect(await releaseReplyClaim(ddb, TABLE, TASK, STAMP)).toBe('not_ours');
  });

  test('the budget check reads strongly-consistent — the increment is seconds old', async () => {
    send
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { ack_reply_attempts: 1 } });

    await releaseReplyClaim(ddb, TABLE, TASK, STAMP);
    expect(inputOf(1)).toMatchObject({ ProjectionExpression: 'ack_reply_attempts', ConsistentRead: true });
  });

  test('an unreadable budget counts as exhausted rather than looping', async () => {
    send
      .mockRejectedValueOnce(conditionalFailure())
      .mockRejectedValueOnce(new Error('throttled'));

    expect(await releaseReplyClaim(ddb, TABLE, TASK, STAMP)).toBe('exhausted');
  });

  test('an infra failure reports exhausted — the claim is still held', async () => {
    // AccessDenied or a throttle leaves the claim in place, so promising a retry
    // would leave the request looking unanswered indefinitely.
    send.mockRejectedValueOnce(new Error('AccessDeniedException'));

    expect(await releaseReplyClaim(ddb, TABLE, TASK, STAMP)).toBe('exhausted');
    expect(warnFields()).toMatchObject({ event: 'iteration_reply.claim_release_failed' });
  });

  test('a successful release is announced with the attempt number', async () => {
    send.mockResolvedValueOnce({ Attributes: { ack_reply_attempts: 2 } });
    await releaseReplyClaim(ddb, TABLE, TASK, STAMP);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Released'),
      expect.objectContaining({ task_id: TASK, attempt: 2, max_attempts: MAX_REPLY_ATTEMPTS }),
    );
  });

  test('never throws — the caller is on a best-effort feedback path', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(releaseReplyClaim(ddb, TABLE, TASK, STAMP)).resolves.toBe('exhausted');
  });
});

describe('terminalReplyClaimed', () => {
  test('reads strongly-consistent, because the write may be seconds old', async () => {
    send.mockResolvedValueOnce({ Item: { ack_replied_at: STAMP } });

    expect(await terminalReplyClaimed(ddb, TABLE, TASK)).toBe(true);
    expect(inputOf(0)).toMatchObject({
      Key: { task_id: TASK },
      ProjectionExpression: 'ack_replied_at',
      // An eventually-consistent read is exactly how a stale progress edit slips
      // past a settle that has already happened.
      ConsistentRead: true,
    });
  });

  test('an unclaimed or missing task reads as not settled', async () => {
    send.mockResolvedValueOnce({ Item: {} });
    expect(await terminalReplyClaimed(ddb, TABLE, TASK)).toBe(false);

    send.mockResolvedValueOnce({});
    expect(await terminalReplyClaimed(ddb, TABLE, TASK)).toBe(false);
  });

  test('fails OPEN on a read error — a missed progress edit beats a frozen reply', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    expect(await terminalReplyClaimed(ddb, TABLE, TASK)).toBe(false);
  });
});
