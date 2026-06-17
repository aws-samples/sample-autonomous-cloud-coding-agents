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

import { GetCommand, BatchWriteCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SubIssueNode } from '../../../src/handlers/shared/linear-subissue-fetch';
import {
  seedOrchestration,
  extendOrchestration,
  deriveOrchestrationId,
  claimRollup,
  clearRollupClaim,
  claimCommentAck,
  loadOrchestration,
  findOrchestrationChildByBranch,
} from '../../../src/handlers/shared/orchestration-store';

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
    expect(byId.A.child_status).toBe('ready');
    expect(byId.B.child_status).toBe('blocked');
    expect(byId.B.depends_on).toEqual(['A']);
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

  test('persists channel_source on the meta row when supplied (#247 trigger-agnostic)', async () => {
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
      releaseContext: { platform_user_id: 'u1', channel_source: 'linear' },
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const meta = puts.find((p) => p.PutRequest.Item.sub_issue_id === '#meta')!.PutRequest.Item;
    expect(meta.channel_source).toBe('linear');
  });

  test('omits channel_source from the meta row when not supplied (back-compat)', async () => {
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
      releaseContext: RC, // no channel_source
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const meta = puts.find((p) => p.PutRequest.Item.sub_issue_id === '#meta')!.PutRequest.Item;
    expect(meta.channel_source).toBeUndefined();
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

describe('clearRollupClaim — release the claim so a re-completing epic re-settles', () => {
  test('REMOVEs rollup_posted_at on the meta row (unconditional, idempotent)', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({}) };
    await clearRollupClaim(ddb as never, TABLE, 'orch_1', NOW);
    const cmd = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.UpdateExpression).toContain('REMOVE rollup_posted_at');
    expect(cmd.input.Key).toMatchObject({ sub_issue_id: '#meta', orchestration_id: 'orch_1' });
    // No conditional — a no-op when already absent.
    expect(cmd.input.ConditionExpression).toBeUndefined();
  });
});

describe('claimCommentAck — exactly-once per comment (#247 UX.20 redelivery dedup)', () => {
  test('first delivery wins → true, conditional create-once on a per-comment SK + TTL', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({}) };
    const won = await claimCommentAck(ddb as never, TABLE, 'orch_1', 'cmt-9', NOW, 1781800000);
    expect(won).toBe(true);
    const cmd = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.Key).toMatchObject({ orchestration_id: 'orch_1', sub_issue_id: 'ack#cmt-9' });
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists(orchestration_id)');
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ':ttl': 1781800000 });
    // ``ttl`` is a DynamoDB reserved keyword — must be aliased, else the write
    // 400s with ValidationException (live-caught: the unaliased form errored
    // out the whole handler, silently dropping the comment).
    expect(cmd.input.ExpressionAttributeNames).toMatchObject({ '#ttl': 'ttl' });
    expect(cmd.input.UpdateExpression).toContain('#ttl');
  });

  test('redelivery of the same comment loses (ConditionalCheckFailed) → false, no throw', async () => {
    const ddb = { send: jest.fn().mockRejectedValueOnce(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' })) };
    expect(await claimCommentAck(ddb as never, TABLE, 'orch_1', 'cmt-9', NOW, 1781800000)).toBe(false);
  });

  test('non-conditional error propagates', async () => {
    const ddb = { send: jest.fn().mockRejectedValueOnce(new Error('throttle')) };
    await expect(claimCommentAck(ddb as never, TABLE, 'orch_1', 'cmt-9', NOW, 1781800000)).rejects.toThrow('throttle');
  });
});

describe('loadOrchestration — marker rows are not children (#247 UX.20)', () => {
  test('excludes ack#<commentId> marker rows from children (only real sub-issues count)', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          { orchestration_id: 'orch_1', sub_issue_id: '#meta', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1', child_count: 2 },
          { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', depends_on: [], child_status: 'succeeded' },
          { orchestration_id: 'orch_1', sub_issue_id: 'orch_1__integration', depends_on: ['uuid-A'], child_status: 'succeeded' },
          { orchestration_id: 'orch_1', sub_issue_id: 'ack#cmt-9', acked_at: NOW, ttl: 1781800000 }, // marker — must NOT be a child
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap).not.toBeNull();
    const ids = snap!.children.map((c) => c.sub_issue_id).sort();
    expect(ids).toEqual(['orch_1__integration', 'uuid-A']); // ack# row excluded; integration kept
  });
});

describe('findOrchestrationChildByBranch (#305 A6)', () => {
  test('queries the ChildBranchIndex GSI by branch and returns the child row', async () => {
    const ddb = makeDdb();
    const row = { orchestration_id: 'orch_1', sub_issue_id: 'SUB-A', child_branch_name: 'bgagent/01T/abca-1-x' };
    ddb.send.mockResolvedValueOnce({ Items: [row] });

    const result = await findOrchestrationChildByBranch(
      ddb as never, TABLE, 'ChildBranchIndex', 'bgagent/01T/abca-1-x',
    );

    expect(result).toEqual(row);
    const cmd = ddb.send.mock.calls[0][0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe('ChildBranchIndex');
    expect(cmd.input.KeyConditionExpression).toBe('child_branch_name = :b');
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ':b': 'bgagent/01T/abca-1-x' });
    expect(cmd.input.Limit).toBe(1);
  });

  test('returns null when no released child owns the branch (non-orchestration PR)', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Items: [] });
    const result = await findOrchestrationChildByBranch(
      ddb as never, TABLE, 'ChildBranchIndex', 'feature/some-human-branch',
    );
    expect(result).toBeNull();
  });
});

describe('extendOrchestration — add nodes to an already-seeded epic', () => {
  const PARENT = 'parent-issue-1';
  const ORCH = deriveOrchestrationId(PARENT);

  /** A loadOrchestration Query response: meta + existing child rows. */
  function existing(children: Array<{ id: string; deps?: string[]; status: string }>) {
    const meta = {
      orchestration_id: ORCH,
      sub_issue_id: '#meta',
      parent_linear_issue_id: PARENT,
      linear_workspace_id: 'WS',
      repo: 'o/r',
      child_count: children.length,
      platform_user_id: 'u1',
      created_at: NOW,
      updated_at: NOW,
    };
    const rows = children.map((c) => ({
      orchestration_id: ORCH,
      sub_issue_id: c.id,
      parent_linear_issue_id: PARENT,
      linear_workspace_id: 'WS',
      repo: 'o/r',
      depends_on: c.deps ?? [],
      child_status: c.status,
      created_at: NOW,
      updated_at: NOW,
    }));
    return { Items: [meta, ...rows] };
  }

  function extendParams(graph: SubIssueNode[]) {
    return {
      tableName: TABLE,
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'o/r',
      graph,
      now: NOW,
    };
  }

  test('adds a NEW node blocked-by a finished node → releasable immediately', async () => {
    const ddb = makeDdb();
    // load (Query) → existing A succeeded; then BatchWrite (new rows) + Update (meta).
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }]))
      .mockResolvedValueOnce({}) // BatchWrite
      .mockResolvedValueOnce({}); // Update meta
    // Graph now has A (existing) + B (new, depends on the finished A).
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A'], { title: 'UI' })]),
    });
    expect(result.addedSubIssueIds).toEqual(['B']);
    expect(result.releasableSubIssueIds).toEqual(['B']); // A already succeeded
    // The new row was written as 'ready' (deps satisfied).
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; child_status: string } } }>)[0].PutRequest.Item;
    expect(written.sub_issue_id).toBe('B');
    expect(written.child_status).toBe('ready');
  });

  test('adds a NEW node whose predecessor is NOT yet done → blocked, not releasable', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'released' }])) // A still running
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A'])]),
    });
    expect(result.addedSubIssueIds).toEqual(['B']);
    expect(result.releasableSubIssueIds).toEqual([]); // A not succeeded → B blocked
  });

  // #247 UX.4: a new node with NO declared dependency stacks on the epic TIP
  // (the leaf frontier of existing nodes), not bare main.
  test('new UNCONSTRAINED node → implicit depends_on = epic tip (linear chain → its leaf)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'A', status: 'succeeded' },
        { id: 'B', deps: ['A'], status: 'succeeded' }, // B is the leaf / tip
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    // New node C declares NO dependency.
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A']), child('C', [], { title: 'New step' })]),
    });
    expect(result.addedSubIssueIds).toEqual(['C']);
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; depends_on: string[]; child_status: string } } }>)[0].PutRequest.Item;
    expect(written.sub_issue_id).toBe('C');
    // Stacked on the tip B (not []), and B succeeded so C is releasable.
    expect(written.depends_on).toEqual(['B']);
    expect(written.child_status).toBe('ready');
    expect(result.releasableSubIssueIds).toEqual(['C']);
  });

  test('new unconstrained node, tip NOT done → blocked on the tip (stacks, waits)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'released' }])) // tip A still running
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', [])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { depends_on: string[]; child_status: string } } }>)[0].PutRequest.Item;
    expect(written.depends_on).toEqual(['A']); // stacked on the tip
    expect(written.child_status).toBe('blocked');
    expect(result.releasableSubIssueIds).toEqual([]);
  });

  test('new unconstrained node on a fan-out epic → diamond implicit deps (all leaves)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'R', status: 'succeeded' },
        { id: 'B', deps: ['R'], status: 'succeeded' },
        { id: 'C', deps: ['R'], status: 'succeeded' }, // B and C are both leaves
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('R'), child('B', ['R']), child('C', ['R']), child('D', [])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; depends_on: string[] } } }>)[0].PutRequest.Item;
    expect(written.depends_on).toEqual(['B', 'C']); // diamond over both leaves
    expect(result.releasableSubIssueIds).toEqual(['D']); // both succeeded
  });

  test('new node WITH an explicit dependency keeps it (user intent wins over the tip)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'A', status: 'succeeded' },
        { id: 'B', deps: ['A'], status: 'succeeded' }, // tip would be B
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    // New node C explicitly depends on A (not the tip B).
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A']), child('C', ['A'])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { depends_on: string[] } } }>)[0].PutRequest.Item;
    expect(written.depends_on).toEqual(['A']); // explicit edge preserved, NOT overridden to ['B']
    expect(result.addedSubIssueIds).toEqual(['C']);
  });

  test('no new nodes (graph unchanged) → no-op, no writes', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }]));
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A')]),
    });
    expect(result.addedSubIssueIds).toEqual([]);
    // Only the load Query ran — no BatchWrite/Update.
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof BatchWriteCommand)).toHaveLength(0);
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
  });

  test('a new edge that introduces a CYCLE → rejected, nothing written', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce(existing([
      { id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'succeeded' },
    ]));
    // New node C depends on B, but the augmented graph also makes A depend on C → cycle.
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A', ['C']), child('B', ['A']), child('C', ['B'])]),
    });
    expect(result.rejected?.reason).toBe('cycle');
    expect(result.addedSubIssueIds).toEqual([]);
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof BatchWriteCommand)).toHaveLength(0);
  });

  test('no existing orchestration (load returns nothing) → empty result', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Items: [] }); // loadOrchestration → null
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A')]),
    });
    expect(result.addedSubIssueIds).toEqual([]);
  });

  test('bumps meta child_count by the number of added nodes', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'succeeded' }]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A']), child('C', ['A']), child('D', ['B'])]),
    });
    const upd = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)![0];
    // 2 existing + 2 new (C, D) = 4.
    expect(upd.input.ExpressionAttributeValues[':n']).toBe(4);
  });

  test('clears rollup_posted_at so a re-completed (post-completion) epic can rollup again (#247 UX.4)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', [])]),
    });
    const upd = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)![0];
    // The meta update REMOVEs rollup_posted_at so the reconciler can re-claim
    // and re-settle the parent state when the added node finishes.
    expect(upd.input.UpdateExpression).toContain('REMOVE rollup_posted_at');
  });
});
