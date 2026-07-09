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

import type { EventRule } from '../../../src/handlers/shared/event-governance-types';
import {
  resolveEventRules,
  UnknownEventRulePackError,
  listBuiltinEventRulePacks,
} from '../../../src/handlers/shared/event-rule-pack-resolver';

const PACK = { id: 'platform-default', version: '1.0.0' } as const;

describe('resolveEventRules', () => {
  test('returns inline rules verbatim when no pack is pinned', () => {
    const inline: EventRule[] = [
      { id: 'a', on: 'pr_created', action: 'notify', mode: 'enforce', evaluation: 'async' },
    ];
    expect(resolveEventRules({ inlineRules: inline })).toEqual(inline);
  });

  test('returns pack rules (tagged with rule_pack_id) when no inline rules', () => {
    const rules = resolveEventRules({ packRef: PACK });
    expect(rules.map((r) => r.id)).toEqual(expect.arrayContaining(['observe-repo-setup', 'notify-on-pr']));
    expect(rules.every((r) => r.rule_pack_id === 'platform-default')).toBe(true);
  });

  test('inline rule with same id overrides the pack rule', () => {
    const override: EventRule = {
      id: 'notify-on-pr',
      on: 'pr_created',
      action: 'cancel_task',
      mode: 'enforce',
      evaluation: 'async',
    };
    const rules = resolveEventRules({ packRef: PACK, inlineRules: [override] });
    const merged = rules.find((r) => r.id === 'notify-on-pr');
    // The inline override replaces the pack's action wholesale.
    expect(merged?.action).toBe('cancel_task');
    // The other pack rule is retained.
    expect(rules.find((r) => r.id === 'observe-repo-setup')).toBeDefined();
  });

  test('inline-only rule is appended alongside pack rules', () => {
    const extra: EventRule = {
      id: 'inline-extra',
      on: 'agent_turn',
      action: 'escalate',
      mode: 'enforce',
      evaluation: 'async',
    };
    const rules = resolveEventRules({ packRef: PACK, inlineRules: [extra] });
    expect(rules.map((r) => r.id)).toEqual(
      expect.arrayContaining(['observe-repo-setup', 'notify-on-pr', 'inline-extra']),
    );
  });

  test('throws UnknownEventRulePackError for an unknown pin', () => {
    expect(() => resolveEventRules({ packRef: { id: 'nope', version: '0.0.1' } }))
      .toThrow(UnknownEventRulePackError);
  });

  test('throws UnknownEventRulePackError for a known id at an unknown version', () => {
    expect(() => resolveEventRules({ packRef: { id: 'platform-default', version: '9.9.9' } }))
      .toThrow(UnknownEventRulePackError);
  });

  test('listBuiltinEventRulePacks reports the bundled pack', () => {
    const packs = listBuiltinEventRulePacks();
    expect(packs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'platform-default', version: '1.0.0' }),
      ]),
    );
    expect(packs[0].rule_count).toBeGreaterThan(0);
  });
});
