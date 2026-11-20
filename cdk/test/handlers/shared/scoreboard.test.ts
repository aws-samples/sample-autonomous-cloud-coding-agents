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

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

import { ACTIVE_STATUSES, PRE_ACTIVE_STATUSES, TaskStatus } from '../../../src/constructs/task-status';
import { type BlockerKind, formatBlockerReason } from '../../../src/handlers/shared/error-classifier';
import { INTEGRATION_NODE_SUFFIX } from '../../../src/handlers/shared/orchestration-integration-node';
import {
  FACTORY_DIMENSIONS,
  FACTORY_METRIC_NAMESPACE,
  FACTORY_METRICS,
  FACTORY_WORK,
  SCOREBOARD_TASK_FIELDS,
  buildScoreboard,
  parseScoreboardRange,
  scoreboardWindows,
  taskFacts,
  taskMetricLine,
  type ScoreboardTask,
  type TaskFacts,
} from '../../../src/handlers/shared/scoreboard';
import {
  APPROVAL_GATE_CAP_MAX,
  MAX_BUDGET_USD_MAX,
  type ScoreboardPeriod,
  type TaskRecord,
  type TouchpointKind,
} from '../../../src/handlers/shared/types';
import { CODING_WORKFLOW_ID } from '../../../src/handlers/shared/workflows';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const PR_ITERATION = 'coding/pr-iteration-v1';
const PR_REVIEW = 'coding/pr-review-v1';
const RESTACK = 'coding/restack-v1';
const RESEARCH = 'knowledge/web-research-v1';

/** The pin and the raw ref of a task that runs workflow `id`. */
const runs = (id: string): Pick<TaskRecord, 'resolved_workflow' | 'workflow_ref'> =>
  ({ resolved_workflow: { id, version: '1.0.0' }, workflow_ref: id });

const pullRequest = (number: number): string => `https://github.com/Owner/Repo/pull/${number}`;

/** ISO time `days` days and `seconds` seconds before NOW, in the platform's millisecond form. */
const before = (days: number, seconds = 0): string =>
  new Date(NOW.getTime() - days * DAY_MS - seconds * 1000).toISOString();

/**
 * A whole task record of new work that ended in a verified pull request, with the stamps
 * as their writers leave them: the platform's with milliseconds, the agent's in whole seconds.
 */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: 'task-1',
    user_id: 'user-1',
    status: TaskStatus.COMPLETED,
    repo: 'Owner/Repo',
    ...runs(CODING_WORKFLOW_ID),
    task_description: 'Add a retry to the uploader.',
    branch_name: 'bgagent/task-1/add-a-retry',
    channel_source: 'api',
    status_created_at: 'COMPLETED#2026-11-18T10:24:00Z',
    created_at: '2026-11-18T10:00:00.000Z',
    started_at: '2026-11-18T10:00:41.000Z',
    completed_at: '2026-11-18T10:24:00Z',
    updated_at: '2026-11-18T10:24:00Z',
    pr_url: pullRequest(12),
    build_passed: true,
    lint_passed: true,
    cost_usd: '3.87',
    duration_s: '1399.0',
    turns_attempted: '31',
    approval_gate_count: 0,
    approval_gate_cap: 50,
    ...overrides,
  };
}

/** A follow-up on pull request 12: the record names the pull request from the start. */
const iteration = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  task({ ...runs(PR_ITERATION), pr_number: 12, code_changed: true, ...overrides });

/** What the orchestrator throws when a guardrail blocks the content of a task while it is prepared. */
const GUARDRAIL_BLOCKED = 'Guardrail blocked: Task description blocked by content policy: PROMPT_ATTACK';

/** A hundred times the largest budget a task can be given: beyond it, a recorded cost is not believed. */
const LARGEST_COST_USD = 100 * MAX_BUDGET_USD_MAX;

const NO_PULL_REQUEST = { pr_url: undefined, build_passed: undefined };
/** What a task leaves when no agent session ever wrote to it. */
const NEVER_RAN = { ...NO_PULL_REQUEST, started_at: undefined, cost_usd: undefined };

/** The facts of `task()`. */
const VERIFIED: TaskFacts = {
  taskId: 'task-1',
  finishedAtMs: Date.parse('2026-11-18T10:24:00.000Z'),
  outcome: 'verified_pr',
  newWork: true,
  coding: true,
  ran: true,
  queued: false,
  leadTimeS: 1440,
  waitS: 41,
  costUsd: 3.87,
  touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 },
  guardrailStop: false,
  blanketApproval: false,
  prKey: 'owner/repo#12',
  reworks: false,
};
const facts = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({ ...VERIFIED, ...overrides });
const touchpoints = (counts: Partial<Record<TouchpointKind, number>>): TaskFacts['touchpoints'] =>
  ({ ...VERIFIED.touchpoints, ...counts });

/** What the API read returns for a record: the projected fields and nothing else. */
function projected(record: TaskRecord): ScoreboardTask {
  return Object.fromEntries(
    SCOREBOARD_TASK_FIELDS.filter((field) => field in record).map((field) => [field, record[field]]),
  ) as ScoreboardTask;
}

const SHAPES: readonly (readonly [string, TaskRecord, TaskFacts])[] = [
  ['a verified pull request', task(), VERIFIED],
  ['a pull request on a build that was already failing', task({ build_passed: false }), facts({ outcome: 'unverified_pr' })],
  ['a pull request whose build command could not run', task({ build_passed: undefined }), facts({ outcome: 'unverified_pr' })],
  ['a verdict that is not a boolean', task({ build_passed: 'true' as unknown as boolean }), facts({ outcome: 'unverified_pr' })],
  [
    'a change that broke a passing build',
    task({ status: TaskStatus.FAILED, build_passed: false, error_message: "Task did not succeed (agent_status='success', build_ok=False)" }),
    facts({ outcome: 'failed', prKey: null }),
  ],
  [
    'a clarify hold',
    task({ ...NO_PULL_REQUEST, code_changed: false, answer_text: 'Which environment should this deploy to?' }),
    facts({ outcome: 'no_new_pr', touchpoints: touchpoints({ clarify: 1 }), prKey: null }),
  ],
  ['new work that completed without a pull request', task(NO_PULL_REQUEST), facts({ outcome: 'no_new_pr', prKey: null })],
  [
    'a follow-up that changed the code',
    iteration(),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true }),
  ],
  [
    'a follow-up that only answered',
    iteration({ code_changed: false, answer_text: 'It retries three times.' }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), prKey: null }),
  ],
  [
    'a follow-up that left no comparison of commits',
    iteration({ code_changed: undefined }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true }),
  ],
  [
    'a follow-up that failed',
    iteration({ status: TaskStatus.FAILED, code_changed: undefined, error_message: 'Agent session lost: no heartbeat for 300s' }),
    facts({ outcome: 'failed', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true }),
  ],
  [
    'a follow-up on a pull request the record does not name',
    iteration({ pr_number: undefined, pr_url: undefined }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), prKey: null }),
  ],
  [
    'a review',
    task({ ...runs(PR_REVIEW), pr_number: 12, code_changed: false, answer_text: 'Two findings, both minor.' }),
    facts({ outcome: 'no_new_pr', newWork: false, coding: false, prKey: null }),
  ],
  [
    'a restack',
    task({ ...runs(RESTACK), pr_number: 12, code_changed: true }),
    facts({ outcome: 'no_new_pr', newWork: false, prKey: null }),
  ],
  [
    'repo-less work',
    task({ ...runs(RESEARCH), ...NO_PULL_REQUEST, repo: undefined }),
    facts({ outcome: 'no_new_pr', newWork: false, coding: false, prKey: null }),
  ],
  [
    'an integration node',
    task({ channel_source: 'linear', channel_metadata: { orchestration_sub_issue_id: `orch-1${INTEGRATION_NODE_SUFFIX}` } }),
    facts({ outcome: 'no_new_pr', newWork: false, prKey: null }),
  ],
  [
    'a sub-issue of an orchestration',
    task({ channel_source: 'linear', channel_metadata: { orchestration_sub_issue_id: 'sub-issue-7' } }),
    VERIFIED,
  ],
  [
    'a task a person cancelled',
    task({ status: TaskStatus.CANCELLED, ...NO_PULL_REQUEST, cost_usd: undefined }),
    facts({ outcome: 'cancelled', costUsd: null, touchpoints: touchpoints({ cancel: 1 }), prKey: null }),
  ],
  [
    'an upload window that expired',
    task({ status: TaskStatus.CANCELLED, ...NEVER_RAN, error_message: 'Upload window expired (30 minutes). Please re-submit the task.' }),
    facts({ outcome: 'cancelled', ran: false, waitS: null, costUsd: null, prKey: null }),
  ],
  [
    'a task that ran out of time',
    task({ status: TaskStatus.TIMED_OUT, ...NO_PULL_REQUEST, cost_usd: undefined, error_message: 'Orchestrator poll timeout exceeded' }),
    facts({ outcome: 'timed_out', costUsd: null, prKey: null }),
  ],
  [
    'content blocked by a guardrail',
    task({ status: TaskStatus.FAILED, ...NEVER_RAN, error_message: `Hydration failed: Error: ${GUARDRAIL_BLOCKED}` }),
    facts({ outcome: 'failed', ran: false, waitS: null, costUsd: null, guardrailStop: true, prKey: null }),
  ],
  ['a task started with blanket approval', task({ initial_approvals: ['all_session'] }), facts({ blanketApproval: true })],
  ['approvals granted in advance for some actions only', task({ initial_approvals: ['tool_type_session', 'bash_pattern:git push*'] }), VERIFIED],
  ['a task that asked for approval three times', task({ approval_gate_count: 3 }), facts({ touchpoints: touchpoints({ approve: 3 }) })],
  ['an approval count below zero', task({ approval_gate_count: -1 }), VERIFIED],
  ['an approval count below one', task({ approval_gate_count: 0.5 }), VERIFIED],
  ['an approval count that is not whole', task({ approval_gate_count: 2.7 }), facts({ touchpoints: touchpoints({ approve: 2 }) })],
  [
    'an approval count above what a task can ask for',
    task({ approval_gate_count: 1e12 }),
    facts({ touchpoints: touchpoints({ approve: APPROVAL_GATE_CAP_MAX }) }),
  ],
  [
    'numbers stored as strings',
    task({ cost_usd: '0.5', approval_gate_count: '2' as unknown as number }),
    facts({ costUsd: 0.5, touchpoints: touchpoints({ approve: 2 }) }),
  ],
  ['a cost stored as a number', task({ cost_usd: 1.25 }), facts({ costUsd: 1.25 })],
  ['a cost of zero', task({ cost_usd: '0' }), facts({ costUsd: 0 })],
  ['a negative cost', task({ cost_usd: '-1' }), facts({ costUsd: null })],
  ['a cost that is not a number', task({ cost_usd: 'NaN' }), facts({ costUsd: null })],
  ['the largest cost that is taken for one', task({ cost_usd: String(LARGEST_COST_USD) }), facts({ costUsd: LARGEST_COST_USD })],
  ['a cost a cent above it', task({ cost_usd: String(LARGEST_COST_USD + 0.01) }), facts({ costUsd: null })],
  ['a cost no task can have', task({ cost_usd: '1e15' }), facts({ costUsd: null })],
  [
    // 1440.7 seconds to the finish and 40.2 to the start: one rounds up, the other down.
    'millisecond stamps at both ends',
    task({ created_at: '2026-11-18T10:00:00.200Z', started_at: '2026-11-18T10:00:40.400Z', completed_at: '2026-11-18T10:24:00.900Z' }),
    facts({ finishedAtMs: Date.parse('2026-11-18T10:24:00.900Z'), leadTimeS: 1441, waitS: 40 }),
  ],
  ['whole-second stamps at both ends', task({ created_at: '2026-11-18T10:00:00Z', started_at: '2026-11-18T10:00:41Z' }), VERIFIED],
  ['a session that started at once', task({ started_at: '2026-11-18T10:00:00.000Z' }), facts({ waitS: 0 })],
  ['no started_at', task({ started_at: undefined }), facts({ ran: false, waitS: null })],
  [
    'a task cancelled while it waited in the queue',
    task({ status: TaskStatus.CANCELLED, ...NEVER_RAN, queued_at: '2026-11-18T10:00:01.000Z' }),
    facts({ outcome: 'cancelled', ran: false, queued: true, waitS: null, costUsd: null, touchpoints: touchpoints({ cancel: 1 }), prKey: null }),
  ],
  [
    'a session that never started',
    task({ status: TaskStatus.FAILED, ...NEVER_RAN, error_message: 'Session start failed: ThrottlingException: Rate exceeded' }),
    facts({ outcome: 'failed', ran: false, waitS: null, costUsd: null, prKey: null }),
  ],
  ['a pull request URL that names no number', task({ pr_url: 'https://github.com/Owner/Repo/tree/bgagent/task-1' }), facts({ prKey: null })],
  ['a pull request URL of white space', task({ pr_url: '  ' }), facts({ outcome: 'no_new_pr', prKey: null })],
  ['a pull request URL that is not text', task({ pr_url: 12 as unknown as string }), facts({ outcome: 'no_new_pr', prKey: null })],
  ['a pull request without a repository', task({ repo: undefined }), facts({ prKey: null })],
  [
    'no completed_at',
    task({ completed_at: undefined, updated_at: '2026-11-18T11:00:00.000Z' }),
    facts({ finishedAtMs: Date.parse('2026-11-18T11:00:00.000Z'), leadTimeS: 3600 }),
  ],
  [
    'a completed_at that is not a time',
    task({ completed_at: 'soon', updated_at: '2026-11-18T11:00:00.000Z' }),
    facts({ finishedAtMs: Date.parse('2026-11-18T11:00:00.000Z'), leadTimeS: 3600 }),
  ],
  ['no finish time at all', task({ completed_at: undefined, updated_at: undefined }), facts({ finishedAtMs: NaN, leadTimeS: null })],
  ['no created_at', task({ created_at: undefined }), facts({ leadTimeS: null, waitS: null })],
  ['a creation time after the finish', task({ created_at: '2026-11-18T10:30:00.000Z' }), facts({ leadTimeS: null, waitS: null })],
  ['a record without the workflow pin', task({ resolved_workflow: undefined, workflow_ref: `${CODING_WORKFLOW_ID}@1.0.0` }), VERIFIED],
];

describe('taskFacts', () => {
  test.each(SHAPES)('%s', (_shape, record, expected) => {
    expect(taskFacts(record)).toEqual(expected);
  });

  test.each([...PRE_ACTIVE_STATUSES, ...ACTIVE_STATUSES])('has nothing to say about a %s task', (status) => {
    expect(taskFacts(task({ status }))).toBeNull();
  });

  // A blocker is what the agent read in the output of a tool, not the act of a control: a
  // host name that did not resolve reads as a denied connection.
  test.each<BlockerKind>([
    'egress_denied', 'missing_secret', 'dependency_unreachable', 'policy_fail_closed', 'auth_failure', 'unknown_environmental',
  ])('a task the agent reports as blocked by %s is not a guardrail stop', (kind) => {
    const message = formatBlockerReason(kind, 'the agent could not go on', 'registry.example.com');
    expect(taskFacts(task({ status: TaskStatus.FAILED, error_message: message }))?.guardrailStop).toBe(false);
  });

  test('a guardrail stop is a task that failed: the same message on another status is not one', () => {
    const stops = [TaskStatus.FAILED, TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT]
      .map((status) => taskFacts(task({ status, error_message: GUARDRAIL_BLOCKED }))?.guardrailStop);
    expect(stops).toEqual([true, false, false, false]);
  });

  // Only the first 1,000 characters of a message are classified. The words that make a
  // guardrail stop are "Guardrail blocked".
  test.each([
    ['end with the 1,000th character', 1000, true],
    ['end one character later', 1001, false],
    ['start after the 1,000th character', 1000 + 'Guardrail blocked'.length, false],
  ])('a message whose words of a guardrail stop %s is a guardrail stop: %s', (_where, end, expected) => {
    const message = `${'x'.repeat(end - 'Guardrail blocked'.length)}${GUARDRAIL_BLOCKED}`;
    expect(taskFacts(task({ status: TaskStatus.FAILED, error_message: message }))?.guardrailStop).toBe(expected);
  });

  test('says so when a recorded cost is not a number, and counts the task as having none', () => {
    expect(taskFacts(task({ cost_usd: 'Infinity' }))?.costUsd).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ field: 'cost_usd', task_id: 'task-1', raw: 'Infinity' }),
    );
  });

  test.each([
    [TaskStatus.COMPLETED, 'no_new_pr', 0],
    [TaskStatus.FAILED, 'failed', 0],
    // No message on a cancelled record reads as a cancel by a person.
    [TaskStatus.CANCELLED, 'cancelled', 1],
    [TaskStatus.TIMED_OUT, 'timed_out', 0],
  ] as const)('a %s record that holds nothing else still has facts', (status, outcome, cancel) => {
    const sparse = { task_id: 'sparse', status } as ScoreboardTask;
    expect(taskFacts(sparse)).toEqual({
      taskId: 'sparse',
      finishedAtMs: NaN,
      outcome,
      newWork: false,
      coding: false,
      ran: false,
      queued: false,
      leadTimeS: null,
      waitS: null,
      costUsd: null,
      touchpoints: touchpoints({ cancel }),
      guardrailStop: false,
      blanketApproval: false,
      prKey: null,
      reworks: false,
    });
  });

  test('reads a record whose every field has the wrong type without throwing', () => {
    const odd = {
      task_id: 'odd',
      status: TaskStatus.FAILED,
      repo: 42,
      resolved_workflow: CODING_WORKFLOW_ID,
      workflow_ref: 7,
      channel_metadata: 'linear',
      // As strings these two would parse as years.
      created_at: 2025,
      updated_at: 2026,
      queued_at: 1,
      started_at: true,
      completed_at: null,
      pr_url: 12,
      pr_number: '12',
      build_passed: 'true',
      code_changed: 'false',
      answer_text: 9,
      cost_usd: {},
      error_message: 404,
      approval_gate_count: 'many',
      initial_approvals: 'all_session',
    } as unknown as ScoreboardTask;
    // A field of the wrong type counts as a field that is absent.
    expect(taskFacts(odd)).toEqual(taskFacts({ task_id: 'odd', status: TaskStatus.FAILED } as ScoreboardTask));
  });
});

describe('SCOREBOARD_TASK_FIELDS', () => {
  /** For each projected field, a record whose facts depend on it. */
  const COUNTS_ON: Record<(typeof SCOREBOARD_TASK_FIELDS)[number], TaskRecord> = {
    task_id: task(),
    status: task(),
    repo: task(),
    resolved_workflow: task({ workflow_ref: undefined }),
    workflow_ref: task({ resolved_workflow: undefined }),
    channel_metadata: task({ channel_metadata: { orchestration_sub_issue_id: `orch-1${INTEGRATION_NODE_SUFFIX}` } }),
    created_at: task(),
    updated_at: task({ completed_at: undefined }),
    queued_at: task({ queued_at: '2026-11-18T10:00:01.000Z' }),
    started_at: task(),
    completed_at: task({ updated_at: '2026-11-18T11:00:00.000Z' }),
    pr_url: task(),
    pr_number: iteration({ pr_url: undefined }),
    build_passed: task(),
    code_changed: iteration({ code_changed: false }),
    answer_text: task({ ...NO_PULL_REQUEST, code_changed: false, answer_text: 'Which environment?' }),
    cost_usd: task(),
    error_message: task({ status: TaskStatus.CANCELLED, error_message: 'Upload window expired (30 minutes).' }),
    approval_gate_count: task({ approval_gate_count: 2 }),
    initial_approvals: task({ initial_approvals: ['all_session'] }),
  };

  test.each(SCOREBOARD_TASK_FIELDS)('%s is read: a record without it counts differently', (field) => {
    const without = { ...COUNTS_ON[field], [field]: undefined } as ScoreboardTask;
    expect(taskFacts(without)).not.toEqual(taskFacts(COUNTS_ON[field]));
  });

  // The stream step sees the whole record and the API read only the projection: a field read
  // outside the list would make the two count one task differently.
  test.each(SHAPES)('%s counts the same when only the projected fields are read', (_shape, record) => {
    expect(taskFacts(projected(record))).toEqual(taskFacts(record));
  });
});

describe('scoreboardWindows', () => {
  test.each([
    ['7d', '2026-11-12T12:00:00.000Z', '2026-11-05T12:00:00.000Z'],
    ['30d', '2026-10-20T12:00:00.000Z', '2026-09-20T12:00:00.000Z'],
  ] as const)('%s goes back that many days of 24 hours, and as many again for the period before', (range, from, previousFrom) => {
    const windows = scoreboardWindows(range, NOW);
    expect(windows.from.toISOString()).toBe(from);
    expect(windows.previousFrom.toISOString()).toBe(previousFrom);
  });
});

describe('parseScoreboardRange', () => {
  test.each([
    [undefined, '30d'],
    ['7d', '7d'],
    ['30d', '30d'],
  ])('reads %s as %s', (value, range) => {
    expect(parseScoreboardRange(value)).toBe(range);
  });

  test.each(['', '90d', '7D', ' 7d', 'toString', 'constructor'])('refuses %j', (value) => {
    expect(parseScoreboardRange(value)).toBeNull();
  });
});

/** A verified pull request that finished `days` days before NOW, 24 minutes after it was created. */
function finished(id: string, days: number, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return task({
    task_id: id,
    created_at: before(days, 1440),
    started_at: before(days, 1399),
    completed_at: before(days),
    updated_at: before(days),
    ...overrides,
  });
}

/** A follow-up on pull request `number` that finished `days` days before NOW. */
const followUp = (id: string, days: number, number: number, overrides: Partial<TaskRecord> = {}): TaskRecord =>
  finished(id, days, { ...runs(PR_ITERATION), pr_number: number, pr_url: pullRequest(number), code_changed: true, ...overrides });

const emptyPeriod = (from: string, to: string): ScoreboardPeriod => ({
  from,
  to,
  finished: 0,
  outcomes: { verified_pr: 0, unverified_pr: 0, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 },
  time_to_verified_pr_s: null,
  wait_p50_s: null,
  queued: { count: 0, total: 0 },
  verified: { count: 0, total: 0 },
  not_reworked: { count: 0, total: 0 },
  untouched: { count: 0, total: 0 },
  touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 },
  spend_usd: 0,
  uncosted: 0,
  guardrail_stops: { count: 0, task_ids: [] },
  blanket_approvals: { count: 0, task_ids: [] },
  gated: { count: 0, total: 0 },
});

/**
 * One week of one user: every outcome, coding tasks that are not new work (two follow-ups, a
 * restack, an integration node) and two tasks that are not coding (a review, cancelled research).
 */
const WEEK: readonly TaskRecord[] = [
  finished('v1', 1, { pr_url: pullRequest(1), cost_usd: '2' }),
  finished('v2', 2, {
    pr_url: pullRequest(2),
    cost_usd: '4',
    approval_gate_count: 2,
    created_at: before(2, 3000),
    queued_at: before(2, 2990),
    started_at: before(2, 2100),
  }),
  finished('u1', 3, { pr_url: pullRequest(3), build_passed: false, cost_usd: '1.5' }),
  finished('h1', 3, { ...NO_PULL_REQUEST, code_changed: false, answer_text: 'Which environment should this deploy to?', cost_usd: '0.25' }),
  finished('f1', 4, {
    status: TaskStatus.FAILED,
    pr_url: pullRequest(4),
    build_passed: false,
    error_message: "Task did not succeed (agent_status='success', build_ok=False)",
    cost_usd: '3',
  }),
  followUp('i1', 1, 2, { cost_usd: '1' }),
  followUp('i2', 1, 1, { code_changed: false, answer_text: 'It retries three times.', cost_usd: '0.1' }),
  finished('rv1', 2, {
    ...runs(PR_REVIEW),
    pr_number: 9,
    pr_url: pullRequest(9),
    code_changed: false,
    answer_text: 'Two findings, both minor.',
    cost_usd: '0.5',
  }),
  finished('x1', 2, { status: TaskStatus.CANCELLED, ...runs(RESEARCH), ...NO_PULL_REQUEST, repo: undefined, cost_usd: undefined }),
  finished('c1', 5, { status: TaskStatus.CANCELLED, ...NO_PULL_REQUEST, cost_usd: undefined }),
  finished('q1', 5, {
    status: TaskStatus.FAILED,
    ...NEVER_RAN,
    queued_at: before(5, 1400),
    error_message: 'Admission queue timeout: task waited 7200s for a free concurrency slot (limit per user) without being admitted.',
  }),
  finished('t1', 5, { status: TaskStatus.TIMED_OUT, ...NO_PULL_REQUEST, cost_usd: undefined, error_message: 'Orchestrator poll timeout exceeded' }),
  finished('g1', 6, {
    status: TaskStatus.FAILED,
    ...NEVER_RAN,
    error_message: 'Hydration failed: Error: Guardrail blocked: Task description blocked by content policy: PROMPT_ATTACK',
  }),
  finished('b1', 6, {
    pr_url: pullRequest(5),
    cost_usd: '5',
    initial_approvals: ['all_session'],
    created_at: before(6, 600),
    started_at: before(6, 580),
  }),
  finished('n1', 4, {
    pr_url: pullRequest(6),
    cost_usd: '0.75',
    channel_source: 'linear',
    channel_metadata: { orchestration_sub_issue_id: `orch-1${INTEGRATION_NODE_SUFFIX}` },
  }),
  finished('s1', 4, { ...runs(RESTACK), pr_number: 7, pr_url: pullRequest(7), code_changed: true, cost_usd: '0.4' }),
];

/** How many tasks `buildScoreboard` puts in the current and in the previous period. */
function placed(tasks: readonly ScoreboardTask[], now = NOW): [current: number, previous: number | undefined] {
  const board = buildScoreboard(tasks, '7d', now);
  return [board.current.finished, board.previous?.finished];
}

describe('buildScoreboard', () => {
  test('counts each number of a period over its own population', () => {
    expect(buildScoreboard(WEEK, '7d', NOW)).toEqual({
      range: '7d',
      truncated: false,
      current: {
        from: '2026-11-12T12:00:00.000Z',
        to: '2026-11-19T12:00:00.000Z',
        finished: 16,
        outcomes: { verified_pr: 3, unverified_pr: 1, no_new_pr: 6, failed: 3, cancelled: 2, timed_out: 1 },
        // v1, v2 and b1.
        time_to_verified_pr_s: { p50: 1440, p90: 3000, count: 3 },
        wait_p50_s: 41,
        // v2 and q1 waited; g1 neither waited nor ran.
        queued: { count: 2, total: 15 },
        // Of the ten tasks that asked for a new pull request: the integration node n1 is not one.
        verified: { count: 3, total: 10 },
        // The pull requests of v1, v2, u1 and b1: i1 changed v2's, i2 only answered on v1's, f1 failed.
        not_reworked: { count: 3, total: 4 },
        // v2 stopped for approvals.
        untouched: { count: 2, total: 10 },
        // Coding tasks only: the cancel of the research task x1 is not here.
        touchpoints: { approve: 2, clarify: 1, follow_up: 2, cancel: 1 },
        // Coding tasks of every outcome: the review rv1 (0.5) is not here.
        spend_usd: 18,
        // c1 and t1 ran and recorded nothing; q1 and g1 never ran.
        uncosted: 2,
        guardrail_stops: { count: 1, task_ids: ['g1'] },
        blanket_approvals: { count: 1, task_ids: ['b1'] },
        gated: { count: 1, total: 12 },
      },
      previous: emptyPeriod('2026-11-05T12:00:00.000Z', '2026-11-12T12:00:00.000Z'),
    });
  });

  test('counts the trust flags and the queue over every finished task, whatever its work', () => {
    const board = buildScoreboard([
      // A review that waited in line and started with blanket approval.
      finished('rv', 1, {
        ...runs(PR_REVIEW),
        pr_number: 9,
        pr_url: pullRequest(9),
        code_changed: false,
        queued_at: before(1, 1430),
        initial_approvals: ['all_session'],
      }),
      // Research stopped by a guardrail before it started.
      finished('rs', 2, {
        status: TaskStatus.FAILED,
        ...runs(RESEARCH),
        ...NEVER_RAN,
        repo: undefined,
        error_message: `Hydration failed: Error: ${GUARDRAIL_BLOCKED}`,
      }),
    ], '7d', NOW);

    expect(board.current).toMatchObject({
      queued: { count: 1, total: 1 },
      guardrail_stops: { count: 1, task_ids: ['rs'] },
      blanket_approvals: { count: 1, task_ids: ['rv'] },
    });
  });

  test('adds up the spend of a period to the micro-dollar', () => {
    const costs = ['0.1', '0.2', '0.0000004', '0.0000004'];
    const tasks = costs.map((cost, index) => finished(`v${index}`, 1, { pr_url: pullRequest(index + 1), cost_usd: cost }));

    // As floats 0.1 + 0.2 is 0.30000000000000004, and the two small amounts add up to most of a micro-dollar.
    expect(buildScoreboard(tasks, '7d', NOW).current.spend_usd).toBe(0.300001);
  });

  test('keeps a denominator of zero where a period has no task of that population', () => {
    const review = finished('rv1', 1, { ...runs(PR_REVIEW), pr_number: 9, pr_url: pullRequest(9), code_changed: false, cost_usd: '0.5' });

    expect(buildScoreboard([review], '7d', NOW).current).toEqual({
      ...emptyPeriod('2026-11-12T12:00:00.000Z', '2026-11-19T12:00:00.000Z'),
      finished: 1,
      outcomes: { verified_pr: 0, unverified_pr: 0, no_new_pr: 1, failed: 0, cancelled: 0, timed_out: 0 },
      queued: { count: 0, total: 1 },
    });
  });

  test('reports the period of equal length before the current one', () => {
    const board = buildScoreboard([
      finished('this-week', 1, { pr_url: pullRequest(1), cost_usd: '8' }),
      finished('last-week-1', 8, { pr_url: pullRequest(2), cost_usd: '1' }),
      finished('last-week-2', 13, { pr_url: pullRequest(3), build_passed: false, cost_usd: '2' }),
      finished('older', 15, { pr_url: pullRequest(4), cost_usd: '4' }),
    ], '7d', NOW);

    expect(board.previous).toEqual({
      ...emptyPeriod('2026-11-05T12:00:00.000Z', '2026-11-12T12:00:00.000Z'),
      finished: 2,
      outcomes: { verified_pr: 1, unverified_pr: 1, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 },
      time_to_verified_pr_s: { p50: 1440, p90: 1440, count: 1 },
      wait_p50_s: 41,
      queued: { count: 0, total: 2 },
      verified: { count: 1, total: 2 },
      not_reworked: { count: 2, total: 2 },
      untouched: { count: 1, total: 2 },
      spend_usd: 3,
      gated: { count: 0, total: 2 },
    });
    expect(board.current).toMatchObject({ finished: 1, spend_usd: 8 });
  });

  test.each([
    ['at the start of the current period', before(7), [1, 0]],
    ['a millisecond before the current period', before(7, 0.001), [0, 1]],
    ['at the start of the previous period', before(14), [0, 1]],
    ['a millisecond before the previous period', before(14, 0.001), [0, 0]],
    ['ahead of the clock', before(-0.5), [1, 0]],
  ])('a task that finished %s is placed by its instant', (_when, stamp, expected) => {
    expect(placed([finished('t', 0, { created_at: before(20), completed_at: stamp, updated_at: stamp })])).toEqual(expected);
  });

  test('compares instants, not the strings: a whole-second stamp half a second before the period is before it', () => {
    // As strings, "…T12:00:00Z" sorts after "…T12:00:00.500Z".
    const halfPast = new Date('2026-11-19T12:00:00.500Z');
    const stamp = '2026-11-12T12:00:00Z';
    expect(placed([finished('t', 0, { created_at: before(20), completed_at: stamp, updated_at: stamp })], halfPast)).toEqual([0, 1]);
  });

  test('leaves out a task that is not finished and one without a usable finish time', () => {
    expect(placed([
      finished('running', 1, { status: TaskStatus.RUNNING }),
      finished('timeless', 1, { completed_at: undefined, updated_at: undefined }),
    ])).toEqual([0, 0]);
  });

  test('takes the median and the 90th percentile by nearest rank', () => {
    const leadTimes = [700, 100, 1000, 400, 300, 900, 200, 600, 500, 800];
    const tasks = leadTimes.map((seconds, index) => finished(`v${index}`, 1, {
      pr_url: pullRequest(index + 1),
      created_at: before(1, seconds),
      started_at: before(1, seconds / 2),
    }));

    expect(buildScoreboard(tasks, '7d', NOW).current).toMatchObject({
      time_to_verified_pr_s: { p50: 500, p90: 900, count: 10 },
      wait_p50_s: 250,
    });
  });

  test('picks a value that occurred, the smallest with enough of the values at or below it', () => {
    const tasks = [60, 10, 50, 20, 40, 30].map((seconds, index) => finished(`v${index}`, 1, {
      pr_url: pullRequest(index + 1),
      created_at: before(1, seconds),
      started_at: before(1, seconds),
    }));

    // Half of six is the third value; nine tenths of six is 5.4, which only the sixth covers.
    expect(buildScoreboard(tasks, '7d', NOW).current.time_to_verified_pr_s).toEqual({ p50: 30, p90: 60, count: 6 });
  });

  test('measures the time to a verified pull request on verified pull requests with a creation time only', () => {
    const board = buildScoreboard([
      finished('v1', 1, { pr_url: pullRequest(1), created_at: before(1, 600), started_at: before(1, 590) }),
      finished('v2', 1, { pr_url: pullRequest(2), created_at: undefined }),
      finished('u1', 1, { pr_url: pullRequest(3), build_passed: false, created_at: before(1, 9000) }),
      finished('f1', 1, { status: TaskStatus.FAILED, pr_url: pullRequest(4), created_at: before(1, 9000) }),
    ], '7d', NOW);

    expect(board.current.time_to_verified_pr_s).toEqual({ p50: 600, p90: 600, count: 1 });
    expect(board.current.wait_p50_s).toBe(10);
    expect(board.current.verified).toEqual({ count: 2, total: 4 });
  });

  describe('not reworked', () => {
    test('judges each period with the follow-ups that finished before its end', () => {
      const board = buildScoreboard([
        finished('p1', 10, { pr_url: pullRequest(20) }),
        finished('p2', 9, { pr_url: pullRequest(21) }),
        followUp('r1', 8, 20),
        // After the previous period's end: it does not count against that period.
        followUp('r2', 2, 21),
        finished('c1', 3, { pr_url: pullRequest(22) }),
        finished('c2', 3, { pr_url: pullRequest(23) }),
        followUp('r3', 1, 22),
      ], '7d', NOW);

      expect(board.previous?.not_reworked).toEqual({ count: 1, total: 2 });
      expect(board.current.not_reworked).toEqual({ count: 1, total: 2 });
    });

    test.each([
      ['first', ['early', 'late']],
      ['last', ['late', 'early']],
    ])('goes by the earliest follow-up of a pull request, whether it comes %s', (_position, order) => {
      const followUps = { early: followUp('early', 8, 20), late: followUp('late', 1, 20) };
      const board = buildScoreboard([
        ...order.map((id) => followUps[id as keyof typeof followUps]),
        finished('p1', 10, { pr_url: pullRequest(20) }),
      ], '7d', NOW);

      expect(board.previous?.not_reworked).toEqual({ count: 0, total: 1 });
    });

    test('gives a follow-up that finished at the very end of a period to the next one', () => {
      const board = buildScoreboard([
        finished('p1', 10, { pr_url: pullRequest(20) }),
        followUp('on-the-line', 7, 20),
      ], '7d', NOW);

      expect(board.previous?.not_reworked).toEqual({ count: 1, total: 1 });
      expect(board.current.touchpoints.follow_up).toBe(1);
    });

    test('is not misled by a follow-up without a usable finish time', () => {
      const board = buildScoreboard([
        finished('opened', 3, { pr_url: pullRequest(1) }),
        followUp('changed', 2, 1),
        followUp('timeless', 2, 1, { completed_at: undefined, updated_at: undefined }),
      ], '7d', NOW);

      expect(board.current.not_reworked).toEqual({ count: 0, total: 1 });
    });

    test('counts a follow-up as rework unless it is known to have changed nothing', () => {
      const board = buildScoreboard([
        finished('answered', 3, { pr_url: pullRequest(1) }),
        followUp('a', 2, 1, { code_changed: false, answer_text: 'It retries three times.' }),
        finished('changed', 3, { pr_url: pullRequest(2) }),
        followUp('b', 2, 2, { code_changed: true }),
        finished('cancelled', 3, { pr_url: pullRequest(3) }),
        followUp('c', 2, 3, { status: TaskStatus.CANCELLED, code_changed: undefined }),
        finished('restacked', 3, { pr_url: pullRequest(4) }),
        finished('d', 2, { ...runs(RESTACK), pr_number: 4, pr_url: pullRequest(4), code_changed: true }),
      ], '7d', NOW);

      expect(board.current.not_reworked).toEqual({ count: 2, total: 4 });
    });

    test('leaves a pull request without a key out of both numbers, and counts a pull request once', () => {
      const board = buildScoreboard([
        finished('keyed', 3, { pr_url: pullRequest(1) }),
        finished('same-pull-request', 2, { pr_url: pullRequest(1) }),
        finished('unreadable', 3, { pr_url: 'https://github.com/Owner/Repo/tree/main' }),
        // A follow-up on a pull request that no task of this user opened.
        followUp('elsewhere', 2, 99),
      ], '7d', NOW);

      expect(board.current.not_reworked).toEqual({ count: 1, total: 1 });
      expect(board.current.verified).toEqual({ count: 3, total: 3 });
    });

    test('matches the repository of a follow-up whatever its letter case', () => {
      const board = buildScoreboard([
        finished('opened', 3, { repo: 'Owner/Repo', pr_url: pullRequest(1) }),
        followUp('changed', 2, 1, { repo: 'owner/repo' }),
      ], '7d', NOW);

      expect(board.current.not_reworked).toEqual({ count: 0, total: 1 });
    });
  });

  test('lists the newest ten tasks behind a count, newest first', () => {
    const order = [5, 11, 2, 8, 0, 9, 3, 7, 1, 10, 6, 4];
    const stopped = order.map((hours) => finished(`g${hours}`, hours / 24, {
      status: TaskStatus.FAILED,
      ...NEVER_RAN,
      error_message: GUARDRAIL_BLOCKED,
      initial_approvals: ['all_session'],
    }));

    const { guardrail_stops, blanket_approvals } = buildScoreboard(stopped, '7d', NOW).current;
    expect(guardrail_stops).toEqual({ count: 12, task_ids: ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'] });
    expect(blanket_approvals).toEqual(guardrail_stops);
  });

  describe('a read that was cut', () => {
    const tasks = [
      finished('day-1', 1, { pr_url: pullRequest(1) }),
      finished('day-4', 4, { pr_url: pullRequest(2) }),
      finished('day-6', 6, { pr_url: pullRequest(3) }),
      finished('day-9', 9, { pr_url: pullRequest(4) }),
    ];

    test.each([
      ['nothing is said about it', undefined],
      ['it reaches the start of the previous period', new Date(before(14))],
      ['it reaches further back', new Date(before(30))],
    ])('covers both periods when %s', (_when, coveredFrom) => {
      const board = buildScoreboard(tasks, '7d', NOW, coveredFrom);
      expect(board.truncated).toBe(false);
      expect([board.current.from, board.current.finished]).toEqual(['2026-11-12T12:00:00.000Z', 3]);
      expect([board.previous?.from, board.previous?.finished]).toEqual(['2026-11-05T12:00:00.000Z', 1]);
    });

    // The current period is whole: only the comparison is missing, and nothing is truncated.
    test.each([
      ['a millisecond into the previous period', new Date(before(14, -0.001))],
      ['in the middle of the previous period', new Date(before(10))],
      ['at the start of the current period', new Date(before(7))],
    ])('reports no previous period and a whole current one when the read stopped %s', (_where, coveredFrom) => {
      const board = buildScoreboard(tasks, '7d', NOW, coveredFrom);
      expect(board.truncated).toBe(false);
      expect(board.previous).toBeNull();
      expect([board.current.from, board.current.finished]).toEqual(['2026-11-12T12:00:00.000Z', 3]);
    });

    test.each([
      ['a millisecond into the current period', new Date(before(7, -0.001)), '2026-11-12T12:00:00.001Z', 3],
      ['in the middle of the current period', new Date(before(5)), '2026-11-14T12:00:00.000Z', 2],
    ])('starts the current period where the read stopped, %s, and ignores what finished before', (_where, coveredFrom, from, counted) => {
      const board = buildScoreboard(tasks, '7d', NOW, coveredFrom);
      expect(board.truncated).toBe(true);
      expect(board.previous).toBeNull();
      expect([board.current.from, board.current.to, board.current.finished]).toEqual([from, '2026-11-19T12:00:00.000Z', counted]);
      expect(board.current.verified).toEqual({ count: counted, total: counted });
    });
  });
});

interface MetricDirective {
  readonly Namespace: string;
  readonly Dimensions: readonly (readonly string[])[];
  readonly Metrics: readonly { readonly Name: string; readonly Unit: string }[];
}
interface MetricLine {
  readonly _aws: { readonly Timestamp: number; readonly CloudWatchMetrics: readonly MetricDirective[] };
  readonly [member: string]: unknown;
}

/** The line the stream step writes for a record, parsed back. */
function lineOf(record: TaskRecord, nowMs = NOW.getTime()): MetricLine {
  const recordFacts = taskFacts(record);
  if (recordFacts === null) throw new Error(`${record.task_id} is not finished`);
  const context = { user_id: record.user_id, repo: record.repo, workflow: record.resolved_workflow?.id };
  return JSON.parse(taskMetricLine(recordFacts, context, nowMs)) as MetricLine;
}

const declaredMetrics = (line: MetricLine): string[] =>
  line._aws.CloudWatchMetrics.flatMap((directive) => directive.Metrics.map((metric) => metric.Name));

describe('taskMetricLine', () => {
  test('writes one line of JSON: three directives, their members, then the plain fields', () => {
    const line = taskMetricLine(VERIFIED, { user_id: 'user-1', repo: 'Owner/Repo', workflow: CODING_WORKFLOW_ID }, NOW.getTime());

    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      _aws: {
        Timestamp: Date.parse('2026-11-18T10:24:00.000Z'),
        CloudWatchMetrics: [
          { Namespace: 'ABCA/Factory', Dimensions: [['Outcome']], Metrics: [{ Name: 'TasksFinished', Unit: 'Count' }] },
          {
            Namespace: 'ABCA/Factory',
            Dimensions: [['Work']],
            Metrics: [{ Name: 'HumanTouchpoints', Unit: 'Count' }, { Name: 'CostUsd', Unit: 'None' }],
          },
          {
            Namespace: 'ABCA/Factory',
            Dimensions: [[]],
            Metrics: [
              { Name: 'GuardrailStops', Unit: 'Count' },
              { Name: 'BlanketApprovals', Unit: 'Count' },
              { Name: 'TimeToVerifiedPrSeconds', Unit: 'Seconds' },
              { Name: 'UntouchedVerifiedPrs', Unit: 'Count' },
            ],
          },
        ],
      },
      Outcome: 'verified_pr',
      Work: 'coding',
      TasksFinished: 1,
      HumanTouchpoints: 0,
      CostUsd: 3.87,
      GuardrailStops: 0,
      BlanketApprovals: 0,
      TimeToVerifiedPrSeconds: 1440,
      UntouchedVerifiedPrs: 1,
      task_id: 'task-1',
      user_id: 'user-1',
      repo: 'Owner/Repo',
      workflow: 'coding/new-task-v1',
      wait_s: 41,
    });
  });

  // CloudWatch extracts a metric only when the directive that declares it finds a numeric
  // member of that name, and a number nobody declares is no metric.
  test.each(SHAPES)('%s: every declared metric is a number on the line, and every metric on the line is declared', (_shape, record) => {
    const line = lineOf(record);
    const declared = declaredMetrics(line);
    const numbers = Object.keys(line).filter((member) => typeof line[member] === 'number' && member !== 'wait_s');

    expect([...declared].sort()).toEqual(numbers.sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(line._aws.CloudWatchMetrics.map((directive) => directive.Metrics.length > 0)).not.toContain(false);
    expect(line._aws.CloudWatchMetrics.map((directive) => directive.Namespace)).toEqual(
      line._aws.CloudWatchMetrics.map(() => FACTORY_METRIC_NAMESPACE),
    );
  });

  test.each(SHAPES)('%s: the only dimensions are the outcome and the kind of work', (_shape, record) => {
    const line = lineOf(record);
    const expectedFacts = taskFacts(record);

    // The names and the values as CloudWatch stores them: a series is found by these strings.
    expect(line._aws.CloudWatchMetrics.map((directive) => directive.Dimensions)).toEqual([[['Outcome']], [['Work']], [[]]]);
    expect(line.Outcome).toBe(expectedFacts?.outcome);
    expect(line.Work).toBe(expectedFacts?.coding ? 'coding' : 'other');
  });

  test('leaves out the plain fields it was not given, and the wait of a task that never started', () => {
    const neverStarted = facts({ outcome: 'failed', ran: false, waitS: null, costUsd: null, prKey: null });
    const line = JSON.parse(taskMetricLine(neverStarted, {}, NOW.getTime())) as MetricLine;

    expect(Object.keys(line).sort()).toEqual([
      'BlanketApprovals', 'GuardrailStops', 'HumanTouchpoints', 'Outcome', 'TasksFinished', 'UntouchedVerifiedPrs', 'Work', '_aws', 'task_id',
    ]);
  });

  test('sums the touchpoints of every kind into one metric', () => {
    const line = lineOf(iteration({ status: TaskStatus.CANCELLED, approval_gate_count: 3, code_changed: undefined, cost_usd: undefined }));
    // Three approval requests, one follow-up and one cancel by a person.
    expect(line.HumanTouchpoints).toBe(5);
  });

  test.each([
    ['a recorded cost', task({ cost_usd: '0.5' }), 0.5],
    ['a recorded cost of zero', task({ cost_usd: '0' }), 0],
    ['no recorded cost', task({ cost_usd: undefined }), undefined],
    ['a negative cost', task({ cost_usd: '-1' }), undefined],
  ])('CostUsd with %s', (_what, record, expected) => {
    const line = lineOf(record);
    expect(line.CostUsd).toBe(expected);
    expect(declaredMetrics(line).includes('CostUsd')).toBe(expected !== undefined);
  });

  test.each([
    ['a verified pull request', task(), 1440],
    ['a verified pull request without a creation time', task({ created_at: undefined }), undefined],
    ['a pull request without a passed build', task({ build_passed: false }), undefined],
    ['a failed task', task({ status: TaskStatus.FAILED }), undefined],
    ['a follow-up', iteration(), undefined],
  ])('TimeToVerifiedPrSeconds on %s', (_what, record, expected) => {
    const line = lineOf(record);
    expect(line.TimeToVerifiedPrSeconds).toBe(expected);
    expect(declaredMetrics(line).includes('TimeToVerifiedPrSeconds')).toBe(expected !== undefined);
  });

  test.each([
    ['a verified pull request with no stop for a person', task(), 1],
    ['a verified pull request that stopped for an approval', task({ approval_gate_count: 1 }), 0],
    ['a pull request without a passed build', task({ build_passed: false }), 0],
    ['new work that failed', task({ status: TaskStatus.FAILED, ...NO_PULL_REQUEST }), 0],
    ['a follow-up', iteration(), undefined],
    ['an integration node', task({ channel_metadata: { orchestration_sub_issue_id: `orch-1${INTEGRATION_NODE_SUFFIX}` } }), undefined],
    ['a review', task({ ...runs(PR_REVIEW), pr_number: 12 }), undefined],
  ])('UntouchedVerifiedPrs on %s', (_what, record, expected) => {
    const line = lineOf(record);
    expect(line.UntouchedVerifiedPrs).toBe(expected);
    expect(declaredMetrics(line).includes('UntouchedVerifiedPrs')).toBe(expected !== undefined);
  });

  test('flags a guardrail stop and a blanket approval as 1', () => {
    const line = lineOf(task({ status: TaskStatus.FAILED, error_message: GUARDRAIL_BLOCKED, initial_approvals: ['all_session'] }));
    expect(line).toMatchObject({ GuardrailStops: 1, BlanketApprovals: 1 });
  });

  test.each([
    ['the finish time of the task', task(), Date.parse('2026-11-18T10:24:00.000Z')],
    ['the given time when the record has no finish time', task({ completed_at: undefined, updated_at: undefined }), NOW.getTime()],
    // CloudWatch drops a line stamped more than two hours ahead of its clock.
    ['the given time when the finish time is ahead of it', task({ completed_at: before(-1), updated_at: before(-1) }), NOW.getTime()],
  ])('is stamped with %s', (_what, record, expected) => {
    expect(lineOf(record)._aws.Timestamp).toBe(expected);
  });
});

describe('the metric lines and the scoreboard agree', () => {
  const lines = WEEK.map((record) => lineOf(record));
  const { current } = buildScoreboard(WEEK, '7d', NOW);

  /** Sum of a metric over the lines whose dimension has that value, as a CloudWatch `Sum` adds them. */
  const sum = (metric: string, dimension: string, value: string): number =>
    lines.filter((line) => line[dimension] === value).reduce((total, line) => total + ((line[metric] as number | undefined) ?? 0), 0);
  /** The series the dashboard reads: a metric of one kind of work, and the tasks finished with one outcome. */
  const ofWork = (metric: string, work: string): number => sum(metric, FACTORY_DIMENSIONS.work, work);
  const finishedAs = (outcome: string): number => sum(FACTORY_METRICS.tasksFinished, FACTORY_DIMENSIONS.outcome, outcome);
  /** Every value of a metric that has no dimension. */
  const values = (metric: string): number[] => lines.map((line) => line[metric]).filter((value) => typeof value === 'number');

  test('the fixture is not trivial: it has a verified pull request, spend and touchpoints outside coding work', () => {
    expect(current.outcomes.verified_pr).toBeGreaterThan(0);
    expect(ofWork(FACTORY_METRICS.costUsd, FACTORY_WORK.other)).toBeGreaterThan(0);
    expect(ofWork(FACTORY_METRICS.humanTouchpoints, FACTORY_WORK.other)).toBeGreaterThan(0);
  });

  test('tasks finished, by outcome', () => {
    const byOutcome = Object.fromEntries(Object.keys(current.outcomes).map((outcome) => [outcome, finishedAs(outcome)]));
    expect(byOutcome).toEqual(current.outcomes);
  });

  test('spend per verified pull request', () => {
    expect(ofWork(FACTORY_METRICS.costUsd, FACTORY_WORK.coding) / finishedAs('verified_pr'))
      .toBeCloseTo(current.spend_usd / current.outcomes.verified_pr, 10);
  });

  test('human touchpoints per verified pull request', () => {
    const touchpointsInAll = Object.values(current.touchpoints).reduce((total, count) => total + count, 0);
    expect(ofWork(FACTORY_METRICS.humanTouchpoints, FACTORY_WORK.coding) / finishedAs('verified_pr'))
      .toBe(touchpointsInAll / current.outcomes.verified_pr);
  });

  test('verified pull requests with no stop for a person, as the average of the metric', () => {
    const untouched = values(FACTORY_METRICS.untouchedVerifiedPrs);
    const average = untouched.reduce((total, value) => total + value, 0) / untouched.length;
    expect(average).toBe(current.untouched.count / current.untouched.total);
  });

  test('time to verified pull request, over the same pull requests', () => {
    const leadTimes = values(FACTORY_METRICS.timeToVerifiedPr).sort((a, b) => a - b);
    expect(leadTimes).toHaveLength(current.time_to_verified_pr_s?.count ?? 0);
    expect(leadTimes[Math.ceil(leadTimes.length / 2) - 1]).toBe(current.time_to_verified_pr_s?.p50);
  });

  test('guardrail stops and blanket approvals', () => {
    const total = (metric: string): number => values(metric).reduce((all, value) => all + value, 0);
    expect(total(FACTORY_METRICS.guardrailStops)).toBe(current.guardrail_stops.count);
    expect(total(FACTORY_METRICS.blanketApprovals)).toBe(current.blanket_approvals.count);
  });
});
