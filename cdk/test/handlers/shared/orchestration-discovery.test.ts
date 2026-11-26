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

import { discoverOrchestration } from '../../../src/handlers/shared/orchestration-discovery';
import { declarativeGraphSource, linearGraphSource } from '../../../src/handlers/shared/orchestration-graph-source';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function mockFetch(children: Array<{ id: string; blockedBy?: string[] }>): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        issue: {
          id: 'PARENT',
          children: {
            nodes: children.map((c) => ({
              id: c.id,
              inverseRelations: { nodes: (c.blockedBy ?? []).map((b) => ({ type: 'blocks', issue: { id: b } })) },
            })),
          },
        },
      },
    }),
  })) as unknown as typeof fetch;
}

function errorFetch(): typeof fetch {
  return (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
}

function emptyFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { issue: { id: 'PARENT', children: { nodes: [] } } } }),
  })) as unknown as typeof fetch;
}

const base = {
  tableName: 'OrchestrationTable',
  accessToken: 'tok',
  parentIssueRef: 'PARENT',
  credentialsRef: 'WS',
  repo: 'o/r',
  now: '2026-06-09T12:00:00.000Z',
  releaseContext: { platform_user_id: 'platform-user-1' },
};

describe('discoverOrchestration', () => {
  test('no sub-issues → single_task', async () => {
    const ddb = { send: jest.fn() };
    const result = await discoverOrchestration({
      ...base, ddb: ddb as never, graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: emptyFetch() }),
    });
    expect(result.kind).toBe('single_task');
    expect(ddb.send).not.toHaveBeenCalled();
  });

  test('valid DAG → seeded with roots from layer 0', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }]) }),
    });
    expect(result.kind).toBe('seeded');
    if (result.kind === 'seeded') {
      expect(result.childCount).toBe(2);
      expect(result.rootSubIssueIds).toEqual(['A']);
      expect(result.alreadyExisted).toBe(false);
    }
  });

  test('cycle → rejected, nothing persisted', async () => {
    const ddb = { send: jest.fn() };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A', blockedBy: ['B'] }, { id: 'B', blockedBy: ['A'] }]) }),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('cycle');
      expect(result.message).toMatch(/cycle/i);
    }
    expect(ddb.send).not.toHaveBeenCalled();
  });

  test('Linear fetch error → error (does NOT fall back to single_task)', async () => {
    const ddb = { send: jest.fn() };
    const result = await discoverOrchestration({
      ...base, ddb: ddb as never, graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: errorFetch() }),
    });
    expect(result.kind).toBe('error');
    expect(ddb.send).not.toHaveBeenCalled();
  });

  test('persistence throw → error', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockRejectedValueOnce(new Error('DDB down')) };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }]) }),
    });
    expect(result.kind).toBe('error');
  });

  test('an id collision reports a DIFFERENT message than a transient write failure', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValueOnce({
        Item: {
          sub_issue_id: '#meta',
          parent_issue_ref: 'A-DIFFERENT-EPIC',
          credentials_ref: 'ANOTHER-TENANT',
        },
      }),
    };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }]) }),
    });

    expect(result.kind).toBe('error');
    const message = (result as { message: string }).message;
    expect(message).toMatch(/different issue or workspace/i);
    expect(message).not.toMatch(/re-apply the trigger/i);
  });

  test('re-trigger of an existing epic with the SAME graph → extended, no new nodes', async () => {
    const orchId = '#meta';
    const ddb = {
      send: jest.fn()
        .mockResolvedValueOnce({ Item: { sub_issue_id: orchId } })
        .mockResolvedValueOnce({
          Items: [
            { sub_issue_id: '#meta', orchestration_id: 'orch_x', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1' },
            { sub_issue_id: 'A', orchestration_id: 'orch_x', depends_on: [], child_status: 'succeeded', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r' },
            { sub_issue_id: 'B', orchestration_id: 'orch_x', depends_on: ['A'], child_status: 'succeeded', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r' },
          ],
        }),
    };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }]) }),
    });
    expect(result.kind).toBe('extended');
    if (result.kind === 'extended') expect(result.addedSubIssueIds).toEqual([]);
  });

  test('re-trigger with a NEW sub-issue → extended, adds the new node', async () => {
    const ddb = {
      send: jest.fn()
        .mockResolvedValueOnce({ Item: { sub_issue_id: '#meta' } })
        .mockResolvedValueOnce({
          Items: [
            { sub_issue_id: '#meta', orchestration_id: 'orch_x', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r', platform_user_id: 'u1' },
            { sub_issue_id: 'A', orchestration_id: 'orch_x', depends_on: [], child_status: 'succeeded', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r' },
            { sub_issue_id: 'B', orchestration_id: 'orch_x', depends_on: ['A'], child_status: 'succeeded', parent_linear_issue_id: 'P', linear_workspace_id: 'WS', repo: 'o/r' },
          ],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }, { id: 'C', blockedBy: ['B'] }]) }),
    });
    expect(result.kind).toBe('extended');
    if (result.kind === 'extended') {
      expect(result.addedSubIssueIds).toEqual(['C']);
      expect(result.releasableSubIssueIds).toEqual(['C']);
    }
  });

  describe('graphSource seam (non-Linear)', () => {
    test('declarative graph → seeded; never touches the Linear fetch', async () => {
      const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
      const result = await discoverOrchestration({
        ...base,
        ddb: ddb as never,
        graphSource: declarativeGraphSource([
          { id: 'phase-1', depends_on: [], title: 'Plan' },
          { id: 'phase-2', depends_on: ['phase-1'], title: 'Build' },
          { id: 'phase-3', depends_on: ['phase-2'], title: 'Verify' },
        ]),
      });
      expect(result.kind).toBe('seeded');
      if (result.kind === 'seeded') {
        expect(result.childCount).toBe(3);
        expect(result.rootSubIssueIds).toEqual(['phase-1']);
      }
    });

    test('declarative graph still rejects an invalid DAG (cycle)', async () => {
      const ddb = { send: jest.fn() };
      const result = await discoverOrchestration({
        ...base,
        ddb: ddb as never,
        graphSource: declarativeGraphSource([
          { id: 'x', depends_on: ['y'] },
          { id: 'y', depends_on: ['x'] },
        ]),
      });
      expect(result.kind).toBe('rejected');
      expect(ddb.send).not.toHaveBeenCalled();
    });

    test('empty declarative graph → single_task', async () => {
      const ddb = { send: jest.fn() };
      const result = await discoverOrchestration({
        ...base, ddb: ddb as never, graphSource: declarativeGraphSource([]),
      });
      expect(result.kind).toBe('single_task');
      expect(ddb.send).not.toHaveBeenCalled();
    });
  });

  describe('fan-out integration node', () => {
    test('pure fan-out (A→B, A→C) → seeds a synthetic integration node over the leaves', async () => {
      const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
      const result = await discoverOrchestration({
        ...base,
        ddb: ddb as never,
        graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }, { id: 'C', blockedBy: ['A'] }]) }),
      });
      expect(result.kind).toBe('seeded');
      if (result.kind === 'seeded') {
        expect(result.childCount).toBe(4);
        expect(result.rootSubIssueIds).toEqual(['A']);
      }
      const puts = ddb.send.mock.calls[1][0].input.RequestItems[Object.keys(ddb.send.mock.calls[1][0].input.RequestItems)[0]] as Array<{ PutRequest: { Item: Record<string, unknown> } }>;
      const integ = puts.map((p) => p.PutRequest.Item).find((i) => String(i.sub_issue_id).endsWith('__integration'));
      expect(integ).toBeDefined();
      expect([...(integ!.depends_on as string[])].sort()).toEqual(['B', 'C']);
    });

    test('linear chain → NO integration node added', async () => {
      const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
      const result = await discoverOrchestration({
        ...base,
        ddb: ddb as never,
        graphSource: linearGraphSource(base.accessToken, base.parentIssueRef, { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }]) }),
      });
      expect(result.kind).toBe('seeded');
      if (result.kind === 'seeded') expect(result.childCount).toBe(2);
    });

    test('declarative fan-out also gets an integration node', async () => {
      const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
      const result = await discoverOrchestration({
        ...base,
        ddb: ddb as never,
        graphSource: declarativeGraphSource([
          { id: 'x', depends_on: [] },
          { id: 'y', depends_on: [] },
        ]),
      });
      expect(result.kind).toBe('seeded');
      if (result.kind === 'seeded') expect(result.childCount).toBe(3);
    });
  });
});
