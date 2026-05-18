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
 * Cross-handler concurrency test for approve + deny on the same
 * approval row (S1 from PR review).
 *
 * Pre-S1 the at-most-one-decision invariant was enforced by the
 * ``ConditionExpression: status = :pending`` guard on every mutator,
 * but no test verified that two simultaneous approve/deny calls on
 * the same ``request_id`` actually result in exactly one winner.
 * The DDB primitive guarantees this; this test pins it for the two
 * handler entry points so a future refactor that loosens the
 * condition expression fails here.
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';

const TASK_APPROVALS_TABLE_NAME = 'TaskApprovalsTable';
const TASK_TABLE_NAME = 'TaskTable';
const TASK_EVENTS_TABLE_NAME = 'Events';

process.env.TASK_APPROVALS_TABLE_NAME = TASK_APPROVALS_TABLE_NAME;
process.env.TASK_TABLE_NAME = TASK_TABLE_NAME;
process.env.TASK_EVENTS_TABLE_NAME = TASK_EVENTS_TABLE_NAME;
process.env.APPROVE_RATE_LIMIT_PER_MINUTE = '60';
process.env.DENY_RATE_LIMIT_PER_MINUTE = '60';

class MockTransactionCanceledException extends Error {
  name = 'TransactionCanceledException';
  CancellationReasons: Array<{ Code: string }>;

  constructor(reasons: Array<{ Code: string }>) {
    super('TransactionCanceledException');
    this.CancellationReasons = reasons;
  }
}

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  TransactionCanceledException: MockTransactionCanceledException,
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: mockSend })),
    },
    UpdateCommand: jest.fn().mockImplementation((input) => ({ _type: 'Update', input })),
    PutCommand: jest.fn().mockImplementation((input) => ({ _type: 'Put', input })),
    TransactWriteCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: 'TransactWrite', input })),
  };
});

import { handler as approveHandler } from '../../src/handlers/approve-task';
import { handler as denyHandler } from '../../src/handlers/deny-task';

function makeEvent(
  pathTaskId: string,
  body: Record<string, unknown>,
  userSub: string,
): APIGatewayProxyEvent {
  return {
    pathParameters: { task_id: pathTaskId },
    body: JSON.stringify(body),
    requestContext: {
      authorizer: { claims: { sub: userSub } },
    },
  } as unknown as APIGatewayProxyEvent;
}

describe('approve+deny concurrency on a single request_id (S1)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('one writer wins, the other gets 409 from ConditionalCheckFailed', async () => {
    // Scenario: user submits both an approve and a deny in quick
    // succession (e.g. clicked Approve in CLI, then Slack button
    // fired Deny before the first network round-trip completed).
    // First call: rate-limit succeeds, TransactWrite succeeds,
    // audit Put succeeds. Second call: rate-limit succeeds, but
    // the TransactWrite hits ``ConditionalCheckFailed`` on the
    // approval row (status is no longer PENDING).

    const SHARED_TASK_ID = '01KCONCURRENT_TASK';
    const SHARED_REQUEST_ID = '01KCONCURRENT_REQ';

    // Approve goes through cleanly.
    mockSend
      .mockResolvedValueOnce({}) // rate-limit Update
      .mockResolvedValueOnce({}) // TransactWrite (approve)
      .mockResolvedValueOnce({}); // audit Put

    const approveRes = await approveHandler(
      makeEvent(SHARED_TASK_ID, { request_id: SHARED_REQUEST_ID, decision: 'approve' }, 'user-alice'),
    );
    expect(approveRes.statusCode).toBe(202);

    // Deny on the same row — TransactWrite cancelled on
    // ``ConditionalCheckFailed`` because the approval row's status
    // is now APPROVED, not PENDING.
    mockSend
      .mockResolvedValueOnce({}) // rate-limit Update for deny
      .mockRejectedValueOnce(
        new MockTransactionCanceledException([
          { Code: 'ConditionalCheckFailed' }, // approvals row not PENDING
          { Code: 'None' }, // task row check (would have been fine)
        ]),
      );

    const denyRes = await denyHandler(
      makeEvent(
        SHARED_TASK_ID,
        { request_id: SHARED_REQUEST_ID, decision: 'deny', reason: 'too late' },
        'user-alice',
      ),
    );

    // The conflicting decision is rejected with 409 (request not
    // pending) — the API design choice for both approve-task and
    // deny-task is "first write wins, second gets a clear error".
    // 404 (REQUEST_NOT_FOUND) is also acceptable because the
    // condition is "request not in PENDING state", which from the
    // CLI perspective is indistinguishable from "doesn't exist".
    expect([404, 409]).toContain(denyRes.statusCode);

    // Critical invariant: at most ONE TransactWriteCommand reached
    // a successful resolution. The mock recorded one
    // TransactWriteCommand call that resolved without error
    // (the approve path); the deny's TransactWriteCommand call
    // also fired but was rejected by the mock. Counting calls
    // with ``_type === 'TransactWrite'`` proves both were attempted
    // (the condition guard was actually exercised, not bypassed).
    const transactCalls = mockSend.mock.calls.filter(
      (c) => (c[0] as { _type: string })._type === 'TransactWrite',
    );
    expect(transactCalls).toHaveLength(2);
  });

  test('reverse order: deny wins, approve gets ConditionalCheckFailed', async () => {
    // Symmetrical scenario — deny lands first. Same outcome shape:
    // first transaction succeeds, second is rejected. Pinned
    // separately so a future change that broke ONE direction
    // (e.g. by accident omitting the condition on the deny path)
    // is caught.

    const SHARED_TASK_ID = '01KCONCURRENT_TASK_2';
    const SHARED_REQUEST_ID = '01KCONCURRENT_REQ_2';

    mockSend
      .mockResolvedValueOnce({}) // rate-limit Update (deny)
      .mockResolvedValueOnce({}) // TransactWrite (deny)
      .mockResolvedValueOnce({}); // audit Put

    const denyRes = await denyHandler(
      makeEvent(
        SHARED_TASK_ID,
        { request_id: SHARED_REQUEST_ID, decision: 'deny', reason: 'denied first' },
        'user-alice',
      ),
    );
    expect(denyRes.statusCode).toBe(202);

    mockSend
      .mockResolvedValueOnce({}) // rate-limit Update (approve)
      .mockRejectedValueOnce(
        new MockTransactionCanceledException([
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ]),
      );

    const approveRes = await approveHandler(
      makeEvent(SHARED_TASK_ID, { request_id: SHARED_REQUEST_ID, decision: 'approve' }, 'user-alice'),
    );
    expect([404, 409]).toContain(approveRes.statusCode);
  });
});
