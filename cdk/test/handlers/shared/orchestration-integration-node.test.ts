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

import {
  computeLeaves,
  INTEGRATION_NODE_SUFFIX,
  isIntegrationNode,
  withIntegrationNode,
} from '../../../src/handlers/shared/orchestration-integration-node';
import type { SubIssueNode } from '../../../src/handlers/shared/linear-subissue-fetch';

const n = (id: string, deps: string[] = []): SubIssueNode => ({ id, depends_on: deps });
const ORCH = 'orch_abc123';

describe('computeLeaves', () => {
  test('linear chain A→B→C → only C is a leaf', () => {
    expect(computeLeaves([n('A'), n('B', ['A']), n('C', ['B'])])).toEqual(['C']);
  });

  test('pure fan-out A→{B,C} → B and C are leaves (A is not)', () => {
    expect([...computeLeaves([n('A'), n('B', ['A']), n('C', ['A'])])].sort()).toEqual(['B', 'C']);
  });

  test('diamond A→{B,C}→D → only D is a leaf', () => {
    expect(computeLeaves([n('A'), n('B', ['A']), n('C', ['A']), n('D', ['B', 'C'])])).toEqual(['D']);
  });

  test('all independent roots → all are leaves', () => {
    expect([...computeLeaves([n('A'), n('B'), n('C')])].sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('withIntegrationNode', () => {
  test('linear chain (1 leaf) → unchanged, not added', () => {
    const r = withIntegrationNode([n('A'), n('B', ['A'])], ORCH);
    expect(r.added).toBe(false);
    expect(r.nodes).toHaveLength(2);
  });

  test('explicit diamond (1 leaf D) → unchanged, not added', () => {
    const r = withIntegrationNode([n('A'), n('B', ['A']), n('C', ['A']), n('D', ['B', 'C'])], ORCH);
    expect(r.added).toBe(false);
  });

  test('pure fan-out (>1 leaf) → appends a synthetic node over all leaves', () => {
    const r = withIntegrationNode([n('A'), n('B', ['A']), n('C', ['A'])], ORCH);
    expect(r.added).toBe(true);
    expect(r.nodes).toHaveLength(4);
    const integ = r.nodes[r.nodes.length - 1];
    expect(integ.id).toBe(`${ORCH}${INTEGRATION_NODE_SUFFIX}`);
    expect([...integ.depends_on].sort()).toEqual(['B', 'C']);
    expect(integ.title).toContain('Integration');
    expect(integ.identifier).toBeUndefined();
  });

  test('three independent roots → integration node depends on all three', () => {
    const r = withIntegrationNode([n('A'), n('B'), n('C')], ORCH);
    expect(r.added).toBe(true);
    expect([...r.nodes[r.nodes.length - 1].depends_on].sort()).toEqual(['A', 'B', 'C']);
  });

  test('synthetic node id is idempotency-key safe (no "#", matches /^[A-Za-z0-9_-]+$/)', () => {
    const r = withIntegrationNode([n('A'), n('B')], ORCH);
    const id = r.nodes[r.nodes.length - 1].id;
    // releaseChild builds `${orch}_${sub}` and createTaskCore validates it.
    expect(`${ORCH}_${id}`).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });
});

describe('isIntegrationNode', () => {
  test('true for the synthetic suffix, false for real ids', () => {
    expect(isIntegrationNode(`${ORCH}${INTEGRATION_NODE_SUFFIX}`)).toBe(true);
    expect(isIntegrationNode('a1b2c3-uuid')).toBe(false);
    expect(isIntegrationNode('#meta')).toBe(false);
  });
});
