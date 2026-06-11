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
import { declarativeGraphSource } from '../../../src/handlers/shared/orchestration-graph-source';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Mock fetch returning a Linear children payload. */
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
  parentLinearIssueId: 'PARENT',
  linearWorkspaceId: 'WS',
  repo: 'o/r',
  now: '2026-06-09T12:00:00.000Z',
  releaseContext: { platform_user_id: 'platform-user-1' },
};

describe('discoverOrchestration', () => {
  test('no sub-issues → single_task', async () => {
    const ddb = { send: jest.fn() };
    const result = await discoverOrchestration({
      ...base, ddb: ddb as never, fetchOptions: { fetchImpl: emptyFetch() },
    });
    expect(result.kind).toBe('single_task');
    expect(ddb.send).not.toHaveBeenCalled(); // never touches the table
  });

  test('valid DAG → seeded with roots from layer 0', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      fetchOptions: { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }]) },
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
      fetchOptions: { fetchImpl: mockFetch([{ id: 'A', blockedBy: ['B'] }, { id: 'B', blockedBy: ['A'] }]) },
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
      ...base, ddb: ddb as never, fetchOptions: { fetchImpl: errorFetch() },
    });
    expect(result.kind).toBe('error');
    expect(ddb.send).not.toHaveBeenCalled();
  });

  test('persistence throw → error', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockRejectedValueOnce(new Error('DDB down')) };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      fetchOptions: { fetchImpl: mockFetch([{ id: 'A' }]) },
    });
    expect(result.kind).toBe('error');
  });

  test('replay → seeded with alreadyExisted=true', async () => {
    const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: { sub_issue_id: '#meta' } }) };
    const result = await discoverOrchestration({
      ...base,
      ddb: ddb as never,
      fetchOptions: { fetchImpl: mockFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }]) },
    });
    expect(result.kind).toBe('seeded');
    if (result.kind === 'seeded') expect(result.alreadyExisted).toBe(true);
  });

  // #247/#299 trigger-agnostic seam: a custom graphSource (declarative /
  // planner) drives the SAME validate→seed→reconcile pipeline, bypassing the
  // Linear fetch entirely.
  describe('graphSource seam (non-Linear)', () => {
    test('declarative graph → seeded; never touches the Linear fetch', async () => {
      const ddb = { send: jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({}) };
      // No fetchOptions/fetchImpl — if discovery hit the Linear fetch it would throw on the real network.
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
        expect(result.rootSubIssueIds).toEqual(['phase-1']); // layer 0
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
});
