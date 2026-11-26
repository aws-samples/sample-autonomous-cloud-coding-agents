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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  AGENT_SESSION_EVIDENCE_TTL_MS,
  lookupLinearProjectMapping,
  readSessionTaskPointer,
  recordWorkspaceAgentSession,
  resetSessionWorkspaceCacheForTests,
  workspaceDeliversAgentSessions,
  writeSessionTaskPointer,
} from '../../../src/handlers/shared/linear-channel-metadata';

const send = jest.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;
const inputs = (): Array<Record<string, any>> => send.mock.calls.map((c) => c[0].input);
const conditionFailed = () => Object.assign(new Error('cc'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  resetSessionWorkspaceCacheForTests();
});

describe('lookupLinearProjectMapping', () => {
  const row = { linear_project_id: 'p-1', repo: 'acme/web', status: 'active', linear_workspace_id: 'org-1' };

  test('an active mapping owned by the delivering workspace is mapped and verified', async () => {
    send.mockResolvedValue({ Item: row });
    await expect(lookupLinearProjectMapping(ddb, 'Projects', 'p-1', 'org-1'))
      .resolves.toEqual({ kind: 'mapped', item: row, ownerVerified: true });
  });

  test('a mapping owned by another workspace is foreign', async () => {
    send.mockResolvedValue({ Item: row });
    await expect(lookupLinearProjectMapping(ddb, 'Projects', 'p-1', 'org-2'))
      .resolves.toEqual({ kind: 'foreign', mappedWorkspaceId: 'org-1' });
  });

  test('a mapping that predates the owning-workspace field is mapped but unverified', async () => {
    const { linear_workspace_id: _owner, ...legacy } = row;
    send.mockResolvedValue({ Item: legacy });
    await expect(lookupLinearProjectMapping(ddb, 'Projects', 'p-1', 'org-1'))
      .resolves.toEqual({ kind: 'mapped', item: legacy, ownerVerified: false });
  });

  test.each([
    ['no row', undefined],
    ['an inactive row', { ...row, status: 'removed' }],
  ])('%s is none', async (_name, item) => {
    send.mockResolvedValue({ Item: item });
    await expect(lookupLinearProjectMapping(ddb, 'Projects', 'p-1', 'org-1')).resolves.toEqual({ kind: 'none' });
  });

  test('an issue with no project is none, without a read', async () => {
    await expect(lookupLinearProjectMapping(ddb, 'Projects', null, 'org-1')).resolves.toEqual({ kind: 'none' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('session → task pointer', () => {
  test('is written under the issue with a short TTL and read back consistently', async () => {
    await writeSessionTaskPointer(ddb, 'Dedup', { issueId: 'issue-1', taskId: 't-1' }, 1_000);
    expect(inputs()[0]).toEqual({
      TableName: 'Dedup',
      Item: { dedup_key: 'agent-session-task#issue-1', task_id: 't-1', ttl: 1_600 },
    });

    send.mockResolvedValue({ Item: { task_id: 't-1', ttl: 1_600 } });
    await expect(readSessionTaskPointer(ddb, 'Dedup', 'issue-1', 1_100)).resolves.toBe('t-1');
    expect(inputs()[1]).toEqual(expect.objectContaining({
      Key: { dedup_key: 'agent-session-task#issue-1' }, ConsistentRead: true,
    }));
  });

  test('an expired pointer DynamoDB has not deleted yet is ignored', async () => {
    send.mockResolvedValue({ Item: { task_id: 't-1', ttl: 1_600 } });
    await expect(readSessionTaskPointer(ddb, 'Dedup', 'issue-1', 1_601)).resolves.toBeNull();
  });

  test('no pointer reads as null', async () => {
    await expect(readSessionTaskPointer(ddb, 'Dedup', 'issue-1')).resolves.toBeNull();
  });

  test('a failed write is swallowed: the task must still be created', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(writeSessionTaskPointer(ddb, 'Dedup', { issueId: 'issue-1', taskId: 't-1' })).resolves.toBeUndefined();
  });

  test('a failed read propagates: guessing "no task" could start a duplicate', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(readSessionTaskPointer(ddb, 'Dedup', 'issue-1')).rejects.toThrow('throttled');
  });
});

describe('per-workspace agent-session marker', () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const seenAt = (ms: number) => ({ Item: { agent_sessions_seen_at: new Date(ms).toISOString() } });

  test('a session event stamps the registry row, refreshing a marker older than a day', async () => {
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW);
    expect(inputs()[0]).toEqual(expect.objectContaining({
      Key: { linear_workspace_id: 'org-1' },
      UpdateExpression: 'SET agent_sessions_seen_at = :now',
      ConditionExpression: 'attribute_exists(linear_workspace_id) AND '
        + '(attribute_not_exists(agent_sessions_seen_at) OR agent_sessions_seen_at < :stale)',
      ExpressionAttributeValues: { ':now': '2026-11-20T12:00:00.000Z', ':stale': '2026-11-19T12:00:00.000Z' },
    }));
  });

  test('a container writes at most once per cache window, then tries again', async () => {
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW);
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW + MINUTE);
    expect(send).toHaveBeenCalledTimes(1);
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW + 6 * MINUTE);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('a marker that is already fresh is not an error', async () => {
    send.mockRejectedValueOnce(conditionFailed());
    await expect(recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW)).resolves.toBeUndefined();
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW + MINUTE);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a failed write is swallowed and retried on the next event', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW)).resolves.toBeUndefined();
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('a recently marked workspace delivers sessions; the answer is cached briefly', async () => {
    send.mockResolvedValue(seenAt(NOW - 3 * DAY));
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(true);
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW + MINUTE)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('the evidence expires: a workspace that stopped delivering sessions gets its comment trigger back', async () => {
    send.mockResolvedValue(seenAt(NOW - AGENT_SESSION_EVIDENCE_TTL_MS + MINUTE));
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(true);
    resetSessionWorkspaceCacheForTests();
    send.mockResolvedValue(seenAt(NOW - AGENT_SESSION_EVIDENCE_TTL_MS));
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(false);
  });

  test('a warm container does not keep answering "yes" forever', async () => {
    send.mockResolvedValue(seenAt(NOW - AGENT_SESSION_EVIDENCE_TTL_MS + MINUTE));
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(true);
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW + 6 * MINUTE)).resolves.toBe(false);
  });

  test.each([
    ['unmarked', { Item: {} }],
    ['with an unreadable marker', { Item: { agent_sessions_seen_at: 'not-a-date' } }],
  ])('a workspace %s does not deliver sessions, and is re-checked every time', async (_name, row) => {
    send.mockResolvedValue(row);
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(false);
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('a read failure answers false, so the comment trigger keeps replying', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-1', NOW)).resolves.toBe(false);
  });

  test('one workspace\'s marker says nothing about another', async () => {
    await recordWorkspaceAgentSession(ddb, 'Registry', 'org-1', NOW);
    send.mockResolvedValue({ Item: {} });
    await expect(workspaceDeliversAgentSessions(ddb, 'Registry', 'org-2', NOW)).resolves.toBe(false);
  });
});
