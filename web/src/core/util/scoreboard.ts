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
} from '../api/types';
import type { Explanation } from '../components/Explain';
import { formatCost, formatCount, formatDurationShort, formatTimestamp } from './format';

/**
 * The Scoreboard page as data: its sections, tiles, explanations and sentences over the
 * numbers of `GET /v1/tasks?view=scoreboard`.
 *
 * The server defines every number (`cdk/src/handlers/shared/scoreboard.ts`). The only
 * arithmetic here is presentation: a percentage from a fraction, the merged share of the
 * pull requests read, a sum per verified and per merged pull request, the pull requests
 * ABCA does not follow as a period's new pull requests less the four states, the six
 * outcomes folded into the three parts of the bar. A number is added to the page with one
 * entry in {@link SECTIONS}, which holds its explanation too.
 */

export const SCOREBOARD_RANGES: Readonly<Record<ScoreboardRange, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

const RANGE_DAYS: Readonly<Record<ScoreboardRange, number>> = { '7d': 7, '30d': 30 };

/** Below this many pull requests the 90th percentile is the slowest of them, not a tendency. */
const P90_MIN_COUNT = 10;

const NO_VERIFIED_PR = 'No verified pull request in this period.';
const NO_NEW_WORK = 'No task asked for a new pull request in this period.';
const NO_NEW_PR = 'No new pull request in this period.';
const NONE_MERGED = 'No pull request of this period is merged yet.';
const ORCHESTRATION_NOT_FOLLOWED = 'ABCA does not follow the pull requests of an orchestration on GitHub.';

/**
 * What the page calls the coding tasks that started (`gated.total`), in the singular and
 * the plural: the ones that can ask for approval, and the ones that can hold a cost.
 */
const STARTED_TO_WRITE_CODE = ['task that writes code and started', 'tasks that write code and started'] as const;

/** "1 task", "2,140 tasks"; `many` for a word that takes no "s". */
function counted(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The counts above zero, each with its words: "2 closed without merging, 5 still open". Empty when all are zero. */
function countsAboveZero(counts: readonly (readonly [count: number, words: string])[]): string {
  return counts.filter(([count]) => count > 0).map(([count, words]) => `${formatCount(count)} ${words}`).join(', ');
}

/**
 * A share in whole percent, from the two counts shown beside it; null when there is
 * nothing to divide by. A share that is neither none nor all never reads as "0%" or "100%".
 */
export function percent({ count, total }: Fraction): string | null {
  if (total === 0) return null;
  const share = Math.round((100 * count) / total);
  if (share === 0 && count > 0) return '<1%';
  if (share === 100 && count < total) return '>99%';
  return `${share}%`;
}

/** A share as the previous-period line quotes it, with the two counts it rests on: "62% (18 of 29)". */
function shareWithCounts(fraction: Fraction): string | null {
  const share = percent(fraction);
  return share === null ? null : `${share} (${formatCount(fraction.count)} of ${formatCount(fraction.total)})`;
}

/** A sum over the period for each verified pull request; null when the period has none. */
function perVerifiedPr(sum: number, period: ScoreboardPeriod, format: (ratio: number) => string): string | null {
  const pullRequests = period.outcomes.verified_pr;
  return pullRequests === 0 ? null : format(sum / pullRequests);
}

/**
 * The same sum for each pull request merged so far, as the second figure of a tile that
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
 * are in the tiles that count every new pull request and in none of the four states, so a
 * line that counts the states names them where the two totals would otherwise differ.
 */
function notFollowed({ outcomes, pull_requests: { merged, closed, open, unread } }: ScoreboardPeriod): number {
  return outcomes.verified_pr + outcomes.unverified_pr - merged - closed - open - unread;
}

/** What a count over the pull requests ABCA follows says of the others, beside it. */
function orchestrationNotFollowed(count: number): string {
  return count === 1 ? 'The one of an orchestration is not followed.' : `The ${formatCount(count)} of an orchestration are not followed.`;
}

export interface TileSpec {
  readonly label: string;
  /** What it is, why it matters and how it is computed: the bubble of the tile. */
  readonly explanation: Explanation;
  /**
   * The headline number; null when there is nothing to compute it from. A number of a period
   * reads the period. The board is for the one number that belongs to the whole response.
   */
  readonly value: (period: ScoreboardPeriod, board: Scoreboard) => string | null;
  /** The line under the number: the counts behind it, or why there is none. Null where the number needs no line. */
  readonly detail?: (period: ScoreboardPeriod, board: Scoreboard) => string | null;
  /** The tasks behind a count, linked under it where other tiles have a line of text. Null while the count is not known. */
  readonly tasks?: (period: ScoreboardPeriod, board: Scoreboard) => Flagged | null;
  /** The number as the previous-period line quotes it. Only the tiles that compare have one. */
  readonly compare?: (period: ScoreboardPeriod) => string | null;
}

export interface SectionSpec {
  readonly title: string;
  readonly description: string;
  readonly tiles: readonly TileSpec[];
  /** What a reader would look for under this heading and ABCA cannot see. */
  readonly notMeasured: string;
}

/** A tile whose number is a share: "70%" over "26 of 37 tasks that asked for a new pull request". */
function shareTile({ label, explanation, of, noun, plural, rest = '', none, compare: compares = false }: {
  label: string;
  explanation: Explanation;
  of: (period: ScoreboardPeriod) => Fraction;
  /** What the total counts, in the singular; its plural where that takes no "s"; and the words that follow it. */
  noun: string;
  plural?: string;
  rest?: string;
  /** The line shown when the total is zero: one sentence, or the one that fits the period. */
  none: string | ((period: ScoreboardPeriod) => string);
  compare?: boolean;
}): TileSpec {
  return {
    label,
    explanation,
    value: (period) => percent(of(period)),
    detail: (period) => {
      const { count, total } = of(period);
      if (total === 0) return typeof none === 'string' ? none : none(period);
      return `${formatCount(count)} of ${counted(total, noun, plural)}${rest}`;
    },
    ...(compares && { compare: (period) => shareWithCounts(of(period)) }),
  };
}

/** The median of the durations, as the number of a tile and of its previous-period line; null when there is none. */
function median(time: DurationSummary | null): string | null {
  return time === null ? null : formatDurationShort(time.p50);
}

const timeToVerifiedPr = (period: ScoreboardPeriod): string | null => median(period.time_to_verified_pr_s);
const timeToMergedPr = (period: ScoreboardPeriod): string | null => median(period.time_to_merge_s);

/** What a median rests on, then the spread once there are enough durations to show one. */
function medianOf(time: DurationSummary, noun: string): string[] {
  const sentences = [`Median of ${counted(time.count, noun)}.`];
  if (time.count >= P90_MIN_COUNT) sentences.push(`9 in 10 within ${formatDurationShort(time.p90)}.`);
  return sentences;
}

function timeDetail(period: ScoreboardPeriod): string {
  const time = period.time_to_verified_pr_s;
  if (time === null) return NO_VERIFIED_PR;
  const sentences = medianOf(time, 'verified pull request');
  if (period.wait_p50_s !== null) sentences.push(`Typically ${formatDurationShort(period.wait_p50_s)} of it before the agent started.`);
  return sentences.join(' ');
}

/**
 * Why a number over the merged pull requests is missing: none of those ABCA has read is
 * merged; it has read none of them; or it follows none, because the period has no new
 * pull request, or only those of an orchestration.
 */
function noneMerged(period: ScoreboardPeriod): string {
  if (mergedOfRead(period).total > 0) return NONE_MERGED;
  const { unread } = period.pull_requests;
  if (unread > 0) {
    // No "yet": for a pull request ABCA's token cannot read, or one GitHub does not have, no read is coming.
    const unreadOnes = unread === 1 ? 'the new pull request' : `the ${formatCount(unread)} new pull requests`;
    return `ABCA has not read ${unreadOnes} of this period on GitHub.`;
  }
  return notFollowed(period) === 0 ? NO_NEW_PR : ORCHESTRATION_NOT_FOLLOWED;
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
    const timing = review.p50 === 0 ? 'before the task had finished' : `${formatDurationShort(review.p50)} after the task finished`;
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

/**
 * Why the count of pull requests that wait for a person is not known. The API decides that
 * it is not, for one of two reasons, and the response shows which.
 */
function waitingNotCounted(board: Scoreboard): string {
  return board.previous === null
    ? 'The scoreboard did not read far enough back to count these.'
    : 'ABCA has not read these pull requests on GitHub.';
}

/** The kinds of touchpoint in the order the line names them, each in the singular and the plural. */
const TOUCHPOINT_WORDS: Readonly<Record<TouchpointKind, readonly [one: string, many: string]>> = {
  approve: ['approval request', 'approval requests'],
  clarify: ['question from the agent', 'questions from the agent'],
  follow_up: ['follow-up', 'follow-ups'],
  cancel: ['cancelled', 'cancelled'],
};

function touchpointTotal(period: ScoreboardPeriod): number {
  return Object.values(period.touchpoints).reduce((sum, count) => sum + count, 0);
}

/** To one decimal; a ratio above zero never reads as "0". */
function oneDecimal(ratio: number): string {
  const rounded = Math.round(ratio * 10) / 10;
  return rounded === 0 && ratio > 0 ? '<0.1' : String(rounded);
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
  const inAll = `${formatCount(total)} in all: ${kinds.join(' · ')}${perMerged === null ? '' : `. ${perMerged}.`}`;
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

export const SECTIONS: readonly SectionSpec[] = [
  {
    title: 'Speed',
    description: 'How long it takes.',
    tiles: [
      {
        label: 'Time to verified pull request',
        explanation: {
          what: 'How long it takes, from the moment you submit a task, to get a pull request whose build passed.',
          why: 'It is your wait for something ready for review. When it grows, read the line under the number: if much of it is'
            + ' time before the agent started, see "Waited in line"; otherwise look at whether your tasks got bigger or the build'
            + ' slower.',
          how: "The median time from the moment you submit a task until it finishes, over this period's verified pull requests."
            + " Each task has its own clock. A retry, or your answer to an agent's question, is a new task: time spent on earlier"
            + ' attempts, and the time the work waited before you submitted it, are not included.',
        },
        value: timeToVerifiedPr,
        detail: timeDetail,
        compare: timeToVerifiedPr,
      },
      {
        label: 'Time to merged pull request',
        explanation: {
          what: 'How long it takes, from the moment you submit a task, until its pull request is merged.',
          why: 'It is the wait for a change that was accepted, review included. Most of it is usually spent after the agent'
            + ' finished: compare it with "Time to verified pull request", and see "Pull requests open for more than 7 days".',
          how: "The median time from the moment you submit a task until GitHub records the merge, over this period's new pull"
            + ' requests merged so far. The line under the number counts a review when someone with write access to the'
            + " repository, other than the pull request's author, submits it. The author is the account of ABCA's GitHub"
            + ' token: if that is your account, your reviews do not count.',
        },
        value: timeToMergedPr,
        detail: mergeTimeDetail,
        compare: timeToMergedPr,
      },
      shareTile({
        label: 'Waited in line',
        explanation: {
          what: 'The share of your tasks that could not start right away because you already had as many running as allowed.',
          why: 'A high share says your limit on tasks running at once, not the agents, holds work back. How long work waits to'
            + ' start is on the line under "Time to verified pull request". Submit fewer tasks at once, or have the limit raised.',
          how: 'Finished tasks that waited in line, divided by finished tasks that waited in line or started. A task cancelled'
            + ' while it waited, or failed because it waited too long, counts as having waited. It says how often tasks waited,'
            + ' not for how long.',
        },
        of: (period) => period.queued,
        noun: 'task',
        rest: ' that waited in line or started',
        none: 'No task waited or started in this period.',
      }),
      {
        label: 'Pull requests open for more than 7 days',
        explanation: {
          what: 'New pull requests that are still open on GitHub more than 7 days after their task finished.',
          why: 'This is finished agent work waiting for a person. The longer one sits, the staler it gets and the harder it is'
            + ' to merge. Open the tasks linked under the number and decide: review it, send it back, or close it.',
          how: 'New pull requests that were open when ABCA last read them, more than 7 days after their task finished. It'
            + ' covers the pull requests of this period and of the one before. The tasks linked under the number are the ones'
            + ' that finished longest ago, ten at most. Not in it: pull requests ABCA could not read, one opened by a task that'
            + ' failed, and those of an orchestration.',
        },
        // The one number of the whole response: the API counts it over both periods, and says when it cannot.
        value: (_period, board) => board.open_over_7d && formatCount(board.open_over_7d.count),
        detail: (_period, board) => {
          if (board.open_over_7d === null) return waitingNotCounted(board);
          // The count rests on the tasks of both periods, and so does what it leaves out. The API gives no
          // count without the period before: the test for it is there for the type, and no response reaches its other side.
          const orchestration = notFollowed(board.current) + (board.previous ? notFollowed(board.previous) : 0);
          return orchestration > 0 ? orchestrationNotFollowed(orchestration) : null;
        },
        tasks: (_period, board) => board.open_over_7d,
      },
    ],
    notMeasured: 'Not measured by ABCA: deploy, how often you deploy, and the outcome for your customer. The last thing ABCA'
      + ' sees is the merge.',
  },
  {
    title: 'Quality',
    description: 'How often it comes out right.',
    tiles: [
      shareTile({
        label: 'Ended in a verified pull request',
        explanation: {
          what: 'Of the tasks that asked for a new pull request, the share that delivered one with a passed build.',
          why: 'It is the hit rate of the work you hand over. When it drops, "Tasks finished", at the bottom of the page, shows'
            + ' how the others ended: failed, cancelled, ran out of time, or opened a pull request without a passed build.',
          how: 'Verified pull requests divided by the finished tasks that asked for a new pull request. A task that ended with a'
            + " question for you counts as a miss. Verified means the repository's build command passed after the change: it"
            + ' proves only what that command checks, and lint is not part of it. A repository with no build command to run'
            + ' never has a verified pull request.',
        },
        of: (period) => period.verified,
        noun: 'task',
        rest: ' that asked for a new pull request',
        none: NO_NEW_WORK,
        compare: true,
      }),
      {
        label: 'Merged, so far',
        explanation: {
          what: "Of this period's new pull requests that ABCA has read on GitHub, the share that are merged.",
          why: 'A merge is the first outside sign that the work was accepted; a passed build only says it builds. When the'
            + ' share is low, read the line under the number: closed without merging, or still open (see "Pull requests open'
            + ' for more than 7 days").',
          how: "Merged pull requests divided by this period's new pull requests that ABCA has read. Recent ones have had less"
            + ' time, so it can still rise; the period before is counted as it stood at its own end. ABCA reads GitHub about'
            + " once an hour. Not read: pull requests ABCA's token cannot read or GitHub does not have. Not followed: those of a"
            + ' task that failed, and of an orchestration.',
        },
        value: (period) => percent(mergedOfRead(period)),
        detail: mergedDetail,
        compare: (period) => shareWithCounts(mergedOfRead(period)),
      },
      shareTile({
        label: 'Merged without being sent back',
        explanation: {
          what: 'Of the merged pull requests, the share that nobody sent back for changes first.',
          why: "It is how often the agents' work was accepted without a second round. A low share means reviewers had to ask"
            + ' for changes before merging: sharpen the task description, or the instructions the repository gives agents.',
          how: 'Merged pull requests of this period with no change request by a reviewer with write access and no follow-up'
            + " task of yours that changed the pull request before the merge, divided by the period's merged pull requests."
            + ' Not counted: review comments without a change request, and a change request that was dismissed. Not visible'
            + ' to ABCA: follow-ups by other people and fixes pushed by hand.',
        },
        of: (period) => period.merged_clean,
        noun: 'merged pull request',
        none: noneMerged,
      }),
      shareTile({
        label: 'Not reworked through ABCA, so far',
        explanation: {
          what: 'The share of new pull requests you have not sent back to an agent for changes.',
          why: 'A pull request that comes back costs a second run and more of your attention. A falling share means first'
            + ' attempts miss what you wanted: sharpen the task description or the instructions the repository gives agents.',
          how: 'New pull requests of this period, verified or not, with no follow-up task sent to change them, divided by all new'
            + ' pull requests of the period. A follow-up that changed no code does not count. Follow-ups by other people and'
            + ' fixes pushed by hand are not visible to ABCA, reviews on GitHub are not counted here, and recent pull requests'
            + ' can still be sent back.',
        },
        of: (period) => period.not_reworked,
        noun: 'new pull request',
        none: NO_NEW_PR,
      }),
    ],
    notMeasured: 'Not measured by ABCA: change failure rate and time to restore, which need deploy and incident data, and'
      + ' whether a merged change was later reverted.',
  },
  {
    title: 'Leverage',
    description: 'How much it needs you, and what it costs.',
    tiles: [
      shareTile({
        label: 'Verified pull request with no stop for a person',
        explanation: {
          what: 'Of the tasks that asked for a new pull request, the share that reached a verified one without pausing for your'
            + ' approval.',
          why: 'It is how much of the work runs on its own. More is better only if "Not reworked through ABCA, so far" holds. To'
            + ' raise it, pre-approve from the command line what you always approve, but only where a wrong action is cheap to'
            + ' undo.',
          how: 'Verified pull requests whose task made no approval request, divided by finished tasks that asked for a new pull'
            + ' request. A task submitted with blanket approval cannot pause, and a pull request reworked later still counts.'
            + ' Messages sent to a running task, review and merge are not counted.',
        },
        of: (period) => period.untouched,
        noun: 'task',
        rest: ' that asked for a new pull request',
        none: NO_NEW_WORK,
        compare: true,
      }),
      {
        label: 'Human touchpoints per verified pull request',
        explanation: {
          what: 'How many times work waited for you, or was redirected by you, for each verified pull request.',
          why: 'It is what each verified pull request costs in your attention. The line under the number says which kind to act'
            + ' on: approval requests (pre-approve safe actions), questions from the agent (write clearer tasks),'
            + ' follow-ups (see "Not reworked through ABCA, so far").',
          how: 'Approval requests, questions from the agent, follow-ups on existing pull requests and tasks you cancelled, added'
            + " up over this period's tasks that write code, failed ones too, then divided by its verified pull requests. Not"
            + ' counted: messages to a running task, retries submitted as new tasks, follow-ups by other people, and review and'
            + ' merge on GitHub.',
        },
        value: touchpointsPerPr,
        detail: touchpointDetail,
        compare: touchpointsPerPr,
      },
      {
        label: 'Spend per verified pull request',
        explanation: {
          what: 'What a verified pull request costs you in model usage, failed attempts included.',
          why: 'It prices the result, not the attempt: a cheap task that fails three times is not cheap. When it rises, either'
            + ' each task costs more (see the Costs page) or fewer tasks reach a verified pull request (see "Ended in a verified'
            + ' pull request").',
          how: "The recorded cost of this period's tasks that write code, failed attempts and follow-ups included, divided by"
            + ' its verified pull requests. The cost is an estimate of model usage. The machines the agents run on are not in'
            + ' it, and tasks that were cancelled or ran out of time record no cost, so the true figure is higher. Reviews and'
            + ' research are left out: see the Costs page.',
        },
        value: spendPerPr,
        detail: spendDetail,
        compare: spendPerPr,
      },
    ],
    notMeasured: 'Not measured by ABCA: the hours people spent, the time people spent reviewing, and work a person did by hand.',
  },
  {
    title: 'Trust',
    description: 'Whether it stayed inside the rules.',
    tiles: [
      {
        label: 'Stopped by a guardrail',
        explanation: {
          what: 'Tasks ABCA stopped before work began, because an automatic check blocked the issue, pull request or linked file'
            + ' the agent was about to read.',
          why: 'A stop is the control doing its job. Open the task when one appears: either the issue, pull request or file it'
            + ' pointed at held something it should not, or the guardrail is too strict for your work.',
          how: 'Failed tasks of any kind whose recorded reason is a guardrail block. Not counted: text or files of yours refused'
            + ' at submission, actions the agent was refused during a run, and blocked network destinations. These tasks count'
            + ' as failed everywhere else on the page.',
        },
        value: (period) => formatCount(period.guardrail_stops.count),
        tasks: (period) => period.guardrail_stops,
      },
      shareTile({
        label: 'Held for approval',
        explanation: {
          what: 'Of the tasks that write code, the share that paused at least once to ask your approval before a sensitive'
            + ' action.',
          why: 'Too low can mean the repository\'s rules never ask, or too many tasks "Started with blanket approval". Too high'
            + ' makes people the bottleneck, and people who are asked all the time start approving without reading.',
          how: 'Tasks that write code and asked for approval at least once, divided by the tasks that write code and started.'
            + " The repository's rules decide which actions ask. You approve your own tasks: there is no second reviewer.",
        },
        of: (period) => period.gated,
        noun: STARTED_TO_WRITE_CODE[0],
        plural: STARTED_TO_WRITE_CODE[1],
        none: 'No task that writes code started in this period.',
      }),
      {
        label: 'Started with blanket approval',
        explanation: {
          what: 'Tasks submitted with every approval granted in advance.',
          why: 'Blanket approval trades the pause for speed. It suits repositories where a wrong action is cheap to undo; a'
            + ' growing count elsewhere means the approval step is being skipped. The tasks are linked under the number.',
          how: 'Finished tasks of any kind submitted with the option that approves everything for the whole task. Approving'
            + " everything once a task has paused is not counted. The repository's rules that always refuse an action still"
            + ' apply.',
        },
        value: (period) => formatCount(period.blanket_approvals.count),
        tasks: (period) => period.blanket_approvals,
      },
    ],
    notMeasured: 'ABCA does not merge pull requests and does not see who does. Not on this page: how quickly approvals were'
      + ' answered (CloudWatch dashboard), and whether every change left a complete record.',
  },
];

/** "in the last 30 days", or since the time a read that hit its cap reaches back to. */
function when(board: Scoreboard): string {
  return board.truncated ? `since ${formatTimestamp(board.current.from)}` : `in the last ${RANGE_DAYS[board.range]} days`;
}

/**
 * The populations the tiles count over, so that their counts can be reconciled, then the
 * two rules a reader needs before any number: which period a task belongs to, and what
 * "verified" proves.
 */
export function contextLine(board: Scoreboard): string {
  const { finished, verified } = board.current;
  return `${counted(finished, 'task')} finished ${when(board)}: ${formatCount(verified.total)} asked for a new pull request,`
    + ` ${formatCount(verified.count)} delivered a verified one. A task counts in the period it finished in. A verified pull request`
    + " is one opened after the repository's build command passed, which proves only what that command checks.";
}

/** What the page says in place of its sections when no task finished. */
export function nothingFinished(board: Scoreboard): string {
  return `No tasks finished ${when(board)}. The scoreboard fills in as your tasks finish.`;
}

/** What the warning says when the read stopped inside the range. On the shortest range there is no shorter one to advise. */
export function truncationNotice(board: Scoreboard): string {
  const reach = `Showing tasks finished since ${formatTimestamp(board.current.from)}. This range holds more than the scoreboard reads at once`;
  return board.range === '7d' ? `${reach}.` : `${reach}; a shorter range may cover all of it.`;
}

/**
 * The line that sets a tile against the period before: the earlier number in the tile's
 * own form, with no arrow, sign or verdict, because one person's numbers rest on a
 * handful of tasks. Null for a tile that does not compare, when the earlier period was
 * not read, and when that period has nothing to compute the number from.
 */
export function previousLine(tile: TileSpec, board: Scoreboard): string | null {
  const before = board.previous && tile.compare?.(board.previous);
  return before ? `${before} in the ${RANGE_DAYS[board.range]} days before` : null;
}

/**
 * The outcome bar's parts in the order they are drawn, each with its slot in the chart
 * palette and its explanation. Any two parts touch when the third is empty, and slots
 * 0 to 2 stay apart pair by pair under protan and deutan simulation (closest: 1 and 2,
 * OKLab Delta E 9.2 light, 9.4 dark).
 */
const OUTCOME_PARTS: readonly { label: string; slot: 0 | 1 | 2; explanation: Explanation }[] = [
  {
    label: 'Verified pull request',
    slot: 0,
    explanation: {
      what: 'Tasks that asked for a new pull request and delivered one after the build passed.',
      why: 'Every number above that names a verified pull request rests on this count. When it is small, one task swings them'
        + ' all. A bigger count is more volume, not a better score: for that, read "Ended in a verified pull request".',
      how: 'Tasks that ended normally, opened a new pull request and recorded a passed build. Whether it was merged'
        + ' afterwards is counted under "Merged, so far".',
    },
  },
  {
    label: 'Finished without a verified pull request',
    slot: 2,
    explanation: {
      what: 'Tasks that ended normally, but not with a verified pull request.',
      why: 'Follow-ups, reviews and research belong here, and that is normal. The row to watch in the table below is "Pull'
        + ' request without a passed build": those reach reviewers with a build that failed or never ran.',
      how: 'The table rows "Pull request without a passed build" and "Finished, no new pull request", added together. The'
        + ' second holds tasks that ended with a question for you, and work that never aimed at a new pull request, such as'
        + ' follow-ups, reviews and research.',
    },
  },
  {
    label: 'Failed or stopped',
    slot: 1,
    explanation: {
      what: 'Tasks that failed, were cancelled, or ran out of time.',
      why: 'Each one took time, and usually money, without a result you can use. When the share grows, open the tasks from'
        + " the Tasks page: each task's page says why it ended and, for a failure, what to do next.",
      how: 'The table rows "Failed", "Cancelled" and "Ran out of time", added together. A task whose change broke a build that'
        + ' passed before ends as failed, and its pull request stays open on GitHub.',
    },
  },
];

/** The six outcomes in table order, each with the slot of the bar part it belongs to. */
const OUTCOMES: Readonly<Record<TaskOutcome, { label: string; slot: (typeof OUTCOME_PARTS)[number]['slot'] }>> = {
  verified_pr: { label: 'Verified pull request', slot: 0 },
  unverified_pr: { label: 'Pull request without a passed build', slot: 2 },
  no_new_pr: { label: 'Finished, no new pull request', slot: 2 },
  failed: { label: 'Failed', slot: 1 },
  cancelled: { label: 'Cancelled', slot: 1 },
  timed_out: { label: 'Ran out of time', slot: 1 },
};

export interface OutcomeRow {
  readonly outcome: TaskOutcome;
  readonly label: string;
  readonly slot: number;
  readonly count: number;
  /** Of the tasks that finished. */
  readonly share: string | null;
}

export interface OutcomePart {
  readonly label: string;
  readonly slot: number;
  readonly count: number;
  /** The part in numbers: "26 of 52 finished tasks, 50%". */
  readonly summary: string;
  readonly explanation: Explanation;
}

/** The table under the bar: its legend, through each row's slot, and the full data. */
export function outcomeRows(period: ScoreboardPeriod): OutcomeRow[] {
  return (Object.keys(OUTCOMES) as TaskOutcome[]).map((outcome) => ({
    outcome,
    ...OUTCOMES[outcome],
    count: period.outcomes[outcome],
    share: percent({ count: period.outcomes[outcome], total: period.finished }),
  }));
}

/** The six outcomes folded into the three parts of the bar. */
export function outcomeParts(period: ScoreboardPeriod): OutcomePart[] {
  const rows = outcomeRows(period);
  return OUTCOME_PARTS.map((part) => {
    const count = rows.filter((row) => row.slot === part.slot).reduce((sum, row) => sum + row.count, 0);
    const share = percent({ count, total: period.finished });
    const of = `${formatCount(count)} of ${counted(period.finished, 'finished task')}`;
    return { ...part, count, summary: share === null ? of : `${of}, ${share}` };
  });
}
