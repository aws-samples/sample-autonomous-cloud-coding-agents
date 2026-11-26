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
  prOutcomeMetricLine,
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

const runs = (id: string): Pick<TaskRecord, 'resolved_workflow' | 'workflow_ref'> =>
  ({ resolved_workflow: { id, version: '1.0.0' }, workflow_ref: id });

const pullRequest = (number: number): string => `https://github.com/Owner/Repo/pull/${number}`;

const before = (days: number, seconds = 0): string =>
  new Date(NOW.getTime() - days * DAY_MS - seconds * 1000).toISOString();

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

const iteration = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  task({ ...runs(PR_ITERATION), pr_number: 12, code_changed: true, ...overrides });

const GUARDRAIL_BLOCKED = 'Guardrail blocked: Task description blocked by content policy: PROMPT_ATTACK';

const LARGEST_COST_USD = 100 * MAX_BUDGET_USD_MAX;

const NO_PULL_REQUEST = { pr_url: undefined, build_passed: undefined };
const NEVER_RAN = { ...NO_PULL_REQUEST, started_at: undefined, cost_usd: undefined };

const inOrchestration = (subIssueId: string): Pick<TaskRecord, 'channel_source' | 'channel_metadata'> =>
  ({ channel_source: 'linear', channel_metadata: { orchestration_id: 'orch_1', orchestration_sub_issue_id: subIssueId } });
const INTEGRATION_NODE = inOrchestration(`orch-1${INTEGRATION_NODE_SUFFIX}`);

const MERGED = { pr_state: 'merged', pr_closed_at: '2026-11-19T10:00:00Z', pr_changes_requested: 0 } as const;
const REVIEWED_AT = '2026-11-18T16:24:00Z';

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
  prFollowed: true,
  prState: null,
  prClosedAtMs: null,
  timeToMergeS: null,
  firstReviewS: null,
  changesRequested: 0,
};
const facts = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({ ...VERIFIED, ...overrides });
const touchpoints = (counts: Partial<Record<TouchpointKind, number>>): TaskFacts['touchpoints'] =>
  ({ ...VERIFIED.touchpoints, ...counts });
const MERGED_FACTS = facts({ prState: 'merged', prClosedAtMs: Date.parse('2026-11-19T10:00:00.000Z'), timeToMergeS: 86400 });

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
    facts({ outcome: 'failed', prKey: null, prFollowed: false }),
  ],
  [
    'a clarify hold',
    task({ ...NO_PULL_REQUEST, code_changed: false, answer_text: 'Which environment should this deploy to?' }),
    facts({ outcome: 'no_new_pr', touchpoints: touchpoints({ clarify: 1 }), prKey: null, prFollowed: false }),
  ],
  ['new work that completed without a pull request', task(NO_PULL_REQUEST), facts({ outcome: 'no_new_pr', prKey: null, prFollowed: false })],
  [
    'a follow-up that changed the code',
    iteration(),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true, prFollowed: false }),
  ],
  [
    'a follow-up that only answered',
    iteration({ code_changed: false, answer_text: 'It retries three times.' }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), prKey: null, prFollowed: false }),
  ],
  [
    'a follow-up that left no comparison of commits',
    iteration({ code_changed: undefined }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true, prFollowed: false }),
  ],
  [
    'a follow-up that failed',
    iteration({ status: TaskStatus.FAILED, code_changed: undefined, error_message: 'Agent session lost: no heartbeat for 300s' }),
    facts({ outcome: 'failed', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true, prFollowed: false }),
  ],
  [
    'a follow-up on a pull request the record does not name',
    iteration({ pr_number: undefined, pr_url: undefined }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), prKey: null, prFollowed: false }),
  ],
  [
    'a review',
    task({ ...runs(PR_REVIEW), pr_number: 12, code_changed: false, answer_text: 'Two findings, both minor.' }),
    facts({ outcome: 'no_new_pr', newWork: false, coding: false, prKey: null, prFollowed: false }),
  ],
  [
    'a restack',
    task({ ...runs(RESTACK), pr_number: 12, code_changed: true }),
    facts({ outcome: 'no_new_pr', newWork: false, prKey: null, prFollowed: false }),
  ],
  [
    'repo-less work',
    task({ ...runs(RESEARCH), ...NO_PULL_REQUEST, repo: undefined }),
    facts({ outcome: 'no_new_pr', newWork: false, coding: false, prKey: null, prFollowed: false }),
  ],
  ['an integration node', task(INTEGRATION_NODE), facts({ outcome: 'no_new_pr', newWork: false, prKey: null, prFollowed: false })],
  ['a sub-issue of an orchestration', task(inOrchestration('sub-issue-7')), facts({ prFollowed: false })],
  [
    'a sub-issue of an orchestration whose record carries the state of its pull request',
    task({ ...inOrchestration('sub-issue-7'), ...MERGED, pr_first_review_at: REVIEWED_AT, pr_changes_requested: 2 }),
    facts({ prFollowed: false }),
  ],
  [
    'a sub-issue of an orchestration whose pull request has no passed build',
    task({ ...inOrchestration('sub-issue-7'), build_passed: false, pr_state: 'open' }),
    facts({ outcome: 'unverified_pr', prFollowed: false }),
  ],
  [
    'a record that names a node and no orchestration',
    task({ channel_metadata: { orchestration_sub_issue_id: 'sub-issue-7' }, pr_state: 'open' }),
    facts({ prState: 'open' }),
  ],
  [
    'a record that names an orchestration and no node',
    task({ channel_metadata: { orchestration_id: 'orch_1' }, pr_state: 'open' }),
    facts({ prFollowed: false }),
  ],
  ['an orchestration id of white space', task({ channel_metadata: { orchestration_id: '  ' }, pr_state: 'open' }), facts({ prFollowed: false })],
  ['an empty orchestration id', task({ channel_metadata: { orchestration_id: '' }, pr_state: 'open' }), facts({ prState: 'open' })],
  [
    'an orchestration id that is not text',
    task({ channel_metadata: { orchestration_id: 7 as unknown as string }, pr_state: 'open' }),
    facts({ prState: 'open' }),
  ],
  ['an orchestration id at the top level of the record only', task({ orchestration_id: 'orch_1', pr_state: 'open' }), facts({ prFollowed: false })],
  [
    'a top-level orchestration id that is not text, beside the id in the metadata',
    task({ ...inOrchestration('sub-issue-7'), orchestration_id: 7 as unknown as string, pr_state: 'open' }),
    facts({ prFollowed: false }),
  ],
  [
    'an empty top-level orchestration id, beside the id in the metadata',
    task({ ...inOrchestration('sub-issue-7'), orchestration_id: '', pr_state: 'open' }),
    facts({ prState: 'open' }),
  ],
  [
    'a task a person cancelled',
    task({ status: TaskStatus.CANCELLED, ...NO_PULL_REQUEST, cost_usd: undefined }),
    facts({ outcome: 'cancelled', costUsd: null, touchpoints: touchpoints({ cancel: 1 }), prKey: null, prFollowed: false }),
  ],
  [
    'an upload window that expired',
    task({ status: TaskStatus.CANCELLED, ...NEVER_RAN, error_message: 'Upload window expired (30 minutes). Please re-submit the task.' }),
    facts({ outcome: 'cancelled', ran: false, waitS: null, costUsd: null, prKey: null, prFollowed: false }),
  ],
  [
    'a task that ran out of time',
    task({ status: TaskStatus.TIMED_OUT, ...NO_PULL_REQUEST, cost_usd: undefined, error_message: 'Orchestrator poll timeout exceeded' }),
    facts({ outcome: 'timed_out', costUsd: null, prKey: null, prFollowed: false }),
  ],
  [
    'content blocked by a guardrail',
    task({ status: TaskStatus.FAILED, ...NEVER_RAN, error_message: `Hydration failed: Error: ${GUARDRAIL_BLOCKED}` }),
    facts({ outcome: 'failed', ran: false, waitS: null, costUsd: null, guardrailStop: true, prKey: null, prFollowed: false }),
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
    facts({
      outcome: 'cancelled',
      ran: false,
      queued: true,
      waitS: null,
      costUsd: null,
      touchpoints: touchpoints({ cancel: 1 }),
      prKey: null,
      prFollowed: false,
    }),
  ],
  [
    'a session that never started',
    task({ status: TaskStatus.FAILED, ...NEVER_RAN, error_message: 'Session start failed: ThrottlingException: Rate exceeded' }),
    facts({ outcome: 'failed', ran: false, waitS: null, costUsd: null, prKey: null, prFollowed: false }),
  ],
  ['a pull request URL that names no number', task({ pr_url: 'https://github.com/Owner/Repo/tree/bgagent/task-1' }), facts({ prKey: null })],
  ['a pull request URL of white space', task({ pr_url: '  ' }), facts({ outcome: 'no_new_pr', prKey: null, prFollowed: false })],
  ['a pull request URL that is not text', task({ pr_url: 12 as unknown as string }), facts({ outcome: 'no_new_pr', prKey: null, prFollowed: false })],
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
  ['a pull request found open', task({ pr_state: 'open' }), facts({ prState: 'open' })],
  ['a pull request the hourly read did not find', task({ pr_state: 'not_found' }), facts({ prState: 'not_found' })],
  ['a pull request merged without a review', task(MERGED), MERGED_FACTS],
  [
    'a pull request merged after a review and a change request',
    task({ ...MERGED, pr_first_review_at: REVIEWED_AT, pr_changes_requested: 1 }),
    facts({ ...MERGED_FACTS, firstReviewS: 21600, changesRequested: 1 }),
  ],
  [
    'a pull request closed without a merge',
    task({ ...MERGED, pr_state: 'closed', pr_first_review_at: REVIEWED_AT }),
    facts({ prState: 'closed', prClosedAtMs: MERGED_FACTS.prClosedAtMs, firstReviewS: 21600 }),
  ],
  [
    'a review four minutes before the task finished',
    task({ ...MERGED, pr_first_review_at: '2026-11-18T10:20:00Z' }),
    facts({ ...MERGED_FACTS, firstReviewS: 0 }),
  ],
  ['a review time that is not a time', task({ ...MERGED, pr_first_review_at: 'none' }), MERGED_FACTS],
  [
    'a review of a pull request whose task has no finish time',
    task({ ...MERGED, pr_first_review_at: REVIEWED_AT, completed_at: undefined, updated_at: undefined }),
    facts({ ...MERGED_FACTS, finishedAtMs: NaN, leadTimeS: null }),
  ],
  ['a merge time that is not a time', task({ ...MERGED, pr_closed_at: 'soon' }), facts({ prState: 'merged' })],
  ['a merged pull request without a merge time', task({ ...MERGED, pr_closed_at: undefined }), facts({ prState: 'merged' })],
  [
    'a merge dated before the task was created',
    task({ ...MERGED, pr_closed_at: '2026-11-18T09:00:00Z' }),
    facts({ prState: 'merged', prClosedAtMs: Date.parse('2026-11-18T09:00:00.000Z') }),
  ],
  [
    'a merged pull request of a task without a creation time',
    task({ ...MERGED, created_at: undefined }),
    facts({ ...MERGED_FACTS, leadTimeS: null, waitS: null, timeToMergeS: null }),
  ],
  ['a state that no read records', task({ pr_state: 'draft' as 'open' }), VERIFIED],
  ['a state that is not text', task({ pr_state: ['merged'] as unknown as 'merged' }), VERIFIED],
  [
    'change requests stored as a string',
    task({ ...MERGED, pr_changes_requested: '2' as unknown as number }),
    facts({ ...MERGED_FACTS, changesRequested: 2 }),
  ],
  ['change requests that are not a number', task({ ...MERGED, pr_changes_requested: 'some' as unknown as number }), MERGED_FACTS],
  ['a count of change requests below zero', task({ ...MERGED, pr_changes_requested: -1 }), MERGED_FACTS],
  ['a merged pull request without a count of change requests', task({ ...MERGED, pr_changes_requested: undefined }), MERGED_FACTS],
  [
    'pull-request fields of the wrong type',
    task({ ...MERGED, pr_closed_at: 2026, pr_first_review_at: 2027, pr_changes_requested: {} } as unknown as Partial<TaskRecord>),
    facts({ prState: 'merged' }),
  ],
  [
    'a failed task whose pull request was merged since',
    task({ status: TaskStatus.FAILED, error_message: 'Post-run build failed', ...MERGED, pr_first_review_at: REVIEWED_AT, pr_changes_requested: 2 }),
    facts({ outcome: 'failed', prKey: null, prFollowed: false }),
  ],
  [
    'a follow-up whose record carries the state of the pull request',
    iteration({ ...MERGED, pr_first_review_at: REVIEWED_AT, pr_changes_requested: 2 }),
    facts({ outcome: 'no_new_pr', newWork: false, touchpoints: touchpoints({ follow_up: 1 }), reworks: true, prFollowed: false }),
  ],
  [
    'an integration node whose record carries the state of its pull request',
    task({ ...INTEGRATION_NODE, ...MERGED, pr_first_review_at: REVIEWED_AT }),
    facts({ outcome: 'no_new_pr', newWork: false, prKey: null, prFollowed: false }),
  ],
];

describe('taskFacts', () => {
  test.each(SHAPES)('%s', (_shape, record, expected) => {
    expect(taskFacts(record)).toEqual(expected);
  });

  test.each([...PRE_ACTIVE_STATUSES, ...ACTIVE_STATUSES])('has nothing to say about a %s task', (status) => {
    expect(taskFacts(task({ status }))).toBeNull();
  });

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
      prFollowed: false,
      prState: null,
      prClosedAtMs: null,
      timeToMergeS: null,
      firstReviewS: null,
      changesRequested: 0,
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
      orchestration_id: 7,
      // Date.parse reads the strings '2025' and '2026' as years.
      created_at: 2025,
      updated_at: 2026,
      queued_at: 1,
      started_at: true,
      completed_at: null,
      pr_url: 12,
      pr_number: '12',
      pr_state: 1,
      pr_closed_at: 2026,
      pr_first_review_at: 2027,
      pr_changes_requested: 'some',
      build_passed: 'true',
      code_changed: 'false',
      answer_text: 9,
      cost_usd: {},
      error_message: 404,
      approval_gate_count: 'many',
      initial_approvals: 'all_session',
    } as unknown as ScoreboardTask;
    expect(taskFacts(odd)).toEqual(taskFacts({ task_id: 'odd', status: TaskStatus.FAILED } as ScoreboardTask));
  });
});

describe('SCOREBOARD_TASK_FIELDS', () => {
  const COUNTS_ON: Record<(typeof SCOREBOARD_TASK_FIELDS)[number], TaskRecord> = {
    task_id: task(),
    status: task(),
    repo: task(),
    resolved_workflow: task({ workflow_ref: undefined }),
    workflow_ref: task({ resolved_workflow: undefined }),
    channel_metadata: task(INTEGRATION_NODE),
    orchestration_id: task({ orchestration_id: 'orch_1' }),
    created_at: task(),
    updated_at: task({ completed_at: undefined }),
    queued_at: task({ queued_at: '2026-11-18T10:00:01.000Z' }),
    started_at: task(),
    completed_at: task({ updated_at: '2026-11-18T11:00:00.000Z' }),
    pr_url: task(),
    pr_number: iteration({ pr_url: undefined }),
    pr_state: task({ pr_state: 'open' }),
    pr_closed_at: task(MERGED),
    pr_first_review_at: task({ ...MERGED, pr_first_review_at: REVIEWED_AT }),
    pr_changes_requested: task({ ...MERGED, pr_changes_requested: 1 }),
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

const followUp = (id: string, days: number, number: number, overrides: Partial<TaskRecord> = {}): TaskRecord =>
  finished(id, days, { ...runs(PR_ITERATION), pr_number: number, pr_url: pullRequest(number), code_changed: true, ...overrides });

const mergedAt = (at: string, overrides: Partial<TaskRecord> = {}): Partial<TaskRecord> =>
  ({ pr_state: 'merged', pr_closed_at: at, pr_changes_requested: 0, ...overrides });
const closedAt = (at: string, overrides: Partial<TaskRecord> = {}): Partial<TaskRecord> =>
  ({ pr_state: 'closed', pr_closed_at: at, pr_changes_requested: 0, ...overrides });
const FOUND_OPEN: Partial<TaskRecord> = { pr_state: 'open' };
const NOT_FOUND: Partial<TaskRecord> = { pr_state: 'not_found' };
const NO_PULL_REQUESTS = { merged: 0, closed: 0, open: 0, unread: 0 };

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
  pull_requests: NO_PULL_REQUESTS,
  merged_clean: { count: 0, total: 0 },
  time_to_merge_s: null,
  first_review_s: null,
});

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
  finished('n1', 4, { pr_url: pullRequest(6), cost_usd: '0.75', ...INTEGRATION_NODE }),
  finished('s1', 4, { ...runs(RESTACK), pr_number: 7, pr_url: pullRequest(7), code_changed: true, cost_usd: '0.4' }),
];

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
        time_to_verified_pr_s: { p50: 1440, p90: 3000, count: 3 },
        wait_p50_s: 41,
        queued: { count: 2, total: 15 },
        verified: { count: 3, total: 10 },
        not_reworked: { count: 3, total: 4 },
        untouched: { count: 2, total: 10 },
        touchpoints: { approve: 2, clarify: 1, follow_up: 2, cancel: 1 },
        spend_usd: 18,
        uncosted: 2,
        guardrail_stops: { count: 1, task_ids: ['g1'] },
        blanket_approvals: { count: 1, task_ids: ['b1'] },
        gated: { count: 1, total: 12 },
        pull_requests: { merged: 0, closed: 0, open: 0, unread: 4 },
        merged_clean: { count: 0, total: 0 },
        time_to_merge_s: null,
        first_review_s: null,
      },
      previous: emptyPeriod('2026-11-05T12:00:00.000Z', '2026-11-12T12:00:00.000Z'),
      open_over_7d: { count: 0, task_ids: [] },
    });
  });

  test('counts the trust flags and the queue over every finished task, whatever its work', () => {
    const board = buildScoreboard([
      finished('rv', 1, {
        ...runs(PR_REVIEW),
        pr_number: 9,
        pr_url: pullRequest(9),
        code_changed: false,
        queued_at: before(1, 1430),
        initial_approvals: ['all_session'],
      }),
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
      pull_requests: { merged: 0, closed: 0, open: 0, unread: 2 },
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

  describe('pull-request outcomes', () => {
    test('counts each new pull request of a period in the state it had at the period\'s end', () => {
      const board = buildScoreboard([
        finished('m1', 5, { pr_url: pullRequest(1), ...mergedAt(before(4)) }),
        finished('m2', 6, { pr_url: pullRequest(2), ...mergedAt(before(2), { pr_first_review_at: before(5), pr_changes_requested: 1 }) }),
        finished('c1', 3, { pr_url: pullRequest(3), ...closedAt(before(2)) }),
        finished('o1', 2, { pr_url: pullRequest(4), ...FOUND_OPEN }),
        finished('n1', 1, { pr_url: pullRequest(5), build_passed: false }),
        finished('p1', 12, { pr_url: pullRequest(6), ...mergedAt(before(10)) }),
        finished('p2', 9, { pr_url: pullRequest(7), ...mergedAt(before(3)) }),
        finished('p3', 13, { pr_url: pullRequest(8), ...closedAt(before(1)) }),
        finished('p4', 8, { pr_url: pullRequest(9) }),
        finished('p5', 11, { pr_url: pullRequest(10), ...FOUND_OPEN }),
      ], '7d', NOW);

      expect(board.current).toMatchObject({
        outcomes: { verified_pr: 4, unverified_pr: 1 },
        pull_requests: { merged: 2, closed: 1, open: 1, unread: 1 },
        merged_clean: { count: 1, total: 2 },
        time_to_merge_s: { p50: 87840, p90: 347040, count: 2 },
        first_review_s: { p50: 86400, p90: 86400, count: 1 },
      });
      expect(board.previous).toMatchObject({
        outcomes: { verified_pr: 5, unverified_pr: 0 },
        pull_requests: { merged: 1, closed: 0, open: 3, unread: 1 },
        merged_clean: { count: 1, total: 1 },
        time_to_merge_s: { p50: 174240, p90: 174240, count: 1 },
        first_review_s: null,
      });
      expect(board.open_over_7d).toEqual({ count: 1, task_ids: ['p5'] });
    });

    test.each([
      ['was never read', 'unread', {}],
      ['was not found on GitHub', 'unread', NOT_FOUND],
      ['was found open', 'open', FOUND_OPEN],
      ['was merged a millisecond before that end', 'merged', mergedAt(before(7, 0.001))],
      ['was closed a millisecond before that end', 'closed', closedAt(before(7, 0.001))],
      ['was merged at that very end', 'open', mergedAt(before(7))],
      ['was merged in the period after', 'open', mergedAt(before(3))],
      ['was closed in the period after', 'open', closedAt(before(3))],
      ['is merged at a time that cannot be read', 'open', mergedAt('soon')],
    ])('a pull request of the earlier period that %s counts there as %s', (_what, state, recorded) => {
      const board = buildScoreboard([finished('p', 10, recorded)], '7d', NOW);

      expect(board.previous?.pull_requests).toEqual({ ...NO_PULL_REQUESTS, [state]: 1 });
      expect(board.current.pull_requests).toEqual(NO_PULL_REQUESTS);
    });

    test.each([
      ['was never read', 'unread', {}],
      ['was found open', 'open', FOUND_OPEN],
      ['was merged', 'merged', mergedAt(before(1))],
      ['was closed', 'closed', closedAt(before(1))],
      ['was merged at a time ahead of the clock', 'merged', mergedAt(before(-0.01))],
    ])('a pull request of the current period that %s counts as %s', (_what, state, recorded) => {
      const board = buildScoreboard([finished('p', 2, recorded)], '7d', NOW);

      expect(board.current.pull_requests).toEqual({ ...NO_PULL_REQUESTS, [state]: 1 });
    });

    test('a merge after the end of the earlier period counts in neither period, and in the current period of a range that holds its task', () => {
      const tasks = [finished('p', 10, mergedAt(before(3)))];
      const week = buildScoreboard(tasks, '7d', NOW);
      const month = buildScoreboard(tasks, '30d', NOW);

      expect(week.previous).toMatchObject({ pull_requests: { ...NO_PULL_REQUESTS, open: 1 }, merged_clean: { count: 0, total: 0 }, time_to_merge_s: null });
      expect(week.current).toMatchObject({ pull_requests: NO_PULL_REQUESTS, merged_clean: { count: 0, total: 0 }, time_to_merge_s: null });
      expect(month.current).toMatchObject({
        pull_requests: { ...NO_PULL_REQUESTS, merged: 1 },
        merged_clean: { count: 1, total: 1 },
        time_to_merge_s: { p50: 606240, p90: 606240, count: 1 },
      });
    });

    test('has no share, no time and no count of the open ones while no pull request has been read', () => {
      const board = buildScoreboard([
        finished('n1', 1, { pr_url: pullRequest(1) }),
        finished('n2', 3, { pr_url: pullRequest(2), build_passed: false }),
        finished('n3', 10, { pr_url: pullRequest(3) }),
      ], '7d', NOW);

      expect(board.current).toMatchObject({
        pull_requests: { ...NO_PULL_REQUESTS, unread: 2 },
        merged_clean: { count: 0, total: 0 },
        time_to_merge_s: null,
        first_review_s: null,
      });
      expect(board.previous?.pull_requests).toEqual({ ...NO_PULL_REQUESTS, unread: 1 });
      expect(board.open_over_7d).toBeNull();
    });

    const NONE_FOLLOWED = { pull_requests: NO_PULL_REQUESTS, merged_clean: { count: 0, total: 0 }, time_to_merge_s: null, first_review_s: null };

    test('leaves out the pull request of a task that did not end in one, whatever its record carries', () => {
      const board = buildScoreboard([FOUND_OPEN, mergedAt(before(8), { pr_first_review_at: before(9) })].flatMap((recorded, index) => [
        finished(`failed-${index}`, 10, { status: TaskStatus.FAILED, pr_url: pullRequest(1), ...recorded }),
        followUp(`follow-up-${index}`, 10, 2, recorded),
        finished(`integration-${index}`, 10, { ...INTEGRATION_NODE, ...recorded }),
      ]), '7d', NOW);

      expect(board.previous).toMatchObject({ finished: 6, ...NONE_FOLLOWED });
      expect(board.current).toMatchObject({ finished: 0, ...NONE_FOLLOWED });
      expect(board.open_over_7d).toEqual({ count: 0, task_ids: [] });
    });

    test('leaves the pull request of an orchestration\'s task out of every pull-request number, and counts its task like any other', () => {
      const board = buildScoreboard([
        finished('open', 10, { ...inOrchestration('sub-issue-1'), pr_url: pullRequest(1), ...FOUND_OPEN }),
        finished('merged', 10, { ...inOrchestration('sub-issue-2'), pr_url: pullRequest(2), ...mergedAt(before(8), { pr_first_review_at: before(9) }) }),
        finished('never-read', 10, { ...inOrchestration('sub-issue-3'), pr_url: pullRequest(3), build_passed: false }),
        followUp('r', 9, 1),
      ], '7d', NOW);

      expect(board.previous).toMatchObject({
        finished: 4,
        outcomes: { verified_pr: 2, unverified_pr: 1, no_new_pr: 1 },
        verified: { count: 2, total: 3 },
        not_reworked: { count: 2, total: 3 },
        ...NONE_FOLLOWED,
      });
      expect(board.open_over_7d).toEqual({ count: 0, task_ids: [] });
    });

    test.each([
      ['nothing before the merge', 1, {}, []],
      ['a change request by a reviewer', 0, { pr_changes_requested: 1 }, []],
      ['a follow-up that changed it before the merge', 0, {}, [followUp('r', 3, 1)]],
      ['a follow-up that changed it after the merge', 1, {}, [followUp('r', 1, 1)]],
      ['a follow-up that finished at the very time of the merge', 1, {}, [followUp('r', 2, 1)]],
      ['a follow-up that only answered a question', 1, {}, [followUp('r', 3, 1, { code_changed: false, answer_text: 'It retries three times.' })]],
      ['a follow-up that changed another pull request', 1, {}, [followUp('r', 3, 2)]],
    ])('a merged pull request with %s: %s of 1 merged without being sent back', (_what, clean, recorded, others) => {
      const board = buildScoreboard([
        finished('p', 5, { pr_url: pullRequest(1), ...mergedAt(before(2), recorded) }),
        ...others,
      ], '7d', NOW);

      expect(board.current.merged_clean).toEqual({ count: clean, total: 1 });
    });

    test('a merged pull request whose number is not known counts by its change requests alone', () => {
      const unnumbered = 'https://github.com/Owner/Repo/tree/main';
      const board = buildScoreboard([
        finished('no-change-request', 5, { pr_url: unnumbered, ...mergedAt(before(2)) }),
        finished('change-request', 5, { pr_url: unnumbered, ...mergedAt(before(2), { pr_changes_requested: 1 }) }),
        followUp('r', 3, 1),
      ], '7d', NOW);

      expect(board.current.merged_clean).toEqual({ count: 1, total: 2 });
    });

    test('measures the time to merge from the creation of the task, over the pull requests that are merged', () => {
      const board = buildScoreboard([
        finished('soon', 3, { pr_url: pullRequest(1), created_at: before(3, 600), ...mergedAt(before(3, -1000)) }),
        finished('later', 3, { pr_url: pullRequest(2), created_at: before(3, 600), ...mergedAt(before(1)) }),
        finished('no-creation-time', 3, { pr_url: pullRequest(3), created_at: undefined, ...mergedAt(before(1)) }),
        finished('closed', 3, { pr_url: pullRequest(4), created_at: before(3, 600), ...closedAt(before(1)) }),
        finished('open', 3, { pr_url: pullRequest(5), created_at: before(3, 600), ...FOUND_OPEN }),
      ], '7d', NOW);

      expect(board.current.time_to_merge_s).toEqual({ p50: 1600, p90: 173400, count: 2 });
      expect(board.current.pull_requests).toEqual({ merged: 3, closed: 1, open: 1, unread: 0 });
    });

    test('measures the first review from the end of the task, over the merged pull requests that had one', () => {
      const board = buildScoreboard([
        finished('reviewed', 5, { pr_url: pullRequest(1), ...mergedAt(before(2), { pr_first_review_at: before(5, -21600) }) }),
        finished('reviewed-early', 5, { pr_url: pullRequest(2), ...mergedAt(before(2), { pr_first_review_at: before(5, 60) }) }),
        finished('not-reviewed', 5, { pr_url: pullRequest(3), ...mergedAt(before(2)) }),
        finished('closed', 5, { pr_url: pullRequest(4), ...closedAt(before(2), { pr_first_review_at: before(4) }) }),
      ], '7d', NOW);

      expect(board.current.first_review_s).toEqual({ p50: 0, p90: 21600, count: 2 });
    });

    describe('open for more than 7 days', () => {
      test.each([
        ['7d', 10],
        ['30d', 31],
      ] as const)('lists, in the %s range, a pull request that is open %s days after its task finished', (range, days) => {
        const board = buildScoreboard([finished('waiting', days, FOUND_OPEN)], range, NOW);

        expect(board.open_over_7d).toEqual({ count: 1, task_ids: ['waiting'] });
        expect(board.current.pull_requests).toEqual(NO_PULL_REQUESTS);
      });

      test.each([
        ['was merged on its eighth day', mergedAt(before(2))],
        ['was closed on its eighth day', closedAt(before(2))],
        ['was merged at a time ahead of the clock', mergedAt(before(-0.01))],
        ['is merged at a time that cannot be read', mergedAt('soon')],
      ])('does not list a pull request that %s', (_what, recorded) => {
        expect(buildScoreboard([finished('p', 10, recorded)], '7d', NOW).open_over_7d).toEqual({ count: 0, task_ids: [] });
      });

      test.each([
        ['7 days before now', 0, before(7)],
        ['a millisecond more than 7 days before now', 1, before(7, 0.001)],
        ['at the start of the earlier period', 1, before(14)],
        ['a millisecond before the earlier period', 0, before(14, 0.001)],
      ])('counts an open pull request whose task finished %s: %s', (_when, count, stamp) => {
        const waiting = finished('p', 0, { created_at: before(20), completed_at: stamp, updated_at: stamp, ...FOUND_OPEN });

        expect(buildScoreboard([waiting], '7d', NOW).open_over_7d).toMatchObject({ count });
      });

      test.each([
        ['one pull request old enough, never read', null, [finished('never-read', 10)]],
        ['one pull request old enough, which GitHub does not have', null, [finished('not-found', 10, NOT_FOUND)]],
        [
          'two old enough, one that GitHub does not have and one merged',
          { count: 0, task_ids: [] },
          [finished('not-found', 12, NOT_FOUND), finished('merged', 10, mergedAt(before(9)))],
        ],
        ['one old enough and never read, and a younger one found open', null, [finished('never-read', 10), finished('young', 2, FOUND_OPEN)]],
        [
          'two old enough, one of them found open',
          { count: 1, task_ids: ['open'] },
          [finished('never-read', 12), finished('open', 10, FOUND_OPEN)],
        ],
        [
          'two old enough, one of them merged',
          { count: 0, task_ids: [] },
          [finished('never-read', 12), finished('merged', 10, mergedAt(before(9)))],
        ],
        ['no pull request old enough', { count: 0, task_ids: [] }, [finished('young', 2), finished('younger', 1, FOUND_OPEN)]],
        ['one never read whose task finished before the earlier period', { count: 0, task_ids: [] }, [finished('before', 15)]],
      ])('with %s, the count is %j', (_what, expected, tasks) => {
        expect(buildScoreboard(tasks, '7d', NOW).open_over_7d).toEqual(expected);
      });

      test('lists the ten that have waited longest, oldest first', () => {
        const order = [15, 21, 12, 18, 10, 19, 13, 17, 11, 20, 16, 14];
        const waiting = order.map((days) => finished(`w${days}`, days, FOUND_OPEN));

        expect(buildScoreboard(waiting, '30d', NOW).open_over_7d).toEqual({
          count: 12,
          task_ids: ['w21', 'w20', 'w19', 'w18', 'w17', 'w16', 'w15', 'w14', 'w13', 'w12'],
        });
      });
    });
  });

  describe('a read that was cut', () => {
    const tasks = [
      finished('day-1', 1, { pr_url: pullRequest(1) }),
      finished('day-4', 4, { pr_url: pullRequest(2) }),
      finished('day-6', 6, { pr_url: pullRequest(3) }),
      finished('day-9', 9, { pr_url: pullRequest(4), ...FOUND_OPEN }),
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
      expect(board.open_over_7d).toEqual({ count: 1, task_ids: ['day-9'] });
    });

    test.each([
      ['a millisecond into the previous period', new Date(before(14, -0.001))],
      ['in the middle of the previous period', new Date(before(10))],
      ['at the start of the current period', new Date(before(7))],
    ])('reports no previous period and a whole current one when the read stopped %s', (_where, coveredFrom) => {
      const board = buildScoreboard(tasks, '7d', NOW, coveredFrom);
      expect(board.truncated).toBe(false);
      expect(board.previous).toBeNull();
      expect([board.current.from, board.current.finished]).toEqual(['2026-11-12T12:00:00.000Z', 3]);
      expect(board.open_over_7d).toBeNull();
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
      expect(board.open_over_7d).toBeNull();
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

    expect(line._aws.CloudWatchMetrics.map((directive) => directive.Dimensions)).toEqual([[['Outcome']], [['Work']], [[]]]);
    expect(line.Outcome).toBe(expectedFacts?.outcome);
    expect(line.Work).toBe(expectedFacts?.coding ? 'coding' : 'other');
  });

  test('leaves out the plain fields it was not given, and the wait of a task that never started', () => {
    const neverStarted = facts({ outcome: 'failed', ran: false, waitS: null, costUsd: null, prKey: null, prFollowed: false });
    const line = JSON.parse(taskMetricLine(neverStarted, {}, NOW.getTime())) as MetricLine;

    expect(Object.keys(line).sort()).toEqual([
      'BlanketApprovals', 'GuardrailStops', 'HumanTouchpoints', 'Outcome', 'TasksFinished', 'UntouchedVerifiedPrs', 'Work', '_aws', 'task_id',
    ]);
  });

  test('sums the touchpoints of every kind into one metric', () => {
    const line = lineOf(iteration({ status: TaskStatus.CANCELLED, approval_gate_count: 3, code_changed: undefined, cost_usd: undefined }));
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
    ['an integration node', task(INTEGRATION_NODE), undefined],
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

function outcomeLineOf(record: TaskRecord): MetricLine | null {
  const recordFacts = taskFacts(record);
  if (recordFacts === null) throw new Error(`${record.task_id} is not finished`);
  const context = { user_id: record.user_id, repo: record.repo, workflow: record.resolved_workflow?.id };
  const line = prOutcomeMetricLine(recordFacts, context);
  return line === null ? null : JSON.parse(line) as MetricLine;
}

describe('prOutcomeMetricLine', () => {
  test('writes one line of JSON for a merged pull request: two directives, their members, then the plain fields', () => {
    const line = prOutcomeMetricLine(MERGED_FACTS, { user_id: 'user-1', repo: 'Owner/Repo', workflow: CODING_WORKFLOW_ID });

    expect(line).not.toContain('\n');
    expect(JSON.parse(line ?? '')).toEqual({
      _aws: {
        Timestamp: Date.parse('2026-11-19T10:00:00.000Z'),
        CloudWatchMetrics: [
          { Namespace: 'ABCA/Factory', Dimensions: [['PrOutcome']], Metrics: [{ Name: 'PullRequestsResolved', Unit: 'Count' }] },
          { Namespace: 'ABCA/Factory', Dimensions: [[]], Metrics: [{ Name: 'TimeToMergeSeconds', Unit: 'Seconds' }] },
        ],
      },
      PrOutcome: 'merged',
      PullRequestsResolved: 1,
      TimeToMergeSeconds: 86400,
      task_id: 'task-1',
      user_id: 'user-1',
      repo: 'Owner/Repo',
      workflow: 'coding/new-task-v1',
    });
  });

  test.each([
    ['a closed pull request', task({ ...MERGED, pr_state: 'closed' }), 'closed'],
    ['a merged pull request of a task without a creation time', task({ ...MERGED, created_at: undefined }), 'merged'],
  ])('%s has no time to merge: the line declares its outcome alone', (_what, record, state) => {
    const line = outcomeLineOf(record);

    expect(line?._aws.CloudWatchMetrics).toEqual([
      { Namespace: 'ABCA/Factory', Dimensions: [['PrOutcome']], Metrics: [{ Name: 'PullRequestsResolved', Unit: 'Count' }] },
    ]);
    expect(line).toMatchObject({ PrOutcome: state, PullRequestsResolved: 1 });
    expect(line).not.toHaveProperty('TimeToMergeSeconds');
  });

  test.each([
    ['a pull request that no read has recorded', task()],
    ['a pull request found open', task({ pr_state: 'open' })],
    ['a pull request the hourly read did not find', task({ ...MERGED, pr_state: 'not_found' })],
    ['an open pull request whose record carries a close time', task({ ...MERGED, pr_state: 'open' })],
    ['a close time on a record without a state', task({ ...MERGED, pr_state: undefined })],
    ['a merge without a time that can be read', task({ ...MERGED, pr_closed_at: 'soon' })],
    ['a failed task whose record carries a merge', task({ status: TaskStatus.FAILED, ...MERGED })],
    ['a task of an orchestration whose record carries a merge', task({ ...inOrchestration('sub-issue-7'), ...MERGED })],
  ])('writes no line for %s', (_what, record) => {
    expect(outcomeLineOf(record)).toBeNull();
  });

  test.each([
    ['40 days old', before(40)],
    ['ahead of the clock', before(-1)],
  ])('is stamped with the time the pull request was merged or closed, even one %s', (_what, stamp) => {
    expect(outcomeLineOf(task({ ...MERGED, pr_closed_at: stamp }))?._aws.Timestamp).toBe(Date.parse(stamp));
  });
});

describe('the metric lines and the scoreboard agree', () => {
  const lines = WEEK.map((record) => lineOf(record));
  const { current } = buildScoreboard(WEEK, '7d', NOW);

  const sum = (metric: string, dimension: string, value: string): number =>
    lines.filter((line) => line[dimension] === value).reduce((total, line) => total + ((line[metric] as number | undefined) ?? 0), 0);
  const ofWork = (metric: string, work: string): number => sum(metric, FACTORY_DIMENSIONS.work, work);
  const finishedAs = (outcome: string): number => sum(FACTORY_METRICS.tasksFinished, FACTORY_DIMENSIONS.outcome, outcome);
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
