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

import { GetCommand, BatchWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  seedOrchestration,
  deriveOrchestrationId,
  claimRollup,
} from '../../../src/handlers/shared/orchestration-store';
import type { SubIssueNode } from '../../../src/handlers/shared/linear-subissue-fetch';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const child = (id: string, depends_on: string[] = [], extra: Partial<SubIssueNode> = {}): SubIssueNode => ({
  id,
  depends_on,
  ...extra,
});

interface MockDdb {
  send: jest.Mock;
}

function makeDdb(): MockDdb {
  return { send: jest.fn() };
}

const TABLE = 'OrchestrationTable';
const NOW = '2026-06-09T12:00:00.000Z';
const RC = { platform_user_id: 'platform-user-1' };

describe('deriveOrchestrationId', () => {
  test('is deterministic for the same parent id', () => {
    expect(deriveOrchestrationId('ISSUE-123')).toBe(deriveOrchestrationId('ISSUE-123'));
  });

  test('differs for different parent ids', () => {
    expect(deriveOrchestrationId('A')).not.toBe(deriveOrchestrationId('B'));
  });

  test('is prefixed and fixed-length', () => {
    const id = deriveOrchestrationId('anything');
    expect(id).toMatch(/^orch_[0-9a-f]{32}$/);
  });
});

describe('seedOrchestration — first write', () => {
  test('writes one row per child plus a meta row', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce({ Item: undefined }) // GetCommand: no existing meta
      .mockResolvedValueOnce({}); // BatchWrite

    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentLinearIssueId: 'PARENT',
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      children: [child('A'), child('B', ['A'])],
      now: NOW,
      releaseContext: RC,
    });

    expect(result.alreadyExisted).toBe(false);
    // 2 children + 1 meta row.
    expect(result.rowsWritten).toBe(3);
    expect(result.orchestrationId).toBe(deriveOrchestrationId('PARENT'));

    // First call is the idempotency GetCommand.
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    // Second is the BatchWrite.
    const batch = ddb.send.mock.calls[1][0];
    expect(batch).toBeInstanceOf(BatchWriteCommand);
    const puts = batch.input.RequestItems[TABLE];
    expect(puts).toHaveLength(3);
  });

  test('roots get child_status=ready, blocked children get blocked', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentLinearIssueId: 'PARENT',
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      children: [child('A'), child('B', ['A'])],
      now: NOW,
      releaseContext: RC,
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const byId = Object.fromEntries(puts.map((p) => [p.PutRequest.Item.sub_issue_id, p.PutRequest.Item]));
    expect(byId['A'].child_status).toBe('ready');
    expect(byId['B'].child_status).toBe('blocked');
    expect(byId['B'].depends_on).toEqual(['A']);
  });

  test('persists linear_identifier and title when present', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentLinearIssueId: 'PARENT',
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      children: [child('A', [], { identifier: 'ENG-1', title: 'Do thing' })],
      now: NOW,
      releaseContext: RC,
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const a = puts.find((p) => p.PutRequest.Item.sub_issue_id === 'A')!.PutRequest.Item;
    expect(a.linear_identifier).toBe('ENG-1');
    expect(a.title).toBe('Do thing');
  });

  test('chunks BatchWrite into groups of 25', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValue({}); // Get + all batches
    ddb.send.mockResolvedValueOnce({ Item: undefined }); // first call = Get

    // 30 children + 1 meta = 31 rows → 2 batches (25 + 6).
    const children = Array.from({ length: 30 }, (_, i) => child(`C${i}`));
    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentLinearIssueId: 'PARENT',
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      children,
      now: NOW,
      releaseContext: RC,
    });

    expect(result.rowsWritten).toBe(31);
    // 1 Get + 2 BatchWrite = 3 sends.
    expect(ddb.send).toHaveBeenCalledTimes(3);
  });

  test('includes ttl on rows when provided', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentLinearIssueId: 'PARENT',
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
      ttl: 9999999999,
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    expect(puts.every((p) => p.PutRequest.Item.ttl === 9999999999)).toBe(true);
  });
});

describe('seedOrchestration — idempotent replay', () => {
  test('skips writing when a meta row already exists', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: { orchestration_id: 'x', sub_issue_id: '#meta' } });

    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentLinearIssueId: 'PARENT',
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      children: [child('A'), child('B', ['A'])],
      now: NOW,
      releaseContext: RC,
    });

    expect(result.alreadyExisted).toBe(true);
    expect(result.rowsWritten).toBe(0);
    // Only the Get fired — no BatchWrite.
    expect(ddb.send).toHaveBeenCalledTimes(1);
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });
});

describe('claimRollup — exactly-once parent rollup', () => {
  function makeDdb(): MockDdb { return { send: jest.fn() }; }

  test('first claim wins (conditional write succeeds) → true', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({});
    const won = await claimRollup(ddb as never, TABLE, 'orch_1', NOW);
    expect(won).toBe(true);
    const cmd = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists(rollup_posted_at)');
    expect(cmd.input.Key).toMatchObject({ sub_issue_id: '#meta' });
  });

  test('second claim loses (ConditionalCheckFailed) → false, no throw', async () => {
    const ddb = makeDdb();
    const e = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
    ddb.send.mockRejectedValueOnce(e);
    const won = await claimRollup(ddb as never, TABLE, 'orch_1', NOW);
    expect(won).toBe(false);
  });

  test('non-conditional error propagates', async () => {
    const ddb = makeDdb();
    ddb.send.mockRejectedValueOnce(new Error('throttle'));
    await expect(claimRollup(ddb as never, TABLE, 'orch_1', NOW)).rejects.toThrow('throttle');
  });
});
