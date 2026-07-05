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

// #299 agent-native planning: the inline two-stage Bedrock planner (assessor +
// decomposer + bedrockInvokeModel) was RETIRED — planning moved into the
// coding/decompose-v1 agent. What survives here is the PURE plan parser/validator
// the reconciler feeds the agent's plan artifact into. These tests cover it.

import {
  parseDecomposerResponse,
  SIZE_DEFAULT_BUDGET_USD,
} from '../../../src/handlers/shared/orchestration-decomposition-planner';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** A decomposition-plan JSON completion (the shape the agent emits). */
const DECOMPOSER_JSON = (subs: unknown[], reasoning = 'breakdown') =>
  JSON.stringify({ reasoning, sub_issues: subs });

// The fallback reasoning string threaded into parseDecomposerResponse so a
// <2-node breakdown can fall back to it (the reconciler passes '').
const FALLBACK_REASON = 'spans multiple surfaces';

describe('parseDecomposerResponse — golden plans', () => {
  test('a fan-out plan (3 independent leaves) parses + sizes budgets', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Pricing route', description: 'Add /pricing', size: 'M', depends_on: [] },
      { title: 'Comparison table', description: 'Table component', size: 'S', depends_on: [] },
      { title: 'Stripe checkout', description: 'Checkout flow', size: 'L', depends_on: [] },
    ], 'Three independent surfaces.');
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes).toHaveLength(3);
      expect(r.plan.nodes[0].max_budget_usd).toBe(SIZE_DEFAULT_BUDGET_USD.M);
      expect(r.plan.nodes[1].max_budget_usd).toBe(SIZE_DEFAULT_BUDGET_USD.S);
      expect(r.plan.nodes[2].max_budget_usd).toBe(SIZE_DEFAULT_BUDGET_USD.L);
      expect(r.plan.nodes.every((n) => n.depends_on.length === 0)).toBe(true);
    }
  });

  test('a chain plan (A→B→C) preserves index edges', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Schema', description: 'DB schema', size: 'S', depends_on: [] },
      { title: 'API', description: 'Endpoints', size: 'M', depends_on: [0] },
      { title: 'UI', description: 'Frontend', size: 'M', depends_on: [1] },
    ]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[1].depends_on).toEqual([0]);
      expect(r.plan.nodes[2].depends_on).toEqual([1]);
    }
  });

  test('a diamond plan (A→{B,C}→D) parses', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Base', description: 'base', size: 'S', depends_on: [] },
      { title: 'Left', description: 'left', size: 'M', depends_on: [0] },
      { title: 'Right', description: 'right', size: 'M', depends_on: [0] },
      { title: 'Merge', description: 'merge', size: 'M', depends_on: [1, 2] },
    ]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes[3].depends_on).toEqual([1, 2]);
  });

  test('tolerates markdown fences and leading prose around the JSON', () => {
    const raw = 'Here is the plan:\n```json\n'
      + DECOMPOSER_JSON([
        { title: 'One', description: 'a', size: 'S', depends_on: [] },
        { title: 'Two', description: 'b', size: 'S', depends_on: [0] },
      ])
      + '\n```\nLet me know if you want changes.';
    expect(parseDecomposerResponse(raw, 8, FALLBACK_REASON).kind).toBe('plan');
  });

  test('picks the plan object even when earlier prose contains OTHER braces (ABCA-504 live: inline CSS)', () => {
    // The agent's final message quoted CSS (`.nav { padding: 20px 40px; }`) in its
    // findings BEFORE the fenced plan JSON. The old extractor balanced from the
    // first `{` (the CSS) and returned error; it must scan past it to the real plan.
    const raw = [
      'Key findings:',
      '- Current nav CSS: `.nav { padding: 20px 40px; justify-content: space-between; }`',
      '- Mobile override: `.nav { padding: 18px 24px; }`',
      '',
      'Here is the breakdown:',
      '```json',
      DECOMPOSER_JSON([
        { title: 'One', description: 'a', size: 'S', depends_on: [] },
        { title: 'Two', description: 'b', size: 'M', depends_on: [0] },
      ]),
      '```',
    ].join('\n');
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes).toHaveLength(2);
  });
});

describe('parseDecomposerResponse — <2 nodes collapses to single_task', () => {
  test('a single proposed node collapses to single_task (nothing to orchestrate)', () => {
    const raw = DECOMPOSER_JSON([{ title: 'Just do it', description: 'x', size: 'M', depends_on: [] }]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('single_task');
    // falls back to the supplied reasoning for the note
    if (r.kind === 'single_task') expect(r.reasoning).toBe('spans multiple surfaces');
  });

  test('zero nodes → single_task', () => {
    expect(parseDecomposerResponse(DECOMPOSER_JSON([]), 8, 'cohesive').kind).toBe('single_task');
  });

  test('ABCA-504 live: a decompose:false decline after CSS-in-prose → single_task (NOT error)', () => {
    // The real cohesive-decline artifact: prose quoting `.nav { … }` then the
    // fenced verdict. Must parse to single_task with the agent's own reasoning,
    // so the platform posts the honest "single cohesive change" note — not the
    // planner-error note (which the first-`{` extractor wrongly produced live).
    const raw = [
      'Key findings:',
      '- Current nav CSS: `.nav { padding: 20px 40px; }`',
      '',
      'This is one cohesive unit of work.',
      '```json',
      '{"decompose": false, "reasoning": "single CSS tweak across all files", "sub_issues": []}',
      '```',
    ].join('\n');
    const r = parseDecomposerResponse(raw, 8, '');
    expect(r.kind).toBe('single_task');
    if (r.kind === 'single_task') expect(r.reasoning).toBe('single CSS tweak across all files');
  });
});

describe('parseDecomposerResponse — malformed + adversarial', () => {
  test('non-JSON garbage → error', () => {
    expect(parseDecomposerResponse('I cannot help with that.', 8, FALLBACK_REASON).kind).toBe('error');
  });

  test('an unbalanced/truncated brace (no closing }) → error, not a throw', () => {
    expect(parseDecomposerResponse('Here you go: { "sub_issues": [', 8, FALLBACK_REASON).kind).toBe('error');
  });

  test('a node missing a title → error (not silently dropped)', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Good', description: 'a', size: 'S', depends_on: [] },
      { description: 'no title', size: 'M', depends_on: [0] },
    ]);
    expect(parseDecomposerResponse(raw, 8, FALLBACK_REASON).kind).toBe('error');
  });

  test('a self-contradictory plan (cycle) is rejected by validateDag', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'A', description: 'a', size: 'S', depends_on: [1] },
      { title: 'B', description: 'b', size: 'S', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('cycle');
  });

  test('out-of-range / self / non-integer depends_on indices are dropped, not fatal', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'A', description: 'a', size: 'S', depends_on: [0, 99, 'x'] }, // self + OOR + junk
      { title: 'B', description: 'b', size: 'M', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[0].depends_on).toEqual([]);
      expect(r.plan.nodes[1].depends_on).toEqual([0]);
    }
  });

  test('an unknown size defaults to M', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'A', description: 'a', size: 'XL', depends_on: [] },
      { title: 'B', description: 'b', depends_on: [] },
    ]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[0].size).toBe('M');
      expect(r.plan.nodes[1].size).toBe('M');
    }
  });

  test('over-cap node count still parses into a plan (caps reject downstream, not here)', () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, description: 'x', size: 'S', depends_on: [] }));
    const r = parseDecomposerResponse(DECOMPOSER_JSON(subs), 8, FALLBACK_REASON);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes).toHaveLength(10);
  });

  test('a node description defaults to its title when absent', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Only a title', size: 'S', depends_on: [] },
      { title: 'Second', size: 'S', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, FALLBACK_REASON);
    if (r.kind === 'plan') expect(r.plan.nodes[0].description).toBe('Only a title');
  });
});
