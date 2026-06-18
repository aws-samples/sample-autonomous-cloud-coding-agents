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

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  declarativeGraphSource,
  linearGraphSource,
} from '../../../src/handlers/shared/orchestration-graph-source';

/** A `fetch` impl returning a Linear children payload, for the Linear source. */
function linearFetch(children: Array<{ id: string; blockedBy?: string[] }>): typeof fetch {
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

describe('declarativeGraphSource', () => {
  test('non-empty node list → ok with the same children', async () => {
    const nodes = [
      { id: 'a', depends_on: [], title: 'A' },
      { id: 'b', depends_on: ['a'], title: 'B' },
    ];
    const result = await declarativeGraphSource(nodes)();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.children).toEqual(nodes);
  });

  test('empty node list → no_children (caller falls through to single task)', async () => {
    const result = await declarativeGraphSource([])();
    expect(result.kind).toBe('no_children');
  });

  test('never errors — validity is enforced downstream, not here', async () => {
    // A cyclic graph is still "ok" from the source's perspective; validateDag
    // (in discoverOrchestration) is what rejects it.
    const result = await declarativeGraphSource([
      { id: 'x', depends_on: ['y'] },
      { id: 'y', depends_on: ['x'] },
    ])();
    expect(result.kind).toBe('ok');
  });
});

describe('linearGraphSource', () => {
  test('maps a Linear children payload to ok', async () => {
    const result = await linearGraphSource('tok', 'PARENT', {
      fetchImpl: linearFetch([{ id: 'A' }, { id: 'B', blockedBy: ['A'] }]),
    })();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.children.map((c) => c.id)).toEqual(['A', 'B']);
      expect(result.children[1].depends_on).toEqual(['A']);
    }
  });

  test('no children → no_children', async () => {
    const empty = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { issue: { id: 'PARENT', children: { nodes: [] } } } }),
    })) as unknown as typeof fetch;
    const result = await linearGraphSource('tok', 'PARENT', { fetchImpl: empty })();
    expect(result.kind).toBe('no_children');
  });

  test('Linear API failure → error (not silently empty)', async () => {
    const fail = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await linearGraphSource('tok', 'PARENT', { fetchImpl: fail })();
    expect(result.kind).toBe('error');
  });
});
