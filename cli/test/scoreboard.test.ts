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

import * as path from 'path';
import { formatScoreboard } from '../src/scoreboard';
import type { DurationSummary, Flagged, Fraction, Scoreboard, ScoreboardPeriod } from '../src/types';

const CURRENT: ScoreboardPeriod = {
  from: '2026-10-20T12:00:00.000Z',
  to: '2026-11-19T12:00:00.000Z',
  finished: 8,
  outcomes: { verified_pr: 2, unverified_pr: 1, no_new_pr: 2, failed: 1, cancelled: 1, timed_out: 1 },
  time_to_verified_pr_s: { p50: 1440, p90: 3600, count: 2 },
  wait_p50_s: 41,
  queued: { count: 1, total: 7 },
  verified: { count: 2, total: 7 },
  not_reworked: { count: 2, total: 3 },
  untouched: { count: 1, total: 7 },
  touchpoints: { approve: 2, clarify: 1, follow_up: 1, cancel: 1 },
  spend_usd: 14.5,
  uncosted: 2,
  guardrail_stops: { count: 1, task_ids: ['01M6P'] },
  blanket_approvals: { count: 1, task_ids: ['01M7F'] },
  gated: { count: 1, total: 7 },
  pull_requests: { merged: 1, closed: 0, open: 1, unread: 1 },
  merged_clean: { count: 1, total: 1 },
  time_to_merge_s: { p50: 93600, p90: 93600, count: 1 },
  first_review_s: { p50: 21600, p90: 21600, count: 1 },
};

const PREVIOUS: ScoreboardPeriod = {
  from: '2026-09-20T12:00:00.000Z',
  to: '2026-10-20T12:00:00.000Z',
  finished: 2,
  outcomes: { verified_pr: 1, unverified_pr: 0, no_new_pr: 0, failed: 1, cancelled: 0, timed_out: 0 },
  time_to_verified_pr_s: { p50: 1800, p90: 1800, count: 1 },
  wait_p50_s: 60,
  queued: { count: 0, total: 2 },
  verified: { count: 1, total: 2 },
  not_reworked: { count: 1, total: 1 },
  untouched: { count: 1, total: 2 },
  touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 },
  spend_usd: 3.5,
  uncosted: 0,
  guardrail_stops: { count: 0, task_ids: [] },
  blanket_approvals: { count: 0, task_ids: [] },
  gated: { count: 0, total: 2 },
  pull_requests: { merged: 1, closed: 0, open: 0, unread: 0 },
  merged_clean: { count: 1, total: 1 },
  time_to_merge_s: { p50: 172800, p90: 172800, count: 1 },
  first_review_s: { p50: 7200, p90: 7200, count: 1 },
};

const BOARD: Scoreboard = {
  range: '30d',
  truncated: false,
  current: CURRENT,
  previous: PREVIOUS,
  open_over_7d: { count: 1, task_ids: ['01M4C'] },
};

const NOTHING: Fraction = { count: 0, total: 0 };

const EMPTY: ScoreboardPeriod = {
  from: CURRENT.from,
  to: CURRENT.to,
  finished: 0,
  outcomes: { verified_pr: 0, unverified_pr: 0, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 },
  time_to_verified_pr_s: null,
  wait_p50_s: null,
  queued: NOTHING,
  verified: NOTHING,
  not_reworked: NOTHING,
  untouched: NOTHING,
  touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 },
  spend_usd: 0,
  uncosted: 0,
  guardrail_stops: { count: 0, task_ids: [] },
  blanket_approvals: { count: 0, task_ids: [] },
  gated: NOTHING,
  pull_requests: { merged: 0, closed: 0, open: 0, unread: 0 },
  merged_clean: NOTHING,
  time_to_merge_s: null,
  first_review_s: null,
};

function board(current: Partial<ScoreboardPeriod> = {}, response: Partial<Scoreboard> = {}): Scoreboard {
  return { ...BOARD, ...response, current: { ...CURRENT, ...current } };
}

function numbers(text: string): string {
  return text.slice(text.indexOf('\nSpeed\n') + 1, text.lastIndexOf('\n\n'));
}

function rows(text: string): string[][] {
  const printed: string[][] = [];
  for (const line of numbers(text).split('\n')) {
    if (line.startsWith('      ')) printed[printed.length - 1].push(line.trim());
    else if (line !== '') printed.push(line.trim().split(/ {2,}/));
  }
  return printed;
}

function row(text: string, label: string): string[] {
  const found = rows(text).find(([printed]) => printed === label);
  if (!found) throw new Error(`no row "${label}" in:\n${text}`);
  return found.slice(1);
}

describe('formatScoreboard', () => {
  test('prints the numbers under the four headings of the page, then the outcomes', () => {
    expect(formatScoreboard(BOARD)).toBe(`
Scoreboard of your tasks, 2026-10-20T12:00:00.000Z to 2026-11-19T12:00:00.000Z

8 tasks finished in the last 30 days: 7 asked for a new pull request, 2 delivered a verified one.
A task counts in the period it finished in. A verified pull request is one opened after the repository's build command passed, which proves only what that command checks.

Speed
  Time to verified pull request                    24m
      Median of 2 verified pull requests. Typically 41s of it before the agent started.
      30m in the 30 days before
  Time to merged pull request                      1d 2h
      Median of 1 merged pull request. It had a review by someone else, 6h after the task finished.
      2d in the 30 days before
  Waited in line                                   14%
      1 of 7 tasks that waited in line or started
  Pull requests open for more than 7 days          1
      Tasks: 01M4C

Quality
  Ended in a verified pull request                 29%
      2 of 7 tasks that asked for a new pull request
      50% (1 of 2) in the 30 days before
  Merged, so far                                   50%
      1 of 2 new pull requests that ABCA has read on GitHub. 1 still open. 1 not read.
      100% (1 of 1) in the 30 days before
  Merged without being sent back                   100%
      1 of 1 merged pull request
  Not reworked through ABCA, so far                67%
      2 of 3 new pull requests

Leverage
  Verified pull request with no stop for a person  14%
      1 of 7 tasks that asked for a new pull request
      50% (1 of 2) in the 30 days before
  Human touchpoints per verified pull request      2.5
      5 in all: 2 approval requests, 1 question from the agent, 1 follow-up, 1 cancelled. 5 per merged pull request so far.
      0 in the 30 days before
  Spend per verified pull request                  $7.25
      $14.50 on 7 tasks that write code and started. 2 have no recorded cost. $14.50 per merged pull request so far: 1 merged, 1 still open, 1 not read.
      $3.50 in the 30 days before

Trust
  Stopped by a guardrail                           1
      Tasks: 01M6P
  Held for approval                                14%
      1 of 7 tasks that write code and started
  Started with blanket approval                    1
      Tasks: 01M7F

Tasks finished
  Verified pull request                            2  25%
  Pull request without a passed build              1  13%
  Finished, no new pull request                    2  25%
  Failed                                           1  13%
  Cancelled                                        1  13%
  Ran out of time                                  1  13%

These numbers cover your own tasks. Numbers for every user are on the CloudWatch dashboard, in the "Factory scoreboard" row.
`.trim());
  });

  test('names the repository the request was limited to', () => {
    expect(formatScoreboard(BOARD, 'acme/shop').split('\n')[0])
      .toBe('Scoreboard of your tasks in acme/shop, 2026-10-20T12:00:00.000Z to 2026-11-19T12:00:00.000Z');
  });
});

interface Page {
  readonly SECTIONS: readonly { readonly title: string; readonly tiles: readonly PageTile[] }[];
  contextLine(response: Scoreboard): string;
  nothingFinished(response: Scoreboard): string;
  previousLine(tile: PageTile, response: Scoreboard): string | null;
  outcomeRows(period: ScoreboardPeriod): readonly { readonly label: string; readonly count: number; readonly share: string | null }[];
}
interface PageTile {
  readonly label: string;
  readonly value: (period: ScoreboardPeriod, response: Scoreboard) => string | null;
  readonly detail?: (period: ScoreboardPeriod, response: Scoreboard) => string | null;
  readonly tasks?: (period: ScoreboardPeriod, response: Scoreboard) => Flagged | null;
}

describe('the numbers of the console page', () => {
  let page: Page;
  beforeAll(() => {
    page = jest.requireActual(path.join(__dirname, '..', '..', 'web', 'src', 'core', 'util', 'scoreboard'));
  });

  const asPrinted = (text: string): string => text.split(String.fromCharCode(0xa0)).join(' ').split(` ${String.fromCharCode(0xb7)} `).join(', ');
  const tasksLine = ({ count, task_ids: ids }: Flagged): string | null =>
    (ids.length === 0 ? null : `Tasks: ${ids.join(', ')}${count > ids.length ? ` and ${(count - ids.length).toLocaleString('en-US')} more` : ''}`);

  function pageRows(shown: Scoreboard): string[][] {
    const period = shown.current;
    const tiles = page.SECTIONS.flatMap((section) => [[section.title], ...section.tiles.map((tile) => {
      const tasks = tile.tasks?.(period, shown);
      const under = [tasks ? tasksLine(tasks) : null, tile.detail?.(period, shown) ?? null, page.previousLine(tile, shown)];
      return [tile.label, tile.value(period, shown) ?? '-', ...under.filter((line): line is string => line !== null)].map(asPrinted);
    })]);
    const outcomes = page.outcomeRows(period).map((outcome) => [outcome.label, outcome.count.toLocaleString('en-US'), outcome.share ?? '-']);
    return [...tiles, ['Tasks finished'], ...outcomes];
  }

  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
  }

  function response(random: () => number): Scoreboard {
    const pick = <T>(...values: T[]): T => values[Math.floor(random() * values.length)];
    const count = (): number => pick(0, 0, 1, 1, 2, 3, 9, 10, 11, 37, 1204, 2140);
    const upTo = (most: number): number => Math.floor(random() * (most + 1));
    const fraction = (): Fraction => { const total = count(); return { count: upTo(total), total }; };
    const seconds = (): number => pick(0, 1, 41, 59, 60, 80, 1440, 3570, 3600, 9900, 86370, 86400, 93600, 221400, 433200);
    const durations = (): DurationSummary | null =>
      (random() < 0.25 ? null : { p50: seconds(), p90: seconds(), count: pick(1, 1, 2, 9, 10, 11, 1204) });
    const flagged = (): Flagged => {
      const total = count();
      return { count: total, task_ids: Array.from({ length: Math.min(total, pick(0, 1, 10)) }, (_, at) => `01M${at}`) };
    };
    const period = (from: string, to: string): ScoreboardPeriod => {
      const states = { merged: random() < 0.3 ? 0 : count(), closed: pick(0, 0, 1, 3), open: pick(0, 0, 1, 5), unread: pick(0, 0, 1, 2, 28) };
      const ofAnOrchestration = pick(0, 0, 0, 1, 2, 7);
      const verified = upTo(states.merged + states.closed + states.open + states.unread + ofAnOrchestration);
      const outcomes = {
        verified_pr: verified,
        unverified_pr: states.merged + states.closed + states.open + states.unread + ofAnOrchestration - verified,
        no_new_pr: count(),
        failed: count(),
        cancelled: pick(0, 1, 2),
        timed_out: pick(0, 1),
      };
      const started = count();
      return {
        from,
        to,
        finished: Object.values(outcomes).reduce((sum, tasks) => sum + tasks, 0),
        outcomes,
        time_to_verified_pr_s: verified === 0 ? null : durations(),
        wait_p50_s: random() < 0.3 ? null : seconds(),
        queued: fraction(),
        verified: fraction(),
        not_reworked: fraction(),
        untouched: fraction(),
        touchpoints: { approve: pick(0, 0, 1, 20, 1650), clarify: pick(0, 0, 1, 6), follow_up: pick(0, 0, 1, 8), cancel: pick(0, 0, 1, 2) },
        spend_usd: pick(0, 0.004, 2.5, 14.5, 107.12, 10428.8),
        uncosted: random() < 0.3 ? started : upTo(started),
        guardrail_stops: flagged(),
        blanket_approvals: flagged(),
        gated: { count: upTo(started), total: started },
        pull_requests: states,
        merged_clean: { count: upTo(states.merged), total: states.merged },
        time_to_merge_s: states.merged === 0 ? null : durations(),
        first_review_s: states.merged === 0 ? null : durations(),
      };
    };
    const previous = random() < 0.2 ? null : period('2026-09-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z');
    return {
      range: pick('7d', '30d'),
      truncated: false,
      current: period('2026-10-20T12:00:00.000Z', '2026-11-19T12:00:00.000Z'),
      previous,
      open_over_7d: previous === null || random() < 0.2 ? null : flagged(),
    };
  }

  test('are the numbers of the command, with the lines above and under them, for any response', () => {
    expect(Object.keys(page)).toEqual(expect.arrayContaining(['SECTIONS', 'contextLine', 'nothingFinished', 'previousLine', 'outcomeRows']));

    const random = generator(20261120);
    const responses = [{ ...BOARD, current: EMPTY, open_over_7d: null }, ...Array.from({ length: 500 }, () => response(random))];
    for (const any of responses) {
      const text = formatScoreboard(any);
      const [, , first, second] = text.split('\n');
      if (second === undefined) {
        expect(first).toBe(page.nothingFinished(any));
      } else {
        expect(`${first} ${second}`).toBe(page.contextLine(any));
        expect(rows(text)).toEqual(pageRows(any));
      }
    }
  });
});

describe('a caller with nothing finished', () => {
  test.each([
    ['none is waiting from the period before', { count: 0, task_ids: [] }],
    ['the count of those waiting is not known', null],
  ])('is told so, in place of the numbers, when %s', (_case, waiting) => {
    expect(formatScoreboard({ ...BOARD, current: EMPTY, previous: EMPTY, open_over_7d: waiting }).split('\n').slice(1))
      .toEqual(['', 'No tasks finished in the last 30 days. The scoreboard fills in as your tasks finish.']);
  });

  test('sees the pull requests that wait from the period before, and under every other number why there is none', () => {
    const text = formatScoreboard({ ...BOARD, current: EMPTY, previous: EMPTY, open_over_7d: { count: 2, task_ids: ['01M4C', '01M4D'] } });

    expect(text.split('\n')[2]).toBe('0 tasks finished in the last 30 days: 0 asked for a new pull request, 0 delivered a verified one.');
    expect(numbers(text)).toBe(`
Speed
  Time to verified pull request                    -
      No verified pull request in this period.
  Time to merged pull request                      -
      No new pull request in this period.
  Waited in line                                   -
      No task waited or started in this period.
  Pull requests open for more than 7 days          2
      Tasks: 01M4C, 01M4D

Quality
  Ended in a verified pull request                 -
      No task asked for a new pull request in this period.
  Merged, so far                                   -
      No new pull request in this period.
  Merged without being sent back                   -
      No new pull request in this period.
  Not reworked through ABCA, so far                -
      No new pull request in this period.

Leverage
  Verified pull request with no stop for a person  -
      No task asked for a new pull request in this period.
  Human touchpoints per verified pull request      -
      No verified pull request in this period.
  Spend per verified pull request                  -
      No verified pull request in this period.

Trust
  Stopped by a guardrail                           0
  Held for approval                                -
      No task that writes code started in this period.
  Started with blanket approval                    0

Tasks finished
  Verified pull request                            0  -
  Pull request without a passed build              0  -
  Finished, no new pull request                    0  -
  Failed                                           0  -
  Cancelled                                        0  -
  Ran out of time                                  0  -
`.trim());
  });
});

describe('a response that covers part of the range', () => {
  const cut = { truncated: true, previous: null, open_over_7d: null };
  const since = { from: '2026-11-05T08:00:00.000Z', finished: 2140, verified: { count: 610, total: 1204 } };

  test('says from when the numbers count, and which range may cover all of it', () => {
    expect(formatScoreboard(board(since, cut)).split('\n').slice(0, 5)).toEqual([
      'Scoreboard of your tasks, 2026-11-05T08:00:00.000Z to 2026-11-19T12:00:00.000Z',
      '',
      'These numbers cover part of the range: tasks finished since 2026-11-05T08:00:00.000Z. This range holds more than the scoreboard reads'
        + ' at once; --range 7d may cover all of it.',
      '',
      '2,140 tasks finished since 2026-11-05T08:00:00.000Z: 1,204 asked for a new pull request, 610 delivered a verified one.',
    ]);
  });

  test('advises no shorter range on the shortest one', () => {
    expect(formatScoreboard(board(since, { ...cut, range: '7d' })).split('\n')[2])
      .toBe('These numbers cover part of the range: tasks finished since 2026-11-05T08:00:00.000Z. This range holds more than the scoreboard reads at once.');
  });

  test('tells a caller with nothing finished since then from when it looked', () => {
    expect(formatScoreboard({ ...BOARD, ...cut, current: { ...EMPTY, from: since.from } }).split('\n')[2])
      .toBe('No tasks finished since 2026-11-05T08:00:00.000Z. The scoreboard fills in as your tasks finish.');
  });

  test('has no number of the period before, and says why the waiting pull requests are not counted', () => {
    const text = formatScoreboard(board(since, cut));

    expect(text).not.toContain('days before');
    expect(row(text, 'Pull requests open for more than 7 days')).toEqual(['-', 'The scoreboard did not read far enough back to count these.']);
  });
});

describe('Tasks finished', () => {
  test('lines the shares up under one another', () => {
    const finished = { verified_pr: 1500, unverified_pr: 0, no_new_pr: 0, failed: 500, cancelled: 0, timed_out: 0 };
    const text = formatScoreboard(board({ finished: 2000, outcomes: finished })).split('\n');

    expect(text.find((line) => line.includes('Verified pull request  '))).toMatch(/ {2}1,500 {2}75%$/);
    expect(text.find((line) => line.includes('Failed  '))).toMatch(/ {2}500 {4}25%$/);
  });
});
