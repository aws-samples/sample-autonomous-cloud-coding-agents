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

import type { Severity } from './types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cedar = require('@cedar-policy/cedar-wasm/nodejs');

/**
 * Rule metadata recovered from a Cedar policy set.
 *
 * - `policy_id`: the positional ID cedar-wasm assigned on parse (`policy0`, `policy1`, ...).
 * - `rule_id`: author-chosen ID, unique within the tier.
 * - `severity`: soft rules only.
 * - `approval_timeout_s`: per-rule override, in seconds.
 * - `summary`: the `@summary` annotation, or a rendering of the policy's `when` clause.
 */
export interface ParsedRule {
  readonly policy_id: string;
  readonly rule_id: string;
  readonly tier: 'hard' | 'soft';
  readonly severity?: Severity;
  readonly approval_timeout_s?: number;
  readonly category?: string;
  readonly summary: string;
}

export class CedarPolicyParseError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly unknown[],
  ) {
    super(message);
    this.name = 'CedarPolicyParseError';
  }
}

interface CedarPolicySetParts {
  type: 'success' | 'failure';
  policies?: readonly string[];
  policy_templates?: readonly string[];
  errors?: readonly unknown[];
}

interface CedarPolicyJson {
  type: 'success' | 'failure';
  json?: {
    annotations?: Record<string, string>;
    conditions?: unknown;
  };
  errors?: readonly unknown[];
}

/**
 * Parse a Cedar policy set into `ParsedRule[]`, in parse order.
 *
 * @param policiesText - raw Cedar policy text. An empty built-in set returns `[]`.
 * @param nextLegacyRuleId - pass when parsing one Blueprint entry. A single
 *   rule without a tier or rule ID receives a generated ID and the soft tier.
 * @returns ordered list of parsed rules.
 * @throws CedarPolicyParseError if cedar-wasm rejects the text. The
 *         error carries the upstream errors array verbatim.
 */
export function parseRules(policiesText: string, nextLegacyRuleId?: () => string): ParsedRule[] {
  if (!policiesText.trim() && !nextLegacyRuleId) {
    return [];
  }
  const parts = cedar.policySetTextToParts(policiesText) as CedarPolicySetParts;
  if (parts.type !== 'success' || !parts.policies) {
    throw new CedarPolicyParseError(
      'cedar-wasm rejected policy set',
      parts.errors ?? [],
    );
  }
  const policies = parts.policies;
  if (nextLegacyRuleId && (!policies.length || parts.policy_templates?.length)) {
    throw new CedarPolicyParseError('Blueprint entry must contain static Cedar policies', []);
  }

  const out: ParsedRule[] = [];
  policies.forEach((policyText, index) => {
    const parsed = cedar.policyToJson(policyText) as CedarPolicyJson;
    if (parsed.type !== 'success' || !parsed.json) {
      throw new CedarPolicyParseError(
        `cedar-wasm rejected policy ${index}`,
        parsed.errors ?? [],
      );
    }
    const annotations = parsed.json.annotations ?? {};
    if (nextLegacyRuleId && policies.length === 1
      && annotations.tier === undefined && annotations.rule_id === undefined) {
      annotations.tier = 'soft';
      annotations.rule_id = nextLegacyRuleId();
    }
    const tier = annotations.tier;
    const rule_id = annotations.rule_id;

    if (!nextLegacyRuleId && rule_id === 'base_permit' && tier === undefined) {
      return;
    }

    if (tier !== 'hard' && tier !== 'soft') {
      throw new CedarPolicyParseError(
        `policy ${index} is missing @tier("hard") or @tier("soft")`,
        [],
      );
    }
    if (!rule_id) {
      throw new CedarPolicyParseError(
        `policy ${index} is missing @rule_id`,
        [],
      );
    }
    if (nextLegacyRuleId && out.length > 0 && out[0]!.tier !== tier) {
      throw new CedarPolicyParseError('Put hard and soft rules in separate Blueprint entries', []);
    }

    const rule: ParsedRule = {
      policy_id: `policy${index}`,
      rule_id,
      tier,
      severity: coerceSeverity(annotations.severity),
      approval_timeout_s: coerceTimeout(annotations.approval_timeout_s),
      category: annotations.category,
      summary: annotations.summary ?? deriveSummary(parsed.json.conditions),
    };
    out.push(rule);
  });
  return out;
}

/**
 * True when `ruleId` resolves to a hard-deny rule in `policiesText`.
 */
export function isHardDenyRule(policiesText: string, ruleId: string): boolean {
  return parseRules(policiesText).some(
    (r) => r.rule_id === ruleId && r.tier === 'hard',
  );
}

/**
 * True when `ruleId` exists in the parsed `rules` regardless of tier.
 */
export function isValidRuleId(rules: readonly ParsedRule[], ruleId: string): boolean {
  return rules.some((r) => r.rule_id === ruleId);
}

/**
 * Convert a list of cedar-wasm matching policy IDs (from
 * `diagnostics.reason`) to the corresponding `rule_id[]`. IDs that do
 * not resolve are skipped.
 */
export function matchingRuleIds(
  rules: readonly ParsedRule[],
  matchingPolicyIds: readonly string[],
): string[] {
  const byId = new Map<string, ParsedRule>();
  for (const rule of rules) {
    byId.set(rule.policy_id, rule);
  }
  const out: string[] = [];
  for (const pid of matchingPolicyIds) {
    const rule = byId.get(pid);
    if (rule) {
      out.push(rule.rule_id);
    }
  }
  return out;
}

/**
 * Concatenate the built-in policies with a blueprint override, built-in first:
 * the order `PolicyEngine.__init__` uses on the agent side.
 *
 * Built-in text is trusted and does not count against the 64 KB
 * blueprint cap; callers enforce the cap on the blueprint text
 * separately.
 */
export function concatPolicies(
  builtin: string,
  blueprint: string,
): string {
  if (!blueprint.trim()) {
    return builtin;
  }
  if (!builtin.trim()) {
    return blueprint;
  }
  return `${builtin}\n${blueprint}`;
}

function coerceSeverity(value: string | undefined): ParsedRule['severity'] {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

function coerceTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

const CEDAR_SUMMARY_MAX_LENGTH = 160;
const CEDAR_SUMMARY_ELLIPSIS_LENGTH = 3;
const CEDAR_SUMMARY_TRUNCATE_LENGTH = CEDAR_SUMMARY_MAX_LENGTH - CEDAR_SUMMARY_ELLIPSIS_LENGTH;

function deriveSummary(conditions: unknown): string {
  if (!conditions) {
    return '(no summary)';
  }
  const raw = JSON.stringify(conditions);
  if (raw.length <= CEDAR_SUMMARY_MAX_LENGTH) {
    return raw;
  }
  return raw.slice(0, CEDAR_SUMMARY_TRUNCATE_LENGTH) + '...';
}
