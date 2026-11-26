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
  type DurationSummary,
  type Flagged,
  type Fraction,
  type PullRequestState,
  type Scoreboard,
  type ScoreboardPeriod,
  type ScoreboardRange,
  type TaskOutcome,
  type TaskRecord,
  type TouchpointKind,
} from './types';

export const FACTORY_METRIC_NAMESPACE = 'ABCA/Factory';

export const FACTORY_METRICS = {
  tasksFinished: 'TasksFinished',
  timeToVerifiedPr: 'TimeToVerifiedPrSeconds',
  untouchedVerifiedPrs: 'UntouchedVerifiedPrs',
  costUsd: 'CostUsd',
  humanTouchpoints: 'HumanTouchpoints',
  guardrailStops: 'GuardrailStops',
  blanketApprovals: 'BlanketApprovals',
  pullRequestsResolved: 'PullRequestsResolved',
  timeToMerge: 'TimeToMergeSeconds',
} as const;

/** `Outcome` takes a `TaskOutcome`; `PrOutcome` takes the final state of a pull request, `merged` or `closed`. */
export const FACTORY_DIMENSIONS = { outcome: 'Outcome', work: 'Work', prOutcome: 'PrOutcome' } as const;

/** The values of `Work`: `coding` for a coding task, `other` for every other finished task. */
export const FACTORY_WORK = { coding: 'coding', other: 'other' } as const;

export const SCOREBOARD_TASK_FIELDS = [
  'task_id',
  'status',
  'repo',
  'resolved_workflow',
  'workflow_ref',
  'channel_metadata',
  'orchestration_id',
  'created_at',
  'updated_at',
  'queued_at',
  'started_at',
  'completed_at',
  'pr_url',
  'pr_number',
  'pr_state',
  'pr_closed_at',
  'pr_first_review_at',
  'pr_changes_requested',
  'build_passed',
  'code_changed',
  'answer_text',
  'cost_usd',
  'error_message',
  'approval_gate_count',
  'initial_approvals',
] as const satisfies readonly (keyof TaskRecord)[];

export type ScoreboardTask = Pick<TaskRecord, (typeof SCOREBOARD_TASK_FIELDS)[number]>;

/**
 * The fields a scoreboard reads, as the projection of a DynamoDB read. Every name is behind
 * an alias: `status` is a reserved word of DynamoDB. The other expressions of the same read
 * can use the aliases too.
 */
export const SCOREBOARD_PROJECTION = {
  ProjectionExpression: SCOREBOARD_TASK_FIELDS.map((field) => `#${field}`).join(', '),
  ExpressionAttributeNames: Object.fromEntries(SCOREBOARD_TASK_FIELDS.map((field) => [`#${field}`, field])),
};

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
  /**
   * The hourly read of GitHub follows the pull request: a new one, opened by a task that is
   * not part of an orchestration. The five facts below exist for a followed pull request only.
   */
  readonly prFollowed: boolean;
  /**
   * What the hourly read last recorded about the followed pull request: its state on GitHub, or
   * `not_found` when GitHub had no pull request of this task under the recorded number. Null
   * until a read records one.
   */
  readonly prState: 'open' | 'merged' | 'closed' | 'not_found' | null;
  /** Epoch milliseconds of GitHub's merge or close time; null without a usable one. */
  readonly prClosedAtMs: number | null;
  /** Whole seconds from creation to the merge; null unless the pull request is merged and both ends are known. */
  readonly timeToMergeS: number | null;
  /** Whole seconds from the finish time to the first review that counts (a person who can push, other than the author), 0 for a review before the finish; null without one. */
  readonly firstReviewS: number | null;
  /** Reviews that requested changes, counted when the final state was recorded. */
  readonly changesRequested: number;
}

const PR_ITERATION_WORKFLOW_ID = 'coding/pr-iteration-v1';
const RESTACK_WORKFLOW_ID = 'coding/restack-v1';

const BLANKET_APPROVAL_SCOPE: ApprovalScope = 'all_session';

const MAX_TASK_COST_USD = 100 * MAX_BUDGET_USD_MAX;

const MICRO_USD = 1_000_000;

const SCOREBOARD_RANGE_DAYS: Readonly<Record<ScoreboardRange, number>> = { '7d': 7, '30d': 30 };
const DEFAULT_SCOREBOARD_RANGE: ScoreboardRange = '30d';
const MS_PER_DAY = 86400 * 1000;

const MEDIAN = 50;
const P90 = 90;

const FLAGGED_TASK_IDS_MAX = 10;

const OPEN_OVER_DAYS = 7;

function isSet(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function epochMs(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/**
 * The finish time of a task: `completed_at`, else `updated_at`, in epoch milliseconds; NaN
 * when the record has neither.
 */
export function finishTimeMs(task: { completed_at?: string; updated_at?: string }): number {
  const completedAtMs = epochMs(task.completed_at);
  return Number.isFinite(completedAtMs) ? completedAtMs : epochMs(task.updated_at);
}

function wholeSeconds(startMs: number, endMs: number): number | null {
  const elapsedMs = endMs - startMs;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs / 1000) : null;
}

function isIntegrationNodeTask(task: ScoreboardTask): boolean {
  const subIssueId = task.channel_metadata?.orchestration_sub_issue_id;
  return typeof subIssueId === 'string' && isIntegrationNode(subIssueId);
}

function outcomeOf(task: ScoreboardTask, newWork: boolean): TaskOutcome {
  if (task.status === TaskStatus.FAILED) return 'failed';
  if (task.status === TaskStatus.CANCELLED) return 'cancelled';
  if (task.status === TaskStatus.TIMED_OUT) return 'timed_out';
  if (!newWork || !isSet(task.pr_url)) return 'no_new_pr';
  return task.build_passed === true ? 'verified_pr' : 'unverified_pr';
}

function recordedCost(task: ScoreboardTask): number | null {
  const cost = coerceNumericOrNull(task.cost_usd, { task_id: task.task_id, field: 'cost_usd' }, logger);
  return cost !== null && cost >= 0 && cost <= MAX_TASK_COST_USD ? cost : null;
}

function storedCount(task: ScoreboardTask, field: 'approval_gate_count' | 'pr_changes_requested'): number {
  const count = coerceNumericOrNull(task[field], { task_id: task.task_id, field }, logger);
  return count !== null && count >= 1 ? Math.floor(count) : 0;
}

function approvalRequests(task: ScoreboardTask): number {
  return Math.min(storedCount(task, 'approval_gate_count'), APPROVAL_GATE_CAP_MAX);
}

function isGuardrailStop(task: ScoreboardTask): boolean {
  return task.status === TaskStatus.FAILED && classifyError(task.error_message)?.category === ErrorCategory.GUARDRAIL;
}

function pullRequestKey(task: ScoreboardTask): string | null {
  const number = prNumberFromTask(task);
  return isSet(task.repo) && number !== null ? `${task.repo.toLowerCase()}#${number}` : null;
}

function isOrchestrationTask(task: ScoreboardTask): boolean {
  const orchestrationId = typeof task.orchestration_id === 'string' ? task.orchestration_id : task.channel_metadata?.orchestration_id;
  return typeof orchestrationId === 'string' && orchestrationId !== '';
}

type PullRequestFacts = Pick<TaskFacts, 'prState' | 'prClosedAtMs' | 'timeToMergeS' | 'firstReviewS' | 'changesRequested'>;

const NO_PULL_REQUEST: PullRequestFacts = { prState: null, prClosedAtMs: null, timeToMergeS: null, firstReviewS: null, changesRequested: 0 };

function recordedState(value: unknown): TaskFacts['prState'] {
  return value === 'open' || value === 'merged' || value === 'closed' || value === 'not_found' ? value : null;
}

function pullRequestFacts(task: ScoreboardTask, createdAtMs: number, finishedAtMs: number): PullRequestFacts {
  const prState = recordedState(task.pr_state);
  const closedAtMs = epochMs(task.pr_closed_at);
  return {
    prState,
    prClosedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : null,
    timeToMergeS: prState === 'merged' ? wholeSeconds(createdAtMs, closedAtMs) : null,
    firstReviewS: wholeSeconds(finishedAtMs, Math.max(finishedAtMs, epochMs(task.pr_first_review_at))),
    changesRequested: storedCount(task, 'pr_changes_requested'),
  };
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
  const reworks = iteration && key !== null && task.code_changed !== false;
  const opensPullRequest = outcome === 'verified_pr' || outcome === 'unverified_pr';
  const prFollowed = opensPullRequest && !isOrchestrationTask(task);
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
      cancel: task.status === TaskStatus.CANCELLED && !isSet(task.error_message) ? 1 : 0,
    },
    guardrailStop: isGuardrailStop(task),
    blanketApproval: Array.isArray(task.initial_approvals) && task.initial_approvals.includes(BLANKET_APPROVAL_SCOPE),
    prKey: opensPullRequest || reworks ? key : null,
    reworks,
    prFollowed,
    ...(prFollowed ? pullRequestFacts(task, createdAtMs, finishedAtMs) : NO_PULL_REQUEST),
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

function ascending(values: readonly (number | null)[]): number[] {
  return values.filter((value) => value !== null).sort((a, b) => a - b);
}

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

function durationSummary(durations: readonly (number | null)[]): DurationSummary | null {
  const known = ascending(durations);
  if (known.length === 0) return null;
  return { p50: percentile(known, MEDIAN), p90: percentile(known, P90), count: known.length };
}

function flagged(tasks: readonly TaskFacts[], first: 'newest' | 'oldest'): Flagged {
  const direction = first === 'newest' ? -1 : 1;
  const ordered = [...tasks].sort((a, b) => direction * (a.finishedAtMs - b.finishedAtMs));
  return { count: tasks.length, task_ids: ordered.slice(0, FLAGGED_TASK_IDS_MAX).map((facts) => facts.taskId) };
}

function firstReworks(all: readonly TaskFacts[]): Map<string, number> {
  const firstReworkMs = new Map<string, number>();
  for (const facts of all) {
    if (!facts.reworks || facts.prKey === null) continue;
    firstReworkMs.set(facts.prKey, Math.min(firstReworkMs.get(facts.prKey) ?? Infinity, facts.finishedAtMs));
  }
  return firstReworkMs;
}

function notReworked(finished: readonly TaskFacts[], firstReworkMs: ReadonlyMap<string, number>, endMs: number): Fraction {
  const opened = new Set<string>();
  for (const facts of finished) {
    if (facts.newWork && facts.prKey !== null) opened.add(facts.prKey);
  }
  const reworked = [...opened].filter((key) => (firstReworkMs.get(key) ?? Infinity) < endMs).length;
  return { count: opened.size - reworked, total: opened.size };
}

function readState(facts: TaskFacts): Exclude<TaskFacts['prState'], 'not_found'> {
  return facts.prState === 'not_found' ? null : facts.prState;
}

function stateAt(facts: TaskFacts, endMs: number): PullRequestState {
  const state = readState(facts);
  if (state === null) return 'unread';
  return facts.prClosedAtMs !== null && facts.prClosedAtMs < endMs ? state : 'open';
}

function reworkedBeforeClose(facts: TaskFacts, firstReworkMs: ReadonlyMap<string, number>): boolean {
  return facts.prKey !== null && facts.prClosedAtMs !== null && (firstReworkMs.get(facts.prKey) ?? Infinity) < facts.prClosedAtMs;
}

function pullRequestNumbers(
  finished: readonly TaskFacts[],
  firstReworkMs: ReadonlyMap<string, number>,
  endMs: number,
): Pick<ScoreboardPeriod, 'pull_requests' | 'merged_clean' | 'time_to_merge_s' | 'first_review_s'> {
  const followed = finished.filter((facts) => facts.prFollowed);
  const states: Record<PullRequestState, number> = { merged: 0, closed: 0, open: 0, unread: 0 };
  for (const facts of followed) states[stateAt(facts, endMs)] += 1;
  const merged = followed.filter((facts) => stateAt(facts, endMs) === 'merged');
  const clean = merged.filter((facts) => facts.changesRequested === 0 && !reworkedBeforeClose(facts, firstReworkMs));
  return {
    pull_requests: states,
    merged_clean: { count: clean.length, total: merged.length },
    time_to_merge_s: durationSummary(merged.map((facts) => facts.timeToMergeS)),
    first_review_s: durationSummary(merged.map((facts) => facts.firstReviewS)),
  };
}

function openTooLong(all: readonly TaskFacts[], previousFrom: Date, now: Date): Flagged | null {
  const finishedBeforeMs = now.getTime() - OPEN_OVER_DAYS * MS_PER_DAY;
  const oldEnough = all.filter((facts) =>
    facts.prFollowed && facts.finishedAtMs >= previousFrom.getTime() && facts.finishedAtMs < finishedBeforeMs);
  if (oldEnough.length > 0 && oldEnough.every((facts) => readState(facts) === null)) return null;
  return flagged(oldEnough.filter((facts) => facts.prState === 'open'), 'oldest');
}

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
    time_to_verified_pr_s: durationSummary(verified.map((facts) => facts.leadTimeS)),
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
    guardrail_stops: flagged(finished.filter((facts) => facts.guardrailStop), 'newest'),
    blanket_approvals: flagged(finished.filter((facts) => facts.blanketApproval), 'newest'),
    gated: { count: codingRan.filter((facts) => facts.touchpoints.approve > 0).length, total: codingRan.length },
    ...pullRequestNumbers(finished, firstReworkMs, endMs),
  };
}

/**
 * Aggregate task records into the API response. `tasks` must hold every task of the caller that
 * finished at or after `coveredFrom` (default: the previous period's start).
 */
export function buildScoreboard(tasks: readonly ScoreboardTask[], range: ScoreboardRange, now: Date, coveredFrom?: Date): Scoreboard {
  const { from, previousFrom } = scoreboardWindows(range, now);
  const all = tasks
    .map((task) => taskFacts(task))
    .filter((facts): facts is TaskFacts => facts !== null && Number.isFinite(facts.finishedAtMs));
  const firstReworkMs = firstReworks(all);
  const truncated = coveredFrom !== undefined && coveredFrom.getTime() > from.getTime();
  const previousCovered = coveredFrom === undefined || coveredFrom.getTime() <= previousFrom.getTime();
  return {
    range,
    truncated,
    current: buildPeriod(all, firstReworkMs, truncated ? coveredFrom : from, now, Infinity),
    previous: previousCovered ? buildPeriod(all, firstReworkMs, previousFrom, from, from.getTime()) : null,
    open_over_7d: previousCovered ? openTooLong(all, previousFrom, now) : null,
  };
}

interface LineMetric {
  readonly name: string;
  readonly unit: 'Count' | 'Seconds' | 'None';
  readonly value: number | null;
}

interface MetricGroup {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly metrics: readonly LineMetric[];
}

interface LineContext {
  readonly user_id?: string;
  readonly repo?: string;
  readonly workflow?: string;
}

function metricLine(timestampMs: number, groups: readonly MetricGroup[], plainFields: Readonly<Record<string, unknown>>): string {
  // The EMF specification requires every declared metric to be a member of the line.
  const declared = groups
    .map(({ dimensions, metrics }) => ({ dimensions, metrics: metrics.filter((metric) => metric.value !== null) }))
    .filter(({ metrics }) => metrics.length > 0);
  return JSON.stringify({
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: declared.map(({ dimensions, metrics }) => ({
        Namespace: FACTORY_METRIC_NAMESPACE,
        // One DimensionSet each, the empty one for the metrics without dimensions: `[]` would declare no metric.
        Dimensions: [Object.keys(dimensions)],
        Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })),
      })),
    },
    ...Object.fromEntries(declared.flatMap(({ dimensions }) => Object.entries(dimensions))),
    ...Object.fromEntries(declared.flatMap(({ metrics }) => metrics.map(({ name, value }) => [name, value]))),
    ...plainFields,
  });
}

function taskIdentity(facts: TaskFacts, context: LineContext): Record<string, string | undefined> {
  return { task_id: facts.taskId, user_id: context.user_id, repo: context.repo, workflow: context.workflow };
}

/**
 * One EMF line for one finished task. The outcome and the kind of work are the only dimensions,
 * both closed sets; the identifiers and the workflow ride as plain fields, which create no
 * metric series.
 */
export function taskMetricLine(facts: TaskFacts, context: LineContext, nowMs: number): string {
  const untouched = isUntouchedVerifiedPr(facts) ? 1 : 0;
  // CloudWatch drops a timestamp more than two hours in the future.
  const timestampMs = Number.isFinite(facts.finishedAtMs) ? Math.min(facts.finishedAtMs, nowMs) : nowMs;
  const groups: readonly MetricGroup[] = [
    { dimensions: { [FACTORY_DIMENSIONS.outcome]: facts.outcome }, metrics: [{ name: FACTORY_METRICS.tasksFinished, unit: 'Count', value: 1 }] },
    {
      dimensions: { [FACTORY_DIMENSIONS.work]: facts.coding ? FACTORY_WORK.coding : FACTORY_WORK.other },
      metrics: [
        { name: FACTORY_METRICS.humanTouchpoints, unit: 'Count', value: touchpointTotal(facts) },
        { name: FACTORY_METRICS.costUsd, unit: 'None', value: facts.costUsd },
      ],
    },
    {
      dimensions: {},
      metrics: [
        { name: FACTORY_METRICS.guardrailStops, unit: 'Count', value: facts.guardrailStop ? 1 : 0 },
        { name: FACTORY_METRICS.blanketApprovals, unit: 'Count', value: facts.blanketApproval ? 1 : 0 },
        { name: FACTORY_METRICS.timeToVerifiedPr, unit: 'Seconds', value: facts.outcome === 'verified_pr' ? facts.leadTimeS : null },
        { name: FACTORY_METRICS.untouchedVerifiedPrs, unit: 'Count', value: facts.newWork ? untouched : null },
      ],
    },
  ];
  return metricLine(timestampMs, groups, { ...taskIdentity(facts, context), wait_s: facts.waitS ?? undefined });
}

/**
 * One EMF line for the final state of one followed pull request; null for facts without a
 * final state, or without a usable time for it. The state is the only dimension. The line is
 * stamped with GitHub's merge or close time, whatever its age: the caller answers for what
 * CloudWatch accepts.
 */
export function prOutcomeMetricLine(facts: TaskFacts, context: LineContext): string | null {
  if ((facts.prState !== 'merged' && facts.prState !== 'closed') || facts.prClosedAtMs === null) return null;
  const groups: readonly MetricGroup[] = [
    { dimensions: { [FACTORY_DIMENSIONS.prOutcome]: facts.prState }, metrics: [{ name: FACTORY_METRICS.pullRequestsResolved, unit: 'Count', value: 1 }] },
    { dimensions: {}, metrics: [{ name: FACTORY_METRICS.timeToMerge, unit: 'Seconds', value: facts.timeToMergeS }] },
  ];
  return metricLine(facts.prClosedAtMs, groups, taskIdentity(facts, context));
}
