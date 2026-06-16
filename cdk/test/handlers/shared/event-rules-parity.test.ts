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

import * as fs from 'fs';
import * as path from 'path';
import { matchEventRules, parseEventRules } from '../../../src/handlers/shared/event-rule-evaluator';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'contracts', 'event-rules', 'fixtures');

interface FixtureFile {
  description?: string;
  event: { event_type: string; metadata?: Record<string, unknown> };
  rules: unknown[];
  expected_matches: string[];
  aggregate_state?: { cumulative_cost_usd?: number; turn_count?: number };
}

function loadFixtures(): FixtureFile[] {
  return fs.readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as FixtureFile);
}

describe('event-rules parity (TS evaluator)', () => {
  it.each(loadFixtures().map(f => [path.basename(f.description ?? 'fixture'), f]))(
    '%s',
    (_name, fixture) => {
      const rules = parseEventRules(fixture.rules);
      const matched = matchEventRules(rules, {
        event_type: fixture.event.event_type,
        metadata: fixture.event.metadata ?? {},
      }, {
        aggregateState: fixture.aggregate_state,
      }).map(r => r.id);
      expect(matched.sort()).toEqual([...fixture.expected_matches].sort());
    },
  );
});
