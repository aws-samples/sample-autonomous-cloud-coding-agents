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
 * Event rule evaluator tests (issue #230).
 */

import aggregateFixture from '../../../../agent/event-rules/fixtures/aggregate-cost-cancel.json';
import observeFixture from '../../../../agent/event-rules/fixtures/observe-repo-setup.json';
import type { EventRule } from '../../../src/handlers/shared/event-governance-types';
import {
  buildPolicyDecisionMetadata,
  matchEventRules,
  parseEventRules,
} from '../../../src/handlers/shared/event-rule-evaluator';

describe('event-rule-evaluator', () => {
  test('matches observe-repo-setup fixture', () => {
    const rules = parseEventRules(observeFixture.rules);
    const matched = matchEventRules(rules, observeFixture.event, { evaluation: 'sync' });
    expect(matched.map((r: EventRule) => r.id)).toEqual(observeFixture.expected_matches);
  });

  test('matches aggregate-cost-cancel fixture', () => {
    const rules = parseEventRules(aggregateFixture.rules);
    const matched = matchEventRules(rules, aggregateFixture.event, {
      evaluation: 'async',
      aggregateState: aggregateFixture.aggregate_state,
    });
    expect(matched.map((r: EventRule) => r.id)).toEqual(aggregateFixture.expected_matches);
  });

  test('buildPolicyDecisionMetadata marks would_block for enforce require_approval', () => {
    const rules = parseEventRules([
      {
        id: 'gate',
        on: 'checkpoint:before_execution',
        action: 'require_approval',
        mode: 'enforce',
        evaluation: 'sync',
      },
    ]);
    const meta = buildPolicyDecisionMetadata(rules[0], {
      event_type: 'agent_milestone',
      metadata: { milestone: 'checkpoint:before_execution', checkpoint: 'checkpoint:before_execution' },
    }, true);
    expect(meta.would_block).toBe(true);
    expect(meta.source).toBe('event_rule');
  });
});
