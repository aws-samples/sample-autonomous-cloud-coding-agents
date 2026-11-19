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

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  addIssueLabel,
  findTriggerLabelId,
  getIssueForStart,
  LinearApiError,
  listOpenProjectIssues,
  readStartClaim,
  releaseStartClaim,
  START_CLAIM_TTL_SECONDS,
  writeStartClaim,
} from '../../src/handlers/shared/linear-console';

const conditionFailed = () => new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

const NOW = 1_800_000_000;
const send = jest.fn();
const ddb = { send } as never;

function linear(data: unknown, status = 200) {
  return jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) }) as unknown as Response);
}

beforeEach(() => send.mockReset());

describe('start claims', () => {
  test('a claim records who asked, for which workspace, and expires, only if nobody else holds one', async () => {
    send.mockResolvedValue({});
    await expect(writeStartClaim(ddb, 'Dedup', { issueId: 'i1', workspaceId: 'w1', platformUserId: 'u1' }, NOW)).resolves.toBe(true);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'Dedup',
      Item: { dedup_key: 'console-start#i1', platform_user_id: 'u1', linear_workspace_id: 'w1', ttl: NOW + START_CLAIM_TTL_SECONDS },
      ConditionExpression: 'attribute_not_exists(dedup_key) OR #ttl < :now OR platform_user_id = :user',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': NOW, ':user': 'u1' },
    });
  });

  test('a second person cannot take over a live claim', async () => {
    send.mockRejectedValue(conditionFailed());
    await expect(writeStartClaim(ddb, 'Dedup', { issueId: 'i1', workspaceId: 'w1', platformUserId: 'u2' }, NOW)).resolves.toBe(false);
  });

  test('other write errors still fail', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(writeStartClaim(ddb, 'Dedup', { issueId: 'i1', workspaceId: 'w1', platformUserId: 'u1' }, NOW)).rejects.toThrow('throttled');
  });

  test('reading returns the user without consuming the claim', async () => {
    send.mockResolvedValue({ Item: { platform_user_id: 'u1', linear_workspace_id: 'w1', ttl: NOW + 10 } });
    await expect(readStartClaim(ddb, 'Dedup', 'i1', 'w1', NOW)).resolves.toBe('u1');
    expect(send.mock.calls[0][0].input).toEqual({ TableName: 'Dedup', Key: { dedup_key: 'console-start#i1' }, ConsistentRead: true });
  });

  test.each([
    ['no claim', undefined],
    ['an expired claim (TTL deletion is lazy)', { platform_user_id: 'u1', linear_workspace_id: 'w1', ttl: NOW - 1 }],
    ['a claim from another workspace', { platform_user_id: 'u1', linear_workspace_id: 'other', ttl: NOW + 10 }],
  ])('ignores %s', async (_label, item) => {
    send.mockResolvedValue({ Item: item });
    await expect(readStartClaim(ddb, 'Dedup', 'i1', 'w1', NOW)).resolves.toBeNull();
  });

  test('releasing deletes only the caller\'s own claim', async () => {
    send.mockResolvedValue({});
    await expect(releaseStartClaim(ddb, 'Dedup', 'i1', 'u1')).resolves.toBe(true);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'Dedup',
      Key: { dedup_key: 'console-start#i1' },
      ConditionExpression: 'platform_user_id = :user',
      ExpressionAttributeValues: { ':user': 'u1' },
    });
    send.mockRejectedValue(conditionFailed());
    await expect(releaseStartClaim(ddb, 'Dedup', 'i1', 'u1')).resolves.toBe(false);
  });
});

describe('Linear queries', () => {
  test('lists open issues of a project with plain fields', async () => {
    const fetchImpl = linear({
      project: {
        issues: {
          nodes: [{
            id: 'i1',
            identifier: 'MON-4',
            title: 'Pause menu',
            url: 'https://linear.app/x/issue/MON-4',
            priorityLabel: 'High',
            updatedAt: '2026-10-29T10:00:00Z',
            state: { name: 'Todo', type: 'unstarted' },
            labels: { nodes: [{ name: 'bug' }] },
            assignee: null,
          }],
        },
      },
    });
    await expect(listOpenProjectIssues('tok', 'p1', fetchImpl)).resolves.toEqual([{
      id: 'i1',
      identifier: 'MON-4',
      title: 'Pause menu',
      url: 'https://linear.app/x/issue/MON-4',
      state: 'Todo',
      state_type: 'unstarted',
      priority_label: 'High',
      labels: ['bug'],
      assignee: null,
      updated_at: '2026-10-29T10:00:00Z',
    }]);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.query).toContain('nin: ["completed", "canceled"]');
    expect(body.variables).toEqual({ id: 'p1', first: 50 });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  test('reports a deleted project and Linear errors as LinearApiError', async () => {
    await expect(listOpenProjectIssues('tok', 'p1', linear({ project: null }))).rejects.toThrow(LinearApiError);
    await expect(listOpenProjectIssues('tok', 'p1', linear(null, 401))).rejects.toThrow('Linear returned HTTP 401');
    const errors = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'scope missing' }] }) }) as unknown as Response);
    await expect(listOpenProjectIssues('tok', 'p1', errors)).rejects.toThrow('scope missing');
  });

  test('prefers the issue team\'s label, then a workspace label', async () => {
    const nodes = [{ id: 'other-team', name: 'bgagent', team: { id: 't2' } }, { id: 'workspace', name: 'bgagent', team: null }, { id: 'mine', name: 'BGAgent', team: { id: 't1' } }];
    await expect(findTriggerLabelId('tok', 't1', 'bgagent', linear({ issueLabels: { nodes } }))).resolves.toBe('mine');
    await expect(findTriggerLabelId('tok', 't3', 'bgagent', linear({ issueLabels: { nodes } }))).resolves.toBe('workspace');
    await expect(findTriggerLabelId('tok', 't3', 'bgagent', linear({ issueLabels: { nodes: [nodes[0]] } }))).resolves.toBeNull();
  });

  test('reads an issue\'s project, team and labels for the start checks', async () => {
    const fetchImpl = linear({ issue: { id: 'i1', identifier: 'MON-4', project: { id: 'p1' }, team: { id: 't1' }, labels: { nodes: [{ id: 'l1', name: 'bug' }] } } });
    await expect(getIssueForStart('tok', 'i1', fetchImpl)).resolves.toEqual({ id: 'i1', identifier: 'MON-4', projectId: 'p1', teamId: 't1', labels: [{ id: 'l1', name: 'bug' }] });
    await expect(getIssueForStart('tok', 'missing', linear({ issue: null }))).resolves.toBeNull();
  });

  test('adds the label, and fails loudly when Linear says no', async () => {
    await expect(addIssueLabel('tok', 'i1', 'l1', linear({ issueAddLabel: { success: true } }))).resolves.toBeUndefined();
    await expect(addIssueLabel('tok', 'i1', 'l1', linear({ issueAddLabel: { success: false } }))).rejects.toThrow('did not add the label');
  });
});

describe('bundle hygiene', () => {
  test('the Linear handler modules do not import the TaskTable construct (it bundles aws-cdk-lib)', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    for (const file of ['console-linear.ts', 'shared/linear-console.ts', 'shared/linear-task-by-issue.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'handlers', file), 'utf8');
      expect({ file, imports: src.includes("constructs/task-table'") }).toEqual({ file, imports: false });
    }
  });
});
