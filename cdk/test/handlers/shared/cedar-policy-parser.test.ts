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
  CedarPolicyParseError,
  concatPolicies,
  isHardDenyRule,
  isValidRuleId,
  matchingRuleIds,
  parseRules,
} from '../../../src/handlers/shared/cedar-policy';

const SOFT_POLICY =
  '@tier("soft") @rule_id("force_push_any") @approval_timeout_s("300") @severity("medium") @category("destructive") ' +
  'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
  'when { context.command like "*git push --force*" };';

const SOFT_POLICY_2 =
  '@tier("soft") @rule_id("write_env_files") @approval_timeout_s("600") @severity("high") @category("filesystem") ' +
  'forbid (principal, action == Agent::Action::"write_file", resource) ' +
  'when { context.path like "*.env*" };';

const HARD_POLICY =
  '@tier("hard") @rule_id("rm_slash") @category("destructive") ' +
  'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
  'when { context.command like "*rm -rf /*" };';

const SOFT_WITH_SUMMARY =
  '@tier("soft") @rule_id("sample_summary") @severity("low") @summary("force push to any branch") ' +
  'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
  'when { context.command like "*--force*" };';

describe('parseRules', () => {
  test('returns empty array for empty input', () => {
    expect(parseRules('')).toEqual([]);
    expect(parseRules('   \n  ')).toEqual([]);
  });

  test('parses single soft policy with full annotation set', () => {
    const rules = parseRules(SOFT_POLICY);
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.rule_id).toBe('force_push_any');
    expect(rule.tier).toBe('soft');
    expect(rule.severity).toBe('medium');
    expect(rule.approval_timeout_s).toBe(300);
    expect(rule.category).toBe('destructive');
    expect(rule.policy_id).toBe('policy0');
    // `summary` falls back to a conditions render when @summary is absent.
    expect(rule.summary.length).toBeGreaterThan(0);
  });

  test('parses hard policy without severity / timeout', () => {
    const rules = parseRules(HARD_POLICY);
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.tier).toBe('hard');
    expect(rule.severity).toBeUndefined();
    expect(rule.approval_timeout_s).toBeUndefined();
  });

  test('preserves order and increments policy_id', () => {
    const rules = parseRules(SOFT_POLICY + '\n' + SOFT_POLICY_2);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.policy_id).toBe('policy0');
    expect(rules[0]!.rule_id).toBe('force_push_any');
    expect(rules[1]!.policy_id).toBe('policy1');
    expect(rules[1]!.rule_id).toBe('write_env_files');
  });

  test('prefers @summary annotation when present', () => {
    const rules = parseRules(SOFT_WITH_SUMMARY);
    expect(rules[0]!.summary).toBe('force push to any branch');
  });

  test('rejects policy missing @tier', () => {
    const bad =
      '@rule_id("no_tier") forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*foo*" };';
    expect(() => parseRules(bad)).toThrow(CedarPolicyParseError);
    expect(() => parseRules(bad)).toThrow(/missing @tier/);
  });

  test('rejects policy missing @rule_id', () => {
    const bad =
      '@tier("soft") forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*foo*" };';
    expect(() => parseRules(bad)).toThrow(/missing @rule_id/);
  });

  test('rejects policy with invalid @tier value', () => {
    const bad =
      '@tier("weird") @rule_id("bad_tier") ' +
      'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*foo*" };';
    expect(() => parseRules(bad)).toThrow(/missing @tier/);
  });

  test('coerces bad @approval_timeout_s to undefined', () => {
    const bad =
      '@tier("soft") @rule_id("bad_timeout") @approval_timeout_s("abc") @severity("low") ' +
      'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*foo*" };';
    const rules = parseRules(bad);
    expect(rules[0]!.approval_timeout_s).toBeUndefined();
  });

  test('coerces bad @severity to undefined', () => {
    const bad =
      '@tier("soft") @rule_id("bad_sev") @severity("critical") ' +
      'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
      'when { context.command like "*foo*" };';
    const rules = parseRules(bad);
    expect(rules[0]!.severity).toBeUndefined();
  });

  test('CedarPolicyParseError carries upstream errors', () => {
    const bad = '@tier("soft") @rule_id("unclosed_policy" ;';
    try {
      parseRules(bad);
      fail('expected parse error');
    } catch (err) {
      expect(err).toBeInstanceOf(CedarPolicyParseError);
      const e = err as CedarPolicyParseError;
      expect(e.errors).toBeDefined();
    }
  });
});

describe('isHardDenyRule', () => {
  test('true for hard-deny rule ID', () => {
    expect(isHardDenyRule(HARD_POLICY, 'rm_slash')).toBe(true);
  });

  test('false for soft-deny rule ID', () => {
    expect(isHardDenyRule(SOFT_POLICY, 'force_push_any')).toBe(false);
  });

  test('false for unknown rule ID', () => {
    expect(isHardDenyRule(HARD_POLICY, 'unknown_rule')).toBe(false);
  });

  test('false for empty policy text', () => {
    expect(isHardDenyRule('', 'rm_slash')).toBe(false);
  });
});

describe('isValidRuleId', () => {
  test('true when rule_id exists', () => {
    const rules = parseRules(SOFT_POLICY);
    expect(isValidRuleId(rules, 'force_push_any')).toBe(true);
  });

  test('false when rule_id missing', () => {
    const rules = parseRules(SOFT_POLICY);
    expect(isValidRuleId(rules, 'nope')).toBe(false);
  });
});

describe('matchingRuleIds', () => {
  test('maps policy_id[] back to rule_id[]', () => {
    const rules = parseRules(SOFT_POLICY + '\n' + SOFT_POLICY_2);
    expect(matchingRuleIds(rules, ['policy0', 'policy1'])).toEqual([
      'force_push_any',
      'write_env_files',
    ]);
  });

  test('skips unknown policy IDs silently', () => {
    const rules = parseRules(SOFT_POLICY);
    expect(matchingRuleIds(rules, ['policy0', 'policy42'])).toEqual(['force_push_any']);
  });

  test('preserves order from the matching input', () => {
    const rules = parseRules(SOFT_POLICY + '\n' + SOFT_POLICY_2);
    expect(matchingRuleIds(rules, ['policy1', 'policy0'])).toEqual([
      'write_env_files',
      'force_push_any',
    ]);
  });

  test('empty input returns empty array', () => {
    const rules = parseRules(SOFT_POLICY);
    expect(matchingRuleIds(rules, [])).toEqual([]);
  });
});

describe('concatPolicies', () => {
  test('returns builtin when blueprint is empty', () => {
    expect(concatPolicies(HARD_POLICY, '')).toBe(HARD_POLICY);
    expect(concatPolicies(HARD_POLICY, '   ')).toBe(HARD_POLICY);
  });

  test('returns blueprint when builtin is empty', () => {
    expect(concatPolicies('', SOFT_POLICY)).toBe(SOFT_POLICY);
  });

  test('joins with newline', () => {
    expect(concatPolicies(HARD_POLICY, SOFT_POLICY)).toBe(`${HARD_POLICY}\n${SOFT_POLICY}`);
  });
});
