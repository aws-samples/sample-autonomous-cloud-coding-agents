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
  test('removes the claim only while it is still the one this caller made', async () => {
    await releaseReplyClaim(ddb, TABLE, TASK, STAMP);

    expect(inputOf(0)).toMatchObject({
      UpdateExpression: 'REMOVE ack_replied_at',
      // A blind REMOVE would, when this release is delayed past another
      // delivery's successful claim-and-reply, strip that writer's claim and let
      // a third delivery reply again — one lost reply becoming a duplicated one.
      ConditionExpression: 'ack_replied_at = :ours',
      ExpressionAttributeValues: { ':ours': STAMP },
    });
  });

  test('a claim that is no longer ours is left alone, and reported as not stuck', async () => {
    send.mockRejectedValueOnce(conditionalFailure());

    await releaseReplyClaim(ddb, TABLE, TASK, STAMP);

    expect(warnFields()).toMatchObject({ claim_no_longer_ours: true });
  });

  test('a release that fails for any other reason is reported as a stuck claim', async () => {
    send.mockRejectedValueOnce(new Error('AccessDeniedException'));

    await releaseReplyClaim(ddb, TABLE, TASK, STAMP);

    expect(warnFields()).toMatchObject({
      event: 'iteration_reply.claim_release_failed',
      claim_no_longer_ours: false,
    });
    expect(warnFields().error).toContain('AccessDenied');
  });

  test('a successful release is announced, so a retry is traceable in the logs', async () => {
    await releaseReplyClaim(ddb, TABLE, TASK, STAMP);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Released'), { task_id: TASK });
  });

  test('never throws — the caller is on a best-effort feedback path', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(releaseReplyClaim(ddb, TABLE, TASK, STAMP)).resolves.toBeUndefined();
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
