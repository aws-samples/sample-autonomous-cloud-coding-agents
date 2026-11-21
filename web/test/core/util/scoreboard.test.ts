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
} from '../../../src/core/util/scoreboard';
import { mockScoreboard } from '../../../src/mocks/fixtures';

const NOW = new Date('2026-11-19T12:00:00Z');
/** A busy month after another one: most of its new pull requests are merged. */
const MONTH = mockScoreboard('30d', NOW);
/** Two weeks in a repository ABCA has read no pull request of: a week without a verified pull request, after a week with one pull request. */
const WEEK = mockScoreboard('7d', NOW);

const ALL_TILES = SECTIONS.flatMap((section) => section.tiles);
const TILES = new Map(ALL_TILES.map((spec) => [spec.label, spec]));
/** Between the two units of a duration. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);
/** The one tile whose number is of the whole response, not of a period. */
const WAITING = 'Pull requests open for more than 7 days';

/**
 * A tile of the page, with its number, its line and its tasks as functions of a period.
 * The board they are read with is the month's: only the tile of {@link WAITING} reads it,
 * and its tests name the board.
 */
function tile(label: string, board: Scoreboard = MONTH) {
  const spec = TILES.get(label);
  if (!spec) throw new Error(`no tile "${label}"`);
  const { value, detail, tasks } = spec;
  return {
    ...spec,
    value: (period: ScoreboardPeriod) => value(period, board),
    detail: detail && ((period: ScoreboardPeriod) => detail(period, board)),
    tasks: tasks && ((period: ScoreboardPeriod) => tasks(period, board)),
  };
}

/** The month's numbers with some of them replaced. */
function month(overrides: Partial<ScoreboardPeriod>): ScoreboardPeriod {
  return { ...MONTH.current, ...overrides };
}

const NOTHING = { count: 0, total: 0 };
const NO_VERIFIED_PR = { ...MONTH.current.outcomes, verified_pr: 0 };
const NO_TOUCHPOINT = { approve: 0, clarify: 0, follow_up: 0, cancel: 0 };

/** The new pull requests of a period, by what ABCA last read of them on GitHub. */
function states(merged: number, closed: number, open: number, unread: number): ScoreboardPeriod['pull_requests'] {
  return { merged, closed, open, unread };
}

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
      ['Speed', 'How long it takes.', [
        'Time to verified pull request',
        'Time to merged pull request',
        'Waited in line',
        'Pull requests open for more than 7 days',
      ]],
      ['Quality', 'How often it comes out right.', [
        'Ended in a verified pull request',
        'Merged, so far',
        'Merged without being sent back',
        'Not reworked through ABCA, so far',
      ]],
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

  it('say nowhere that a merge or a review is out of sight: the three sentences that did', () => {
    expect(SECTIONS[1].notMeasured).toBe('Not measured by ABCA: change failure rate and time to restore, which need deploy and incident data, and'
      + ' whether a merged change was later reverted.');
    // The page times the first review; what it cannot see is the time people spend on reviewing.
    expect(SECTIONS[2].notMeasured).toBe('Not measured by ABCA: the hours people spent, the time people spent reviewing, and work a person did by hand.');
    expect(tile('Not reworked through ABCA, so far').explanation.how)
      .toMatch(/ are not visible to ABCA, reviews on GitHub are not counted here, and recent pull requests can still be sent back\.$/);
    expect(outcomeParts(MONTH.current)[0].explanation.how).toMatch(/ Whether it was merged afterwards is counted under "Merged, so far"\.$/);
  });
});

describe('the bubbles of the numbers that rest on a read of GitHub', () => {
  it.each([
    ['Time to merged pull request', 'How long it takes, from the moment you submit a task, until its pull request is merged.'],
    [WAITING, 'New pull requests that are still open on GitHub more than 7 days after their task finished.'],
    ['Merged, so far', "Of this period's new pull requests that ABCA has read on GitHub, the share that are merged."],
    ['Merged without being sent back', 'Of the merged pull requests, the share that nobody sent back for changes first.'],
  ])('%s says what it is', (label, what) => {
    expect(tile(label).explanation.what).toBe(what);
  });

  it.each([
    [
      'Time to merged pull request',
      'why',
      'Most of it is usually spent after the agent finished: compare it with "Time to verified pull request", and see "Pull requests open for more than 7 days".',
    ],
    [
      'Time to merged pull request',
      'how',
      "The line under the number counts a review when someone with write access to the repository, other than the pull request's author, submits it.",
    ],
    [WAITING, 'how', 'The tasks linked under the number are the ones that finished longest ago, ten at most.'],
    [WAITING, 'how', 'Not in it: pull requests ABCA could not read, one opened by a task that failed, and those of an orchestration.'],
    [
      'Merged, so far',
      'why',
      'When the share is low, read the line under the number: closed without merging, or still open (see "Pull requests open for more than 7 days").',
    ],
    ['Merged, so far', 'how', 'ABCA reads GitHub about once an hour.'],
    [
      'Merged, so far',
      'how',
      // A pull request the token cannot read, or that GitHub does not have under the recorded number, is followed:
      // the line under the number counts it as not read.
      "Not read: pull requests ABCA's token cannot read or GitHub does not have. Not followed: those of a task that failed, and of an orchestration.",
    ],
    ['Merged without being sent back', 'how', 'with no change request by a reviewer with write access and no follow-up task of yours'],
    [
      'Merged without being sent back',
      'how',
      'Not counted: review comments without a change request, and a change request that was dismissed.'
        + ' Not visible to ABCA: follow-ups by other people and fixes pushed by hand.',
    ],
  ] as const)('%s, %s, states the rule: %s', (label, question, rule) => {
    expect(tile(label).explanation[question]).toContain(rule);
  });
});

describe('a tile over a busy month', () => {
  it.each([
    ['Time to verified pull request', '24m', 'Median of 26 verified pull requests. 9 in 10 within 58m. Typically 1m of it before the agent started.'],
    [
      'Time to merged pull request',
      `1d${NO_BREAK_SPACE}3h`,
      `Median of 20 merged pull requests. 9 in 10 within 3d${NO_BREAK_SPACE}2h.`
        + ' 18 of them had a review by someone else, typically 6h after the task finished.',
    ],
    ['Waited in line', '8%', '4 of 48 tasks that waited in line or started'],
    ['Ended in a verified pull request', '70%', '26 of 37 tasks that asked for a new pull request'],
    // The one not read is outside the share: 20 of 28 would be 71%.
    ['Merged, so far', '74%', '20 of 27 new pull requests that ABCA has read on GitHub. 2 closed without merging, 5 still open. 1 not read.'],
    ['Merged without being sent back', '85%', '17 of 20 merged pull requests'],
    ['Not reworked through ABCA, so far', '79%', '22 of 28 new pull requests'],
    ['Verified pull request with no stop for a person', '62%', '23 of 37 tasks that asked for a new pull request'],
    [
      'Human touchpoints per verified pull request',
      '1.4',
      '36 in all: 20 approval requests · 6 questions from the agent · 8 follow-ups · 2 cancelled. 1.8 per merged pull request so far.',
    ],
    [
      'Spend per verified pull request',
      '$4.12',
      // The figure names what its divisor leaves out: the pull requests that can still be merged, and the one not read.
      '$107.12 on 45 tasks that write code and started. 3 have no recorded cost.'
        + ' $5.36 per merged pull request so far: 20 merged, 5 still open, 1 not read.',
    ],
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
      pull_requests: states(1204, 250, 600, 1086),
      merged_clean: { count: 1001, total: 1204 },
      time_to_merge_s: { p50: 97200, p90: 266400, count: 1204 },
      first_review_s: { p50: 21600, p90: 100800, count: 1001 },
    });
    expect(tile('Waited in line').detail?.(large)).toBe('1,204 of 2,140 tasks that waited in line or started');
    expect(tile('Human touchpoints per verified pull request').detail?.(large))
      .toBe('1,650 in all: 1,650 approval requests. 1.4 per merged pull request so far.');
    expect(tile('Spend per verified pull request').value(large)).toBe('$5,214.21');
    expect(tile('Spend per verified pull request').detail?.(large)).toBe(
      '$135,569.44 on 2,140 tasks that write code and started. 1,001 have no recorded cost.'
      + ' $112.60 per merged pull request so far: 1,204 merged, 600 still open, 1,086 not read.',
    );
    expect(tile('Time to merged pull request').detail?.(large)).toBe(
      `Median of 1,204 merged pull requests. 9 in 10 within 3d${NO_BREAK_SPACE}2h.`
      + ' 1,001 of them had a review by someone else, typically 6h after the task finished.',
    );
    expect(tile('Merged, so far').detail?.(large))
      .toBe('1,204 of 2,054 new pull requests that ABCA has read on GitHub. 250 closed without merging, 600 still open. 1,086 not read.');
    expect(tile('Merged without being sent back').detail?.(large)).toBe('1,001 of 1,204 merged pull requests');
    expect(tile('Merged, so far').detail?.(month({ pull_requests: states(0, 0, 0, 2140) })))
      .toBe('ABCA has not read the 2,140 new pull requests of this period on GitHub.');
    expect(tile('Merged, so far').detail?.(month({ outcomes: { ...MONTH.current.outcomes, verified_pr: 2166 } })))
      .toBe('20 of 27 new pull requests that ABCA has read on GitHub. 2 closed without merging, 5 still open. 1 not read.'
        + ' The 2,140 of an orchestration are not followed.');
    expect(tile(WAITING, { ...MONTH, open_over_7d: { count: 2140, task_ids: [] } }).value(large)).toBe('2,140');
  });

  it('counts one of a thing in the singular', () => {
    const one = { count: 1, total: 1 };
    const single = month({
      outcomes: { ...MONTH.current.outcomes, verified_pr: 1, unverified_pr: 0 },
      time_to_verified_pr_s: { p50: 7500, p90: 7500, count: 1 },
      wait_p50_s: null,
      queued: one,
      verified: one,
      not_reworked: one,
      gated: one,
      touchpoints: { approve: 1, clarify: 0, follow_up: 0, cancel: 0 },
      spend_usd: 2.5,
      uncosted: 0,
      pull_requests: states(1, 0, 0, 0),
      merged_clean: one,
      time_to_merge_s: { p50: 93600, p90: 93600, count: 1 },
      first_review_s: { p50: 7200, p90: 7200, count: 1 },
    });
    expect(tile('Time to verified pull request').value(single)).toBe(`2h${NO_BREAK_SPACE}5m`);
    expect(tile('Time to verified pull request').detail?.(single)).toBe('Median of 1 verified pull request.');
    expect(tile('Time to merged pull request').value(single)).toBe(`1d${NO_BREAK_SPACE}2h`);
    // One pull request is not "1 of them", and its one review has a time, not a typical time.
    expect(tile('Time to merged pull request').detail?.(single))
      .toBe('Median of 1 merged pull request. It had a review by someone else, 2h after the task finished.');
    expect(tile('Waited in line').detail?.(single)).toBe('1 of 1 task that waited in line or started');
    expect(tile('Ended in a verified pull request').detail?.(single)).toBe('1 of 1 task that asked for a new pull request');
    expect(tile('Merged, so far').detail?.(single)).toBe('1 of 1 new pull request that ABCA has read on GitHub.');
    expect(tile('Merged without being sent back').detail?.(single)).toBe('1 of 1 merged pull request');
    expect(tile('Not reworked through ABCA, so far').detail?.(single)).toBe('1 of 1 new pull request');
    expect(tile('Held for approval').detail?.(single)).toBe('1 of 1 task that writes code and started');
    expect(tile('Human touchpoints per verified pull request').value(single)).toBe('1');
    expect(tile('Human touchpoints per verified pull request').detail?.(single))
      .toBe('1 in all: 1 approval request. 1 per merged pull request so far.');
    expect(tile('Spend per verified pull request').detail?.(single))
      .toBe('$2.50 on 1 task that writes code and started. $2.50 per merged pull request so far: 1 merged.');
    expect(tile('Merged, so far').detail?.({ ...single, pull_requests: states(0, 0, 0, 1) }))
      .toBe('ABCA has not read the new pull request of this period on GitHub.');
  });

  it.each([
    [9, 'Median of 9 verified pull requests. Typically 1m of it before the agent started.'],
    [10, 'Median of 10 verified pull requests. 9 in 10 within 58m. Typically 1m of it before the agent started.'],
  ])('names the time 9 in 10 stay within only from ten pull requests up: %d', (count, detail) => {
    expect(tile('Time to verified pull request').detail?.(month({ time_to_verified_pr_s: { p50: 1432, p90: 3480, count } }))).toBe(detail);
  });

  it.each([
    [9, 'Median of 9 merged pull requests.'],
    [10, `Median of 10 merged pull requests. 9 in 10 within 3d${NO_BREAK_SPACE}2h.`],
  ])('names the time 9 in 10 are merged within only from ten merged pull requests up: %d', (count, detail) => {
    const period = month({ time_to_merge_s: { p50: 97200, p90: 266400, count }, first_review_s: null });
    expect(tile('Time to merged pull request').detail?.(period)).toBe(detail);
  });

  it('says of one review among several pull requests when it came, not when reviews typically come', () => {
    expect(tile('Time to merged pull request').detail?.(month({ first_review_s: { p50: 21600, p90: 21600, count: 1 } }))).toBe(
      `Median of 20 merged pull requests. 9 in 10 within 3d${NO_BREAK_SPACE}2h.`
      + ' 1 of them had a review by someone else, 6h after the task finished.',
    );
  });

  it('says that the reviews came before the task had finished, when the API counts their time as 0', () => {
    expect(tile('Time to merged pull request').detail?.(month({ first_review_s: { p50: 0, p90: 3600, count: 18 } }))).toBe(
      `Median of 20 merged pull requests. 9 in 10 within 3d${NO_BREAK_SPACE}2h.`
      + ' 18 of them had a review by someone else, typically before the task had finished.',
    );
  });

  it('leaves out what the period does not have: no touchpoint, every cost recorded, no pull request still open or not read', () => {
    const smooth = month({ touchpoints: NO_TOUCHPOINT, uncosted: 0, pull_requests: states(26, 2, 0, 0) });
    expect(tile('Human touchpoints per verified pull request').value(smooth)).toBe('0');
    expect(tile('Human touchpoints per verified pull request').detail?.(smooth)).toBe('None in this period.');
    expect(tile('Spend per verified pull request').detail?.(smooth))
      .toBe('$107.12 on 45 tasks that write code and started. $4.12 per merged pull request so far: 26 merged.');
    expect(tile('Merged, so far').detail?.(smooth)).toBe('26 of 28 new pull requests that ABCA has read on GitHub. 2 closed without merging.');
  });

  it('does not round a few touchpoints over many pull requests down to none', () => {
    const rare = month({ touchpoints: { approve: 1, clarify: 0, follow_up: 0, cancel: 0 }, pull_requests: states(40, 0, 0, 0) });
    expect(tile('Human touchpoints per verified pull request').value(rare)).toBe('<0.1');
    expect(tile('Human touchpoints per verified pull request').detail?.(rare))
      .toBe('1 in all: 1 approval request. <0.1 per merged pull request so far.');
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
    ['Not reworked through ABCA, so far', '100%', '2 of 2 new pull requests'],
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
    ['Not reworked through ABCA, so far', 'No new pull request in this period.'],
    ['Verified pull request with no stop for a person', 'No task asked for a new pull request in this period.'],
    ['Held for approval', 'No task that writes code started in this period.'],
  ])('%s gives the reason in place of the counts', (label, reason) => {
    const quiet = month({ queued: NOTHING, verified: NOTHING, untouched: NOTHING, gated: NOTHING, not_reworked: NOTHING });
    expect(tile(label).value(quiet)).toBeNull();
    expect(tile(label).detail?.(quiet)).toBe(reason);
  });

  it('states the numerator only when there is one', () => {
    const idle = month({ outcomes: NO_VERIFIED_PR, touchpoints: NO_TOUCHPOINT, uncosted: 0, pull_requests: states(0, 0, 2, 0) });
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

describe('the numbers over the merged pull requests of a period', () => {
  /** A period of the month in which no pull request is merged. */
  function unmerged(pullRequests: ScoreboardPeriod['pull_requests'], newPullRequests: Partial<ScoreboardPeriod['outcomes']> = {}): ScoreboardPeriod {
    return month({
      outcomes: { ...MONTH.current.outcomes, ...newPullRequests },
      pull_requests: pullRequests,
      merged_clean: NOTHING,
      time_to_merge_s: null,
      first_review_s: null,
    });
  }

  it.each([
    ['the period has no new pull request', unmerged(states(0, 0, 0, 0), { verified_pr: 0, unverified_pr: 0 }), 'No new pull request in this period.'],
    [
      "its new pull requests, all verified, are an orchestration's, which ABCA does not follow",
      unmerged(states(0, 0, 0, 0), { verified_pr: 3, unverified_pr: 0 }),
      'ABCA does not follow the pull requests of an orchestration on GitHub.',
    ],
    [
      "its new pull requests, none verified, are an orchestration's",
      unmerged(states(0, 0, 0, 0), { verified_pr: 0, unverified_pr: 2 }),
      'ABCA does not follow the pull requests of an orchestration on GitHub.',
    ],
    [
      'ABCA has read none of its new pull requests, and no read may be coming',
      unmerged(states(0, 0, 0, 28)),
      'ABCA has not read the 28 new pull requests of this period on GitHub.',
    ],
  ])('are all missing, for one reason, when %s', (_when, period, reason) => {
    for (const label of ['Time to merged pull request', 'Merged, so far', 'Merged without being sent back']) {
      expect(tile(label).value(period)).toBeNull();
      expect(tile(label).detail?.(period)).toBe(reason);
    }
  });

  it('say that none is merged yet only of pull requests ABCA has read; the share is then 0%, with its counts', () => {
    const period = unmerged(states(0, 2, 5, 1), { verified_pr: 6, unverified_pr: 2 });
    for (const label of ['Time to merged pull request', 'Merged without being sent back']) {
      expect(tile(label).value(period)).toBeNull();
      expect(tile(label).detail?.(period)).toBe('No pull request of this period is merged yet.');
    }
    expect(tile('Merged, so far').value(period)).toBe('0%');
    expect(tile('Merged, so far').detail?.(period))
      .toBe('0 of 7 new pull requests that ABCA has read on GitHub. 2 closed without merging, 5 still open. 1 not read.');
  });

  it.each([
    [
      'beside the ones it has read',
      month({ outcomes: { ...MONTH.current.outcomes, verified_pr: 22, unverified_pr: 0 }, pull_requests: states(2, 0, 0, 0) }),
      '2 of 2 new pull requests that ABCA has read on GitHub. The 20 of an orchestration are not followed.',
    ],
    [
      'beside the ones it has read, when it is one',
      month({ outcomes: { ...MONTH.current.outcomes, verified_pr: 2, unverified_pr: 1 }, pull_requests: states(2, 0, 0, 0) }),
      '2 of 2 new pull requests that ABCA has read on GitHub. The one of an orchestration is not followed.',
    ],
    [
      'beside the one it has not read',
      unmerged(states(0, 0, 0, 1), { verified_pr: 3, unverified_pr: 0 }),
      'ABCA has not read the new pull request of this period on GitHub. The 2 of an orchestration are not followed.',
    ],
  ])('"Merged, so far" names the pull requests of an orchestration, which ABCA does not follow, %s', (_where, period, detail) => {
    // "Not reworked through ABCA, so far", beside it, counts them: without the sentence the two totals differ unexplained.
    expect(tile('Merged, so far').detail?.(period)).toBe(detail);
  });

  it('names them under no other of the three tiles: only "Merged, so far" counts a total', () => {
    const period = unmerged(states(0, 0, 0, 1), { verified_pr: 3, unverified_pr: 0 });
    for (const label of ['Time to merged pull request', 'Merged without being sent back']) {
      expect(tile(label).detail?.(period)).toBe('ABCA has not read the new pull request of this period on GitHub.');
    }
  });

  it('says nothing of reviews when no merged pull request had one by someone else', () => {
    expect(tile('Time to merged pull request').detail?.(month({ first_review_s: null })))
      .toBe(`Median of 20 merged pull requests. 9 in 10 within 3d${NO_BREAK_SPACE}2h.`);
  });

  it('does not set the touchpoints and the spend against merged pull requests while none is merged', () => {
    const period = unmerged(states(0, 2, 5, 0));
    expect(tile('Human touchpoints per verified pull request').detail?.(period))
      .toBe('36 in all: 20 approval requests · 6 questions from the agent · 8 follow-ups · 2 cancelled');
    expect(tile('Spend per verified pull request').detail?.(period)).toBe('$107.12 on 45 tasks that write code and started. 3 have no recorded cost.');
  });

  it('sets them against the merged pull requests of a period without a verified one: a pull request can be merged without a passed build', () => {
    const week = { ...WEEK.current, pull_requests: states(2, 0, 0, 0) };
    expect(tile('Human touchpoints per verified pull request').detail?.(week)).toBe(
      'No verified pull request in this period. 5 in all: 2 approval requests · 1 question from the agent · 1 follow-up · 1 cancelled.'
      + ' 2.5 per merged pull request so far.',
    );
    expect(tile('Spend per verified pull request').detail?.(week)).toBe(
      'No verified pull request in this period. $12.40 spent on 6 tasks that write code and started. 1 has no recorded cost.'
      + ' $6.20 per merged pull request so far: 2 merged.',
    );
  });

  it('names in the spend sentence the pull requests of an orchestration: their tasks are in the spend, and their merges never count', () => {
    const period = month({
      outcomes: { ...MONTH.current.outcomes, verified_pr: 22, unverified_pr: 0 },
      pull_requests: states(2, 0, 3, 1),
      spend_usd: 110,
      uncosted: 0,
      gated: { count: 0, total: 22 },
    });
    expect(tile('Spend per verified pull request').detail?.(period))
      .toBe('$110.00 on 22 tasks that write code and started. $55.00 per merged pull request so far: 2 merged, 3 still open, 1 not read,'
        + ' 16 of an orchestration not followed.');
  });
});

describe(`"${WAITING}", the one number of the whole response`, () => {
  /** What the tile shows for a response: its number, the line under it, the tasks it links. */
  function shown(board: Scoreboard) {
    const waiting = tile(WAITING, board);
    return { value: waiting.value(board.current), detail: waiting.detail?.(board.current), tasks: waiting.tasks?.(board.current) };
  }

  it('shows the count the API gives, with its tasks in place of a line of text', () => {
    expect(shown(MONTH)).toEqual({ value: '2', detail: null, tasks: MONTH.open_over_7d });
  });

  it('shows the zero the API counted, whatever is read of the current period: none of its pull requests is old enough to count', () => {
    const board = { ...MONTH, current: month({ pull_requests: states(0, 0, 0, 28) }), open_over_7d: { count: 0, task_ids: [] } };
    expect(shown(board)).toEqual({ value: '0', detail: null, tasks: board.open_over_7d });
  });

  /** The month's response with that many more verified pull requests in each period than ABCA follows: an orchestration's. */
  function withOrchestration(current: number, before: number): Scoreboard {
    if (!MONTH.previous) throw new Error('the month has no period before it');
    const more = (period: ScoreboardPeriod, count: number): ScoreboardPeriod => (
      { ...period, outcomes: { ...period.outcomes, verified_pr: period.outcomes.verified_pr + count } }
    );
    return { ...MONTH, current: more(MONTH.current, current), previous: more(MONTH.previous, before) };
  }

  it.each([
    ['in the current period', 20, 0, 'The 20 of an orchestration are not followed.'],
    ['in the period before', 0, 1, 'The one of an orchestration is not followed.'],
    ['in both periods', 20, 1, 'The 21 of an orchestration are not followed.'],
  ])('names under a count the pull requests of an orchestration %s: the count rests on both periods and leaves them out', (_where, current, before, sentence) => {
    expect(shown(withOrchestration(current, before))).toEqual({ value: '2', detail: sentence, tasks: MONTH.open_over_7d });
  });

  it('names them under a zero too: of pull requests that are all of an orchestration, ABCA sees none wait', () => {
    const board = { ...withOrchestration(20, 0), open_over_7d: { count: 0, task_ids: [] } };
    expect(shown(board)).toEqual({ value: '0', detail: 'The 20 of an orchestration are not followed.', tasks: board.open_over_7d });
  });

  it.each([
    ['ABCA has read none of the pull requests that are old enough', WEEK, 'ABCA has not read these pull requests on GitHub.'],
    [
      'the read did not reach the period before',
      { ...MONTH, previous: null, open_over_7d: null },
      'The scoreboard did not read far enough back to count these.',
    ],
    [
      // What a count leaves out is said under a count: under a dash the one line is the reason.
      'ABCA has read none of them, and the periods hold pull requests of an orchestration too',
      { ...withOrchestration(20, 1), open_over_7d: null },
      'ABCA has not read these pull requests on GitHub.',
    ],
  ])('shows no number and no task, and says why, when the API does not know the count: %s', (_when, board, reason) => {
    expect(shown(board)).toEqual({ value: null, detail: reason, tasks: null });
  });
});

describe('previousLine', () => {
  it.each([
    ['Time to verified pull request', '31m in the 30 days before'],
    ['Time to merged pull request', `1d${NO_BREAK_SPACE}9h in the 30 days before`],
    ['Ended in a verified pull request', '62% (18 of 29) in the 30 days before'],
    ['Merged, so far', '71% (15 of 21) in the 30 days before'],
    ['Verified pull request with no stop for a person', '55% (16 of 29) in the 30 days before'],
    ['Human touchpoints per verified pull request', '1.6 in the 30 days before'],
    ['Spend per verified pull request', '$4.51 in the 30 days before'],
    ['Waited in line', null],
    [WAITING, null],
    ['Merged without being sent back', null],
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
    // A period before in which no task asked for a new pull request.
    const before = month({
      outcomes: { ...MONTH.current.outcomes, verified_pr: 0, unverified_pr: 0 },
      time_to_verified_pr_s: null,
      verified: NOTHING,
      untouched: NOTHING,
      pull_requests: states(0, 0, 0, 0),
      time_to_merge_s: null,
    });
    expect(ALL_TILES.map((spec) => previousLine(spec, { ...MONTH, previous: before }))).toEqual(ALL_TILES.map(() => null));
    // The merged share is a share of the pull requests ABCA has read: with none read there is nothing to quote.
    expect(previousLine(tile('Merged, so far'), { ...MONTH, previous: month({ pull_requests: states(0, 0, 0, 21) }) })).toBeNull();
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
