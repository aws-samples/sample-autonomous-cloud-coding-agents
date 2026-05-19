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

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_HARD_DENY_POLICIES,
  BUILTIN_SOFT_DENY_POLICIES,
} from '../../../src/handlers/shared/builtin-policies';
import { parseRules } from '../../../src/handlers/shared/cedar-policy';

const AGENT_POLICIES_DIR = path.join(__dirname, '..', '..', '..', '..', 'agent', 'policies');

describe('builtin-policies — drift guard', () => {
  test('BUILTIN_HARD_DENY_POLICIES matches agent/policies/hard_deny.cedar byte-for-byte', () => {
    const agentFile = fs.readFileSync(
      path.join(AGENT_POLICIES_DIR, 'hard_deny.cedar'),
      'utf-8',
    );
    // The embedded text must match the agent-side file exactly. If a
    // rule is added / removed / re-annotated on one side, update both
    // in the same PR; this test is the tripwire.
    expect(BUILTIN_HARD_DENY_POLICIES).toBe(agentFile);
  });

  test('BUILTIN_SOFT_DENY_POLICIES matches agent/policies/soft_deny.cedar byte-for-byte', () => {
    const agentFile = fs.readFileSync(
      path.join(AGENT_POLICIES_DIR, 'soft_deny.cedar'),
      'utf-8',
    );
    expect(BUILTIN_SOFT_DENY_POLICIES).toBe(agentFile);
  });
});

describe('builtin-policies — parseable by shared/cedar-policy', () => {
  test('hard-deny set parses with the expected rule_ids', () => {
    const rules = parseRules(BUILTIN_HARD_DENY_POLICIES);
    const ruleIds = rules.map((r) => r.rule_id);
    // `base_permit` has no @tier annotation so it's filtered from
    // parseRules — the parser requires @tier + @rule_id on every
    // entry. The hard-deny rules that survive:
    expect(ruleIds).toEqual(
      expect.arrayContaining([
        'pr_review_forbid_write',
        'pr_review_forbid_edit',
        'rm_slash',
        'write_git_internals',
        'write_git_internals_nested',
        'drop_table',
      ]),
    );
    expect(rules.every((r) => r.tier === 'hard' || r.rule_id === 'base_permit')).toBe(true);
  });

  test('soft-deny set parses with the expected rule_ids', () => {
    const rules = parseRules(BUILTIN_SOFT_DENY_POLICIES);
    const ruleIds = rules.map((r) => r.rule_id);
    expect(ruleIds).toEqual(
      expect.arrayContaining([
        'force_push_any',
        'force_push_main',
        'push_to_protected_branch',
        'write_env_files',
        'write_credentials',
      ]),
    );
  });
});
