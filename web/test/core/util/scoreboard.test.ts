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
import type { Scoreboard, ScoreboardPeriod } from '../../../src/core/api/types';
import { formatTimestamp } from '../../../src/core/util/format';
import {
  contextLine,
  nothingFinished,
  outcomeParts,
  outcomeRows,
  percent,
  previousLine,
  SECTIONS,
  truncationNotice,
  type TileSpec,
} from '../../../src/core/util/scoreboard';
import { mockScoreboard } from '../../../src/mocks/fixtures';

const NOW = new Date('2026-11-19T12:00:00Z');
/** A busy month after another one. */
const MONTH = mockScoreboard('30d', NOW);
/** A week without a verified pull request, after a week without coding work. */
const WEEK = mockScoreboard('7d', NOW);

const ALL_TILES = SECTIONS.flatMap((section) => section.tiles);
const TILES = new Map(ALL_TILES.map((spec) => [spec.label, spec]));
/** Between the two units of a duration. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

function tile(label: string): TileSpec {
  const spec = TILES.get(label);
  if (!spec) throw new Error(`no tile "${label}"`);
  return spec;
}

/** The month's numbers with some of them replaced. */
function month(overrides: Partial<ScoreboardPeriod>): ScoreboardPeriod {
  return { ...MONTH.current, ...overrides };
}

const NOTHING = { count: 0, total: 0 };
const NO_VERIFIED_PR = { ...MONTH.current.outcomes, verified_pr: 0 };

describe('percent', () => {
  it.each([
    [26, 37, '70%'],
    [2, 3, '67%'],
    // 14.5 exactly: dividing first and multiplying after gives 14.499999999999998.
    [29, 200, '15%'],
    [1, 200, '1%'],
    [0, 5, '0%'],
    [5, 5, '100%'],
  ])('%d of %d is %s', (count, total, expected) => {
    expect(percent({ count, total })).toBe(expected);
  });

  it.each([
    [1, 201, '<1%'],
    [1, 2140, '<1%'],
    [200, 201, '>99%'],
    [2139, 2140, '>99%'],
  ])('%d of %d is %s: some is never none, and most is never all', (count, total, expected) => {
    expect(percent({ count, total })).toBe(expected);
  });

  it('has no value when there is nothing to divide by', () => {
    expect(percent(NOTHING)).toBeNull();
  });
});

describe('the sections of the page', () => {
  it('are the four headings, each with its tiles in reading order', () => {
    expect(SECTIONS.map((section) => [section.title, section.description, section.tiles.map((spec) => spec.label)])).toEqual([
      ['Speed', 'How long it takes.', ['Time to verified pull request', 'Waited in line']],
      ['Quality', 'How often it comes out right.', ['Ended in a verified pull request', 'Not reworked through ABCA, so far']],
      ['Leverage', 'How much it needs you, and what it costs.', [
        'Verified pull request with no stop for a person',
        'Human touchpoints per verified pull request',
        'Spend per verified pull request',
      ]],
      ['Trust', 'Whether it stayed inside the rules.', ['Stopped by a guardrail', 'Held for approval', 'Started with blanket approval']],
    ]);
  });

  it('say under each heading what ABCA cannot see', () => {
    expect(SECTIONS.map((section) => section.notMeasured.split(/[:.]/)[0])).toEqual([
      'Not measured by ABCA',
      'Not measured by ABCA',
      'Not measured by ABCA',
      'ABCA does not merge pull requests and does not see who does',
    ]);
  });
});

describe('a tile over a busy month', () => {
  it.each([
    ['Time to verified pull request', '24m', 'Median of 26 verified pull requests. 9 in 10 within 58m. Typically 1m of it before the agent started.'],
    ['Waited in line', '8%', '4 of 48 tasks that waited in line or started'],
    ['Ended in a verified pull request', '70%', '26 of 37 tasks that asked for a new pull request'],
    ['Not reworked through ABCA, so far', '79%', '22 of 28 new pull requests'],
    ['Verified pull request with no stop for a person', '62%', '23 of 37 tasks that asked for a new pull request'],
    [
      'Human touchpoints per verified pull request',
      '1.4',
      '36 in all: 20 approval requests · 6 questions from the agent · 8 follow-ups · 2 cancelled',
    ],
    ['Spend per verified pull request', '$4.12', '$107.12 on 45 tasks that write code and started. 3 have no recorded cost.'],
    ['Held for approval', '7%', '3 of 45 tasks that write code and started'],
  ])('%s: %s', (label, value, detail) => {
    expect(tile(label).value(MONTH.current)).toBe(value);
    expect(tile(label).detail?.(MONTH.current)).toBe(detail);
  });

  it.each([
    ['Stopped by a guardrail', 'guardrail_stops'],
    ['Started with blanket approval', 'blanket_approvals'],
  ] as const)('%s: the count, and its tasks in place of a line of text', (label, field) => {
    const flagged = { count: 2140, task_ids: ['01JF3KQZ8X0000000000FAILED01'] };
    const period = month({ [field]: flagged });
    expect(tile(label).value(period)).toBe('2,140');
    expect(tile(label).tasks?.(period)).toBe(flagged);
    expect(tile(label).detail).toBeUndefined();
  });

  it('groups the digits of the large numbers it quotes', () => {
    const large = month({
      queued: { count: 1204, total: 2140 },
      gated: { count: 1204, total: 2140 },
      touchpoints: { approve: 1650, clarify: 0, follow_up: 0, cancel: 0 },
      spend_usd: 135569.44,
      uncosted: 1001,
    });
    expect(tile('Waited in line').detail?.(large)).toBe('1,204 of 2,140 tasks that waited in line or started');
    expect(tile('Human touchpoints per verified pull request').detail?.(large)).toBe('1,650 in all: 1,650 approval requests');
    expect(tile('Spend per verified pull request').value(large)).toBe('$5,214.21');
    expect(tile('Spend per verified pull request').detail?.(large)).toBe('$135,569.44 on 2,140 tasks that write code and started. 1,001 have no recorded cost.');
  });

  it('counts one of a thing in the singular', () => {
    const one = { count: 1, total: 1 };
    const single = month({
      outcomes: { ...MONTH.current.outcomes, verified_pr: 1 },
      time_to_verified_pr_s: { p50: 7500, p90: 7500, count: 1 },
      wait_p50_s: null,
      queued: one,
      verified: one,
      not_reworked: one,
      gated: one,
      touchpoints: { approve: 1, clarify: 0, follow_up: 0, cancel: 0 },
      spend_usd: 2.5,
      uncosted: 0,
    });
    expect(tile('Time to verified pull request').value(single)).toBe(`2h${NO_BREAK_SPACE}5m`);
    expect(tile('Time to verified pull request').detail?.(single)).toBe('Median of 1 verified pull request.');
    expect(tile('Waited in line').detail?.(single)).toBe('1 of 1 task that waited in line or started');
    expect(tile('Ended in a verified pull request').detail?.(single)).toBe('1 of 1 task that asked for a new pull request');
    expect(tile('Not reworked through ABCA, so far').detail?.(single)).toBe('1 of 1 new pull request');
    expect(tile('Held for approval').detail?.(single)).toBe('1 of 1 task that writes code and started');
    expect(tile('Human touchpoints per verified pull request').value(single)).toBe('1');
    expect(tile('Human touchpoints per verified pull request').detail?.(single)).toBe('1 in all: 1 approval request');
    expect(tile('Spend per verified pull request').detail?.(single)).toBe('$2.50 on 1 task that writes code and started.');
  });

  it.each([
    [9, 'Median of 9 verified pull requests. Typically 1m of it before the agent started.'],
    [10, 'Median of 10 verified pull requests. 9 in 10 within 58m. Typically 1m of it before the agent started.'],
  ])('names the time 9 in 10 stay within only from ten pull requests up: %d', (count, detail) => {
    expect(tile('Time to verified pull request').detail?.(month({ time_to_verified_pr_s: { p50: 1432, p90: 3480, count } }))).toBe(detail);
  });

  it('leaves out what the period does not have: no touchpoint, every cost recorded', () => {
    const smooth = month({ touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 }, uncosted: 0 });
    expect(tile('Human touchpoints per verified pull request').value(smooth)).toBe('0');
    expect(tile('Human touchpoints per verified pull request').detail?.(smooth)).toBe('None in this period.');
    expect(tile('Spend per verified pull request').detail?.(smooth)).toBe('$107.12 on 45 tasks that write code and started.');
  });

  it('does not round a few touchpoints over many pull requests down to none', () => {
    const rare = month({ touchpoints: { approve: 1, clarify: 0, follow_up: 0, cancel: 0 } });
    expect(tile('Human touchpoints per verified pull request').value(rare)).toBe('<0.1');
    expect(previousLine(tile('Human touchpoints per verified pull request'), { ...MONTH, previous: rare })).toBe('<0.1 in the 30 days before');
  });

  it.each([
    [240, 'None of the 240 tasks that write code and started has a recorded cost.'],
    [1, 'The only task that writes code and started has no recorded cost.'],
  ])('has no spend to show, and says so, when none of the %d tasks that write code and started has a recorded cost', (started, detail) => {
    const unknown = month({ gated: { count: 0, total: started }, uncosted: started, spend_usd: 0 });
    expect(tile('Spend per verified pull request').value(unknown)).toBeNull();
    expect(tile('Spend per verified pull request').detail?.(unknown)).toBe(detail);
    expect(previousLine(tile('Spend per verified pull request'), { ...MONTH, previous: unknown })).toBeNull();
  });
});

describe('a tile with nothing to divide by', () => {
  it.each([
    ['Time to verified pull request', null, 'No verified pull request in this period.'],
    ['Waited in line', '14%', '1 of 7 tasks that waited in line or started'],
    ['Ended in a verified pull request', '0%', '0 of 5 tasks that asked for a new pull request'],
    ['Not reworked through ABCA, so far', null, 'No new pull request in this period.'],
    ['Verified pull request with no stop for a person', '0%', '0 of 5 tasks that asked for a new pull request'],
    [
      'Human touchpoints per verified pull request',
      null,
      'No verified pull request in this period. 5 in all: 2 approval requests · 1 question from the agent · 1 follow-up · 1 cancelled',
    ],
    [
      'Spend per verified pull request',
      null,
      'No verified pull request in this period. $12.40 spent on 6 tasks that write code and started. 1 has no recorded cost.',
    ],
    ['Held for approval', '17%', '1 of 6 tasks that write code and started'],
  ])('%s in a week without a verified pull request: %s', (label, value, detail) => {
    expect(tile(label).value(WEEK.current)).toBe(value);
    expect(tile(label).detail?.(WEEK.current)).toBe(detail);
  });

  it.each([
    ['Waited in line', 'No task waited or started in this period.'],
    ['Ended in a verified pull request', 'No task asked for a new pull request in this period.'],
    ['Verified pull request with no stop for a person', 'No task asked for a new pull request in this period.'],
    ['Held for approval', 'No task that writes code started in this period.'],
  ])('%s gives the reason in place of the counts', (label, reason) => {
    const quiet = month({ queued: NOTHING, verified: NOTHING, untouched: NOTHING, gated: NOTHING });
    expect(tile(label).value(quiet)).toBeNull();
    expect(tile(label).detail?.(quiet)).toBe(reason);
  });

  it('states the numerator only when there is one', () => {
    const idle = month({ outcomes: NO_VERIFIED_PR, touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 }, uncosted: 0 });
    expect(tile('Human touchpoints per verified pull request').detail?.(idle)).toBe('No verified pull request in this period.');
    expect(tile('Spend per verified pull request').detail?.(idle))
      .toBe('No verified pull request in this period. $107.12 spent on 45 tasks that write code and started.');
  });

  it('says of the spend only that there is no verified pull request, when no task that writes code started', () => {
    const noCoding = month({ outcomes: NO_VERIFIED_PR, gated: NOTHING, spend_usd: 0, uncosted: 0 });
    expect(tile('Spend per verified pull request').value(noCoding)).toBeNull();
    expect(tile('Spend per verified pull request').detail?.(noCoding)).toBe('No verified pull request in this period.');
  });

  it('says both when no pull request was verified and no task that writes code and started has a recorded cost', () => {
    const unknown = month({ outcomes: NO_VERIFIED_PR, gated: { count: 0, total: 6 }, spend_usd: 0, uncosted: 6 });
    expect(tile('Spend per verified pull request').detail?.(unknown))
      .toBe('No verified pull request in this period. None of the 6 tasks that write code and started has a recorded cost.');
  });
});

describe('previousLine', () => {
  it.each([
    ['Time to verified pull request', '31m in the 30 days before'],
    ['Ended in a verified pull request', '62% (18 of 29) in the 30 days before'],
    ['Verified pull request with no stop for a person', '55% (16 of 29) in the 30 days before'],
    ['Human touchpoints per verified pull request', '1.6 in the 30 days before'],
    ['Spend per verified pull request', '$4.51 in the 30 days before'],
    ['Waited in line', null],
    ['Not reworked through ABCA, so far', null],
    ['Stopped by a guardrail', null],
    ['Held for approval', null],
    ['Started with blanket approval', null],
  ])('%s: %s', (label, line) => {
    expect(previousLine(tile(label), MONTH)).toBe(line);
  });

  it('names the length of the range', () => {
    const week: Scoreboard = { ...WEEK, previous: MONTH.previous };
    expect(previousLine(tile('Ended in a verified pull request'), week)).toBe('62% (18 of 29) in the 7 days before');
  });

  it('is absent when the period before has nothing to compute the number from', () => {
    expect(ALL_TILES.map((spec) => previousLine(spec, WEEK))).toEqual(ALL_TILES.map(() => null));
  });

  it('is absent when the period before was not read', () => {
    expect(previousLine(tile('Ended in a verified pull request'), { ...MONTH, previous: null })).toBeNull();
  });
});

describe('the sentences around the tiles', () => {
  /** What follows the counts: which period a task belongs to, and what "verified" proves. */
  const RULES = 'A task counts in the period it finished in. A verified pull request is one opened after the'
    + " repository's build command passed, which proves only what that command checks.";

  it('name the populations the tiles count over', () => {
    expect(contextLine(MONTH)).toBe(`52 tasks finished in the last 30 days: 37 asked for a new pull request, 26 delivered a verified one. ${RULES}`);
    expect(contextLine(WEEK)).toBe(`8 tasks finished in the last 7 days: 5 asked for a new pull request, 0 delivered a verified one. ${RULES}`);
  });

  it('count one task in the singular', () => {
    const one = { count: 1, total: 1 };
    expect(contextLine({ ...MONTH, current: month({ finished: 1, verified: one }) }))
      .toBe(`1 task finished in the last 30 days: 1 asked for a new pull request, 1 delivered a verified one. ${RULES}`);
  });

  it('group the digits of large counts', () => {
    expect(contextLine({ ...MONTH, current: month({ finished: 2140, verified: { count: 1204, total: 1650 } }) }))
      .toBe(`2,140 tasks finished in the last 30 days: 1,650 asked for a new pull request, 1,204 delivered a verified one. ${RULES}`);
  });

  it('say since when, for a read that did not reach the start of the range', () => {
    const from = '2026-11-07T09:42:07.000Z';
    const cut: Scoreboard = { ...MONTH, truncated: true, previous: null, current: month({ from }) };
    expect(contextLine(cut)).toBe(`52 tasks finished since ${formatTimestamp(from)}: 37 asked for a new pull request, 26 delivered a verified one. ${RULES}`);
  });

  it('advise a shorter range for such a read, except on the shortest', () => {
    const from = '2026-11-17T09:42:07.000Z';
    const reach = `Showing tasks finished since ${formatTimestamp(from)}. This range holds more than the scoreboard reads at once`;
    expect(truncationNotice({ ...MONTH, truncated: true, previous: null, current: month({ from }) })).toBe(`${reach}; a shorter range may cover all of it.`);
    expect(truncationNotice({ ...WEEK, truncated: true, previous: null, current: { ...WEEK.current, from } })).toBe(`${reach}.`);
  });

  it('say so when no task finished', () => {
    expect(nothingFinished(WEEK)).toBe('No tasks finished in the last 7 days. The scoreboard fills in as your tasks finish.');
  });
});

describe('outcomes', () => {
  it('lists the six outcomes with their share of the finished tasks and the slot of their bar part', () => {
    expect(outcomeRows(MONTH.current).map((row) => [row.outcome, row.label, row.count, row.share, row.slot])).toEqual([
      ['verified_pr', 'Verified pull request', 26, '50%', 0],
      ['unverified_pr', 'Pull request without a passed build', 2, '4%', 2],
      ['no_new_pr', 'Finished, no new pull request', 15, '29%', 2],
      ['failed', 'Failed', 5, '10%', 1],
      ['cancelled', 'Cancelled', 2, '4%', 1],
      ['timed_out', 'Ran out of time', 2, '4%', 1],
    ]);
  });

  it('folds them into the three parts of the bar, which add up to the finished tasks, each with its number in words', () => {
    expect(outcomeParts(MONTH.current).map((part) => [part.label, part.slot, part.count, part.summary])).toEqual([
      ['Verified pull request', 0, 26, '26 of 52 finished tasks, 50%'],
      ['Finished without a verified pull request', 2, 17, '17 of 52 finished tasks, 33%'],
      ['Failed or stopped', 1, 9, '9 of 52 finished tasks, 17%'],
    ]);
    expect(outcomeParts(WEEK.current).map((part) => part.count)).toEqual([0, 3, 5]);
  });

  it('gives a part no share when no task finished', () => {
    const none = month({ finished: 0, outcomes: { verified_pr: 0, unverified_pr: 0, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 } });
    expect(outcomeParts(none).map((part) => part.summary)).toEqual(Array(3).fill('0 of 0 finished tasks'));
  });
});
