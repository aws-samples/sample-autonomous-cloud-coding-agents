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

import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  consumePendingPlan,
  discardPendingPlan,
  getPendingPlan,
  PENDING_PLAN_SK,
  putPendingPlan,
  replacePendingPlan,
} from '../../../src/handlers/shared/orchestration-decomposition-store';
import type { PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';
import { deriveOrchestrationId } from '../../../src/handlers/shared/orchestration-store';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PARENT = 'issue-uuid-1';
const NOW = '2026-06-23T12:00:00.000Z';
const TTL = 1_800_000_000;

const NODES: PlannedSubIssue[] = [
  { title: 'A', description: 'a', size: 'S', max_budget_usd: 1, depends_on: [] },
  { title: 'B', description: 'b', size: 'M', max_budget_usd: 3, depends_on: [0] },
];

function conditionalFail() {
  return Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
}

describe('putPendingPlan — create-once', () => {
  test('first write succeeds, returns true, keyed on derived id + #pending-plan', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const ok = await putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      proposalCommentId: 'c-1',
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    expect(ok).toBe(true);
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.Item!.orchestration_id).toBe(deriveOrchestrationId(PARENT));
    expect(cmd.input.Item!.sub_issue_id).toBe(PENDING_PLAN_SK);
    expect(cmd.input.Item!.nodes).toEqual(NODES);
    expect(cmd.input.Item!.ttl).toBe(TTL);
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists');
  });

  test('redelivery (row exists) returns false, no throw', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(conditionalFail()) };
    const ok = await putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    expect(ok).toBe(false);
  });

  test('a non-conditional error propagates', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(new Error('throttle')) };
    await expect(putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      now: NOW,
      ttlEpochSeconds: TTL,
    })).rejects.toThrow('throttle');
  });

  test('omits proposal_comment_id when not provided', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect(cmd.input.Item!.proposal_comment_id).toBeUndefined();
  });

  test('records revision_round when provided', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      revisionRound: 0,
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect(cmd.input.Item!.revision_round).toBe(0);
  });

  test('#299 T2: persists repo_digest + repo_digest_sha when provided; round-trips via getPendingPlan', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      repoDigest: 'modules: api/, ui/; tests in test/',
      repoDigestSha: 'a1b2c3d4e5f6',
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect(cmd.input.Item!.repo_digest).toBe('modules: api/, ui/; tests in test/');
    expect(cmd.input.Item!.repo_digest_sha).toBe('a1b2c3d4e5f6');
  });

  test('#299 T2: repo_digest fields are omitted when not provided (no undefined attrs)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await putPendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect('repo_digest' in cmd.input.Item!).toBe(false);
    expect('repo_digest_sha' in cmd.input.Item!).toBe(false);
  });
});

describe('replacePendingPlan — unconditional upsert (#299 revise loop)', () => {
  test('overwrites the prior plan (NO attribute_not_exists condition) and returns true', async () => {
    // The whole point: a revision MUST replace the create-once row, else approve
    // seeds the stale plan the reviewer asked to change.
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const ok = await replacePendingPlan({
      ddb: ddb as never,
      tableName: 'OrchTable',
      parentLinearIssueId: PARENT,
      linearWorkspaceId: 'WS',
      repo: 'owner/repo',
      nodes: NODES,
      platformUserId: 'u1',
      proposalCommentId: 'c-2',
      revisionRound: 2,
      now: NOW,
      ttlEpochSeconds: TTL,
    });
    expect(ok).toBe(true);
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.ConditionExpression).toBeUndefined(); // unconditional
    expect(cmd.input.Item!.orchestration_id).toBe(deriveOrchestrationId(PARENT));
    expect(cmd.input.Item!.nodes).toEqual(NODES);
    expect(cmd.input.Item!.revision_round).toBe(2);
  });
});

describe('getPendingPlan — read-only', () => {
  test('returns the parsed plan when present', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValue({
        Item: {
          orchestration_id: deriveOrchestrationId(PARENT),
          parent_linear_issue_id: PARENT,
          linear_workspace_id: 'WS',
          repo: 'owner/repo',
          nodes: NODES,
          platform_user_id: 'u1',
          proposal_comment_id: 'c-1',
          repo_digest: 'modules: api/, ui/',
          repo_digest_sha: 'a1b2c3d4',
          created_at: NOW,
        },
      }),
    };
    const plan = await getPendingPlan(ddb as never, 'OrchTable', PARENT);
    expect(plan).toBeDefined();
    expect(plan!.nodes).toEqual(NODES);
    expect(plan!.platform_user_id).toBe('u1');
    expect(plan!.proposal_comment_id).toBe('c-1');
    // #299 T2: the cached digest + sha round-trip so the revise path can reuse them.
    expect(plan!.repo_digest).toBe('modules: api/, ui/');
    expect(plan!.repo_digest_sha).toBe('a1b2c3d4');
  });

  test('returns undefined when absent', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    expect(await getPendingPlan(ddb as never, 'OrchTable', PARENT)).toBeUndefined();
  });
});

describe('consumePendingPlan — atomic take (approve path)', () => {
  test('deletes the row and returns its contents (the delete winner)', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValue({
        Attributes: {
          orchestration_id: deriveOrchestrationId(PARENT),
          parent_linear_issue_id: PARENT,
          linear_workspace_id: 'WS',
          repo: 'owner/repo',
          nodes: NODES,
          platform_user_id: 'u1',
          created_at: NOW,
        },
      }),
    };
    const plan = await consumePendingPlan(ddb as never, 'OrchTable', PARENT);
    expect(plan).toBeDefined();
    expect(plan!.nodes).toEqual(NODES);
    const cmd = ddb.send.mock.calls[0][0] as DeleteCommand;
    expect(cmd).toBeInstanceOf(DeleteCommand);
    expect(cmd.input.ConditionExpression).toContain('attribute_exists');
    expect(cmd.input.ReturnValues).toBe('ALL_OLD');
  });

  test('a racing second approve (already deleted) returns undefined, no throw', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(conditionalFail()) };
    expect(await consumePendingPlan(ddb as never, 'OrchTable', PARENT)).toBeUndefined();
  });

  test('a non-conditional error propagates', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(new Error('throttle')) };
    await expect(consumePendingPlan(ddb as never, 'OrchTable', PARENT)).rejects.toThrow('throttle');
  });
});

describe('discardPendingPlan — reject path', () => {
  test('issues an unconditional delete (idempotent)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await discardPendingPlan(ddb as never, 'OrchTable', PARENT);
    const cmd = ddb.send.mock.calls[0][0] as DeleteCommand;
    expect(cmd).toBeInstanceOf(DeleteCommand);
    expect(cmd.input.Key!.sub_issue_id).toBe(PENDING_PLAN_SK);
    expect(cmd.input.ConditionExpression).toBeUndefined();
  });
});
