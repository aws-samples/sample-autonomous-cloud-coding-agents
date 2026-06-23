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
  buildDecompositionPrompt,
  DEFAULT_DECOMPOSITION_MODEL_ID,
  parsePlannerResponse,
  planDecomposition,
  SIZE_DEFAULT_BUDGET_USD,
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

describe('buildDecompositionPrompt — deterministic + carries the inputs', () => {
  test('includes title, description, repo, and the cap', () => {
    const p = buildDecompositionPrompt(INPUT);
    expect(p).toContain('acme/web');
    expect(p).toContain('Add a pricing page');
    expect(p).toContain('Build a /pricing route');
    expect(p).toContain('at most 8 sub-issues');
    expect(p).toContain('should_decompose');
  });

  test('is a pure function (same input → same prompt)', () => {
    expect(buildDecompositionPrompt(INPUT)).toBe(buildDecompositionPrompt(INPUT));
  });

  test('handles an empty description gracefully', () => {
    const p = buildDecompositionPrompt({ ...INPUT, description: '   ' });
    expect(p).toContain('(no description provided)');
  });
});

describe('parsePlannerResponse — golden plans', () => {
  test('a fan-out plan (3 independent leaves) parses + sizes budgets', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'Three independent surfaces.',
      sub_issues: [
        { title: 'Pricing route', description: 'Add /pricing', size: 'M', depends_on: [] },
        { title: 'Comparison table', description: 'Table component', size: 'S', depends_on: [] },
        { title: 'Stripe checkout', description: 'Checkout flow', size: 'L', depends_on: [] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
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
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'Sequential build order.',
      sub_issues: [
        { title: 'Schema', description: 'DB schema', size: 'S', depends_on: [] },
        { title: 'API', description: 'Endpoints', size: 'M', depends_on: [0] },
        { title: 'UI', description: 'Frontend', size: 'M', depends_on: [1] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[1].depends_on).toEqual([0]);
      expect(r.plan.nodes[2].depends_on).toEqual([1]);
    }
  });

  test('a diamond plan (A→{B,C}→D) parses', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'Fan-out then integrate.',
      sub_issues: [
        { title: 'Base', description: 'base', size: 'S', depends_on: [] },
        { title: 'Left', description: 'left', size: 'M', depends_on: [0] },
        { title: 'Right', description: 'right', size: 'M', depends_on: [0] },
        { title: 'Merge', description: 'merge', size: 'M', depends_on: [1, 2] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes[3].depends_on).toEqual([1, 2]);
  });

  test('tolerates markdown fences and leading prose around the JSON', () => {
    const raw = 'Here is the plan:\n```json\n'
      + JSON.stringify({
        should_decompose: true,
        reasoning: 'x',
        sub_issues: [
          { title: 'One', description: 'a', size: 'S', depends_on: [] },
          { title: 'Two', description: 'b', size: 'S', depends_on: [0] },
        ],
      })
      + '\n```\nLet me know if you want changes.';
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('plan');
  });
});

describe('parsePlannerResponse — single-task verdicts', () => {
  test('should_decompose false → single_task with reasoning', () => {
    const raw = JSON.stringify({ should_decompose: false, reasoning: 'Small cohesive fix.', sub_issues: [] });
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('single_task');
    if (r.kind === 'single_task') expect(r.reasoning).toBe('Small cohesive fix.');
  });

  test('a single proposed node (<2) collapses to single_task (nothing to orchestrate)', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'only one unit',
      sub_issues: [{ title: 'Just do it', description: 'x', size: 'M', depends_on: [] }],
    });
    expect(parsePlannerResponse(raw, 8).kind).toBe('single_task');
  });
});

describe('parsePlannerResponse — malformed + adversarial', () => {
  test('non-JSON garbage → error', () => {
    expect(parsePlannerResponse('I cannot help with that.', 8).kind).toBe('error');
  });

  test('an unbalanced/truncated brace (no closing }) → error, not a throw', () => {
    // A "{" that never closes — the brace scanner must fall through to null.
    expect(parsePlannerResponse('Here you go: { "should_decompose": true, "sub_issues": [', 8).kind).toBe('error');
  });

  test('a "{" inside a string does not confuse the balancer', () => {
    const raw = '{ "should_decompose": false, "reasoning": "use the { token }", "sub_issues": [] }';
    expect(parsePlannerResponse(raw, 8).kind).toBe('single_task');
  });

  test('a node missing a title → error (not silently dropped)', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'x',
      sub_issues: [
        { title: 'Good', description: 'a', size: 'S', depends_on: [] },
        { description: 'no title', size: 'M', depends_on: [0] },
      ],
    });
    expect(parsePlannerResponse(raw, 8).kind).toBe('error');
  });

  test('a self-contradictory plan (cycle) is rejected by validateDag', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'oops cyclic',
      sub_issues: [
        { title: 'A', description: 'a', size: 'S', depends_on: [1] },
        { title: 'B', description: 'b', size: 'S', depends_on: [0] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('cycle');
  });

  test('out-of-range / self / non-integer depends_on indices are dropped, not fatal', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'messy edges',
      sub_issues: [
        { title: 'A', description: 'a', size: 'S', depends_on: [0, 99, 'x'] }, // self + OOR + junk
        { title: 'B', description: 'b', size: 'M', depends_on: [0] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[0].depends_on).toEqual([]); // all of A's edges were invalid
      expect(r.plan.nodes[1].depends_on).toEqual([0]);
    }
  });

  test('an unknown size defaults to M', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'x',
      sub_issues: [
        { title: 'A', description: 'a', size: 'XL', depends_on: [] },
        { title: 'B', description: 'b', depends_on: [] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') {
      expect(r.plan.nodes[0].size).toBe('M');
      expect(r.plan.nodes[1].size).toBe('M');
    }
  });

  test('over-cap node count still parses into a plan (caps reject downstream, not here)', () => {
    const sub_issues = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`, description: 'x', size: 'S', depends_on: [],
    }));
    const r = parsePlannerResponse(JSON.stringify({ should_decompose: true, reasoning: 'big', sub_issues }), 8);
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.nodes).toHaveLength(10);
  });

  test('a node description defaults to its title when absent', () => {
    const raw = JSON.stringify({
      should_decompose: true,
      reasoning: 'x',
      sub_issues: [
        { title: 'Only a title', size: 'S', depends_on: [] },
        { title: 'Second', size: 'S', depends_on: [0] },
      ],
    });
    const r = parsePlannerResponse(raw, 8);
    if (r.kind === 'plan') expect(r.plan.nodes[0].description).toBe('Only a title');
  });
});

describe('planDecomposition — model boundary', () => {
  test('threads the prompt through the injected model and parses its output', async () => {
    const invoke = jest.fn().mockResolvedValue(JSON.stringify({
      should_decompose: true,
      reasoning: 'two units',
      sub_issues: [
        { title: 'A', description: 'a', size: 'S', depends_on: [] },
        { title: 'B', description: 'b', size: 'M', depends_on: [0] },
      ],
    }));
    const r = await planDecomposition(INPUT, invoke);
    expect(r.kind).toBe('plan');
    // The model received a prompt containing the issue title.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toContain('Add a pricing page');
  });

  test('a model throw is caught and returned as error (never throws)', async () => {
    const invoke = jest.fn().mockRejectedValue(new Error('bedrock 500'));
    const r = await planDecomposition(INPUT, invoke);
    expect(r.kind).toBe('error');
  });
});

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
      body: bodyOf({ content: [{ type: 'text', text: '{"should_decompose":false,' }, { type: 'text', text: '"sub_issues":[]}' }] }),
    });
    const invoke = bedrockInvokeModel();
    const out = await invoke('PROMPT-TEXT');

    expect(out).toBe('{"should_decompose":false,"sub_issues":[]}');
    // Request body: anthropic_version + the prompt as a user message + temp 0.
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
