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

import { GetCommand, BatchWriteCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SubIssueNode } from '../../../src/handlers/shared/linear-subissue-fetch';
import { discoverOrchestration } from '../../../src/handlers/shared/orchestration-discovery';
import {
  seedOrchestration,
  setRetryCommentId,
  extendOrchestration,
  deriveOrchestrationId,
  OrchestrationIdCollisionError,
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

const metaRowOf = (ddb: MockDdb): Record<string, unknown> => ddb.send.mock.calls
  .map((c) => c[0])
  .find((cmd) => cmd instanceof PutCommand)!.input.Item!;

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
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({});

    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A'), child('B', ['A'])],
      now: NOW,
      releaseContext: RC,
    });

    expect(result.alreadyExisted).toBe(false);
    expect(result.rowsWritten).toBe(3);
    expect(result.orchestrationId).toBe(deriveOrchestrationId('PARENT'));

    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const batch = ddb.send.mock.calls[1][0];
    expect(batch).toBeInstanceOf(BatchWriteCommand);
    const puts = batch.input.RequestItems[TABLE];
    expect(puts).toHaveLength(2);
    const meta = ddb.send.mock.calls[2][0];
    expect(meta).toBeInstanceOf(PutCommand);
    expect(meta.input).toMatchObject({ TableName: TABLE, Item: { sub_issue_id: '#meta', child_count: 2 } });
    expect(ddb.send).toHaveBeenCalledTimes(3);
  });

  test('fails when the meta row cannot be written: the caller must not start an epic that does not exist', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    await expect(seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A'), child('B', ['A'])],
      now: NOW,
      releaseContext: RC,
    })).rejects.toThrow('ProvisionedThroughputExceededException');
  });

  test('roots get child_status=ready, blocked children get blocked', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
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
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
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

  test('persists the planner description onto the child row (and omits an empty one)', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [
        child('A', [], { title: 'Dashboard', description: 'Create `dashboard.html` at the root.' }),
        child('B', [], { title: 'No scope' }),
      ],
      now: NOW,
      releaseContext: RC,
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const a = puts.find((p) => p.PutRequest.Item.sub_issue_id === 'A')!.PutRequest.Item;
    const b = puts.find((p) => p.PutRequest.Item.sub_issue_id === 'B')!.PutRequest.Item;
    expect(a.description).toBe('Create `dashboard.html` at the root.');
    expect(b).not.toHaveProperty('description');
  });

  test('persists adapter-owned channel metadata on the child row', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'ENG-1',
      credentialsRef: 'cloud-1',
      repo: 'o/r',
      children: [child('ENG-2', [], {
        channel_metadata: {
          jira_cloud_id: 'cloud-1',
          jira_issue_key: 'ENG-2',
        },
      })],
      now: NOW,
      releaseContext: { ...RC, channel_source: 'jira' },
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const row = puts.find((put) => put.PutRequest.Item.sub_issue_id === 'ENG-2')!.PutRequest.Item;
    expect(row.channel_metadata).toEqual({
      jira_cloud_id: 'cloud-1',
      jira_issue_key: 'ENG-2',
    });
  });

  test('chunks BatchWrite into groups of 25', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValue({});
    ddb.send.mockResolvedValueOnce({ Item: undefined });

    const children = Array.from({ length: 30 }, (_, i) => child(`C${i}`));
    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children,
      now: NOW,
      releaseContext: RC,
    });

    expect(result.rowsWritten).toBe(31);
    expect(ddb.send.mock.calls.map((c) => c[0].constructor.name)).toEqual([
      'GetCommand', 'BatchWriteCommand', 'BatchWriteCommand', 'PutCommand',
    ]);
    const batches = ddb.send.mock.calls.slice(1, 3).map((c) => c[0].input.RequestItems[TABLE].length);
    expect(batches).toEqual([25, 5]);
  });

  test('includes ttl on rows when provided', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
      ttl: 9999999999,
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    expect(puts.every((p) => p.PutRequest.Item.ttl === 9999999999)).toBe(true);
    expect(metaRowOf(ddb).ttl).toBe(9999999999);
  });

  test('persists channel_source on the meta row when supplied (so feedback goes back to the right surface)', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: { platform_user_id: 'u1', channel_source: 'linear' },
    });

    expect(metaRowOf(ddb).channel_source).toBe('linear');
  });

  test('omits channel_source from the meta row when not supplied (back-compat)', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    });

    const meta = metaRowOf(ddb);
    expect(meta.sub_issue_id).toBe('#meta');
    expect(meta.channel_source).toBeUndefined();
  });
});

describe('rows that DynamoDB hands back unprocessed', () => {
  // A throttled BatchWriteItem answers 200 with the puts it did not make in UnprocessedItems, and the SDK does not resend them.
  type Put = { PutRequest: { Item: Record<string, unknown> } };
  const puts = (ddb: MockDdb): Put[][] => ddb.send.mock.calls
    .map((c) => c[0])
    .filter((cmd) => cmd instanceof BatchWriteCommand)
    .map((cmd) => cmd.input.RequestItems![TABLE] as Put[]);
  const ids = (batch: Put[]) => batch.map((put) => put.PutRequest.Item.sub_issue_id);
  const throttled = (keep: (put: Put) => boolean) => async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: undefined };
    if (cmd instanceof QueryCommand) {
      return { Items: [{ orchestration_id: deriveOrchestrationId('PARENT'), sub_issue_id: '#meta', repo: 'o/r', platform_user_id: 'u1' }] };
    }
    if (!(cmd instanceof BatchWriteCommand)) return {};
    const unprocessed = (cmd.input.RequestItems![TABLE] as Put[]).filter(keep);
    return unprocessed.length > 0 ? { UnprocessedItems: { [TABLE]: unprocessed } } : {};
  };
  const seed = (ddb: MockDdb, children: SubIssueNode[]) => seedOrchestration({
    ddb: ddb as never,
    tableName: TABLE,
    parentIssueRef: 'PARENT',
    credentialsRef: 'WS',
    repo: 'o/r',
    children,
    now: NOW,
    releaseContext: RC,
  });

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('the seed sends them again, after a pause, and only them', async () => {
    const ddb = makeDdb();
    let answers = 0;
    ddb.send.mockImplementation(throttled((put) => put.PutRequest.Item.sub_issue_id === 'A' && (answers += 1) === 1));

    const seeding = seed(ddb, [child('A'), child('B', ['A'])]);
    await jest.advanceTimersByTimeAsync(99);
    expect(puts(ddb)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);

    expect((await seeding).rowsWritten).toBe(3);
    expect(puts(ddb).map(ids)).toEqual([['A', 'B'], ['A']]);
    expect(ddb.send.mock.calls.map((c) => c[0].constructor.name)).toEqual([
      'GetCommand', 'BatchWriteCommand', 'BatchWriteCommand', 'PutCommand',
    ]);
  });

  test('an extend sends them again before it counts the new rows on the meta row', async () => {
    const ddb = makeDdb();
    let answers = 0;
    ddb.send.mockImplementation(throttled((put) => put.PutRequest.Item.sub_issue_id === 'B' && (answers += 1) === 1));

    const extending = extendOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      graph: [child('A'), child('B')],
      now: NOW,
    });
    await jest.advanceTimersByTimeAsync(100);

    expect((await extending).addedSubIssueIds).toEqual(['A', 'B']);
    expect(puts(ddb).map(ids)).toEqual([['A', 'B'], ['B']]);
    const sent = ddb.send.mock.calls.map((c) => c[0].constructor.name);
    expect(sent).toEqual(['QueryCommand', 'BatchWriteCommand', 'BatchWriteCommand', 'UpdateCommand']);
  });

  test('rows that stay unprocessed fail the seed after five attempts, before any later row is sent', async () => {
    const ddb = makeDdb();
    ddb.send.mockImplementation(throttled((put) => put.PutRequest.Item.sub_issue_id === 'C7'));

    const outcome = seed(ddb, Array.from({ length: 30 }, (_, i) => child(`C${i}`)))
      .then(() => 'seeded', (err: Error) => err.message);
    await jest.advanceTimersByTimeAsync(100 + 200 + 400 + 800);

    expect(puts(ddb).map((batch) => batch.length)).toEqual([25, 1, 1, 1, 1]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(puts(ddb)).toHaveLength(5);
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
    expect(await outcome).toBe('1 orchestration row(s) were not written: DynamoDB left them unprocessed 5 times');
  });

  test.each([
    ['a first trigger', undefined, 'Could not persist the orchestration graph. Please re-apply the trigger.'],
    ['a re-trigger that adds a sub-issue', { sub_issue_id: '#meta' }, 'Could not extend the orchestration graph. Please re-apply the trigger.'],
  ])('what the caller of %s is told when rows stay unprocessed', async (_name, existingMeta, message) => {
    const ddb = makeDdb();
    const answer = throttled(() => true);
    ddb.send.mockImplementation(async (cmd: unknown) => (cmd instanceof GetCommand ? { Item: existingMeta } : answer(cmd)));

    const discovering = discoverOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      now: NOW,
      releaseContext: RC,
      graphSource: async () => ({ kind: 'ok', parentIssueId: 'PARENT', children: [child('A')] }),
    });
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await discovering).toEqual({ kind: 'error', message });
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(false);
  });

  test('a seed that gives up on a sub-issue stores no meta row, and the re-applied trigger seeds again', async () => {
    const rows = new Map<unknown, Record<string, unknown>>();
    let throttling = true;
    const ddb = makeDdb();
    ddb.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: rows.get(cmd.input.Key!.sub_issue_id) };
      if (cmd instanceof PutCommand) rows.set(cmd.input.Item!.sub_issue_id, cmd.input.Item!);
      if (!(cmd instanceof BatchWriteCommand)) return {};
      const sent = cmd.input.RequestItems![TABLE] as Put[];
      const unprocessed = sent.filter((put) => throttling && put.PutRequest.Item.sub_issue_id === 'A');
      for (const put of sent) {
        if (!unprocessed.includes(put)) rows.set(put.PutRequest.Item.sub_issue_id, put.PutRequest.Item);
      }
      return unprocessed.length > 0 ? { UnprocessedItems: { [TABLE]: unprocessed } } : {};
    });
    const children = [child('A'), child('B', ['A'])];

    const first = seed(ddb, children).then(() => 'seeded', (err: Error) => err.message);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await first).toBe('1 orchestration row(s) were not written: DynamoDB left them unprocessed 5 times');
    expect([...rows.keys()]).toEqual(['B']);

    throttling = false;
    expect(await seed(ddb, children)).toMatchObject({ alreadyExisted: false, rowsWritten: 3 });
    expect([...rows.keys()].sort()).toEqual(['#meta', 'A', 'B']);
  });

  test('the pause doubles: the third attempt comes 200 ms after the second', async () => {
    const ddb = makeDdb();
    ddb.send.mockImplementation(throttled((put) => put.PutRequest.Item.sub_issue_id === 'A'));
    const outcome = seed(ddb, [child('A')]).then(() => 'seeded', (err: Error) => err.message);

    await jest.advanceTimersByTimeAsync(100);
    expect(puts(ddb)).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(199);
    expect(puts(ddb)).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(puts(ddb)).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(puts(ddb)).toHaveLength(5);
    expect(await outcome).toMatch(/^1 orchestration row\(s\) were not written/);
  });
});

describe("seedOrchestration — the project's trigger label round-trips", () => {
  test('a supplied trigger_label is persisted on the meta row and read back', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: { ...RC, trigger_label: 'ship' },
    });

    const meta = metaRowOf(ddb);
    expect(meta.sub_issue_id).toBe('#meta');
    expect(meta.trigger_label).toBe('ship');
  });

  test('an absent trigger_label writes no attribute (older rows load fine)', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});
    await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    });
    const meta = metaRowOf(ddb);
    expect(meta.sub_issue_id).toBe('#meta');
    expect('trigger_label' in meta).toBe(false);
  });
});

describe('seedOrchestration — idempotent replay', () => {
  test('skips writing when a meta row already exists', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({ Item: { orchestration_id: 'x', sub_issue_id: '#meta' } });

    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A'), child('B', ['A'])],
      now: NOW,
      releaseContext: RC,
    });

    expect(result.alreadyExisted).toBe(true);
    expect(result.rowsWritten).toBe(0);
    expect(ddb.send).toHaveBeenCalledTimes(1);
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  test('a row that records the SAME owner is a replay, not a collision', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Item: {
        orchestration_id: 'x',
        sub_issue_id: '#meta',
        parent_issue_ref: 'PARENT',
        credentials_ref: 'WS',
      },
    });

    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    });

    expect(result.alreadyExisted).toBe(true);
  });

  test('recognises the owner under the LEGACY attribute names too', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Item: {
        orchestration_id: 'x',
        sub_issue_id: '#meta',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'OTHER-TENANT',
      },
    });

    await expect(seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    })).rejects.toThrow(OrchestrationIdCollisionError);
  });

  test('a legacy row with MATCHING legacy owner fields still replays', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Item: {
        orchestration_id: 'x',
        sub_issue_id: '#meta',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
      },
    });

    const result = await seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    });

    expect(result.alreadyExisted).toBe(true);
  });

  test('REFUSES to adopt an orchestration owned by a different tenant', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Item: {
        orchestration_id: 'x',
        sub_issue_id: '#meta',
        parent_issue_ref: 'PARENT',
        credentials_ref: 'OTHER-TENANT',
      },
    });

    await expect(seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    })).rejects.toThrow(OrchestrationIdCollisionError);

    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  test('REFUSES when the id is held by a different parent issue', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Item: {
        orchestration_id: 'x',
        sub_issue_id: '#meta',
        parent_issue_ref: 'SOME-OTHER-EPIC',
        credentials_ref: 'WS',
      },
    });

    await expect(seedOrchestration({
      ddb: ddb as never,
      tableName: TABLE,
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: RC,
    })).rejects.toThrow(OrchestrationIdCollisionError);
  });
});

describe('claimRollup — exactly-once parent rollup', () => {
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
    expect(cmd.input.ConditionExpression).toBeUndefined();
  });
});

describe('claimCommentAck — exactly-once per comment, so a redelivered webhook is deduped', () => {
  test('first delivery wins → true, conditional create-once on a per-comment SK + TTL', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({}) };
    const won = await claimCommentAck(ddb as never, TABLE, 'orch_1', 'cmt-9', NOW, 1781800000);
    expect(won).toBe(true);
    const cmd = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.Key).toMatchObject({ orchestration_id: 'orch_1', sub_issue_id: 'ack#cmt-9' });
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists(orchestration_id)');
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ':ttl': 1781800000 });
    // `ttl` is a DynamoDB reserved keyword: unaliased, the write fails with ValidationException.
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

describe('renamed row attributes stay readable across the rename', () => {
  const childRow = (extra: Record<string, unknown>) => ({
    orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', depends_on: [], child_status: 'succeeded', ...extra,
  });

  test('a row written BEFORE the rename (legacy names only) still loads', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          {
            orchestration_id: 'orch_1',
            sub_issue_id: '#meta',
            repo: 'o/r',
            platform_user_id: 'u1',
            child_count: 1,
            parent_linear_issue_id: 'P-old',
            linear_workspace_id: 'WS-old',
          },
          childRow({ parent_linear_issue_id: 'P-old', linear_workspace_id: 'WS-old', linear_identifier: 'ENG-1' }),
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.parent_issue_ref).toBe('P-old');
    expect(snap!.meta.credentials_ref).toBe('WS-old');
    expect(snap!.children[0].parent_issue_ref).toBe('P-old');
    expect(snap!.children[0].credentials_ref).toBe('WS-old');
    expect(snap!.children[0].display_id).toBe('ENG-1');
  });

  test('a row written AFTER the rename (neutral names only) loads too', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          {
            orchestration_id: 'orch_1',
            sub_issue_id: '#meta',
            repo: 'o/r',
            platform_user_id: 'u1',
            child_count: 1,
            parent_issue_ref: 'P-new',
            credentials_ref: 'WS-new',
          },
          childRow({ parent_issue_ref: 'P-new', credentials_ref: 'WS-new', display_id: 'ENG-2' }),
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.parent_issue_ref).toBe('P-new');
    expect(snap!.meta.credentials_ref).toBe('WS-new');
    expect(snap!.children[0].parent_issue_ref).toBe('P-new');
    expect(snap!.children[0].credentials_ref).toBe('WS-new');
    expect(snap!.children[0].display_id).toBe('ENG-2');
  });

  test('the neutral name wins when a row carries both', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          {
            orchestration_id: 'orch_1',
            sub_issue_id: '#meta',
            repo: 'o/r',
            platform_user_id: 'u1',
            child_count: 1,
            parent_issue_ref: 'P-new',
            parent_linear_issue_id: 'P-old',
            credentials_ref: 'WS-new',
            linear_workspace_id: 'WS-old',
          },
          childRow({ parent_issue_ref: 'P-new', parent_linear_issue_id: 'P-old' }),
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.parent_issue_ref).toBe('P-new');
    expect(snap!.meta.credentials_ref).toBe('WS-new');
    expect(snap!.children[0].parent_issue_ref).toBe('P-new');
  });
});

describe("loadOrchestration — the project's trigger label is hydrated", () => {
  test('a persisted trigger_label reaches release_context so the panel can name it', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValue({
        Items: [
          {
            orchestration_id: 'orch_1',
            sub_issue_id: '#meta',
            repo: 'o/r',
            platform_user_id: 'u1',
            child_count: 1,
            parent_issue_ref: 'P',
            credentials_ref: 'WS',
            trigger_label: 'ship',
          },
          {
            orchestration_id: 'orch_1',
            sub_issue_id: 'uuid-A',
            depends_on: [],
            child_status: 'succeeded',
            parent_issue_ref: 'P',
            credentials_ref: 'WS',
            repo: 'o/r',
          },
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.release_context.trigger_label).toBe('ship');
  });

  test('an absent trigger_label leaves release_context without one (older rows)', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValue({
        Items: [
          {
            orchestration_id: 'orch_1',
            sub_issue_id: '#meta',
            repo: 'o/r',
            platform_user_id: 'u1',
            child_count: 1,
            parent_issue_ref: 'P',
            credentials_ref: 'WS',
          },
          {
            orchestration_id: 'orch_1',
            sub_issue_id: 'uuid-A',
            depends_on: [],
            child_status: 'succeeded',
            parent_issue_ref: 'P',
            credentials_ref: 'WS',
            repo: 'o/r',
          },
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.release_context.trigger_label).toBeUndefined();
  });
});

describe("loadOrchestration — the meta row's own time stamp", () => {
  const metaRow = {
    orchestration_id: 'orch_1',
    sub_issue_id: '#meta',
    repo: 'o/r',
    platform_user_id: 'u1',
    child_count: 0,
    parent_issue_ref: 'P',
    credentials_ref: 'WS',
  };

  test('a meta row carries its updated_at', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({ Items: [{ ...metaRow, updated_at: NOW }] }) };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.updated_at).toBe(NOW);
  });

  test('a meta row without the attribute has no such member', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({ Items: [metaRow] }) };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta).not.toHaveProperty('updated_at');
  });
});

describe('loadOrchestration — dedup marker rows are not children', () => {
  test('excludes ack#<commentId> marker rows from children (only real sub-issues count)', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          { orchestration_id: 'orch_1', sub_issue_id: '#meta', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1', child_count: 2 },
          { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', depends_on: [], child_status: 'succeeded' },
          { orchestration_id: 'orch_1', sub_issue_id: 'orch_1__integration', depends_on: ['uuid-A'], child_status: 'succeeded' },
          { orchestration_id: 'orch_1', sub_issue_id: 'ack#cmt-9', acked_at: NOW, ttl: 1781800000 },
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap).not.toBeNull();
    const ids = snap!.children.map((c) => c.sub_issue_id).sort();
    expect(ids).toEqual(['orch_1__integration', 'uuid-A']);
  });

  test('round-trips pre_screened_attachments through the meta row', async () => {
    const att = {
      attachment_id: 'a1',
      type: 'file',
      content_type: 'application/pdf',
      filename: 'spec.pdf',
      s3_key: 'attachments/u1/epic-P/a1/spec.pdf',
      s3_version_id: 'v1',
      size_bytes: 42,
      screening: { status: 'passed', screened_at: NOW },
      checksum_sha256: 'x'.repeat(64),
    };
    const seedDdb = makeDdb();
    seedDdb.send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});
    await seedOrchestration({
      ddb: seedDdb as never,
      tableName: TABLE,
      parentIssueRef: 'P',
      credentialsRef: 'WS',
      repo: 'o/r',
      children: [child('A')],
      now: NOW,
      releaseContext: { platform_user_id: 'u1', pre_screened_attachments: [att as never] },
    });
    const metaPut = metaRowOf(seedDdb);
    expect(metaPut.sub_issue_id).toBe('#meta');
    expect(typeof metaPut.pre_screened_attachments_json).toBe('string');

    const loadDdb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          { orchestration_id: 'orch_1', sub_issue_id: '#meta', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1', child_count: 1, pre_screened_attachments_json: JSON.stringify([att]) },
          { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', depends_on: [], child_status: 'ready' },
        ],
      }),
    };
    const snap = await loadOrchestration(loadDdb as never, TABLE, 'orch_1');
    expect(snap!.meta.release_context.pre_screened_attachments).toHaveLength(1);
    expect(snap!.meta.release_context.pre_screened_attachments![0].s3_key).toBe('attachments/u1/epic-P/a1/spec.pdf');
  });

  test('a malformed pre_screened_attachments_json degrades to no attachments (best-effort)', async () => {
    const loadDdb = {
      send: jest.fn().mockResolvedValueOnce({
        Items: [
          { orchestration_id: 'orch_1', sub_issue_id: '#meta', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1', child_count: 1, pre_screened_attachments_json: '{not json' },
          { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', depends_on: [], child_status: 'ready' },
        ],
      }),
    };
    const snap = await loadOrchestration(loadDdb as never, TABLE, 'orch_1');
    expect(snap).not.toBeNull();
    expect(snap!.meta.release_context.pre_screened_attachments).toBeUndefined();
  });

  test('paginates a multi-page Query so a large epic is NOT truncated to one 1MB page', async () => {
    const ddb = {
      send: jest.fn()
        .mockResolvedValueOnce({
          Items: [
            { orchestration_id: 'orch_1', sub_issue_id: '#meta', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1', child_count: 2 },
            { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', depends_on: [], child_status: 'succeeded' },
          ],
          LastEvaluatedKey: { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A' },
        })
        .mockResolvedValueOnce({
          Items: [
            { orchestration_id: 'orch_1', sub_issue_id: 'uuid-B', depends_on: ['uuid-A'], child_status: 'blocked' },
          ],
        }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(ddb.send).toHaveBeenCalledTimes(2);
    expect(snap).not.toBeNull();
    expect(snap!.children.map((c) => c.sub_issue_id).sort()).toEqual(['uuid-A', 'uuid-B']);
    const secondCall = ddb.send.mock.calls[1][0] as QueryCommand;
    expect((secondCall.input as { ExclusiveStartKey?: unknown }).ExclusiveStartKey).toEqual({
      orchestration_id: 'orch_1', sub_issue_id: 'uuid-A',
    });
  });
});

describe('loadOrchestration — "rows but no meta" is only alarming with a real child', () => {
  const loggerMock = jest.requireMock('../../../src/handlers/shared/logger').logger as {
    info: jest.Mock; warn: jest.Mock; error: jest.Mock;
  };
  beforeEach(() => { loggerMock.info.mockClear(); loggerMock.warn.mockClear(); });

  test('marker rows only → info, not warn', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Items: [{ orchestration_id: 'orch_1', sub_issue_id: 'ack#help', acked_at: NOW }],
    });

    expect(await loadOrchestration(ddb as never, TABLE, 'orch_1')).toBeNull();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.stringContaining('only dedup markers'), expect.anything(),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  test('a REAL child row with no meta is the genuinely inconsistent case → warn', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Items: [
        { orchestration_id: 'orch_1', sub_issue_id: 'ack#help', acked_at: NOW },
        { orchestration_id: 'orch_1', sub_issue_id: 'uuid-A', child_status: 'ready', depends_on: [] },
      ],
    });

    expect(await loadOrchestration(ddb as never, TABLE, 'orch_1')).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('meta row is missing'), expect.anything(),
    );
  });
});

describe('setRetryCommentId — remember the retry comment awaiting an outcome', () => {
  test('records the comment id on the meta row', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({});

    await setRetryCommentId(ddb as never, TABLE, 'orch_1', 'retry-cmt-1');

    const cmd = ddb.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(cmd.input.Key).toEqual({ orchestration_id: 'orch_1', sub_issue_id: '#meta' });
    expect(cmd.input.UpdateExpression).toBe('SET retry_comment_id = :cid');
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ':cid': 'retry-cmt-1' });
  });

  test('clearing REMOVEs it, so a later settle cannot re-answer an answered comment', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({});

    await setRetryCommentId(ddb as never, TABLE, 'orch_1', undefined);

    const cmd = ddb.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(cmd.input.UpdateExpression).toBe('REMOVE retry_comment_id');
    // DynamoDB rejects an ExpressionAttributeValues entry that no expression uses.
    expect(cmd.input.ExpressionAttributeValues).toBeUndefined();
  });

  test('loadOrchestration surfaces it on the meta snapshot', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Items: [{
        orchestration_id: 'orch_1',
        sub_issue_id: '#meta',
        parent_issue_ref: 'PARENT',
        credentials_ref: 'WS',
        repo: 'o/r',
        child_count: 1,
        platform_user_id: 'u1',
        retry_comment_id: 'retry-cmt-1',
      }],
    });

    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap?.meta.retry_comment_id).toBe('retry-cmt-1');
  });
});

describe('findOrchestrationChildByBranch — map a PR branch back to its child row', () => {
  test('queries the ChildBranchIndex GSI by branch and returns the child row', async () => {
    const ddb = makeDdb();
    const row = { orchestration_id: 'orch_1', sub_issue_id: 'SUB-A', child_branch_name: 'bgagent/01T/abca-1-x' };
    ddb.send.mockResolvedValueOnce({ Items: [row] });

    const result = await findOrchestrationChildByBranch(
      ddb as never, TABLE, 'ChildBranchIndex', 'bgagent/01T/abca-1-x',
    );

    expect(result).toEqual({ ...row, parent_issue_ref: '', credentials_ref: '' });
    const cmd = ddb.send.mock.calls[0][0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe('ChildBranchIndex');
    expect(cmd.input.KeyConditionExpression).toBe('child_branch_name = :b');
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ':b': 'bgagent/01T/abca-1-x' });
    expect(cmd.input.Limit).toBe(1);
  });

  test('marshals the row, so a pre-rename row still yields its parent + credentials refs', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce({
      Items: [{
        orchestration_id: 'orch_1',
        sub_issue_id: 'SUB-A',
        child_branch_name: 'bgagent/01T/abca-1-x',
        parent_linear_issue_id: 'parent-uuid-1',
        linear_workspace_id: 'ws-uuid-1',
        linear_identifier: 'ABCA-1',
      }],
    });

    const result = await findOrchestrationChildByBranch(
      ddb as never, TABLE, 'ChildBranchIndex', 'bgagent/01T/abca-1-x',
    );

    expect(result).toMatchObject({
      parent_issue_ref: 'parent-uuid-1',
      credentials_ref: 'ws-uuid-1',
      display_id: 'ABCA-1',
    });
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

  function existing(children: Array<{ id: string; deps?: string[]; status: string; title?: string; description?: string }>) {
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
      ...(c.title !== undefined && { title: c.title }),
      ...(c.description !== undefined && { description: c.description }),
      created_at: NOW,
      updated_at: NOW,
    }));
    return { Items: [meta, ...rows] };
  }

  function extendParams(graph: SubIssueNode[]) {
    return {
      tableName: TABLE,
      parentIssueRef: PARENT,
      credentialsRef: 'WS',
      repo: 'o/r',
      graph,
      now: NOW,
    };
  }

  test('adds a NEW node blocked-by a finished node → releasable immediately', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A'], { title: 'UI' })]),
    });
    expect(result.addedSubIssueIds).toEqual(['B']);
    expect(result.releasableSubIssueIds).toEqual(['B']);
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; child_status: string } } }>)[0].PutRequest.Item;
    expect(written.sub_issue_id).toBe('B');
    expect(written.child_status).toBe('ready');
  });

  test('persists adapter metadata on a newly-added node', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([
        child('A'),
        child('B', ['A'], {
          channel_metadata: {
            jira_cloud_id: 'cloud-1',
            jira_issue_key: 'ENG-2',
          },
        }),
      ]),
    });

    const bw = ddb.send.mock.calls.find((call) => call[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{
      PutRequest: { Item: Record<string, unknown> };
    }>)[0].PutRequest.Item;
    expect(written.channel_metadata).toEqual({
      jira_cloud_id: 'cloud-1',
      jira_issue_key: 'ENG-2',
    });
  });

  test('adds a NEW node whose predecessor is NOT yet done → blocked, not releasable', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'released' }]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A'])]),
    });
    expect(result.addedSubIssueIds).toEqual(['B']);
    expect(result.releasableSubIssueIds).toEqual([]);
  });

  test('new UNCONSTRAINED node → implicit depends_on = epic tip (linear chain → its leaf)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'A', status: 'succeeded' },
        { id: 'B', deps: ['A'], status: 'succeeded' },
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A']), child('C', [], { title: 'New step' })]),
    });
    expect(result.addedSubIssueIds).toEqual(['C']);
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; depends_on: string[]; child_status: string } } }>)[0].PutRequest.Item;
    expect(written.sub_issue_id).toBe('C');
    expect(written.depends_on).toEqual(['B']);
    expect(written.child_status).toBe('ready');
    expect(result.releasableSubIssueIds).toEqual(['C']);
  });

  test('new unconstrained node, tip NOT done → blocked on the tip (stacks, waits)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([{ id: 'A', status: 'released' }]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', [])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { depends_on: string[]; child_status: string } } }>)[0].PutRequest.Item;
    expect(written.depends_on).toEqual(['A']);
    expect(written.child_status).toBe('blocked');
    expect(result.releasableSubIssueIds).toEqual([]);
  });

  test('new unconstrained node after a failure → stacks on the work that succeeded and starts', async () => {
    const INTEGRATION = `${ORCH}__integration`;
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'A', status: 'failed' },
        { id: 'B', status: 'succeeded' },
        { id: INTEGRATION, deps: ['A', 'B'], status: 'skipped' },
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B'), child('C'), child(INTEGRATION, ['A', 'B', 'C'])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; depends_on: string[]; child_status: string } } }>)
      .map((request) => request.PutRequest.Item);
    expect(written.map((row) => [row.sub_issue_id, row.depends_on, row.child_status])).toEqual([['C', ['B'], 'ready']]);
    expect(result.releasableSubIssueIds).toEqual(['C']);
  });

  test('new unconstrained node on a fan-out epic → diamond implicit deps (all leaves)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'R', status: 'succeeded' },
        { id: 'B', deps: ['R'], status: 'succeeded' },
        { id: 'C', deps: ['R'], status: 'succeeded' },
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('R'), child('B', ['R']), child('C', ['R']), child('D', [])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { sub_issue_id: string; depends_on: string[] } } }>)[0].PutRequest.Item;
    expect(written.depends_on).toEqual(['B', 'C']);
    expect(result.releasableSubIssueIds).toEqual(['D']);
  });

  test('new node WITH an explicit dependency keeps it (user intent wins over the tip)', async () => {
    const ddb = makeDdb();
    ddb.send
      .mockResolvedValueOnce(existing([
        { id: 'A', status: 'succeeded' },
        { id: 'B', deps: ['A'], status: 'succeeded' },
      ]))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await extendOrchestration({
      ddb: ddb as never,
      ...extendParams([child('A'), child('B', ['A']), child('C', ['A'])]),
    });
    const bw = ddb.send.mock.calls.find((c) => c[0] instanceof BatchWriteCommand)![0];
    const written = (bw.input.RequestItems[TABLE] as Array<{ PutRequest: { Item: { depends_on: string[] } } }>)[0].PutRequest.Item;
    expect(written.depends_on).toEqual(['A']);
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
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof BatchWriteCommand)).toHaveLength(0);
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
  });

  test('a new edge that introduces a CYCLE → rejected, nothing written', async () => {
    const ddb = makeDdb();
    ddb.send.mockResolvedValueOnce(existing([
      { id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'succeeded' },
    ]));
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
    ddb.send.mockResolvedValueOnce({ Items: [] });
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
    expect(upd.input.ExpressionAttributeValues[':n']).toBe(4);
  });

  test('clears rollup_posted_at so an epic extended after completion can roll up again', async () => {
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
    expect(upd.input.UpdateExpression).toContain('REMOVE rollup_posted_at');
  });

  describe('the integration node of an extend follows the edges as they are stored', () => {
    const INTEGRATION = `${ORCH}__integration`;
    const written = (ddb: MockDdb) => ddb.send.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd instanceof BatchWriteCommand)
      .flatMap((cmd) => (cmd.input.RequestItems![TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>)
        .map((request) => request.PutRequest.Item));

    test('one step added to a finished chain adds one row: it IS the combined result', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'succeeded' }]))
        .mockResolvedValue({});
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A'), child('B', ['A']), child('C'), child(INTEGRATION, ['B', 'C'])]),
      });

      expect(result.addedSubIssueIds).toEqual(['C']);
      expect(result.releasableSubIssueIds).toEqual(['C']);
      expect(written(ddb).map((row) => [row.sub_issue_id, row.depends_on])).toEqual([['C', ['B']]]);
      const meta = ddb.send.mock.calls.find((c) => c[0] instanceof UpdateCommand)![0];
      expect(meta.input.ExpressionAttributeValues[':n']).toBe(3);
    });

    test('two steps added side by side are combined, and the tip they stack on is not merged again', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'succeeded' }]))
        .mockResolvedValue({});
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A'), child('B', ['A']), child('C'), child('D'), child(INTEGRATION, ['B', 'C', 'D'])]),
      });

      expect(result.addedSubIssueIds).toEqual(['C', 'D', INTEGRATION]);
      expect(result.releasableSubIssueIds).toEqual(['C', 'D']);
      expect(written(ddb).map((row) => [row.sub_issue_id, row.depends_on, row.child_status])).toEqual([
        ['C', ['B'], 'ready'],
        ['D', ['B'], 'ready'],
        [INTEGRATION, ['C', 'D'], 'blocked'],
      ]);
    });

    test('a later re-trigger of the extended chain adds nothing', async () => {
      const ddb = makeDdb();
      ddb.send.mockResolvedValueOnce(existing([
        { id: 'A', status: 'succeeded' },
        { id: 'B', deps: ['A'], status: 'succeeded' },
        { id: 'C', deps: ['B'], status: 'released' },
      ]));
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A'), child('B', ['A']), child('C'), child(INTEGRATION, ['B', 'C'])]),
      });

      expect(result).toEqual({ orchestrationId: ORCH, addedSubIssueIds: [], releasableSubIssueIds: [] });
      expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    test('a step added to a chain whose last step failed builds on the step in front of it, and is combined later', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'failed' }]))
        .mockResolvedValue({});
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A'), child('B', ['A']), child('C'), child(INTEGRATION, ['B', 'C'])]),
      });

      expect(result.releasableSubIssueIds).toEqual(['C']);
      expect(written(ddb).map((row) => [row.sub_issue_id, row.depends_on, row.child_status])).toEqual([
        ['C', ['A'], 'ready'],
        [INTEGRATION, ['B', 'C'], 'blocked'],
      ]);
    });

    test('a new node that declares its own edge and makes a second leaf gets the integration node', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'succeeded' }, { id: 'B', deps: ['A'], status: 'succeeded' }]))
        .mockResolvedValue({});
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A'), child('B', ['A']), child('C', ['A']), child(INTEGRATION, ['B', 'C'])]),
      });

      expect(result.addedSubIssueIds).toEqual(['C', INTEGRATION]);
      expect(written(ddb).map((row) => [row.sub_issue_id, row.depends_on])).toEqual([
        ['C', ['A']],
        [INTEGRATION, ['B', 'C']],
      ]);
    });
  });

  describe('the text of a sub-issue that has not started is read again', () => {
    const textUpdates = (ddb: MockDdb) => ddb.send.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is UpdateCommand => cmd instanceof UpdateCommand && cmd.input.Key?.sub_issue_id !== '#meta');

    test('a reworded sub-issue that failed is stored with its new title and description', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([
          { id: 'A', status: 'succeeded', title: 'First step', description: 'as it ran' },
          { id: 'B', deps: ['A'], status: 'failed', title: 'old title', description: 'old text' },
        ]))
        .mockResolvedValueOnce({});
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([
          child('A', [], { title: 'First step, renamed', description: 'changed after it ran' }),
          child('B', ['A'], { title: 'new title', description: 'new text' }),
        ]),
      });

      expect(result.addedSubIssueIds).toEqual([]);
      const updates = textUpdates(ddb);
      expect(updates).toHaveLength(1);
      expect(updates[0].input).toEqual({
        TableName: TABLE,
        Key: { orchestration_id: ORCH, sub_issue_id: 'B' },
        UpdateExpression: 'SET #title = :title, #description = :description',
        ConditionExpression: 'child_status IN (:blocked, :ready, :failed, :skipped)',
        ExpressionAttributeNames: { '#title': 'title', '#description': 'description' },
        ExpressionAttributeValues: {
          ':title': 'new title',
          ':description': 'new text',
          ':blocked': 'blocked',
          ':ready': 'ready',
          ':failed': 'failed',
          ':skipped': 'skipped',
        },
      });
    });

    test.each(['blocked', 'ready', 'skipped'])('a %s sub-issue is refreshed as well', async (status) => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status, title: 'old title' }]))
        .mockResolvedValueOnce({});
      await extendOrchestration({ ddb: ddb as never, ...extendParams([child('A', [], { title: 'new title' })]) });
      expect(textUpdates(ddb).map((u) => u.input.ExpressionAttributeValues![':title'])).toEqual(['new title']);
    });

    test.each(['releasing', 'released', 'succeeded'])('a %s sub-issue keeps the text its task was started with', async (status) => {
      const ddb = makeDdb();
      ddb.send.mockResolvedValueOnce(existing([{ id: 'A', status, title: 'old title', description: 'old text' }]));
      await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A', [], { title: 'new title', description: 'new text' })]),
      });
      expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    test('a description that was deleted is removed from the row', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'failed', title: 'Same title', description: 'old text' }]))
        .mockResolvedValueOnce({});
      await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A', [], { title: 'Same title', description: '' })]),
      });
      const [update] = textUpdates(ddb);
      expect(update.input.UpdateExpression).toBe('SET #title = :title REMOVE #description');
      expect(update.input.ExpressionAttributeValues).not.toHaveProperty(':description');
    });

    test('text that did not change is not written', async () => {
      const ddb = makeDdb();
      ddb.send.mockResolvedValueOnce(existing([
        { id: 'A', status: 'failed', title: 'Same title', description: 'same text' },
        { id: 'B', status: 'blocked', title: 'No description' },
      ]));
      await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([
          child('A', [], { title: 'Same title', description: 'same text' }),
          child('B', [], { title: 'No description', description: '' }),
        ]),
      });
      expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    test('a sub-issue that was started while the graph was read is left as it is', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([
          { id: 'A', status: 'ready', title: 'old title' },
          { id: 'B', status: 'failed', title: 'old title' },
        ]))
        .mockRejectedValueOnce(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }))
        .mockResolvedValueOnce({});
      const result = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A', [], { title: 'new title' }), child('B', [], { title: 'new title' })]),
      });
      expect(result.addedSubIssueIds).toEqual([]);
      expect(textUpdates(ddb).map((u) => u.input.Key!.sub_issue_id)).toEqual(['A', 'B']);
    });

    test('a write that fails for another reason fails the extend, so the caller does not retry on old text', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'failed', title: 'old title' }]))
        .mockRejectedValueOnce(new Error('throttled'));
      await expect(extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A', [], { title: 'new title' })]),
      })).rejects.toThrow('throttled');
    });

    test('an extend that adds a node refreshes the others too, and a rejected one writes nothing', async () => {
      const ddb = makeDdb();
      ddb.send
        .mockResolvedValueOnce(existing([{ id: 'A', status: 'failed', title: 'old title' }]))
        .mockResolvedValue({});
      const added = await extendOrchestration({
        ddb: ddb as never,
        ...extendParams([child('A', [], { title: 'new title' }), child('B', ['A'])]),
      });
      expect(added.addedSubIssueIds).toEqual(['B']);
      expect(textUpdates(ddb).map((u) => u.input.Key!.sub_issue_id)).toEqual(['A']);

      const rejecting = makeDdb();
      rejecting.send.mockResolvedValueOnce(existing([{ id: 'A', status: 'failed', title: 'old title' }]));
      const rejected = await extendOrchestration({
        ddb: rejecting as never,
        ...extendParams([child('A', ['B'], { title: 'new title' }), child('B', ['A'])]),
      });
      expect(rejected.rejected?.reason).toBe('cycle');
      expect(rejecting.send).toHaveBeenCalledTimes(1);
    });
  });
});
