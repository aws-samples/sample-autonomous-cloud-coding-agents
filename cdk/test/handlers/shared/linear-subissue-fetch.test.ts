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

import { fetchSubIssueGraph } from '../../../src/handlers/shared/linear-subissue-fetch';

/** Build a mock fetch returning a given JSON body + ok/status. */
function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

/** Shape a Linear `issue.children` GraphQL response. */
function graphResponse(children: Array<{
  id: string;
  identifier?: string;
  title?: string;
  blockedBy?: string[]; // ids that block this child (inverseRelations type "blocks")
}>) {
  return {
    data: {
      issue: {
        id: 'PARENT',
        children: {
          nodes: children.map((c) => ({
            id: c.id,
            identifier: c.identifier,
            title: c.title,
            inverseRelations: {
              nodes: (c.blockedBy ?? []).map((bid) => ({ type: 'blocks', issue: { id: bid } })),
            },
          })),
        },
      },
    },
  };
}

describe('fetchSubIssueGraph — success shapes', () => {
  test('maps children and blockedBy edges into depends_on', async () => {
    const fetchImpl = mockFetch(graphResponse([
      { id: 'A', identifier: 'ENG-1', title: 'Root' },
      { id: 'B', identifier: 'ENG-2', title: 'Blocked by A', blockedBy: ['A'] },
    ]));
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.parentIssueId).toBe('PARENT');
      expect(result.children).toEqual([
        { id: 'A', identifier: 'ENG-1', title: 'Root', depends_on: [] },
        { id: 'B', identifier: 'ENG-2', title: 'Blocked by A', depends_on: ['A'] },
      ]);
    }
  });

  test('drops blockedBy edges that point outside the child set', async () => {
    // C is blocked by GHOST (not a sibling) — edge dropped.
    const fetchImpl = mockFetch(graphResponse([
      { id: 'C', blockedBy: ['GHOST'] },
    ]));
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    if (result.kind === 'ok') expect(result.children[0].depends_on).toEqual([]);
  });

  test('ignores relation types other than "blocks"', async () => {
    const fetchImpl = mockFetch({
      data: {
        issue: {
          id: 'PARENT',
          children: {
            nodes: [
              { id: 'A' },
              {
                id: 'B',
                inverseRelations: {
                  nodes: [
                    { type: 'related', issue: { id: 'A' } }, // not a blocker
                    { type: 'duplicate', issue: { id: 'A' } },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    if (result.kind === 'ok') expect(result.children[1].depends_on).toEqual([]);
  });

  test('dedups duplicate blocker edges', async () => {
    const fetchImpl = mockFetch({
      data: {
        issue: {
          id: 'PARENT',
          children: {
            nodes: [
              { id: 'A' },
              {
                id: 'B',
                inverseRelations: {
                  nodes: [
                    { type: 'blocks', issue: { id: 'A' } },
                    { type: 'blocks', issue: { id: 'A' } },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    if (result.kind === 'ok') expect(result.children[1].depends_on).toEqual(['A']);
  });

  test('ignores a self-blocking edge from the raw payload', async () => {
    const fetchImpl = mockFetch(graphResponse([{ id: 'A', blockedBy: ['A'] }]));
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    if (result.kind === 'ok') expect(result.children[0].depends_on).toEqual([]);
  });
});

describe('fetchSubIssueGraph — no children', () => {
  test('returns no_children when the issue has an empty children set', async () => {
    const fetchImpl = mockFetch(graphResponse([]));
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    expect(result.kind).toBe('no_children');
    if (result.kind === 'no_children') expect(result.parentIssueId).toBe('PARENT');
  });
});

describe('fetchSubIssueGraph — error shapes', () => {
  test('non-2xx → error', async () => {
    const fetchImpl = mockFetch({}, { ok: false, status: 503 });
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    expect(result.kind).toBe('error');
  });

  test('GraphQL errors → error', async () => {
    const fetchImpl = mockFetch({ errors: [{ message: 'boom' }] });
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    expect(result.kind).toBe('error');
  });

  test('network throw → error (never throws)', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    expect(result.kind).toBe('error');
  });

  test('missing issue in payload → error', async () => {
    const fetchImpl = mockFetch({ data: { issue: null } });
    const result = await fetchSubIssueGraph('tok', 'PARENT', { fetchImpl });
    expect(result.kind).toBe('error');
  });
});
