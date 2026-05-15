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
 * Shared Lambda-side Cedar policy parsing library (design §15.6, §15.2
 * task 11). Wraps `@cedar-policy/cedar-wasm` so handlers that need to
 * inspect blueprint rules (`create-task`, `get-policies`) and handlers
 * that need to evaluate a tool use (future `evaluate` path) share one
 * parser.
 *
 * The matching ``cedarpy`` surface on the agent side is
 * ``agent/src/policy.py``; the cross-engine parity contract
 * (``contracts/cedar-parity/*.json`` + IMPL-29) guarantees the two
 * sides agree on decisions. This module re-derives the key
 * normalization here so a bump in ``cedar-wasm`` that renames
 * ``diagnostics.reason`` is caught by the parity tests before it
 * ships.
 */

import type { Severity } from './types';
// cedar-wasm is a CommonJS package; the nodejs build ships a default
// export that behaves like a module namespace. eslint's
// ``@typescript-eslint/no-require-imports`` is disabled here because
// the wasm package's published types do not expose a working ESM entry
// under Node Lambda.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cedar = require('@cedar-policy/cedar-wasm/nodejs');

/**
 * Parsed rule metadata recovered from a Cedar policy set. Mirrors the
 * five HITL annotations locked in by the Chunk 1 spike (§15.6):
 *
 * - `tier`                 — "hard" | "soft" (required; validated
 *                            separately so a missing tier fails loud).
 * - `rule_id`              — author-chosen ID, unique within the tier.
 * - `severity`             — low/medium/high (soft only; hard rules
 *                            omit).
 * - `approval_timeout_s`   — per-rule override, clamped to the floor
 *                            elsewhere.
 * - `category`             — free-form taxonomy (destructive,
 *                            filesystem, ...).
 *
 * `summary` is a human-readable blurb derived from the optional
 * `@summary` annotation; when absent it falls back to a best-effort
 * render of the policy's `when` clause.
 *
 * `policy_id` is the positional ID cedar-wasm assigned on parse
 * (`policy0`, `policy1`, ...). Used to correlate
 * `diagnostics.reason[]` back to `rule_id` on an evaluation path; not
 * useful outside this module.
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

/** Error raised when the Cedar parser rejects the policy text. */
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
 * Parse a Cedar policy set into `ParsedRule[]`, preserving the five
 * annotations §15.2 task 4 guarantees are on every soft-deny rule.
 *
 * Order is preserved so `policy_id === "policyN"` maps back to
 * `rules[N]` (cedar-wasm assigns positional IDs in parse order).
 *
 * @param policiesText - raw Cedar policy text (concatenated hard +
 *                       soft). Empty string returns `[]`.
 * @returns ordered list of parsed rules.
 * @throws CedarPolicyParseError if cedar-wasm rejects the text. The
 *         error carries the upstream errors array verbatim.
 */
export function parseRules(policiesText: string): ParsedRule[] {
  if (!policiesText.trim()) {
    return [];
  }
  const parts = cedar.policySetTextToParts(policiesText) as CedarPolicySetParts;
  if (parts.type !== 'success' || !parts.policies) {
    throw new CedarPolicyParseError(
      'cedar-wasm rejected policy set',
      parts.errors ?? [],
    );
  }

  const out: ParsedRule[] = [];
  parts.policies.forEach((policyText, index) => {
    const parsed = cedar.policyToJson(policyText) as CedarPolicyJson;
    if (parsed.type !== 'success' || !parsed.json) {
      throw new CedarPolicyParseError(
        `cedar-wasm rejected policy ${index}`,
        parsed.errors ?? [],
      );
    }
    const annotations = parsed.json.annotations ?? {};
    const tier = annotations.tier;
    const rule_id = annotations.rule_id;

    // `base_permit` is an intentional unannotated catch-all on both
    // tiers (see agent/policies/*.cedar comments). cedar engines need
    // it to return ALLOW for non-matching requests rather than
    // default-deny. We skip it from ParsedRule[] so callers only see
    // user-facing rule entries.
    if (rule_id === 'base_permit' && tier === undefined) {
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
 *
 * Used by `create-task` to reject `rule:<id>` pre-approval scopes that
 * point at hard-deny rules (§7.3 step 4).
 */
export function isHardDenyRule(policiesText: string, ruleId: string): boolean {
  return parseRules(policiesText).some(
    (r) => r.rule_id === ruleId && r.tier === 'hard',
  );
}

/**
 * True when `ruleId` exists in the parsed `rules` regardless of tier.
 *
 * Callers do their own `tier === 'soft'` check as needed; surfaced as
 * a helper so the common "rule exists?" check does not re-parse.
 */
export function isValidRuleId(rules: readonly ParsedRule[], ruleId: string): boolean {
  return rules.some((r) => r.rule_id === ruleId);
}

/**
 * Convert a list of cedar-wasm matching policy IDs (from
 * `diagnostics.reason`) to the corresponding `rule_id[]`. IDs that do
 * not resolve are skipped silently — the parity tests catch any
 * structural disagreement between the two engines.
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
 * Bundle the built-in hard + soft policies with a blueprint override.
 *
 * Mirrors the order `PolicyEngine.__init__` uses on the agent side so
 * both engines see the same concatenation. The raw strings feed
 * directly into `parseRules` / `cedar.isAuthorized`; returning the
 * concatenated text (not the parsed rules) gives the caller the option
 * to pass the text to `cedar.isAuthorized` without a second parse
 * round-trip.
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

/**
 * Best-effort summary from a Cedar `when` clause when `@summary` is
 * absent. cedar-wasm returns the conditions as a tagged union JSON
 * tree; we stringify the first expression and cap at ~160 chars so
 * the `GET /v1/repos/{repo}/policies` response stays terse.
 */
function deriveSummary(conditions: unknown): string {
  if (!conditions) {
    return '(no summary)';
  }
  const raw = JSON.stringify(conditions);
  if (raw.length <= 160) {
    return raw;
  }
  return raw.slice(0, 157) + '...';
}
