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
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
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

  test('PM-4: persists the planner description onto the child row (and omits an empty one)', async () => {
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
        child('B', [], { title: 'No scope' }), // no description
      ],
      now: NOW,
      releaseContext: RC,
    });

    const puts = ddb.send.mock.calls[1][0].input.RequestItems[TABLE] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
    const a = puts.find((p) => p.PutRequest.Item.sub_issue_id === 'A')!.PutRequest.Item;
    const b = puts.find((p) => p.PutRequest.Item.sub_issue_id === 'B')!.PutRequest.Item;
    expect(a.description).toBe('Create `dashboard.html` at the root.');
    expect(b).not.toHaveProperty('description'); // absent, not an empty string
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
    ddb.send.mockResolvedValue({}); // Get + all batches
    ddb.send.mockResolvedValueOnce({ Item: undefined }); // first call = Get

    // 30 children + 1 meta = 31 rows → 2 batches (25 + 6).
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
    // 1 Get + 2 BatchWrite = 3 sends.
    expect(ddb.send).toHaveBeenCalledTimes(3);
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
  });

  test('persists channel_source on the meta row when supplied (#247 trigger-agnostic)', async () => {
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
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
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
      parentIssueRef: 'PARENT',
      credentialsRef: 'WS',
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
    // A row written before the neutral names existed still records who owns it.
    // Reading only the new names would see "no owner recorded" and wave a genuine
    // cross-tenant collision through, so this fixture is a legacy row whose owner
    // DIFFERS — the case that distinguishes reading both names from reading one.
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
    // The id is derived from the parent ref alone, so a surface whose refs are
    // only project-unique would let two tenants derive the same id — and the
    // replay gate would hand the second one the first one's children, releasing
    // work against the other tenant's repo under the other tenant's credentials.
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

    // Nothing written — refusing must not half-seed.
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

describe('renamed row attributes stay readable across the rename', () => {
  // Rows already in the table outlive the deploy that renames an attribute, so an
  // epic mid-flight when the rename ships must still load and settle. These pin
  // BOTH spellings, and the fact that a row carrying only the legacy names loads
  // is the actual back-compat guarantee.
  const child = (extra: Record<string, unknown>) => ({
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
          child({ parent_linear_issue_id: 'P-old', linear_workspace_id: 'WS-old', linear_identifier: 'ENG-1' }),
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
          child({ parent_issue_ref: 'P-new', credentials_ref: 'WS-new', display_id: 'ENG-2' }),
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
          child({ parent_issue_ref: 'P-new', parent_linear_issue_id: 'P-old' }),
        ],
      }),
    };
    const snap = await loadOrchestration(ddb as never, TABLE, 'orch_1');
    expect(snap!.meta.parent_issue_ref).toBe('P-new');
    expect(snap!.meta.credentials_ref).toBe('WS-new');
    expect(snap!.children[0].parent_issue_ref).toBe('P-new');
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

  test('round-trips pre_screened_attachments through the meta row (finding #1)', async () => {
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
    // Seed writes the JSON string onto the meta row.
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
    const batch = seedDdb.send.mock.calls[1][0];
    const metaPut = batch.input.RequestItems[TABLE].map((r: { PutRequest: { Item: Record<string, unknown> } }) => r.PutRequest.Item)
      .find((i: Record<string, unknown>) => i.sub_issue_id === '#meta');
    expect(typeof metaPut.pre_screened_attachments_json).toBe('string');

    // Load parses it back into release_context.pre_screened_attachments.
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
    // A single Query returns at most 1MB; a large epic (many children + ack#
    // markers) would otherwise silently drop children → mis-settle/strand. Two
    // pages: the first returns the meta + child A with a LastEvaluatedKey, the
    // second returns child B and no key. Both children must appear.
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
    expect(ddb.send).toHaveBeenCalledTimes(2); // followed LastEvaluatedKey
    expect(snap).not.toBeNull();
    expect(snap!.children.map((c) => c.sub_issue_id).sort()).toEqual(['uuid-A', 'uuid-B']);
    // 2nd Query carried ExclusiveStartKey from the 1st page's LastEvaluatedKey.
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

  // A never-decomposed issue still accumulates dedup MARKER rows (`ack#…`) under the
  // same derived id, so this state is NORMAL for it — a plain `@bgagent` on any such
  // issue reaches it. Warning there cried wolf on a healthy path.
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
    // No stray value binding on a REMOVE — DynamoDB rejects unused ones.
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

describe('findOrchestrationChildByBranch (#305 A6)', () => {
  test('queries the ChildBranchIndex GSI by branch and returns the child row', async () => {
    const ddb = makeDdb();
    const row = { orchestration_id: 'orch_1', sub_issue_id: 'SUB-A', child_branch_name: 'bgagent/01T/abca-1-x' };
    ddb.send.mockResolvedValueOnce({ Items: [row] });

    const result = await findOrchestrationChildByBranch(
      ddb as never, TABLE, 'ChildBranchIndex', 'bgagent/01T/abca-1-x',
    );

    // Marshalled, so the neutral refs are always present (empty when the row
    // carried neither naming, as this minimal fixture does).
    expect(result).toEqual({ ...row, parent_issue_ref: '', credentials_ref: '' });
    const cmd = ddb.send.mock.calls[0][0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe('ChildBranchIndex');
    expect(cmd.input.KeyConditionExpression).toBe('child_branch_name = :b');
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ':b': 'bgagent/01T/abca-1-x' });
    expect(cmd.input.Limit).toBe(1);
  });

  test('marshals the row, so a pre-rename row still yields its parent + credentials refs', async () => {
    // A raw cast type-checked while leaving the renamed attributes unread, which
    // would hand the caller a row with empty refs rather than failing visibly.
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
      parentIssueRef: PARENT,
      credentialsRef: 'WS',
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
