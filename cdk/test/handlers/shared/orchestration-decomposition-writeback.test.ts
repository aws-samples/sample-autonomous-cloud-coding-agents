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

import type { PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';
import {
  linearGraphqlFn,
  writeBackPlan,
  type GraphqlFn,
} from '../../../src/handlers/shared/orchestration-decomposition-writeback';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PARENT = 'parent-uuid';

function node(title: string, depends_on: number[] = []): PlannedSubIssue {
  return { title, description: `${title} scope`, size: 'M', max_budget_usd: 3, depends_on };
}

/**
 * Build a fake GraphqlFn from a scripted Linear state. ``existingChildren`` are
 * the parent's children already in Linear (for reuse/edge-dedup tests). Created
 * issues are assigned deterministic ids ``new-<title>``. Records all calls.
 */
function fakeLinear(opts: {
  teamId?: string | null;
  existingChildren?: { id: string; identifier?: string; title: string; blockedByIds?: string[] }[];
  failCreateFor?: string; // title whose issueCreate returns success:false
  failRelation?: boolean; // issueRelationCreate returns success:false
} = {}) {
  const teamId = opts.teamId === undefined ? 'team-1' : opts.teamId;
  const existing = (opts.existingChildren ?? []).map((c) => ({
    id: c.id,
    identifier: c.identifier,
    title: c.title,
    inverseRelations: { nodes: (c.blockedByIds ?? []).map((bid) => ({ type: 'blocks', issue: { id: bid } })) },
  }));
  const calls: { op: string; vars: Record<string, unknown> }[] = [];
  const createdIssues: Record<string, unknown>[] = [];

  const graphql: GraphqlFn = jest.fn(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes('query ParentState')) {
      calls.push({ op: 'state', vars });
      return { issue: teamId === null ? { team: null, children: { nodes: existing } } : { team: { id: teamId }, children: { nodes: existing } } };
    }
    if (query.includes('mutation CreateSubIssue')) {
      calls.push({ op: 'create', vars });
      const title = vars.title as string;
      if (opts.failCreateFor === title) return { issueCreate: { success: false } };
      const id = `new-${title}`;
      createdIssues.push({ id, title });
      return { issueCreate: { success: true, issue: { id, identifier: `ENG-${createdIssues.length}` } } };
    }
    if (query.includes('mutation CreateBlockingRelation')) {
      calls.push({ op: 'relation', vars });
      return { issueRelationCreate: { success: !opts.failRelation } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  });

  return { graphql, calls };
}

describe('writeBackPlan — happy path (all fresh)', () => {
  test('creates each sub-issue + the blockedBy edges, returns real ids', async () => {
    const { graphql, calls } = fakeLinear();
    const nodes = [node('Schema'), node('API', [0]), node('UI', [1])];
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes });

    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.created).toBe(3);
      expect(r.reused).toBe(0);
      // depends_on rewritten from indices → real Linear ids.
      expect(r.children[0]).toMatchObject({ id: 'new-Schema', depends_on: [] });
      expect(r.children[1]).toMatchObject({ id: 'new-API', depends_on: ['new-Schema'] });
      expect(r.children[2]).toMatchObject({ id: 'new-UI', depends_on: ['new-API'] });
      // PM-4: the planner's per-piece scope survives into the SubIssueNode so it
      // reaches the child task_description (not dropped as it was before).
      expect(r.children[0].description).toBe('Schema scope');
      expect(r.children[2].description).toBe('UI scope');
    }
    // 3 creates + 2 relations (Schema→API, API→UI).
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(3);
    const rels = calls.filter((c) => c.op === 'relation');
    expect(rels).toHaveLength(2);
    // Edge direction: predecessor blocks dependent (issueId=pred, related=dependent).
    expect(rels[0].vars).toMatchObject({ issueId: 'new-Schema', relatedIssueId: 'new-API', type: 'blocks' });
  });

  test('a diamond writes 4 issues + 4 edges', async () => {
    const { graphql, calls } = fakeLinear();
    const nodes = [node('Base'), node('Left', [0]), node('Right', [0]), node('Merge', [1, 2])];
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes });
    expect(r.kind).toBe('ok');
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(4);
    expect(calls.filter((c) => c.op === 'relation')).toHaveLength(4);
  });

  test('independent fan-out writes issues but zero edges', async () => {
    const { graphql, calls } = fakeLinear();
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('A'), node('B'), node('C')] });
    expect(r.kind).toBe('ok');
    expect(calls.filter((c) => c.op === 'relation')).toHaveLength(0);
  });

  test('the relation mutation declares type as the IssueRelationType ENUM, not String (B7 live-fix)', async () => {
    // Regression: Linear's issueRelationCreate input `type` is the
    // IssueRelationType enum; declaring the GraphQL var `String!` makes Linear
    // reject the whole mutation with a 400, so edges silently never get created.
    // Assert the query text uses the enum type.
    const seen: string[] = [];
    const graphql: GraphqlFn = jest.fn(async (query: string, vars: Record<string, unknown>) => {
      seen.push(query);
      if (query.includes('query ParentState')) return { issue: { team: { id: 't' }, children: { nodes: [] } } };
      if (query.includes('mutation CreateSubIssue')) return { issueCreate: { success: true, issue: { id: `new-${vars.title}` } } };
      return { issueRelationCreate: { success: true } };
    });
    await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('A'), node('B', [0])] });
    const relQuery = seen.find((q) => q.includes('CreateBlockingRelation'))!;
    expect(relQuery).toContain('$type: IssueRelationType!');
    expect(relQuery).not.toContain('$type: String!');
  });
});

describe('writeBackPlan — idempotent / resumable', () => {
  test('reuses an existing child by title instead of re-creating (partial-retry)', async () => {
    // "Schema" already created on a prior run; re-approve must not duplicate it.
    const { graphql, calls } = fakeLinear({
      existingChildren: [{ id: 'old-Schema', identifier: 'ENG-7', title: 'Schema' }],
    });
    const nodes = [node('Schema'), node('API', [0])];
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes });

    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.reused).toBe(1);
      expect(r.created).toBe(1);
      expect(r.children[0].id).toBe('old-Schema'); // reused id
      expect(r.children[1].depends_on).toEqual(['old-Schema']); // edge points at reused id
    }
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(1); // only API
  });

  test('follows children pagination so reuse-by-title sees a child beyond the first page', async () => {
    // Parent already has 100+ children spread over 2 pages; the planned "Schema"
    // lives on PAGE 2. Without pagination it would be re-created (duplicate); with
    // it, the dedup map finds it and reuses. First page = filler + hasNextPage;
    // second page (after cursor) = the real match, no further page.
    const calls: { op: string; vars: Record<string, unknown> }[] = [];
    const graphql: GraphqlFn = jest.fn(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes('query ParentState')) {
        calls.push({ op: 'state', vars });
        return {
          issue: {
            team: { id: 'team-1' },
            children: {
              pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
              nodes: [{ id: 'filler-1', title: 'Some unrelated child', inverseRelations: { nodes: [] } }],
            },
          },
        };
      }
      if (query.includes('query ParentChildrenPage')) {
        calls.push({ op: 'page', vars });
        return {
          issue: {
            children: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: 'old-Schema', identifier: 'ENG-7', title: 'Schema', inverseRelations: { nodes: [] } }],
            },
          },
        };
      }
      if (query.includes('mutation CreateSubIssue')) {
        calls.push({ op: 'create', vars });
        return { issueCreate: { success: true, issue: { id: `new-${vars.title}`, identifier: 'ENG-9' } } };
      }
      if (query.includes('mutation CreateBlockingRelation')) {
        calls.push({ op: 'relation', vars });
        return { issueRelationCreate: { success: true } };
      }
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    });

    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('Schema'), node('API', [0])] });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.reused).toBe(1); // Schema found on page 2 → reused, not recreated
      expect(r.created).toBe(1); // only API
      expect(r.children[0].id).toBe('old-Schema');
    }
    expect(calls.filter((c) => c.op === 'page')).toHaveLength(1); // followed the cursor
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(1); // Schema NOT duplicated
    // 2nd page query carried the first page's endCursor.
    expect(calls.find((c) => c.op === 'page')?.vars.after).toBe('cur-1');
  });

  test('skips an edge that already exists (no duplicate relations)', async () => {
    // Both issues + the Schema→API edge already exist; a re-run is a pure no-op
    // on writes.
    const { graphql, calls } = fakeLinear({
      existingChildren: [
        { id: 'old-Schema', title: 'Schema' },
        { id: 'old-API', title: 'API', blockedByIds: ['old-Schema'] },
      ],
    });
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('Schema'), node('API', [0])] });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.reused).toBe(2);
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'relation')).toHaveLength(0);
  });
});

describe('writeBackPlan — failure modes', () => {
  test('no team on the parent → error (cannot create)', async () => {
    const { graphql } = fakeLinear({ teamId: null });
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('A'), node('B')] });
    expect(r.kind).toBe('error');
  });

  test('a state-query failure (null data) → error', async () => {
    const graphql: GraphqlFn = jest.fn().mockResolvedValue(null);
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('A'), node('B')] });
    expect(r.kind).toBe('error');
  });

  test('issueCreate failure → resumable error (created issues persist for retry)', async () => {
    const { graphql, calls } = fakeLinear({ failCreateFor: 'API' });
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('Schema'), node('API', [0])] });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('resume');
    // Schema was created before API failed — a retry will reuse it.
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(2);
  });

  test('issueRelationCreate failure → error (unsafe to seed without the edge)', async () => {
    const { graphql } = fakeLinear({ failRelation: true });
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [node('Schema'), node('API', [0])] });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('dependency');
  });

  test('empty node list → error', async () => {
    const { graphql } = fakeLinear();
    const r = await writeBackPlan({ graphql, parentIssueId: PARENT, nodes: [] });
    expect(r.kind).toBe('error');
  });
});

describe('linearGraphqlFn — production transport', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('posts Bearer-authed query and returns data', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: { team: { id: 't-1' } } } }),
    });
    global.fetch = fetchMock as never;
    const data = await linearGraphqlFn('tok-123')('query X', { issueId: 'i-1' });
    expect(data).toEqual({ issue: { team: { id: 't-1' } } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body)).toEqual({ query: 'query X', variables: { issueId: 'i-1' } });
  });

  test('non-2xx → null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as never;
    expect(await linearGraphqlFn('t')('q', {})).toBeNull();
  });

  test('GraphQL errors → null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: 'bad' }] }) }) as never;
    expect(await linearGraphqlFn('t')('q', {})).toBeNull();
  });

  test('fetch rejection (timeout/DNS) → null', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('aborted')) as never;
    expect(await linearGraphqlFn('t')('q', {})).toBeNull();
  });

  test('429 → retries with backoff, then succeeds (a throttle no longer aborts the write-back)', async () => {
    jest.useFakeTimers();
    try {
      const headers = { get: (h: string) => (h.toLowerCase() === 'retry-after' ? null : null) };
      const fetchMock = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 429, headers })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { ok: 1 } }) });
      global.fetch = fetchMock as never;
      const p = linearGraphqlFn('t')('q', {});
      await jest.runAllTimersAsync();
      expect(await p).toEqual({ ok: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2); // retried once
    } finally {
      jest.useRealTimers();
    }
  });

  test('persistent 429 → null after MAX_RETRIES (bounded, does not loop forever)', async () => {
    jest.useFakeTimers();
    try {
      const headers = { get: () => null };
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 429, headers });
      global.fetch = fetchMock as never;
      const p = linearGraphqlFn('t')('q', {});
      await jest.runAllTimersAsync();
      expect(await p).toBeNull();
      // initial attempt + 3 retries = 4 total
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  test('honors Retry-After header (capped)', async () => {
    jest.useFakeTimers();
    try {
      const headers = { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) };
      const fetchMock = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, headers })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { ok: 1 } }) });
      global.fetch = fetchMock as never;
      const p = linearGraphqlFn('t')('q', {});
      await jest.runAllTimersAsync();
      expect(await p).toEqual({ ok: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a non-retryable 4xx (403) does NOT retry', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } });
    global.fetch = fetchMock as never;
    expect(await linearGraphqlFn('t')('q', {})).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });
});
