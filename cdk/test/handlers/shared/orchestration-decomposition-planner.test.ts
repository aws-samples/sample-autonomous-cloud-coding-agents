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
  bedrockInvokeModel,
  buildAssessmentPrompt,
  buildDecomposerPrompt,
  DEFAULT_DECOMPOSITION_MODEL_ID,
  parseAssessment,
  parseDecomposerResponse,
  planDecomposition,
  SIZE_DEFAULT_BUDGET_USD,
  type AssessmentResult,
  type PlannerInput,
} from '../../../src/handlers/shared/orchestration-decomposition-planner';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock the Bedrock SDK so we can exercise the production invoke path
// (request-body shape + response decoding) without a live call.
const mockSend = jest.fn();
const mockInvokeCtor = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((input) => {
    mockInvokeCtor(input);
    return { input };
  }),
}));

const INPUT: PlannerInput = {
  title: 'Add a pricing page with plan comparison and checkout',
  description: 'Build a /pricing route, a plan-comparison table, and Stripe checkout.',
  repo: 'acme/web',
  maxSubIssues: 8,
};

/** A decomposer JSON completion (stage 2 shape — no should_decompose field). */
const DECOMPOSER_JSON = (subs: unknown[], reasoning = 'breakdown') =>
  JSON.stringify({ reasoning, sub_issues: subs });

/** The assessor's tiny verdict (stage 1 shape). */
const ASSESS_YES: AssessmentResult = { decompose: true, reasoning: 'spans multiple surfaces' };
const ASSESS_NO: AssessmentResult = { decompose: false, reasoning: 'one cohesive change' };

// ---------------------------------------------------------------------------
// Stage 1 — buildAssessmentPrompt / parseAssessment
// ---------------------------------------------------------------------------

describe('buildAssessmentPrompt — balanced, decide-only, carries inputs', () => {
  test('includes title, description, repo and asks ONLY for the decision', () => {
    const p = buildAssessmentPrompt(INPUT);
    expect(p).toContain('acme/web');
    expect(p).toContain('Add a pricing page');
    expect(p).toContain('Build a /pricing route');
    // the tiny decide-only output shape
    expect(p).toContain('"decompose": boolean');
    // it must NOT ask the assessor to draft a breakdown (the anchoring we removed)
    expect(p).not.toContain('"sub_issues"');
  });

  test('is BALANCED — frames both decompose and one-task, no default-to-one thumb', () => {
    const p = buildAssessmentPrompt(INPUT);
    expect(p).toMatch(/DECOMPOSE when/i);
    expect(p).toMatch(/ONE TASK when/i);
    expect(p).toMatch(/there is no default/i);
    // the old biased "when unsure, prefer a single task" must be gone
    expect(p).not.toMatch(/when unsure, prefer a single task/i);
  });

  test('is a pure function (same input → same prompt)', () => {
    expect(buildAssessmentPrompt(INPUT)).toBe(buildAssessmentPrompt(INPUT));
  });

  test('handles an empty description gracefully', () => {
    expect(buildAssessmentPrompt({ ...INPUT, description: '   ' })).toContain('(no description provided)');
  });
});

describe('parseAssessment — tiny verdict JSON', () => {
  test('decompose:true with reasoning', () => {
    expect(parseAssessment('{"decompose":true,"reasoning":"three surfaces"}')).toEqual({
      decompose: true, reasoning: 'three surfaces',
    });
  });

  test('decompose:false', () => {
    expect(parseAssessment('{"decompose":false,"reasoning":"small fix"}')).toEqual({
      decompose: false, reasoning: 'small fix',
    });
  });

  test('tolerates fences/prose around the JSON', () => {
    const r = parseAssessment('Sure:\n```json\n{"decompose":true,"reasoning":"x"}\n```');
    expect(r?.decompose).toBe(true);
  });

  test('missing decompose field → false (conservative default for that field)', () => {
    expect(parseAssessment('{"reasoning":"unsure"}')).toEqual({ decompose: false, reasoning: 'unsure' });
  });

  test('garbage → null (caller maps to error)', () => {
    expect(parseAssessment('I cannot help with that.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — buildDecomposerPrompt / parseDecomposerResponse
// ---------------------------------------------------------------------------

describe('buildDecomposerPrompt — produces the breakdown, does not re-litigate', () => {
  test('carries inputs + cap and asks for sub_issues (not a decompose decision)', () => {
    const p = buildDecomposerPrompt(INPUT);
    expect(p).toContain('acme/web');
    expect(p).toContain('Add a pricing page');
    expect(p).toContain('at most 8 sub-issues');
    expect(p).toContain('"sub_issues"');
    expect(p).not.toContain('"decompose"'); // decision already made
    expect(p).toMatch(/already been made/i);
  });

  test('is a pure function', () => {
    expect(buildDecomposerPrompt(INPUT)).toBe(buildDecomposerPrompt(INPUT));
  });
});

describe('parseDecomposerResponse — golden plans', () => {
  test('a fan-out plan (3 independent leaves) parses + sizes budgets + carries the assessor verdict', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Pricing route', description: 'Add /pricing', size: 'M', depends_on: [] },
      { title: 'Comparison table', description: 'Table component', size: 'S', depends_on: [] },
      { title: 'Stripe checkout', description: 'Checkout flow', size: 'L', depends_on: [] },
    ], 'Three independent surfaces.');
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes).toHaveLength(3);
      expect(r.plan.nodes[0].max_budget_usd).toBe(SIZE_DEFAULT_BUDGET_USD.M);
      expect(r.plan.nodes[1].max_budget_usd).toBe(SIZE_DEFAULT_BUDGET_USD.S);
      expect(r.plan.nodes[2].max_budget_usd).toBe(SIZE_DEFAULT_BUDGET_USD.L);
      expect(r.plan.nodes.every((n) => n.depends_on.length === 0)).toBe(true);
      expect(r.assessedDecompose).toBe(true);
      expect(r.assessedReasoning).toBe('spans multiple surfaces');
    }
  });

  test('a chain plan (A→B→C) preserves index edges', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Schema', description: 'DB schema', size: 'S', depends_on: [] },
      { title: 'API', description: 'Endpoints', size: 'M', depends_on: [0] },
      { title: 'UI', description: 'Frontend', size: 'M', depends_on: [1] },
    ]);
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
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
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes[3].depends_on).toEqual([1, 2]);
  });

  test('carries assessedDecompose=false through when the human forced a plan (DJ-2)', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'A', description: 'a', size: 'S', depends_on: [] },
      { title: 'B', description: 'b', size: 'S', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, ASSESS_NO);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.assessedDecompose).toBe(false);
      expect(r.assessedReasoning).toBe('one cohesive change');
    }
  });

  test('tolerates markdown fences and leading prose around the JSON', () => {
    const raw = 'Here is the plan:\n```json\n'
      + DECOMPOSER_JSON([
        { title: 'One', description: 'a', size: 'S', depends_on: [] },
        { title: 'Two', description: 'b', size: 'S', depends_on: [0] },
      ])
      + '\n```\nLet me know if you want changes.';
    expect(parseDecomposerResponse(raw, 8, ASSESS_YES).kind).toBe('plan');
  });
});

describe('parseDecomposerResponse — <2 nodes collapses to single_task', () => {
  test('a single proposed node collapses to single_task (nothing to orchestrate)', () => {
    const raw = DECOMPOSER_JSON([{ title: 'Just do it', description: 'x', size: 'M', depends_on: [] }]);
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
    expect(r.kind).toBe('single_task');
    // prefers the assessor's reasoning for the note
    if (r.kind === 'single_task') expect(r.reasoning).toBe('spans multiple surfaces');
  });

  test('zero nodes → single_task', () => {
    expect(parseDecomposerResponse(DECOMPOSER_JSON([]), 8, ASSESS_NO).kind).toBe('single_task');
  });
});

describe('parseDecomposerResponse — malformed + adversarial', () => {
  test('non-JSON garbage → error', () => {
    expect(parseDecomposerResponse('I cannot help with that.', 8, ASSESS_YES).kind).toBe('error');
  });

  test('an unbalanced/truncated brace (no closing }) → error, not a throw', () => {
    expect(parseDecomposerResponse('Here you go: { "sub_issues": [', 8, ASSESS_YES).kind).toBe('error');
  });

  test('a node missing a title → error (not silently dropped)', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Good', description: 'a', size: 'S', depends_on: [] },
      { description: 'no title', size: 'M', depends_on: [0] },
    ]);
    expect(parseDecomposerResponse(raw, 8, ASSESS_YES).kind).toBe('error');
  });

  test('a self-contradictory plan (cycle) is rejected by validateDag', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'A', description: 'a', size: 'S', depends_on: [1] },
      { title: 'B', description: 'b', size: 'S', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('cycle');
  });

  test('out-of-range / self / non-integer depends_on indices are dropped, not fatal', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'A', description: 'a', size: 'S', depends_on: [0, 99, 'x'] }, // self + OOR + junk
      { title: 'B', description: 'b', size: 'M', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
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
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[0].size).toBe('M');
      expect(r.plan.nodes[1].size).toBe('M');
    }
  });

  test('over-cap node count still parses into a plan (caps reject downstream, not here)', () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, description: 'x', size: 'S', depends_on: [] }));
    const r = parseDecomposerResponse(DECOMPOSER_JSON(subs), 8, ASSESS_YES);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes).toHaveLength(10);
  });

  test('a node description defaults to its title when absent', () => {
    const raw = DECOMPOSER_JSON([
      { title: 'Only a title', size: 'S', depends_on: [] },
      { title: 'Second', size: 'S', depends_on: [0] },
    ]);
    const r = parseDecomposerResponse(raw, 8, ASSESS_YES);
    if (r.kind === 'plan') expect(r.plan.nodes[0].description).toBe('Only a title');
  });
});

// ---------------------------------------------------------------------------
// planDecomposition — the two-stage orchestration
// ---------------------------------------------------------------------------

describe('planDecomposition — two-stage orchestration', () => {
  test('assessor says decompose → decomposer runs → plan (two model calls)', async () => {
    const invoke = jest.fn()
      .mockResolvedValueOnce(JSON.stringify({ decompose: true, reasoning: 'multi-part' })) // stage 1
      .mockResolvedValueOnce(DECOMPOSER_JSON([ // stage 2
        { title: 'A', description: 'a', size: 'S', depends_on: [] },
        { title: 'B', description: 'b', size: 'M', depends_on: [0] },
      ]));
    const r = await planDecomposition(INPUT, invoke);
    expect(r.kind).toBe('plan');
    expect(invoke).toHaveBeenCalledTimes(2);
    // stage 1 prompt = assessment (decide-only); stage 2 = decomposer (sub_issues)
    expect(invoke.mock.calls[0][0]).toContain('"decompose": boolean');
    expect(invoke.mock.calls[1][0]).toContain('"sub_issues"');
    if (r.kind === 'plan') expect(r.assessedDecompose).toBe(true);
  });

  test('assessor says one-shot + NOT forced (:auto) → single_task WITHOUT a second call', async () => {
    const invoke = jest.fn().mockResolvedValueOnce(JSON.stringify({ decompose: false, reasoning: 'cohesive' }));
    const r = await planDecomposition({ ...INPUT, forceDecompose: false }, invoke);
    expect(r.kind).toBe('single_task');
    expect(invoke).toHaveBeenCalledTimes(1); // no decomposer call
    if (r.kind === 'single_task') expect(r.reasoning).toBe('cohesive');
  });

  test('assessor says one-shot but FORCED (:decompose) → decomposer still runs → plan w/ assessedDecompose=false', async () => {
    const invoke = jest.fn()
      .mockResolvedValueOnce(JSON.stringify({ decompose: false, reasoning: 'looks cohesive' }))
      .mockResolvedValueOnce(DECOMPOSER_JSON([
        { title: 'A', description: 'a', size: 'S', depends_on: [] },
        { title: 'B', description: 'b', size: 'M', depends_on: [0] },
      ]));
    const r = await planDecomposition({ ...INPUT, forceDecompose: true }, invoke);
    expect(r.kind).toBe('plan');
    expect(invoke).toHaveBeenCalledTimes(2);
    if (r.kind === 'plan') {
      expect(r.assessedDecompose).toBe(false);
      expect(r.assessedReasoning).toBe('looks cohesive');
    }
  });

  test('a stage-1 model throw → error (never throws), no stage-2 call', async () => {
    const invoke = jest.fn().mockRejectedValueOnce(new Error('bedrock 500'));
    const r = await planDecomposition(INPUT, invoke);
    expect(r.kind).toBe('error');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('a stage-1 unparseable response → error', async () => {
    const invoke = jest.fn().mockResolvedValueOnce('not json');
    const r = await planDecomposition(INPUT, invoke);
    expect(r.kind).toBe('error');
  });

  test('a stage-2 model throw (after a decompose verdict) → error', async () => {
    const invoke = jest.fn()
      .mockResolvedValueOnce(JSON.stringify({ decompose: true, reasoning: 'x' }))
      .mockRejectedValueOnce(new Error('bedrock 500'));
    const r = await planDecomposition(INPUT, invoke);
    expect(r.kind).toBe('error');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// bedrockInvokeModel — production invoke path (unchanged)
// ---------------------------------------------------------------------------

describe('bedrockInvokeModel — production invoke path', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockInvokeCtor.mockReset();
  });

  function bodyOf(obj: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  test('builds a Messages-API request and concatenates text content', async () => {
    mockSend.mockResolvedValue({
      body: bodyOf({ content: [{ type: 'text', text: '{"decompose":false,' }, { type: 'text', text: '"reasoning":"x"}' }] }),
    });
    const invoke = bedrockInvokeModel();
    const out = await invoke('PROMPT-TEXT');

    expect(out).toBe('{"decompose":false,"reasoning":"x"}');
    const sentBody = JSON.parse(mockInvokeCtor.mock.calls[0][0].body);
    expect(mockInvokeCtor.mock.calls[0][0].modelId).toBe(DEFAULT_DECOMPOSITION_MODEL_ID);
    expect(sentBody.anthropic_version).toBe('bedrock-2023-05-31');
    expect(sentBody.temperature).toBe(0);
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'PROMPT-TEXT' }]);
  });

  test('honours a custom model id', async () => {
    mockSend.mockResolvedValue({ body: bodyOf({ content: [{ type: 'text', text: 'x' }] }) });
    await bedrockInvokeModel('us.anthropic.claude-haiku-4-5-20251001-v1:0')('p');
    expect(mockInvokeCtor.mock.calls[0][0].modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  test('ignores non-text content blocks', async () => {
    mockSend.mockResolvedValue({
      body: bodyOf({ content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'kept' }] }),
    });
    expect(await bedrockInvokeModel()('p')).toBe('kept');
  });
});
