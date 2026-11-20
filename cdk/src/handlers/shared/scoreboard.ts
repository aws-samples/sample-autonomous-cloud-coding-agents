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
 * Factory scoreboard: what a finished task counts as.
 *
 * {@link taskFacts} is the one definition. It has two readers: the TaskTable
 * stream step, which writes one metric line per finished task
 * ({@link taskMetricLine}), and `GET /v1/tasks?view=scoreboard`, which
 * aggregates the caller's finished tasks ({@link buildScoreboard}). No AWS
 * client and no clock: a record counts the same wherever it is read.
 *
 * A number is added in six places:
 *  1. the fact of one task: {@link TaskFacts} and {@link taskFacts} ({@link SCOREBOARD_TASK_FIELDS} when it reads a new field);
 *  2. its aggregate over a period: `buildPeriod`;
 *  3. the wire type `ScoreboardPeriod` in `./types`, and its mirror in `web/src/core/api/types.ts`;
 *  4. the tile list of the console page: `web/src/core/util/scoreboard.ts`;
 *  5. the definitions table of `docs/design/OBSERVABILITY.md`;
 *  6. the field table and the example of `docs/design/API_CONTRACT.md`.
 * A CloudWatch metric is added in {@link FACTORY_METRICS} and {@link taskMetricLine}, and needs a
 * widget in `cdk/src/constructs/task-dashboard.ts`. A new series changes the count (14) in
 * `docs/design/OBSERVABILITY.md` and, with the price, in `docs/guides/COST_ATTRIBUTION.md`.
 */

import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';
import { isClarifyHold, isNewTaskWorkflow } from './clarify-resume';
import { classifyError, ErrorCategory } from './error-classifier';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';
import { isIntegrationNode } from './orchestration-integration-node';
import { prNumberFromTask } from './task-pr-number';
import {
  APPROVAL_GATE_CAP_MAX,
  MAX_BUDGET_USD_MAX,
  type ApprovalScope,
  type Flagged,
  type Fraction,
  type Scoreboard,
  type ScoreboardPeriod,
  type ScoreboardRange,
  type TaskOutcome,
  type TaskRecord,
  type TouchpointKind,
} from './types';

export const FACTORY_METRIC_NAMESPACE = 'ABCA/Factory';

/** Metric names, shared by the line builder and the dashboard so they cannot be spelled apart. */
export const FACTORY_METRICS = {
  tasksFinished: 'TasksFinished',
  timeToVerifiedPr: 'TimeToVerifiedPrSeconds',
  untouchedVerifiedPrs: 'UntouchedVerifiedPrs',
  costUsd: 'CostUsd',
  humanTouchpoints: 'HumanTouchpoints',
  guardrailStops: 'GuardrailStops',
  blanketApprovals: 'BlanketApprovals',
} as const;

/** Dimension names, shared with the dashboard like the metric names. `Outcome` takes a `TaskOutcome`. */
export const FACTORY_DIMENSIONS = { outcome: 'Outcome', work: 'Work' } as const;

/** The values of `Work`: `coding` for a coding task, `other` for every other finished task. */
export const FACTORY_WORK = { coding: 'coding', other: 'other' } as const;

/** The task fields the scoreboard reads: the projection of the API read and the input type, one list. */
export const SCOREBOARD_TASK_FIELDS = [
  'task_id',
  'status',
  'repo',
  'resolved_workflow',
  'workflow_ref',
  'channel_metadata',
  'created_at',
  'updated_at',
  'queued_at',
  'started_at',
  'completed_at',
  'pr_url',
  'pr_number',
  'build_passed',
  'code_changed',
  'answer_text',
  'cost_usd',
  'error_message',
  'approval_gate_count',
  'initial_approvals',
] as const satisfies readonly (keyof TaskRecord)[];

/** A task record as far as the scoreboard reads it. */
export type ScoreboardTask = Pick<TaskRecord, (typeof SCOREBOARD_TASK_FIELDS)[number]>;

/** Everything the scoreboard knows about one finished task. */
export interface TaskFacts {
  readonly taskId: string;
  /** Epoch milliseconds of `completed_at`, else of `updated_at`; NaN when the record has no usable time. */
  readonly finishedAtMs: number;
  readonly outcome: TaskOutcome;
  /** Ran `coding/new-task-v1` and is not an integration node: the task asked for a new pull request. */
  readonly newWork: boolean;
  /** Ran a workflow whose work goes into pull requests: a new task, a PR iteration or a restack. */
  readonly coding: boolean;
  readonly ran: boolean;
  readonly queued: boolean;
  /** Whole seconds from creation to the finish time; null when either end is unknown. */
  readonly leadTimeS: number | null;
  /** Whole seconds from creation to the start of the session; null when either end is unknown. */
  readonly waitS: number | null;
  /** The recorded cost; null when there is none, or when it is not an amount a task can cost: negative, not finite, or beyond belief. */
  readonly costUsd: number | null;
  readonly touchpoints: Readonly<Record<TouchpointKind, number>>;
  readonly guardrailStop: boolean;
  readonly blanketApproval: boolean;
  /** `<repo lower-cased>#<number>`: set for a new pull request and for a task that reworks one. */
  readonly prKey: string | null;
  readonly reworks: boolean;
}

/** With `coding/new-task-v1`, the workflows whose work goes into pull requests. */
const PR_ITERATION_WORKFLOW_ID = 'coding/pr-iteration-v1';
const RESTACK_WORKFLOW_ID = 'coding/restack-v1';

/** The scope that grants every approval in advance. */
const BLANKET_APPROVAL_SCOPE: ApprovalScope = 'all_session';

/**
 * How much of an `error_message` is classified: the agent stores at most 1,000 characters, and
 * the platform's own reasons carry their marker at the front. A record is read from storage and
 * can hold more; nothing past this length is a reason either of them wrote.
 */
const CLASSIFIED_MESSAGE_CHARS = 1000;

/**
 * No task costs this much: 100 times the largest budget a task can be given. A plausibility
 * bound, as a task without a budget has none: one record must not be the whole of a sum over
 * every user that cannot be corrected afterwards.
 */
const MAX_TASK_COST_USD = 100 * MAX_BUDGET_USD_MAX;

/**
 * The precision of a period's spend. Costs are decimal strings summed as floats: unrounded,
 * the sum carries digits that no cost had.
 */
const MICRO_USD = 1_000_000;

const SCOREBOARD_RANGE_DAYS: Readonly<Record<ScoreboardRange, number>> = { '7d': 7, '30d': 30 };
const DEFAULT_SCOREBOARD_RANGE: ScoreboardRange = '30d';
const MS_PER_DAY = 86400 * 1000;

const MEDIAN = 50;
const P90 = 90;

/** How many task ids a `Flagged` count carries. */
const FLAGGED_TASK_IDS_MAX = 10;

/** A record is typed, but it is read from storage: a field counts only when it holds text. */
function isSet(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Epoch milliseconds of an ISO stamp, NaN without one. Agent stamps are whole seconds and
 * platform ones have milliseconds, so the strings do not compare: only the instants do.
 */
function epochMs(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/**
 * The finish time of a task: `completed_at`, else `updated_at`, in epoch milliseconds; NaN
 * when the record has neither. Three writers of a terminal status (a Slack cancel, a refused
 * upload, a failed upload instruction) wrote no `completed_at` until #1048, and their records
 * live until retention ends. On such a record `updated_at` is the terminal write, or seconds
 * later when a write that was already in flight landed after it. The API read meets only the
 * refused upload: the other two kept the index key of the status they left, which is not a
 * terminal one, and are never read. The stream step meets all three, and reads their age
 * from this time.
 */
export function finishTimeMs(task: { completed_at?: string; updated_at?: string }): number {
  const completedAtMs = epochMs(task.completed_at);
  return Number.isFinite(completedAtMs) ? completedAtMs : epochMs(task.updated_at);
}

/** Whole seconds between two instants; null, never zero, when one is unknown or the end comes first. */
function wholeSeconds(startMs: number, endMs: number): number | null {
  const elapsedMs = endMs - startMs;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs / 1000) : null;
}

/** An integration node runs the new-task workflow but merges the branches of other tasks. */
function isIntegrationNodeTask(task: ScoreboardTask): boolean {
  const subIssueId = task.channel_metadata?.orchestration_sub_issue_id;
  return typeof subIssueId === 'string' && isIntegrationNode(subIssueId);
}

function outcomeOf(task: ScoreboardTask, newWork: boolean): TaskOutcome {
  if (task.status === TaskStatus.FAILED) return 'failed';
  if (task.status === TaskStatus.CANCELLED) return 'cancelled';
  if (task.status === TaskStatus.TIMED_OUT) return 'timed_out';
  // COMPLETED also covers a clarify hold and every task that works on an existing pull request.
  if (!newWork || !isSet(task.pr_url)) return 'no_new_pr';
  // An absent verdict means the build command could not run: the pull request is not verified.
  return task.build_passed === true ? 'verified_pr' : 'unverified_pr';
}

/** The agent stores the cost as a string, and only its own terminal write stores one. */
function recordedCost(task: ScoreboardTask): number | null {
  const cost = coerceNumericOrNull(task.cost_usd, { task_id: task.task_id, field: 'cost_usd' }, logger);
  return cost !== null && cost >= 0 && cost <= MAX_TASK_COST_USD ? cost : null;
}

/**
 * `approval_gate_count` counts requests, not approvals: each one asked for a person, and one
 * that could not be stored is counted too. Whole requests, and never more than the platform
 * lets a task make.
 */
function approvalRequests(task: ScoreboardTask): number {
  const requests = coerceNumericOrNull(task.approval_gate_count, { task_id: task.task_id, field: 'approval_gate_count' }, logger);
  return requests !== null && requests >= 1 ? Math.min(Math.floor(requests), APPROVAL_GATE_CAP_MAX) : 0;
}

/**
 * Only what the platform decided: content it blocked while the task was prepared. A blocker
 * the agent reports is its reading of a tool's output, not the act of a control.
 */
function isGuardrailStop(task: ScoreboardTask): boolean {
  if (task.status !== TaskStatus.FAILED || typeof task.error_message !== 'string') return false;
  return classifyError(task.error_message.slice(0, CLASSIFIED_MESSAGE_CHARS))?.category === ErrorCategory.GUARDRAIL;
}

/** First-run tasks store `pr_url` without `pr_number`, follow-ups the number: one key for both. */
function pullRequestKey(task: ScoreboardTask): string | null {
  const number = prNumberFromTask(task);
  return isSet(task.repo) && number !== null ? `${task.repo.toLowerCase()}#${number}` : null;
}

/** The facts of a finished task; null for a task that is not terminal. Never throws on a sparse or odd record. */
export function taskFacts(task: ScoreboardTask): TaskFacts | null {
  if (!TERMINAL_STATUSES.includes(task.status)) return null;
  const workflowId = task.resolved_workflow?.id;
  const newTask = isNewTaskWorkflow(task);
  const iteration = workflowId === PR_ITERATION_WORKFLOW_ID;
  const newWork = newTask && !isIntegrationNodeTask(task);
  const outcome = outcomeOf(task, newWork);
  const createdAtMs = epochMs(task.created_at);
  const finishedAtMs = finishTimeMs(task);
  const key = pullRequestKey(task);
  // `code_changed` is written only when two commits could be compared: absent reads as
  // "changed", the side the reply to a follow-up takes too.
  const reworks = iteration && key !== null && task.code_changed !== false;
  const opensPullRequest = outcome === 'verified_pr' || outcome === 'unverified_pr';
  return {
    taskId: task.task_id,
    finishedAtMs,
    outcome,
    newWork,
    coding: newTask || iteration || workflowId === RESTACK_WORKFLOW_ID,
    ran: isSet(task.started_at),
    queued: isSet(task.queued_at),
    leadTimeS: wholeSeconds(createdAtMs, finishedAtMs),
    waitS: wholeSeconds(createdAtMs, epochMs(task.started_at)),
    costUsd: recordedCost(task),
    touchpoints: {
      approve: approvalRequests(task),
      clarify: isClarifyHold(task) ? 1 : 0,
      follow_up: iteration ? 1 : 0,
      // A negative inference: the human cancel paths write no message, the upload-expiry auto-cancel does.
      cancel: task.status === TaskStatus.CANCELLED && !isSet(task.error_message) ? 1 : 0,
    },
    guardrailStop: isGuardrailStop(task),
    blanketApproval: Array.isArray(task.initial_approvals) && task.initial_approvals.includes(BLANKET_APPROVAL_SCOPE),
    prKey: opensPullRequest || reworks ? key : null,
    reworks,
  };
}

function touchpointTotal(facts: TaskFacts): number {
  return Object.values(facts.touchpoints).reduce((total, count) => total + count, 0);
}

function isUntouchedVerifiedPr(facts: TaskFacts): boolean {
  return facts.outcome === 'verified_pr' && touchpointTotal(facts) === 0;
}

/** Start of the range's current period and of the one before it. Rolling windows: `days` x 24 h back from `now`. */
export function scoreboardWindows(range: ScoreboardRange, now: Date): { from: Date; previousFrom: Date } {
  const lengthMs = SCOREBOARD_RANGE_DAYS[range] * MS_PER_DAY;
  return { from: new Date(now.getTime() - lengthMs), previousFrom: new Date(now.getTime() - 2 * lengthMs) };
}

/** The range a request names: the default when it names none, null when it names an unknown one. */
export function parseScoreboardRange(value: string | undefined): ScoreboardRange | null {
  if (value === undefined) return DEFAULT_SCOREBOARD_RANGE;
  return Object.hasOwn(SCOREBOARD_RANGE_DAYS, value) ? (value as ScoreboardRange) : null;
}

/** The values that are known, ascending. */
function ascending(values: readonly (number | null)[]): number[] {
  return values.filter((value) => value !== null).sort((a, b) => a - b);
}

/** Nearest rank: the smallest of the values (at least one) with `percent` % of them at or below it. */
function percentile(ascendingValues: readonly number[], percent: number): number {
  return ascendingValues[Math.ceil((percent * ascendingValues.length) / 100) - 1];
}

function outcomeCounts(finished: readonly TaskFacts[]): Record<TaskOutcome, number> {
  const counts: Record<TaskOutcome, number> = { verified_pr: 0, unverified_pr: 0, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 };
  for (const facts of finished) counts[facts.outcome] += 1;
  return counts;
}

function touchpointSums(tasks: readonly TaskFacts[]): Record<TouchpointKind, number> {
  const sum = (kind: TouchpointKind): number => tasks.reduce((total, facts) => total + facts.touchpoints[kind], 0);
  return { approve: sum('approve'), clarify: sum('clarify'), follow_up: sum('follow_up'), cancel: sum('cancel') };
}

function timeToVerifiedPr(verified: readonly TaskFacts[]): ScoreboardPeriod['time_to_verified_pr_s'] {
  const leadTimes = ascending(verified.map((facts) => facts.leadTimeS));
  if (leadTimes.length === 0) return null;
  return { p50: percentile(leadTimes, MEDIAN), p90: percentile(leadTimes, P90), count: leadTimes.length };
}

function flagged(tasks: readonly TaskFacts[]): Flagged {
  const newestFirst = [...tasks].sort((a, b) => b.finishedAtMs - a.finishedAtMs);
  return { count: tasks.length, task_ids: newestFirst.slice(0, FLAGGED_TASK_IDS_MAX).map((facts) => facts.taskId) };
}

/** Per pull-request key, the earliest finish time of a task that reworks it. */
function firstReworks(all: readonly TaskFacts[]): Map<string, number> {
  const firstReworkMs = new Map<string, number>();
  for (const facts of all) {
    if (!facts.reworks || facts.prKey === null) continue;
    firstReworkMs.set(facts.prKey, Math.min(firstReworkMs.get(facts.prKey) ?? Infinity, facts.finishedAtMs));
  }
  return firstReworkMs;
}

/**
 * The new pull requests of a period that no task reworked before the period's end, of those
 * pull requests. A later rework is left out so that an earlier period is not judged with more
 * hindsight than the current one. A pull request without a key is in neither number.
 */
function notReworked(finished: readonly TaskFacts[], firstReworkMs: ReadonlyMap<string, number>, endMs: number): Fraction {
  const opened = new Set<string>();
  for (const facts of finished) {
    if (facts.newWork && facts.prKey !== null) opened.add(facts.prKey);
  }
  const reworked = [...opened].filter((key) => (firstReworkMs.get(key) ?? Infinity) < endMs).length;
  return { count: opened.size - reworked, total: opened.size };
}

/** The numbers of the tasks that finished in [from, endMs). `to` is the bound the response names. */
function buildPeriod(
  all: readonly TaskFacts[],
  firstReworkMs: ReadonlyMap<string, number>,
  from: Date,
  to: Date,
  endMs: number,
): ScoreboardPeriod {
  const finished = all.filter((facts) => facts.finishedAtMs >= from.getTime() && facts.finishedAtMs < endMs);
  const newWork = finished.filter((facts) => facts.newWork);
  const coding = finished.filter((facts) => facts.coding);
  const codingRan = coding.filter((facts) => facts.ran);
  const verified = finished.filter((facts) => facts.outcome === 'verified_pr');
  const waits = ascending(verified.map((facts) => facts.waitS));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    finished: finished.length,
    outcomes: outcomeCounts(finished),
    time_to_verified_pr_s: timeToVerifiedPr(verified),
    wait_p50_s: waits.length === 0 ? null : percentile(waits, MEDIAN),
    queued: {
      count: finished.filter((facts) => facts.queued).length,
      total: finished.filter((facts) => facts.queued || facts.ran).length,
    },
    verified: { count: verified.length, total: newWork.length },
    not_reworked: notReworked(finished, firstReworkMs, endMs),
    untouched: { count: verified.filter(isUntouchedVerifiedPr).length, total: newWork.length },
    touchpoints: touchpointSums(coding),
    spend_usd: Math.round(coding.reduce((total, facts) => total + (facts.costUsd ?? 0), 0) * MICRO_USD) / MICRO_USD,
    uncosted: codingRan.filter((facts) => facts.costUsd === null).length,
    guardrail_stops: flagged(finished.filter((facts) => facts.guardrailStop)),
    blanket_approvals: flagged(finished.filter((facts) => facts.blanketApproval)),
    gated: { count: codingRan.filter((facts) => facts.touchpoints.approve > 0).length, total: codingRan.length },
  };
}

/**
 * Aggregate task records into the API response. `tasks` must hold every task of the caller that
 * finished at or after `coveredFrom` (default: the previous period's start).
 */
export function buildScoreboard(tasks: readonly ScoreboardTask[], range: ScoreboardRange, now: Date, coveredFrom?: Date): Scoreboard {
  const { from, previousFrom } = scoreboardWindows(range, now);
  // A task without a usable finish time belongs to no period.
  const all = tasks
    .map((task) => taskFacts(task))
    .filter((facts): facts is TaskFacts => facts !== null && Number.isFinite(facts.finishedAtMs));
  const firstReworkMs = firstReworks(all);
  // A read that was cut inside the current period shortens it; one cut anywhere after the
  // previous period's start leaves that period incomplete, and it is not reported at all.
  const truncated = coveredFrom !== undefined && coveredFrom.getTime() > from.getTime();
  const previousCovered = coveredFrom === undefined || coveredFrom.getTime() <= previousFrom.getTime();
  return {
    range,
    truncated,
    // No upper test: a finish time ahead of the clock belongs to the current period.
    current: buildPeriod(all, firstReworkMs, truncated ? coveredFrom : from, now, Infinity),
    previous: previousCovered ? buildPeriod(all, firstReworkMs, previousFrom, from, from.getTime()) : null,
  };
}

/** One metric of the line. A null value leaves the metric off the line and out of its directive. */
interface LineMetric {
  readonly name: string;
  readonly unit: 'Count' | 'Seconds' | 'None';
  readonly value: number | null;
}

/**
 * One EMF line for one finished task. The outcome and the kind of work are the only dimensions,
 * both closed sets; the identifiers and the workflow ride as plain fields, which create no
 * metric series.
 */
export function taskMetricLine(facts: TaskFacts, context: { user_id?: string; repo?: string; workflow?: string }, nowMs: number): string {
  const untouched = isUntouchedVerifiedPr(facts) ? 1 : 0;
  const groups: readonly { readonly dimensions: readonly string[]; readonly metrics: readonly LineMetric[] }[] = [
    { dimensions: [FACTORY_DIMENSIONS.outcome], metrics: [{ name: FACTORY_METRICS.tasksFinished, unit: 'Count', value: 1 }] },
    {
      dimensions: [FACTORY_DIMENSIONS.work],
      metrics: [
        { name: FACTORY_METRICS.humanTouchpoints, unit: 'Count', value: touchpointTotal(facts) },
        { name: FACTORY_METRICS.costUsd, unit: 'None', value: facts.costUsd },
      ],
    },
    {
      dimensions: [],
      metrics: [
        { name: FACTORY_METRICS.guardrailStops, unit: 'Count', value: facts.guardrailStop ? 1 : 0 },
        { name: FACTORY_METRICS.blanketApprovals, unit: 'Count', value: facts.blanketApproval ? 1 : 0 },
        { name: FACTORY_METRICS.timeToVerifiedPr, unit: 'Seconds', value: facts.outcome === 'verified_pr' ? facts.leadTimeS : null },
        // On new work only, as 0 or 1, so that the average of the metric is the untouched share.
        { name: FACTORY_METRICS.untouchedVerifiedPrs, unit: 'Count', value: facts.newWork ? untouched : null },
      ],
    },
  ];
  // The specification requires every declared metric to be a member of the line, and a
  // directive without metrics declares nothing.
  const declared = groups
    .map(({ dimensions, metrics }) => ({ dimensions, metrics: metrics.filter((metric) => metric.value !== null) }))
    .filter(({ metrics }) => metrics.length > 0);
  return JSON.stringify({
    _aws: {
      // Never ahead of the clock: CloudWatch drops a timestamp more than two hours in the future.
      Timestamp: Number.isFinite(facts.finishedAtMs) ? Math.min(facts.finishedAtMs, nowMs) : nowMs,
      CloudWatchMetrics: declared.map(({ dimensions, metrics }) => ({
        Namespace: FACTORY_METRIC_NAMESPACE,
        // One DimensionSet each, the empty one for the metrics without dimensions: `[]` would declare no metric.
        Dimensions: [dimensions],
        Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })),
      })),
    },
    [FACTORY_DIMENSIONS.outcome]: facts.outcome,
    [FACTORY_DIMENSIONS.work]: facts.coding ? FACTORY_WORK.coding : FACTORY_WORK.other,
    ...Object.fromEntries(declared.flatMap(({ metrics }) => metrics.map(({ name, value }) => [name, value]))),
    task_id: facts.taskId,
    user_id: context.user_id,
    repo: context.repo,
    workflow: context.workflow,
    wait_s: facts.waitS ?? undefined,
  });
}
