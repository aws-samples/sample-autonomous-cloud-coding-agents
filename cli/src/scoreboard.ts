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

const P90_MIN_COUNT = 10;

const NO_NUMBER = '-';

const NO_VERIFIED_PR = 'No verified pull request in this period.';
const NO_NEW_WORK = 'No task asked for a new pull request in this period.';
const NO_NEW_PR = 'No new pull request in this period.';

const STARTED_TO_WRITE_CODE = ['task that writes code and started', 'tasks that write code and started'] as const;

const TOUCHPOINT_WORDS: Readonly<Record<TouchpointKind, readonly [one: string, many: string]>> = {
  approve: ['approval request', 'approval requests'],
  clarify: ['question from the agent', 'questions from the agent'],
  follow_up: ['follow-up', 'follow-ups'],
  cancel: ['cancelled', 'cancelled'],
};

const OUTCOMES: Readonly<Record<TaskOutcome, string>> = {
  verified_pr: 'Verified pull request',
  unverified_pr: 'Pull request without a passed build',
  no_new_pr: 'Finished, no new pull request',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Ran out of time',
};

const GROUPING_LOCALE = 'en-US';

function formatCount(count: number): string {
  return count.toLocaleString(GROUPING_LOCALE);
}

function formatCost(usd: number): string {
  return `$${usd.toLocaleString(GROUPING_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

function counted(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

function countsAboveZero(counts: readonly (readonly [count: number, words: string])[]): string {
  return counts.filter(([count]) => count > 0).map(([count, words]) => `${formatCount(count)} ${words}`).join(', ');
}

function percent({ count, total }: Fraction): string | null {
  if (total === 0) return null;
  const share = Math.round((100 * count) / total);
  if (share === 0 && count > 0) return '<1%';
  if (share === 100 && count < total) return '>99%';
  return `${share}%`;
}

function shareWithCounts(fraction: Fraction): string | null {
  const share = percent(fraction);
  return share === null ? null : `${share} (${formatCount(fraction.count)} of ${formatCount(fraction.total)})`;
}

function oneDecimal(ratio: number): string {
  const rounded = Math.round(ratio * 10) / 10;
  return rounded === 0 && ratio > 0 ? '<0.1' : String(rounded);
}

function perVerifiedPr(sum: number, period: ScoreboardPeriod, format: (ratio: number) => string): string | null {
  const pullRequests = period.outcomes.verified_pr;
  return pullRequests === 0 ? null : format(sum / pullRequests);
}

function perMergedPr(sum: number, period: ScoreboardPeriod, format: (ratio: number) => string): string | null {
  const { merged } = period.pull_requests;
  return merged === 0 ? null : `${format(sum / merged)} per merged pull request so far`;
}

function mergedOfRead({ pull_requests: { merged, closed, open } }: ScoreboardPeriod): Fraction {
  return { count: merged, total: merged + closed + open };
}

function notFollowed({ outcomes, pull_requests: { merged, closed, open, unread } }: ScoreboardPeriod): number {
  return outcomes.verified_pr + outcomes.unverified_pr - merged - closed - open - unread;
}

function orchestrationNotFollowed(count: number): string {
  return count === 1 ? 'The one of an orchestration is not followed.' : `The ${formatCount(count)} of an orchestration are not followed.`;
}

function median(time: DurationSummary | null): string | null {
  return time === null ? null : formatDuration(time.p50);
}

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

function noneMerged(period: ScoreboardPeriod): string {
  if (mergedOfRead(period).total > 0) return 'No pull request of this period is merged yet.';
  const { unread } = period.pull_requests;
  if (unread > 0) {
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
    const reviewed = time.count === 1 ? 'It' : `${formatCount(review.count)} of them`;
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
      const { merged, open, unread } = period.pull_requests;
      const counts = countsAboveZero([[merged, 'merged'], [open, 'still open'], [unread, 'not read'], [notFollowed(period), 'of an orchestration not followed']]);
      spent += ` ${perMerged}: ${counts}.`;
    }
  }
  return noPullRequest ? `${NO_VERIFIED_PR} ${spent}` : spent;
}

interface Row {
  readonly label: string;
  readonly value: string | null;
  readonly lines: readonly (string | null)[];
}

function tasksBehind({ count, task_ids: ids }: Flagged): string | null {
  if (ids.length === 0) return null;
  const unnamed = count - ids.length;
  return `Tasks: ${ids.join(', ')}${unnamed > 0 ? ` and ${formatCount(unnamed)} more` : ''}`;
}

function shareRow(label: string, fraction: Fraction, total: (count: number) => string, none: string, before: string | null = null): Row {
  const counts = fraction.total === 0 ? none : `${formatCount(fraction.count)} of ${total(fraction.total)}`;
  return { label, value: percent(fraction), lines: [counts, before] };
}

function askedForNewPr(count: number): string {
  return `${counted(count, 'task')} that asked for a new pull request`;
}

function waitingRow(board: Scoreboard): Row {
  const label = 'Pull requests open for more than 7 days';
  const waiting = board.open_over_7d;
  if (waiting === null) {
    const reason = board.previous === null
      ? 'The scoreboard did not read far enough back to count these.'
      : 'ABCA has not read these pull requests on GitHub.';
    return { label, value: null, lines: [reason] };
  }
  const orchestration = notFollowed(board.current) + (board.previous ? notFollowed(board.previous) : 0);
  return {
    label,
    value: formatCount(waiting.count),
    lines: [tasksBehind(waiting), orchestration > 0 ? orchestrationNotFollowed(orchestration) : null],
  };
}

function outcomeRows(period: ScoreboardPeriod): Row[] {
  const outcomes = Object.keys(OUTCOMES) as TaskOutcome[];
  const width = Math.max(...outcomes.map((outcome) => formatCount(period.outcomes[outcome]).length));
  return outcomes.map((outcome) => {
    const count = period.outcomes[outcome];
    const share = percent({ count, total: period.finished }) ?? NO_NUMBER;
    return { label: OUTCOMES[outcome], value: `${formatCount(count).padEnd(width)}  ${share}`, lines: [] };
  });
}

function sections(board: Scoreboard): readonly (readonly [title: string, rows: readonly Row[]])[] {
  const period = board.current;
  const before = (number: (earlier: ScoreboardPeriod) => string | null): string | null => {
    const earlier = board.previous && number(board.previous);
    return earlier ? `${earlier} in the ${RANGE_DAYS[board.range]} days before` : null;
  };
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
  if (period.finished === 0 && !board.open_over_7d?.count) {
    lines.push(`No tasks finished ${when(board)}. The scoreboard fills in as your tasks finish.`);
    return lines.join('\n');
  }
  if (board.truncated) {
    const advice = board.range === '7d' ? '.' : '; --range 7d may cover all of it.';
    lines.push(`These numbers cover part of the range: tasks finished ${when(board)}. This range holds more than the scoreboard reads at once${advice}`, '');
  }
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
