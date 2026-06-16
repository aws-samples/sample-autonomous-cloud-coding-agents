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
 * Async event governance tests (issue #230).
 */

import { matchEventRules, parseEventRules } from '../../../src/handlers/shared/event-rule-evaluator';

describe('event-governance-async matching', () => {
  test('async notify rule matches pr_created milestone', () => {
    const rules = parseEventRules([
      {
        id: 'notify-on-pr',
        on: 'pr_created',
        action: 'notify',
        mode: 'enforce',
        evaluation: 'async',
        notify_channels: ['slack'],
      },
    ]);
    const matched = matchEventRules(
      rules,
      { event_type: 'agent_milestone', metadata: { milestone: 'pr_created' } },
      { evaluation: 'async' },
    );
    expect(matched.map(r => r.id)).toEqual(['notify-on-pr']);
    expect(matched[0].notify_channels).toContain('slack');
  });
});
