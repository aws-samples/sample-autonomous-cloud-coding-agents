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

/**
 * Cedar-HITL Day-1 spike: cedar-wasm parse + annotation extraction contract.
 *
 * Locks the assumption (decision #22 / §15.6 of
 * docs/design/CEDAR_HITL_GATES.md) that @cedar-policy/cedar-wasm@4.10.0
 * preserves the five HITL annotations (@rule_id, @tier, @approval_timeout_s,
 * @severity, @category) verbatim as a string → string Record under
 * ``policyToJson(text).json.annotations``.
 *
 * If a future cedar-wasm release renames the key, drops values, or changes
 * the wrapper shape, this test flips red BEFORE shared/cedar-policy.ts
 * (Chunk 5) starts returning subtly-wrong annotation data to CreateTaskFn
 * and friends.
 *
 * Parity with cedarpy is tested separately in cedar-parity.test.ts against
 * the shared contracts/cedar-parity/ fixtures; this file validates only the
 * Lambda-side (cedar-wasm) API shape.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cedar = require('@cedar-policy/cedar-wasm/nodejs');

const ANNOTATED_POLICY =
  '@tier("soft") ' +
  '@rule_id("force_push_any") ' +
  '@approval_timeout_s("300") ' +
  '@severity("medium") ' +
  '@category("destructive") ' +
  'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
  'when { context.command like "*git push --force*" };';

interface PolicySetParts {
  type: 'success' | 'failure';
  policies?: string[];
  errors?: unknown[];
}

interface PolicyJson {
  type: 'success' | 'failure';
  json?: {
    effect: string;
    principal: unknown;
    action: unknown;
    resource: unknown;
    conditions: unknown;
    annotations?: Record<string, string>;
  };
  errors?: unknown[];
}

function firstPolicyJson(policiesText: string): PolicyJson['json'] {
  const parts = cedar.policySetTextToParts(policiesText) as PolicySetParts;
  expect(parts.type).toBe('success');
  expect(parts.policies).toBeDefined();
  expect(parts.policies!.length).toBeGreaterThanOrEqual(1);
  const parsed = cedar.policyToJson(parts.policies![0]) as PolicyJson;
  expect(parsed.type).toBe('success');
  expect(parsed.json).toBeDefined();
  return parsed.json!;
}

describe('cedar-wasm API contract — policyToJson annotation surface', () => {
  test('policySetTextToParts returns success wrapper with policies array', () => {
    const parts = cedar.policySetTextToParts(ANNOTATED_POLICY) as PolicySetParts;
    expect(parts.type).toBe('success');
    expect(Array.isArray(parts.policies)).toBe(true);
    expect(parts.policies!.length).toBe(1);
  });

  test('policyToJson returns {type: success, json: {...}} wrapper', () => {
    const parts = cedar.policySetTextToParts(ANNOTATED_POLICY) as PolicySetParts;
    const parsed = cedar.policyToJson(parts.policies![0]) as PolicyJson;
    // Chunk 5's shared/cedar-policy.ts checks parsed.type before touching
    // .json — if cedar-wasm ever flattens this wrapper, the null-guard
    // blocks parsing but the rule-ID map silently empties.
    expect(parsed.type).toBe('success');
    expect(parsed.json).toBeDefined();
  });

  test('annotations key present on parsed policy', () => {
    const json = firstPolicyJson(ANNOTATED_POLICY);
    expect(json).toHaveProperty('annotations');
    expect(json!.annotations).toBeDefined();
  });

  test('rule_id annotation preserved', () => {
    const { annotations } = firstPolicyJson(ANNOTATED_POLICY)!;
    expect(annotations!.rule_id).toBe('force_push_any');
  });

  test('tier annotation preserved', () => {
    const { annotations } = firstPolicyJson(ANNOTATED_POLICY)!;
    expect(annotations!.tier).toBe('soft');
  });

  test('approval_timeout_s annotation preserved as string', () => {
    // Cedar annotations are always string-valued; the Lambda parser coerces
    // to int inside isHardDenyRule / rule-ID lookup (§15.6 sketch).
    const { annotations } = firstPolicyJson(ANNOTATED_POLICY)!;
    expect(annotations!.approval_timeout_s).toBe('300');
    expect(typeof annotations!.approval_timeout_s).toBe('string');
  });

  test('severity annotation preserved', () => {
    const { annotations } = firstPolicyJson(ANNOTATED_POLICY)!;
    expect(annotations!.severity).toBe('medium');
  });

  test('category annotation preserved', () => {
    const { annotations } = firstPolicyJson(ANNOTATED_POLICY)!;
    expect(annotations!.category).toBe('destructive');
  });

  test('all five annotations present exactly', () => {
    const { annotations } = firstPolicyJson(ANNOTATED_POLICY)!;
    expect(annotations).toEqual({
      tier: 'soft',
      rule_id: 'force_push_any',
      approval_timeout_s: '300',
      severity: 'medium',
      category: 'destructive',
    });
  });

  test('multi-policy split via policySetTextToParts', () => {
    const twoPolicies =
      ANNOTATED_POLICY +
      '\n' +
      '@tier("soft") @rule_id("force_push_main") @approval_timeout_s("600") @severity("high") ' +
      'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*git push --force origin main*" };';
    const parts = cedar.policySetTextToParts(twoPolicies) as PolicySetParts;
    expect(parts.type).toBe('success');
    expect(parts.policies!.length).toBe(2);
    // The shared parser (§15.6 parseRules sketch) iterates this array and
    // calls policyToJson per element; confirming the split is ordered and
    // lossless matters for per-rule annotation recovery.
    const first = cedar.policyToJson(parts.policies![0]) as PolicyJson;
    const second = cedar.policyToJson(parts.policies![1]) as PolicyJson;
    expect(first.json!.annotations!.rule_id).toBe('force_push_any');
    expect(second.json!.annotations!.rule_id).toBe('force_push_main');
  });
});

describe('cedar-wasm API contract — isAuthorized shape', () => {
  test('isAuthorized returns {type: success, response: {decision, diagnostics}}', () => {
    const r = cedar.isAuthorized({
      principal: { type: 'Agent::TaskAgent', id: 'new_task' },
      action: { type: 'Agent::Action', id: 'execute_bash' },
      resource: { type: 'Agent::BashCommand', id: 'command' },
      context: { command: 'git push --force origin main' },
      policies: { staticPolicies: ANNOTATED_POLICY },
      entities: [],
    });
    expect(r.type).toBe('success');
    expect(r.response).toBeDefined();
    expect(r.response.decision).toBe('deny');
    // cedar-wasm exposes matching policy IDs under diagnostics.reason
    // (singular) — note the asymmetry with cedarpy's diagnostics.reasons
    // (plural). The shared parser (§15.6) normalizes via the fixture
    // comparator. IMPL-29 candidate: document this naming asymmetry in
    // §15.6 so future maintainers don't trip on it.
    expect(r.response.diagnostics.reason).toEqual(['policy0']);
  });

  test('diagnostics.reason contains multiple IDs on multi-match', () => {
    const policies =
      ANNOTATED_POLICY +
      '\n' +
      '@tier("soft") @rule_id("force_push_main") @approval_timeout_s("600") @severity("high") ' +
      'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*git push --force origin main*" };';
    const r = cedar.isAuthorized({
      principal: { type: 'Agent::TaskAgent', id: 'new_task' },
      action: { type: 'Agent::Action', id: 'execute_bash' },
      resource: { type: 'Agent::BashCommand', id: 'command' },
      context: { command: 'git push --force origin main' },
      policies: { staticPolicies: policies },
      entities: [],
    });
    expect(r.type).toBe('success');
    expect(r.response.decision).toBe('deny');
    // §6.3 annotation-merging depends on both matching policy IDs being
    // returned here. If cedar-wasm short-circuits on first match, the
    // cross-engine parity test (cedar-parity.test.ts) catches it.
    expect(r.response.diagnostics.reason.length).toBe(2);
  });
});
