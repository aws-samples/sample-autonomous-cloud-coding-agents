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
 * Unit tests for the shared approve/deny decision core (issue #112).
 * The HTTP handlers and the Slack interactions handler both delegate
 * here; these tests pin the invariants that must hold for EVERY
 * surface (the per-handler tests cover surface-specific mapping).
 */

import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ _type: 'TransactWrite', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

import {
  type ApprovalDecisionConfig,
  approvalDecisionConfigFromEnv,
  processApprovalDecision,
} from '../../../src/handlers/shared/approval-decision';

const CONFIG: ApprovalDecisionConfig = {
  taskTableName: 'Tasks',
  approvalsTableName: 'TaskApprovals',
  eventsTableName: 'TaskEvents',
  rateLimitPerMinute: 30,
  auditRetentionDays: 90,
};

const INPUT = {
  taskId: 'task-1',
  requestId: 'req-1',
  callerUserId: 'user-1',
} as const;

function makeDdb(send: jest.Mock): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('processApprovalDecision', () => {
  test('approve: rate limit → transaction → audit, returns ok with decidedAt', async () => {
    const send = jest.fn().mockResolvedValue({});
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'approve',
      scope: 'this_call',
    });

    expect(outcome.kind).toBe('ok');
    const types = send.mock.calls.map(([cmd]) => (cmd as { _type: string })._type);
    expect(types).toEqual(['Update', 'TransactWrite', 'Put']);

    // Rate-limit row shape: shared approve+deny counter namespace.
    const rate = send.mock.calls[0][0].input;
    expect(rate.Key).toEqual({
      task_id: 'RATE#user-1#APPROVE',
      request_id: expect.stringMatching(/^MINUTE#\d{12}$/),
    });

    // Transaction: approval row first (PENDING→APPROVED, ownership-
    // guarded), task row second (AWAITING_APPROVAL guard).
    const txn = send.mock.calls[1][0].input.TransactItems;
    expect(txn[0].Update.ConditionExpression).toContain('user_id = :caller');
    expect(txn[0].Update.ConditionExpression).toContain('#status = :pending');
    expect(txn[0].Update.ExpressionAttributeValues[':decided']).toBe('APPROVED');
    expect(txn[0].Update.ExpressionAttributeValues[':scope']).toBe('this_call');
    expect(txn[1].Update.ConditionExpression).toContain('awaiting_approval_request_id = :rid');

    // Audit event.
    const audit = send.mock.calls[2][0].input.Item;
    expect(audit.event_type).toBe('approval_decision_recorded');
    expect(audit.metadata.status).toBe('APPROVED');
    expect(audit.metadata.caller_user_id).toBe('user-1');
  });

  test('approve without an explicit scope defaults to this_call', async () => {
    const send = jest.fn().mockResolvedValue({});
    await processApprovalDecision(makeDdb(send), CONFIG, { ...INPUT, decision: 'approve' });
    const txn = send.mock.calls[1][0].input.TransactItems;
    expect(txn[0].Update.ExpressionAttributeValues[':scope']).toBe('this_call');
  });

  test('deny persists the sanitized reason on the row and the audit', async () => {
    const send = jest.fn().mockResolvedValue({});
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'deny',
      sanitizedReason: 'too risky',
    });
    expect(outcome.kind).toBe('ok');
    const txn = send.mock.calls[1][0].input.TransactItems;
    expect(txn[0].Update.ExpressionAttributeValues[':decided']).toBe('DENIED');
    expect(txn[0].Update.ExpressionAttributeValues[':reason']).toBe('too risky');
    const audit = send.mock.calls[2][0].input.Item;
    expect(audit.metadata.status).toBe('DENIED');
    expect(audit.metadata.reason).toBe('too risky');
  });

  test('rate-limit conditional failure short-circuits before the transaction', async () => {
    const limitErr = new Error('limit');
    limitErr.name = 'ConditionalCheckFailedException';
    const send = jest.fn().mockRejectedValueOnce(limitErr);
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'approve',
    });
    expect(outcome).toEqual({ kind: 'rate_limited', limit: 30 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('approvals-row condition failure collapses to not_found (no oracle — §7.1 finding #6)', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({}) // rate limit
      .mockRejectedValueOnce(new TransactionCanceledException({
        message: 'cancelled',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        $metadata: {},
      }));
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'approve',
    });
    expect(outcome).toEqual({ kind: 'not_found' });
    // Audit must NOT be written on a failed decision.
    expect(send.mock.calls.find(([cmd]) => (cmd as { _type: string })._type === 'Put')).toBeFalsy();
  });

  test('task-row condition failure maps to not_awaiting', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new TransactionCanceledException({
        message: 'cancelled',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        $metadata: {},
      }));
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'deny',
    });
    expect(outcome).toEqual({ kind: 'not_awaiting' });
  });

  test('unexplained transaction cancellation maps to transaction_unknown', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new TransactionCanceledException({
        message: 'cancelled',
        CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        $metadata: {},
      }));
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'approve',
    });
    expect(outcome).toEqual({ kind: 'transaction_unknown' });
  });

  test('infra errors outside the transaction propagate (caller owns the 500 path)', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('DDB unavailable'));
    await expect(processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'approve',
    })).rejects.toThrow('DDB unavailable');
  });

  test('audit write failure does not fail the decision (already committed)', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({}) // rate limit
      .mockResolvedValueOnce({}) // transaction
      .mockRejectedValueOnce(new Error('events table throttled')); // audit
    const outcome = await processApprovalDecision(makeDdb(send), CONFIG, {
      ...INPUT,
      decision: 'approve',
    });
    expect(outcome.kind).toBe('ok');
  });
});

describe('approvalDecisionConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test('reads the standard env vars', () => {
    process.env.TASK_TABLE_NAME = 'T';
    process.env.TASK_APPROVALS_TABLE_NAME = 'A';
    process.env.TASK_EVENTS_TABLE_NAME = 'E';
    process.env.APPROVE_RATE_LIMIT_PER_MINUTE = '10';
    process.env.TASK_RETENTION_DAYS = '30';
    expect(approvalDecisionConfigFromEnv()).toEqual({
      taskTableName: 'T',
      approvalsTableName: 'A',
      eventsTableName: 'E',
      rateLimitPerMinute: 10,
      auditRetentionDays: 30,
    });
  });

  test('throws when a required table env var is missing', () => {
    process.env.TASK_TABLE_NAME = 'T';
    delete process.env.TASK_APPROVALS_TABLE_NAME;
    process.env.TASK_EVENTS_TABLE_NAME = 'E';
    expect(() => approvalDecisionConfigFromEnv()).toThrow(/TASK_APPROVALS_TABLE_NAME/);
  });
});
