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

import { describe, expect, it } from 'vitest';
import type { Explanation } from '../src/core/components/Explain';
import { COST_EXPLANATIONS } from '../src/core/util/costs';
import { outcomeParts, SECTIONS } from '../src/core/util/scoreboard';
import { COUNTERS } from '../src/domains/overview/OverviewPage';
import { mockScoreboard } from '../src/mocks/fixtures';

const EXPLAINED: readonly (readonly [string, Explanation])[] = [
  ...SECTIONS.flatMap((section) => section.tiles).map((tile) => [`Scoreboard, ${tile.label}`, tile.explanation] as const),
  ...outcomeParts(mockScoreboard('30d', new Date()).current).map((part) => [`Scoreboard, the bar part ${part.label}`, part.explanation] as const),
  ...Object.entries(COST_EXPLANATIONS).map(([number, explanation]) => [`Costs, ${number}`, explanation] as const),
  ...COUNTERS.map((counter) => [`Overview, ${counter.label}`, counter.explanation] as const),
];

const MOST_WORDS = { what: 25, why: 45, how: 70 } as const;

const ANSWERS = EXPLAINED.flatMap(([where, explanation]) => (
  (['what', 'why', 'how'] as const).map((question) => [where, question, explanation[question]] as const)
));

describe('the explanation of a metric or of a graph part', () => {
  it.each(ANSWERS)('%s, %s: full sentences, within the length of that answer', (_where, question, answer) => {
    expect(answer).toMatch(/^[A-Z].*\.$/);
    expect(answer.split(' ').length).toBeLessThanOrEqual(MOST_WORDS[question]);
  });
});
