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
 * The factory scoreboard as text, for `bgagent stats`: the numbers of
 * `GET /v1/tasks?view=scoreboard` under the headings of the console's Scoreboard page, each
 * with the line the page puts under it: the counts the number rests on, or why there is none.
 *
 * The server defines every number (`cdk/src/handlers/shared/scoreboard.ts`). The only
 * arithmetic here is the page's presentation: a percentage from a fraction, the merged share
 * of the pull requests read, a sum per verified and per merged pull request, the pull requests
 * ABCA does not follow as a period's new pull requests less the four states. The page keeps
 * its own copy of these labels and sentences in `web/src/core/util/scoreboard.ts`, which the
 * CLI cannot import: a label or a sentence that changes there changes here.
 */

import type {
  DurationSummary,
  Flagged,
  Fraction,
  Scoreboard,
  ScoreboardPeriod,
  ScoreboardRange,
  TaskOutcome,
  TouchpointKind,
} from './types';

const RANGE_DAYS: Readonly<Record<ScoreboardRange, number>> = { '7d': 7, '30d': 30 };

/** Below this many pull requests the 90th percentile is the slowest of them, not a tendency. */
const P90_MIN_COUNT = 10;

/** What a row shows in place of a number it has nothing to compute from. */
const NO_NUMBER = '-';

const NO_VERIFIED_PR = 'No verified pull request in this period.';
const NO_NEW_WORK = 'No task asked for a new pull request in this period.';
const NO_NEW_PR = 'No new pull request in this period.';

/**
 * What the rows call the coding tasks that started (`gated.total`), in the singular and the
 * plural: the ones that can ask for approval, and the ones that can hold a cost.
 */
const STARTED_TO_WRITE_CODE = ['task that writes code and started', 'tasks that write code and started'] as const;

/** The kinds of touchpoint in the order the line names them, each in the singular and the plural. */
const TOUCHPOINT_WORDS: Readonly<Record<TouchpointKind, readonly [one: string, many: string]>> = {
  approve: ['approval request', 'approval requests'],
  clarify: ['question from the agent', 'questions from the agent'],
  follow_up: ['follow-up', 'follow-ups'],
  cancel: ['cancelled', 'cancelled'],
};

/** The six outcomes in the order of the page's table. */
const OUTCOMES: Readonly<Record<TaskOutcome, string>> = {
  verified_pr: 'Verified pull request',
  unverified_pr: 'Pull request without a passed build',
  no_new_pr: 'Finished, no new pull request',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Ran out of time',
};

/** Digits are grouped the same way for every reader ("2,140", "$5,214.40"), as the dollar sign is fixed too. */
const GROUPING_LOCALE = 'en-US';

function formatCount(count: number): string {
  return count.toLocaleString(GROUPING_LOCALE);
}

function formatCost(usd: number): string {
  return `$${usd.toLocaleString(GROUPING_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Whole seconds in the largest two units, rounded to the smaller one: "45s", "24m", "2h 5m",
 * "2d 14h". No seconds past a minute; a unit at zero is left out.
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return twoUnits(Math.floor(minutes / 60), 'h', minutes % 60, 'm');
  const hours = Math.round(seconds / 3600);
  return twoUnits(Math.floor(hours / 24), 'd', hours % 24, 'h');
}

function twoUnits(large: number, largeUnit: string, small: number, smallUnit: string): string {
  return small === 0 ? `${large}${largeUnit}` : `${large}${largeUnit} ${small}${smallUnit}`;
}

/** "1 task", "2,140 tasks"; `many` for a word that takes no "s". */
function counted(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The counts above zero, each with its words: "2 closed without merging, 5 still open". Empty when all are zero. */
function countsAboveZero(counts: readonly (readonly [count: number, words: string])[]): string {
  return counts.filter(([count]) => count > 0).map(([count, words]) => `${formatCount(count)} ${words}`).join(', ');
}

/**
 * A share in whole percent, from the two counts shown under it; null when there is nothing
 * to divide by. A share that is neither none nor all never reads as "0%" or "100%".
 */
function percent({ count, total }: Fraction): string | null {
  if (total === 0) return null;
  const share = Math.round((100 * count) / total);
  if (share === 0 && count > 0) return '<1%';
  if (share === 100 && count < total) return '>99%';
  return `${share}%`;
}

/** A share as the line of the period before quotes it, with the two counts it rests on: "62% (18 of 29)". */
function shareWithCounts(fraction: Fraction): string | null {
  const share = percent(fraction);
  return share === null ? null : `${share} (${formatCount(fraction.count)} of ${formatCount(fraction.total)})`;
}

/** To one decimal; a ratio above zero never reads as "0". */
function oneDecimal(ratio: number): string {
  const rounded = Math.round(ratio * 10) / 10;
  return rounded === 0 && ratio > 0 ? '<0.1' : String(rounded);
}

/** A sum over the period for each verified pull request; null when the period has none. */
function perVerifiedPr(sum: number, period: ScoreboardPeriod, format: (ratio: number) => string): string | null {
  const pullRequests = period.outcomes.verified_pr;
  return pullRequests === 0 ? null : format(sum / pullRequests);
}

/**
 * The same sum for each pull request merged so far, as the second figure of a row that
 * divides by the verified ones; null while none is merged.
 */
function perMergedPr(sum: number, period: ScoreboardPeriod, format: (ratio: number) => string): string | null {
  const { merged } = period.pull_requests;
  return merged === 0 ? null : `${format(sum / merged)} per merged pull request so far`;
}

/** The merged pull requests, of the period's new pull requests that ABCA has read on GitHub. */
function mergedOfRead({ pull_requests: { merged, closed, open } }: ScoreboardPeriod): Fraction {
  return { count: merged, total: merged + closed + open };
}

/**
 * The period's new pull requests that ABCA does not follow: those of an orchestration. They
 * are in the rows that count every new pull request and in none of the four states, so a
 * line that counts the states names them where the two totals would otherwise differ.
 */
function notFollowed({ outcomes, pull_requests: { merged, closed, open, unread } }: ScoreboardPeriod): number {
  return outcomes.verified_pr + outcomes.unverified_pr - merged - closed - open - unread;
}

/** What a count over the pull requests ABCA follows says of the others, beside it. */
function orchestrationNotFollowed(count: number): string {
  return count === 1 ? 'The one of an orchestration is not followed.' : `The ${formatCount(count)} of an orchestration are not followed.`;
}

/** The median of the durations; null when there is none. */
function median(time: DurationSummary | null): string | null {
  return time === null ? null : formatDuration(time.p50);
}

/** What a median rests on, then the spread once there are enough durations to show one. */
function medianOf(time: DurationSummary, noun: string): string[] {
  const sentences = [`Median of ${counted(time.count, noun)}.`];
  if (time.count >= P90_MIN_COUNT) sentences.push(`9 in 10 within ${formatDuration(time.p90)}.`);
  return sentences;
}

function timeDetail(period: ScoreboardPeriod): string {
  const time = period.time_to_verified_pr_s;
  if (time === null) return NO_VERIFIED_PR;
  const sentences = medianOf(time, 'verified pull request');
  if (period.wait_p50_s !== null) sentences.push(`Typically ${formatDuration(period.wait_p50_s)} of it before the agent started.`);
  return sentences.join(' ');
}

/**
 * Why a number over the merged pull requests is missing: none of those ABCA has read is
 * merged; it has read none of them; or it follows none, because the period has no new
 * pull request, or only those of an orchestration.
 */
function noneMerged(period: ScoreboardPeriod): string {
  if (mergedOfRead(period).total > 0) return 'No pull request of this period is merged yet.';
  const { unread } = period.pull_requests;
  if (unread > 0) {
    // No "yet": for a pull request ABCA's token cannot read, or one GitHub does not have, no read is coming.
    const unreadOnes = unread === 1 ? 'the new pull request' : `the ${formatCount(unread)} new pull requests`;
    return `ABCA has not read ${unreadOnes} of this period on GitHub.`;
  }
  return notFollowed(period) === 0 ? NO_NEW_PR : 'ABCA does not follow the pull requests of an orchestration on GitHub.';
}

function mergeTimeDetail(period: ScoreboardPeriod): string {
  const time = period.time_to_merge_s;
  if (time === null) return noneMerged(period);
  const sentences = medianOf(time, 'merged pull request');
  const review = period.first_review_s;
  if (review !== null) {
    // One pull request is "it", and one review has a time, not a typical time.
    const reviewed = time.count === 1 ? 'It' : `${formatCount(review.count)} of them`;
    // The clock starts when the task finishes: a review that came before then counts as 0.
    const timing = review.p50 === 0 ? 'before the task had finished' : `${formatDuration(review.p50)} after the task finished`;
    sentences.push(`${reviewed} had a review by someone else, ${review.count === 1 ? '' : 'typically '}${timing}.`);
  }
  return sentences.join(' ');
}

function mergedDetail(period: ScoreboardPeriod): string {
  const { closed, open, unread } = period.pull_requests;
  const { count: merged, total: read } = mergedOfRead(period);
  const sentences: string[] = [];
  if (read === 0) {
    sentences.push(noneMerged(period));
  } else {
    sentences.push(`${formatCount(merged)} of ${counted(read, 'new pull request')} that ABCA has read on GitHub.`);
    const notMerged = countsAboveZero([[closed, 'closed without merging'], [open, 'still open']]);
    if (notMerged) sentences.push(`${notMerged}.`);
    if (unread > 0) sentences.push(`${formatCount(unread)} not read.`);
  }
  // Beside pull requests that ABCA follows. A period with none of those has the orchestration as its reason already.
  const orchestration = notFollowed(period);
  if (orchestration > 0 && read + unread > 0) sentences.push(orchestrationNotFollowed(orchestration));
  return sentences.join(' ');
}

function touchpointTotal(period: ScoreboardPeriod): number {
  return Object.values(period.touchpoints).reduce((sum, count) => sum + count, 0);
}

function touchpointsPerPr(period: ScoreboardPeriod): string | null {
  return perVerifiedPr(touchpointTotal(period), period, oneDecimal);
}

function touchpointDetail(period: ScoreboardPeriod): string {
  const total = touchpointTotal(period);
  if (total === 0) return period.outcomes.verified_pr === 0 ? NO_VERIFIED_PR : 'None in this period.';
  const kinds = (Object.keys(TOUCHPOINT_WORDS) as TouchpointKind[])
    .filter((kind) => period.touchpoints[kind] > 0)
    .map((kind) => counted(period.touchpoints[kind], ...TOUCHPOINT_WORDS[kind]));
  const perMerged = perMergedPr(total, period, oneDecimal);
  const inAll = `${formatCount(total)} in all: ${kinds.join(', ')}${perMerged === null ? '' : `. ${perMerged}.`}`;
  return period.outcomes.verified_pr === 0 ? `${NO_VERIFIED_PR} ${inAll}` : inAll;
}

/**
 * Tasks that write code started and none of them recorded a cost: the spend is unknown,
 * not zero. Those tasks (`gated.total`) are the ones that can hold a cost, and the ones
 * `uncosted` is counted among.
 */
function noneCosted(period: ScoreboardPeriod): boolean {
  return period.gated.total > 0 && period.uncosted === period.gated.total;
}

function spendPerPr(period: ScoreboardPeriod): string | null {
  return noneCosted(period) ? null : perVerifiedPr(period.spend_usd, period, formatCost);
}

function spendDetail(period: ScoreboardPeriod): string {
  const started = period.gated.total;
  const noPullRequest = period.outcomes.verified_pr === 0;
  if (noPullRequest && started === 0) return NO_VERIFIED_PR;
  let spent: string;
  if (noneCosted(period)) {
    spent = started === 1
      ? `The only ${STARTED_TO_WRITE_CODE[0]} has no recorded cost.`
      : `None of the ${formatCount(started)} ${STARTED_TO_WRITE_CODE[1]} has a recorded cost.`;
  } else {
    spent = `${formatCost(period.spend_usd)} ${noPullRequest ? 'spent on' : 'on'} ${counted(started, ...STARTED_TO_WRITE_CODE)}.`;
    if (period.uncosted > 0) spent += ` ${counted(period.uncosted, 'has', 'have')} no recorded cost.`;
    const perMerged = perMergedPr(period.spend_usd, period, formatCost);
    if (perMerged !== null) {
      // What the divisor leaves out. The open ones can still be merged and the ones not read may be: the figure falls
      // as they are. The ones of an orchestration never count, though their tasks are in the spend.
      const { merged, open, unread } = period.pull_requests;
      const counts = countsAboveZero([[merged, 'merged'], [open, 'still open'], [unread, 'not read'], [notFollowed(period), 'of an orchestration not followed']]);
      spent += ` ${perMerged}: ${counts}.`;
    }
  }
  return noPullRequest ? `${NO_VERIFIED_PR} ${spent}` : spent;
}

/** One number as the command prints it. */
interface Row {
  readonly label: string;
  /** Null when there is nothing to compute the number from: the row shows a dash. */
  readonly value: string | null;
  /**
   * Under the number, in this order: the tasks behind a count, the counts the number rests
   * on or the reason there is none, the number of the period before. Null for a line the
   * row does not have.
   */
  readonly lines: readonly (string | null)[];
}

/** The tasks behind a count, by id, in the order the API names them. It names ten at most. */
function tasksBehind({ count, task_ids: ids }: Flagged): string | null {
  if (ids.length === 0) return null;
  const unnamed = count - ids.length;
  return `Tasks: ${ids.join(', ')}${unnamed > 0 ? ` and ${formatCount(unnamed)} more` : ''}`;
}

/**
 * A row whose number is a share: "70%" over "26 of 37 tasks that asked for a new pull
 * request", or a dash over `none`, the reason, when the total is zero.
 */
function shareRow(label: string, fraction: Fraction, total: (count: number) => string, none: string, before: string | null = null): Row {
  const counts = fraction.total === 0 ? none : `${formatCount(fraction.count)} of ${total(fraction.total)}`;
  return { label, value: percent(fraction), lines: [counts, before] };
}

function askedForNewPr(count: number): string {
  return `${counted(count, 'task')} that asked for a new pull request`;
}

/** The one number of the whole response: the API counts it over both periods, and says when it cannot. */
function waitingRow(board: Scoreboard): Row {
  const label = 'Pull requests open for more than 7 days';
  const waiting = board.open_over_7d;
  if (waiting === null) {
    // The API decides that the count is not known, for one of two reasons, and the response shows which.
    const reason = board.previous === null
      ? 'The scoreboard did not read far enough back to count these.'
      : 'ABCA has not read these pull requests on GitHub.';
    return { label, value: null, lines: [reason] };
  }
  // The count rests on the tasks of both periods, and so does what it leaves out.
  const orchestration = notFollowed(board.current) + (board.previous ? notFollowed(board.previous) : 0);
  return {
    label,
    value: formatCount(waiting.count),
    lines: [tasksBehind(waiting), orchestration > 0 ? orchestrationNotFollowed(orchestration) : null],
  };
}

/** The six outcomes, each with its count and its share of the tasks that finished. */
function outcomeRows(period: ScoreboardPeriod): Row[] {
  const outcomes = Object.keys(OUTCOMES) as TaskOutcome[];
  const width = Math.max(...outcomes.map((outcome) => formatCount(period.outcomes[outcome]).length));
  return outcomes.map((outcome) => {
    const count = period.outcomes[outcome];
    // No task finished: a share of nothing shows the dash a row without a number shows.
    const share = percent({ count, total: period.finished }) ?? NO_NUMBER;
    return { label: OUTCOMES[outcome], value: `${formatCount(count).padEnd(width)}  ${share}`, lines: [] };
  });
}

/** The four headings of the page with their numbers in its reading order, then the outcomes. */
function sections(board: Scoreboard): readonly (readonly [title: string, rows: readonly Row[]])[] {
  const period = board.current;
  // The number of the period before, in the row's own form, with no arrow, sign or verdict: one person's
  // numbers rest on a handful of tasks. Null when that period was not read, and when it has nothing to
  // compute the number from.
  const before = (number: (earlier: ScoreboardPeriod) => string | null): string | null => {
    const earlier = board.previous && number(board.previous);
    return earlier ? `${earlier} in the ${RANGE_DAYS[board.range]} days before` : null;
  };
  // A row whose number the period before has in the same form.
  const compared = (label: string, number: (of: ScoreboardPeriod) => string | null, detail: string): Row =>
    ({ label, value: number(period), lines: [detail, before(number)] });
  const flagged = (label: string, tasks: Flagged): Row => ({ label, value: formatCount(tasks.count), lines: [tasksBehind(tasks)] });

  return [
    ['Speed', [
      compared('Time to verified pull request', (of) => median(of.time_to_verified_pr_s), timeDetail(period)),
      compared('Time to merged pull request', (of) => median(of.time_to_merge_s), mergeTimeDetail(period)),
      shareRow(
        'Waited in line', period.queued, (count) => `${counted(count, 'task')} that waited in line or started`,
        'No task waited or started in this period.',
      ),
      waitingRow(board),
    ]],
    ['Quality', [
      shareRow(
        'Ended in a verified pull request', period.verified, askedForNewPr, NO_NEW_WORK,
        before((earlier) => shareWithCounts(earlier.verified)),
      ),
      {
        label: 'Merged, so far',
        value: percent(mergedOfRead(period)),
        lines: [mergedDetail(period), before((earlier) => shareWithCounts(mergedOfRead(earlier)))],
      },
      shareRow('Merged without being sent back', period.merged_clean, (count) => counted(count, 'merged pull request'), noneMerged(period)),
      shareRow('Not reworked through ABCA, so far', period.not_reworked, (count) => counted(count, 'new pull request'), NO_NEW_PR),
    ]],
    ['Leverage', [
      shareRow(
        'Verified pull request with no stop for a person', period.untouched, askedForNewPr, NO_NEW_WORK,
        before((earlier) => shareWithCounts(earlier.untouched)),
      ),
      compared('Human touchpoints per verified pull request', touchpointsPerPr, touchpointDetail(period)),
      compared('Spend per verified pull request', spendPerPr, spendDetail(period)),
    ]],
    ['Trust', [
      flagged('Stopped by a guardrail', period.guardrail_stops),
      shareRow(
        'Held for approval', period.gated, (count) => counted(count, ...STARTED_TO_WRITE_CODE),
        'No task that writes code started in this period.',
      ),
      flagged('Started with blanket approval', period.blanket_approvals),
    ]],
    ['Tasks finished', outcomeRows(period)],
  ];
}

/** "in the last 30 days", or since the time a read that hit its cap reaches back to. */
function when(board: Scoreboard): string {
  return board.truncated ? `since ${board.current.from}` : `in the last ${RANGE_DAYS[board.range]} days`;
}

/**
 * The scoreboard as `bgagent stats` prints it.
 *
 * @param board - the scoreboard from `GET /tasks?view=scoreboard`.
 * @param repo - the repository the request was limited to, which the response does not name.
 */
export function formatScoreboard(board: Scoreboard, repo?: string): string {
  const period = board.current;
  const lines = [`Scoreboard of your tasks${repo ? ` in ${repo}` : ''}, ${period.from} to ${period.to}`, ''];
  // Pull requests can wait from the period before: with no task finished in this one, there is still that count to show.
  if (period.finished === 0 && !board.open_over_7d?.count) {
    lines.push(`No tasks finished ${when(board)}. The scoreboard fills in as your tasks finish.`);
    return lines.join('\n');
  }
  if (board.truncated) {
    // On the shortest range there is no shorter one to advise.
    const advice = board.range === '7d' ? '.' : '; --range 7d may cover all of it.';
    lines.push(`These numbers cover part of the range: tasks finished ${when(board)}. This range holds more than the scoreboard reads at once${advice}`, '');
  }
  // The populations the rows count over, so that their counts can be reconciled, then the two rules a reader
  // needs before any number: which period a task belongs to, and what "verified" proves.
  lines.push(
    `${counted(period.finished, 'task')} finished ${when(board)}: ${formatCount(period.verified.total)} asked for a new pull request,`
      + ` ${formatCount(period.verified.count)} delivered a verified one.`,
    "A task counts in the period it finished in. A verified pull request is one opened after the repository's build command passed,"
      + ' which proves only what that command checks.',
  );
  const all = sections(board);
  const width = Math.max(...all.flatMap(([, rows]) => rows.map((row) => row.label.length)));
  for (const [title, rows] of all) {
    lines.push('', title);
    for (const row of rows) {
      lines.push(`  ${row.label.padEnd(width)}  ${row.value ?? NO_NUMBER}`);
      lines.push(...row.lines.filter((line) => line !== null).map((line) => `      ${line}`));
    }
  }
  lines.push('', 'These numbers cover your own tasks. Numbers for every user are on the CloudWatch dashboard, in the "Factory scoreboard" row.');
  return lines.join('\n');
}
