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
 * Task API lifecycle against the AWS Emulator (ADR-013 Tier 2a).
 *
 * The real handler entry points run in-process; only their AWS calls leave the
 * process, to an emulator whose tables are created from the CDK constructs.
 * Nothing is mocked, so these tests see what `jest.mock('@aws-sdk/...')` tests
 * cannot: index key order, `Limit` before `FilterExpression`, and the state a
 * sequence of real conditional writes leaves behind.
 *
 * The scoreboard cases cover both readers of a finished task: the
 * `view=scoreboard` read of the list handler, and the metric step of the task
 * table's stream consumer. The tier has no stream, so that step is handed the
 * record a stream would deliver.
 *
 * Runs only through `jest.emulator.config.js` (see ./harness).
 */

import { randomUUID } from 'node:crypto';
import { DescribeTableCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult, DynamoDBRecord, StreamRecord } from 'aws-lambda';
import { BudgetTable } from '../../src/constructs/budget-table';
import { RepoTable } from '../../src/constructs/repo-table';
import { TaskApprovalsTable } from '../../src/constructs/task-approvals-table';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { type TaskStatusType, TERMINAL_STATUSES } from '../../src/constructs/task-status';
import { TaskTable } from '../../src/constructs/task-table';

// Handlers read their table names at module load, so the environment is set
// before any handler is imported. Names are unique to this file's run.
const run = randomUUID().slice(0, 8);
process.env.TASK_TABLE_NAME = `emu-${run}-tasks`;
process.env.TASK_EVENTS_TABLE_NAME = `emu-${run}-events`;
process.env.REPO_TABLE_NAME = `emu-${run}-repos`;
process.env.TASK_APPROVALS_TABLE_NAME = `emu-${run}-approvals`;
process.env.BUDGET_TABLE_NAME = `emu-${run}-budgets`;
/** A task table as a stack has it before the deploy that adds UserCreatedAtIndex (#51). */
const TASKS_BEFORE_51 = `emu-${run}-tasks-before-51`;

import { handler as cancelTask } from '../../src/handlers/cancel-task';
import { handler as createTask } from '../../src/handlers/create-task';
import { handler as getPending } from '../../src/handlers/get-pending';
import { handler as getTask } from '../../src/handlers/get-task';
import { handler as getTaskEvents } from '../../src/handlers/get-task-events';
import { handler as listTasks } from '../../src/handlers/list-tasks';
import { publishTaskMetrics } from '../../src/handlers/scoreboard-metrics';
import { INTEGRATION_NODE_SUFFIX } from '../../src/handlers/shared/orchestration-integration-node';
import { SCOREBOARD_TASK_FIELDS } from '../../src/handlers/shared/scoreboard';
import type { Scoreboard, TaskRecord } from '../../src/handlers/shared/types';
import { makeDocClient } from '../../src/handlers/shared/ua';
import { apiEvent, emulatorTables } from './harness';

const REPO = 'acme/widgets';
const CONCURRENT_CANCELS = 8;
/** Approval window of the requests written here, in seconds. */
const APPROVAL_TIMEOUT_S = 300;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The range the scoreboard cases ask for, in days. */
const RANGE_DAYS = 7;
/** The tasks of the paging case. A page of an index holds 1 MB of whole records: five of 300 KB need a second one. */
const LARGE_TASKS = 5;
const LARGE_TASK_BYTES = 300 * 1024;
/** The tasks of the cut case. A scoreboard reads six pages of a status, 6 MB at most: 25 of 300 KB lie beyond them. */
const CUT_TASKS = 25;

const ddb = makeDocClient();

/** A user no other test has written for, so tests need no cleanup between them. */
const newUser = (): string => `user-${randomUUID()}`;
const data = (result: APIGatewayProxyResult) => JSON.parse(result.body).data;
const byId = (taskId: string) => ({ pathParameters: { task_id: taskId } });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A time as the platform stores it, with milliseconds, and as the agent does, in whole seconds. */
const platformStamp = (ms: number): string => new Date(ms).toISOString();
const agentStamp = (ms: number): string => platformStamp(ms).replace(/\.\d{3}Z$/, 'Z');

/** POST /v1/tasks through the real handler. Returns the HTTP result. */
function submit(userId: string, idempotencyKey?: string): Promise<APIGatewayProxyResult> {
  return createTask(apiEvent(userId, {
    httpMethod: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    body: JSON.stringify({ repo: REPO, workflow_ref: 'coding/new-task-v1', task_description: 'Add a health check endpoint' }),
  }));
}

/** GET /v1/tasks through the real handler. Returns the parsed body. */
async function list(userId: string, query?: Record<string, string>, handler = listTasks) {
  const result = await handler(apiEvent(userId, { queryStringParameters: query ?? null }));
  expect(result.statusCode).toBe(200);
  return JSON.parse(result.body) as { data: { task_id: string; status: string }[]; pagination: { next_token: string | null; has_more: boolean } };
}

/**
 * Write a task record straight to the table, as it is once `status` was entered at `at`: no
 * writer can leave a task that finished days ago. A status write stamps its time in the index
 * key and in `updated_at`, a terminal one in `completed_at` too. The task was created half an
 * hour earlier.
 * @param userId - the owner.
 * @param status - the status the task is in.
 * @param at - the stored time of that status, in the form its writer uses.
 * @param fields - attributes to add or replace; `undefined` leaves one out.
 * @returns the record.
 */
async function seedTask(userId: string, status: TaskStatusType, at: string, fields: Partial<TaskRecord> = {}): Promise<TaskRecord> {
  const task: TaskRecord = {
    task_id: `task-${randomUUID()}`,
    user_id: userId,
    status,
    branch_name: '',
    channel_source: 'api',
    status_created_at: `${status}#${at}`,
    created_at: platformStamp(Date.parse(at) - 30 * MINUTE_MS),
    updated_at: at,
    ...(TERMINAL_STATUSES.includes(status) && { completed_at: at }),
    ...fields,
  };
  const Item = Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined));
  await ddb.send(new PutCommand({ TableName: process.env.TASK_TABLE_NAME, Item }));
  return task;
}

/** GET /v1/tasks?view=scoreboard for the last RANGE_DAYS days, through the real handler. Returns the scoreboard, of one repository when `repo` names it. */
async function scoreboard(userId: string, repo?: string): Promise<Scoreboard> {
  const queryStringParameters = { view: 'scoreboard', range: `${RANGE_DAYS}d`, ...(repo !== undefined && { repo }) };
  const result = await listTasks(apiEvent(userId, { queryStringParameters }));
  expect(result.statusCode).toBe(200);
  return data(result);
}

/** A task as DynamoDB stores it, in the attribute-value form of a stream image. Undefined when the table holds no such task. */
async function storedTask(taskId: string): Promise<StreamRecord['NewImage']> {
  const { Item } = await ddb.send(new GetItemCommand({
    TableName: process.env.TASK_TABLE_NAME,
    Key: { task_id: { S: taskId } },
    ConsistentRead: true,
  }));
  return Item as StreamRecord['NewImage'];
}

/** Run the stream consumer's metric step on the record of a write that left a task as `image`. Returns its verdict and what it wrote to stdout. */
async function publishMetrics(image: StreamRecord['NewImage']): Promise<{ published: boolean; written: string }> {
  const record: DynamoDBRecord = { eventName: 'MODIFY', dynamodb: { NewImage: image } };
  const stdout = jest.spyOn(process.stdout, 'write');
  try {
    const published = await publishTaskMetrics(record);
    return { published, written: stdout.mock.calls.map(([chunk]) => chunk).join('') };
  } finally {
    stdout.mockRestore();
  }
}

describe('task API against the AWS Emulator', () => {
  const addIndex = emulatorTables((stack) => {
    new TaskTable(stack, 'Tasks', { tableName: process.env.TASK_TABLE_NAME });
    new TaskTable(stack, 'TasksBefore51', { tableName: TASKS_BEFORE_51 });
    new TaskEventsTable(stack, 'Events', { tableName: process.env.TASK_EVENTS_TABLE_NAME });
    new RepoTable(stack, 'Repos', { tableName: process.env.REPO_TABLE_NAME });
    new TaskApprovalsTable(stack, 'Approvals', { tableName: process.env.TASK_APPROVALS_TABLE_NAME });
    new BudgetTable(stack, 'Budgets', { tableName: process.env.BUDGET_TABLE_NAME });
  }, () => {
    // The row a Blueprint writes at deploy time; create-task gates on it.
    const now = new Date().toISOString();
    return makeDocClient().send(new PutCommand({
      TableName: process.env.REPO_TABLE_NAME,
      Item: { repo: REPO, status: 'active', onboarded_at: now, updated_at: now },
    }));
  }, { [TASKS_BEFORE_51]: [TaskTable.USER_CREATED_AT_INDEX] });

  test('create, get, list, cancel: one task through every handler', async () => {
    const user = newUser();

    const created = await submit(user);
    expect(created.statusCode).toBe(201);
    const taskId: string = data(created).task_id;
    expect(data(created)).toMatchObject({ status: 'SUBMITTED', repo: REPO });

    expect(data(await getTask(apiEvent(user, byId(taskId))))).toMatchObject({ task_id: taskId, status: 'SUBMITTED' });
    expect((await getTask(apiEvent(newUser(), byId(taskId)))).statusCode).toBe(403);
    expect((await list(user)).data.map((t) => t.task_id)).toEqual([taskId]);

    const cancelled = await cancelTask(apiEvent(user, byId(taskId)));
    expect(cancelled.statusCode).toBe(200);
    expect((await cancelTask(apiEvent(user, byId(taskId)))).statusCode).toBe(409);

    // The cancel changed the status, so the task has moved between status filters.
    expect(data(await getTask(apiEvent(user, byId(taskId)))).status).toBe('CANCELLED');
    expect((await list(user, { status: 'CANCELLED' })).data.map((t) => t.task_id)).toEqual([taskId]);
    expect((await list(user, { status: 'SUBMITTED' })).data).toEqual([]);

    const events = data(await getTaskEvents(apiEvent(user, byId(taskId))));
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['task_created', 'task_cancelled']);
  });

  test('replaying an Idempotency-Key returns the original task and creates nothing', async () => {
    const user = newUser();
    const key = `key-${randomUUID()}`;

    const first = await submit(user, key);
    const replay = await submit(user, key);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers).toMatchObject({ 'Idempotent-Replay': 'true' });
    expect(data(replay).task_id).toBe(data(first).task_id);
    expect((await list(user)).data).toHaveLength(1);

    // The key is global, not per user: someone else reusing it is refused, not handed the task.
    expect((await submit(newUser(), key)).statusCode).toBe(409);
  });

  // An outcome test: a loser is refused either by cancel-task's read of the task or
  // by its conditional write, depending on timing, and this cannot tell which. The
  // test that fails when a condition is missing is 'racing admissions' in
  // concurrency-seats.emulator.ts.
  test('concurrent cancels: one succeeds, the rest are refused, one event is recorded', async () => {
    const user = newUser();
    const taskId: string = data(await submit(user)).task_id;

    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- fixed-size fixture, not input-derived
    const results = await Promise.all(Array.from({ length: CONCURRENT_CANCELS }, () => cancelTask(apiEvent(user, byId(taskId)))));

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, ...Array(CONCURRENT_CANCELS - 1).fill(409)]);
    const events = data(await getTaskEvents(apiEvent(user, byId(taskId))));
    expect(events.filter((e: { event_type: string }) => e.event_type === 'task_cancelled')).toHaveLength(1);
  });

  test('list pages through the index without losing or repeating a task', async () => {
    const user = newUser();
    const submitted: string[] = [];
    for (let i = 0; i < 5; i++) submitted.push(data(await submit(user)).task_id);

    const seen: string[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    do {
      const page = await list(user, { limit: '2', ...(nextToken && { next_token: nextToken }) });
      seen.push(...page.data.map((t) => t.task_id));
      nextToken = page.pagination.next_token;
      pages++;
    } while (nextToken);

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...submitted].sort());
  });

  test('#51: list returns the newest task first (API_CONTRACT.md: "ordered by created_at descending")', async () => {
    const user = newUser();
    const older: string = data(await submit(user)).task_id;
    await pause(5);
    const newer: string = data(await submit(user)).task_id;
    await cancelTask(apiEvent(user, byId(newer)));

    expect((await list(user)).data.map((t) => t.task_id)).toEqual([newer, older]);
  });

  test('#51: a status filter returns the matching task when it fits the page', async () => {
    const user = newUser();
    const first: string = data(await submit(user)).task_id;
    // Three newer tasks: the match lies beyond the first Query, which reads limit + 1 rows.
    await submit(user);
    await submit(user);
    await submit(user);
    await cancelTask(apiEvent(user, byId(first)));

    expect((await list(user, { status: 'CANCELLED', limit: '2' })).data.map((t) => t.task_id)).toEqual([first]);
  });

  // The deploy that adds UserCreatedAtIndex updates the handler while DynamoDB is still
  // building the index, and an index cannot be queried until it is ACTIVE. This walks a
  // table through that deploy: no such index, the index being created, the index ACTIVE.
  test('#51: the list reads UserStatusIndex until UserCreatedAtIndex is ACTIVE, then lists newest first', async () => {
    let listBefore51!: typeof listTasks;
    jest.isolateModules(() => {
      const current = process.env.TASK_TABLE_NAME;
      process.env.TASK_TABLE_NAME = TASKS_BEFORE_51;
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a second copy of the handler, bound to this table when it loads
      listBefore51 = require('../../src/handlers/list-tasks').handler;
      process.env.TASK_TABLE_NAME = current;
    });
    const doc = makeDocClient();
    const indexStatus = async () => (await doc.send(new DescribeTableCommand({ TableName: TASKS_BEFORE_51 })))
      .Table?.GlobalSecondaryIndexes?.find((index) => index.IndexName === TaskTable.USER_CREATED_AT_INDEX)?.IndexStatus;
    const ids = (page: { data: { task_id: string }[] }) => page.data.map((t) => t.task_id);

    // UserStatusIndex sorts by status before time, so its order is not newest first here.
    const user = newUser();
    const tasks = [['oldest', 'RUNNING'], ['middle', 'COMPLETED'], ['newest', 'SUBMITTED']];
    for (const [day, [taskId, status]] of tasks.entries()) {
      const createdAt = `2026-01-0${day + 1}T00:00:00.000Z`;
      await doc.send(new PutCommand({
        TableName: TASKS_BEFORE_51,
        Item: { task_id: taskId, user_id: user, status, repo: REPO, created_at: createdAt, status_created_at: `${status}#${createdAt}` },
      }));
    }
    const byStatus = ['newest', 'oldest', 'middle'];

    // 1. No such index: the list is read from UserStatusIndex, with cursors of that index.
    const first = await list(user, { limit: '2' }, listBefore51);
    const cursor = first.pagination.next_token ?? '';
    expect(Buffer.from(cursor, 'base64').toString('utf-8')).toContain('"status_created_at"');
    const second = await list(user, { limit: '2', next_token: cursor }, listBefore51);
    expect([...ids(first), ...ids(second)]).toEqual(byStatus);

    try {
      // 2. The index is being created (the emulator holds it in CREATING for about 3 seconds).
      // The status only moves forward, so CREATING after the list means CREATING during it.
      await addIndex(TASKS_BEFORE_51, TaskTable.USER_CREATED_AT_INDEX);
      const whileCreating = await list(user, undefined, listBefore51);
      expect(await indexStatus()).toBe('CREATING');
      expect(ids(whileCreating)).toEqual(byStatus);

      // 3. The index is ACTIVE: newest first, and a cursor issued earlier still finishes its list.
      while (await indexStatus() !== 'ACTIVE') await pause(250);
      expect(ids(await list(user, undefined, listBefore51))).toEqual(['newest', 'middle', 'oldest']);
      expect(ids(await list(user, { limit: '2', next_token: cursor }, listBefore51))).toEqual(['middle']);
    } finally {
      // A table cannot be deleted while one of its indexes is being created.
      while (await indexStatus() === 'CREATING') await pause(250);
    }
  }, 30_000);

  // The agent closes an approval request itself. A row is left PENDING when it cannot: its
  // container or MicroVM is gone by the end of the window. Nothing deletes
  // such a row here (the harness leaves TTL off), and on AWS the deletion takes days.
  test('#1043: pending lists the request that can still be decided, not the one whose window has passed', async () => {
    const user = newUser();
    const doc = makeDocClient();
    /** A PENDING approval row shaped like the one the agent's gate writes, created `ageSeconds` ago. */
    const request = (requestId: string, ageSeconds: number) => {
      const created = Math.floor(Date.now() / 1000) - ageSeconds;
      return doc.send(new PutCommand({
        TableName: process.env.TASK_APPROVALS_TABLE_NAME,
        Item: {
          task_id: `task-${requestId}`,
          request_id: requestId,
          user_id: user,
          repo: REPO,
          status: 'PENDING',
          tool_name: 'Bash',
          tool_input_preview: 'git push --force',
          reason: 'force_push_any',
          severity: 'medium',
          matching_rule_ids: ['force_push_any'],
          created_at: new Date(created * 1000).toISOString().replace('.000Z', 'Z'),
          timeout_s: APPROVAL_TIMEOUT_S,
          // The window plus the agent's two minutes of margin: already past for the first row.
          ttl: created + APPROVAL_TIMEOUT_S + 120,
        },
      }));
    };
    await request('passed', 3600);
    await request('open', 10);

    const listed = await getPending(apiEvent(user));

    expect(listed.statusCode).toBe(200);
    // The handler can tell the two apart only if created_at and timeout_s reach it
    // through the projection of the index it reads.
    expect(data(listed).pending).toMatchObject([{ request_id: 'open', timeout_s: APPROVAL_TIMEOUT_S }]);
  });

  test('scoreboard: a finished task counts in the period of its finish time, in either timestamp form', async () => {
    const user = newUser();
    // The handler reads the clock after this does, so its bounds lie a moment later than
    // these: a minute from a bound is far more than passes between the two readings.
    const from = Date.now() - RANGE_DAYS * DAY_MS;
    const previousFrom = from - RANGE_DAYS * DAY_MS;
    for (const status of TERMINAL_STATUSES) {
      for (const stamp of [platformStamp, agentStamp]) {
        for (const at of [from + MINUTE_MS, from - MINUTE_MS, previousFrom + MINUTE_MS, previousFrom - MINUTE_MS]) {
          await seedTask(user, status, stamp(at));
        }
      }
    }
    // In neither period: a task that has not finished, and a finished task of someone else.
    await seedTask(user, 'RUNNING', platformStamp(from + MINUTE_MS));
    await seedTask(newUser(), 'COMPLETED', platformStamp(from + MINUTE_MS));

    const { truncated, current, previous } = await scoreboard(user);

    // Per status and form, the first time lies in the current period, the next two in the
    // previous one and the last before it.
    expect(truncated).toBe(false);
    expect(current).toMatchObject({ finished: 8, outcomes: { no_new_pr: 2, failed: 2, cancelled: 2, timed_out: 2 } });
    expect(previous).toMatchObject({ finished: 16, outcomes: { no_new_pr: 4, failed: 4, cancelled: 4, timed_out: 4 } });
  });

  // No single task can show every field: an answer counts only without a pull request,
  // `workflow_ref` only without the pin, `updated_at` only without `completed_at`.
  test('scoreboard: every field of the projection reaches a number', async () => {
    const user = newUser();
    // The first task was created yesterday, on a whole second, so that the agent's form of
    // a time below loses nothing. `at` counts seconds from then.
    const start = Math.floor(Date.now() / 1000) * 1000 - DAY_MS;
    const at = (seconds: number): number => start + seconds * 1000;
    const newTask = { id: 'coding/new-task-v1', version: '1.0.0' };
    const pullRequest = (number: number): string => `https://github.com/${REPO}/pull/${number}`;

    // New work that waited in the queue, stopped twice for an approval and ended in a verified pull request.
    const verified = await seedTask(user, 'COMPLETED', agentStamp(at(1800)), {
      repo: REPO,
      resolved_workflow: newTask,
      queued_at: platformStamp(at(1)),
      started_at: platformStamp(at(41)),
      // A later write moved `updated_at`: the lead time tells which of the two times was read.
      updated_at: platformStamp(at(1860)),
      pr_url: pullRequest(12),
      build_passed: true,
      cost_usd: '3.75',
      approval_gate_count: 2,
      // What the hourly read of GitHub recorded: merged an hour after the task was created, first
      // reviewed 15 minutes after it finished, with one change request. GitHub's times are whole seconds.
      pr_state: 'merged',
      pr_closed_at: agentStamp(at(3600)),
      pr_first_review_at: agentStamp(at(2700)),
      pr_changes_requested: 1,
    });
    // A follow-up that changed the code of that pull request, started with every approval granted
    // in advance. It stores the number of the pull request, not its URL.
    const followUp = await seedTask(user, 'COMPLETED', agentStamp(at(5400)), {
      repo: REPO,
      resolved_workflow: { id: 'coding/pr-iteration-v1', version: '1.0.0' },
      started_at: platformStamp(at(3630)),
      pr_number: 12,
      code_changed: true,
      cost_usd: '1.5',
      initial_approvals: ['all_session'],
    });
    // The agent asked a question instead of changing code. Only the raw ref says what this record ran.
    const question = await seedTask(user, 'COMPLETED', agentStamp(at(9000)), {
      repo: REPO,
      workflow_ref: 'coding/new-task-v1',
      started_at: platformStamp(at(7230)),
      code_changed: false,
      answer_text: 'Which environment should this deploy to?',
      cost_usd: '0.5',
    });
    // An integration node opens a pull request too, but it merges the branches of other tasks.
    const integration = await seedTask(user, 'COMPLETED', agentStamp(at(12600)), {
      repo: REPO,
      resolved_workflow: newTask,
      channel_metadata: { orchestration_sub_issue_id: `issue-1${INTEGRATION_NODE_SUFFIX}` },
      started_at: platformStamp(at(10830)),
      pr_url: pullRequest(13),
      build_passed: true,
      cost_usd: '2',
    });
    // Stopped by a guardrail before it started. A record without `completed_at`: `updated_at` is its finish time.
    const stopped = await seedTask(user, 'FAILED', platformStamp(at(14400)), {
      repo: REPO,
      resolved_workflow: newTask,
      completed_at: undefined,
      error_message: 'Hydration failed: Error: Guardrail blocked: Task description blocked by content policy: PROMPT_ATTACK',
    });
    // New work of an orchestration, which its record names at the top level: a verified pull
    // request like the first, except that the hourly read of GitHub does not follow it.
    const orchestrated = await seedTask(user, 'COMPLETED', agentStamp(at(16200)), {
      repo: REPO,
      resolved_workflow: newTask,
      orchestration_id: 'orch_1',
      started_at: platformStamp(at(14441)),
      pr_url: pullRequest(14),
      build_passed: true,
      cost_usd: '1',
    });
    // A field added to the list needs a task above that sets it, and a number below that shows it.
    const seeded = Object.keys({ ...verified, ...followUp, ...question, ...integration, ...stopped, ...orchestrated });
    expect(SCOREBOARD_TASK_FIELDS.filter((field) => !seeded.includes(field))).toEqual([]);

    const { current, open_over_7d } = await scoreboard(user);

    // Beside each number, the fields it is wrong without.
    expect(current).toMatchObject({
      finished: 6, // status, updated_at
      outcomes: { verified_pr: 2, unverified_pr: 0, no_new_pr: 3, failed: 1, cancelled: 0, timed_out: 0 }, // resolved_workflow, pr_url, build_passed, channel_metadata
      time_to_verified_pr_s: { p50: 1800, p90: 1800, count: 2 }, // created_at, completed_at
      wait_p50_s: 41, // started_at
      queued: { count: 1, total: 5 }, // queued_at
      verified: { count: 2, total: 4 }, // workflow_ref
      not_reworked: { count: 1, total: 2 }, // repo, pr_number
      untouched: { count: 1, total: 4 },
      touchpoints: { approve: 2, clarify: 1, follow_up: 1, cancel: 0 }, // approval_gate_count, code_changed, answer_text
      spend_usd: 8.75, // cost_usd
      uncosted: 0,
      guardrail_stops: { count: 1, task_ids: [stopped.task_id] }, // error_message, task_id
      blanket_approvals: { count: 1, task_ids: [followUp.task_id] }, // initial_approvals
      gated: { count: 1, total: 5 },
      // One of the two new pull requests: the orchestration's is not followed, and is in none of the four.
      pull_requests: { merged: 1, closed: 0, open: 0, unread: 0 }, // pr_state, pr_closed_at, orchestration_id
      // The follow-up finished after the merge: only the change request sent the pull request back.
      merged_clean: { count: 0, total: 1 }, // pr_changes_requested
      time_to_merge_s: { p50: 3600, p90: 3600, count: 1 },
      first_review_s: { p50: 900, p90: 900, count: 1 }, // pr_first_review_at
    });
    // Every task finished yesterday: no pull request is old enough to have been open for more than 7 days.
    expect(open_over_7d).toEqual({ count: 0, task_ids: [] });
  });

  test('scoreboard: with a repository, the numbers are those of its tasks, whatever the letter case of its name', async () => {
    const user = newUser();
    const hourAgo = platformStamp(Date.now() - 3600 * 1000);
    const newTask = { id: 'coding/new-task-v1', version: '1.0.0' };
    const verified = (repo: string, number: number): Partial<TaskRecord> =>
      ({ repo, resolved_workflow: newTask, pr_url: `https://github.com/${repo}/pull/${number}`, build_passed: true });
    // Two tasks of one repository, whose name the records hold in two letter cases, and one of
    // another, whose name starts with it: the filter takes whole names.
    await seedTask(user, 'COMPLETED', hourAgo, verified(REPO, 21));
    await seedTask(user, 'FAILED', hourAgo, { repo: 'Acme/Widgets', resolved_workflow: newTask });
    await seedTask(user, 'COMPLETED', hourAgo, verified('acme/widgets-api', 22));

    const every = await scoreboard(user);
    const ofWidgets = await scoreboard(user, 'ACME/WIDGETS');

    expect(every.current).toMatchObject({ finished: 3, outcomes: { verified_pr: 2, failed: 1 }, verified: { count: 2, total: 3 } });
    expect(ofWidgets.current).toMatchObject({ finished: 2, outcomes: { verified_pr: 1, failed: 1 }, verified: { count: 1, total: 2 } });
  });

  test('scoreboard: a status that does not fit one page of the index is read whole', async () => {
    const user = newUser();
    const hourAgo = Date.now() - 3600 * 1000;
    for (let i = 0; i < LARGE_TASKS; i++) {
      await seedTask(user, 'COMPLETED', platformStamp(hourAgo + i), { task_description: 'x'.repeat(LARGE_TASK_BYTES) });
    }
    // The premise: one page does not hold them all, whatever the read projects.
    const firstPage = await ddb.send(new QueryCommand({
      TableName: process.env.TASK_TABLE_NAME,
      IndexName: TaskTable.USER_STATUS_INDEX,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': user },
      Select: 'COUNT',
    }));
    expect(firstPage.Count).toBeLessThan(LARGE_TASKS);

    const { truncated, current } = await scoreboard(user);

    expect(truncated).toBe(false);
    expect(current.finished).toBe(LARGE_TASKS);
  });

  test('scoreboard: a status beyond the page cap is reported from the second after the read stopped', async () => {
    const user = newUser();
    const start = Math.floor(Date.now() / 1000) * 1000 - 3600 * 1000;
    // One task a second, a quarter of a second into it: no key holds the time of a whole second.
    for (let i = 0; i < CUT_TASKS; i++) {
      await seedTask(user, 'COMPLETED', platformStamp(start + i * 1000 + 250), { task_description: 'x'.repeat(LARGE_TASK_BYTES) });
    }
    // Another status, read whole: one task older than every task the read can stop at, one newer.
    await seedTask(user, 'FAILED', platformStamp(start + 500));
    await seedTask(user, 'FAILED', platformStamp(start + CUT_TASKS * 1000));

    const { truncated, current, previous, open_over_7d } = await scoreboard(user);

    expect(truncated).toBe(true);
    expect(previous).toBeNull();
    // The pull requests open for more than 7 days are counted over both periods: not over a read that was cut.
    expect(open_over_7d).toBeNull();
    // The read stopped at the key of one task, and the scoreboard starts the second after it:
    // it holds the tasks that finished later, of either status.
    const stoppedAt = (Date.parse(current.from) - start) / 1000 - 1;
    expect(stoppedAt).toBeGreaterThanOrEqual(0);
    expect(current.outcomes).toMatchObject({ no_new_pr: CUT_TASKS - 1 - stoppedAt, failed: 1 });
  });

  test('scoreboard metrics: a finished task is claimed once, on the budget table, and its own record is left as it was', async () => {
    const user = newUser();
    const taskId: string = data(await submit(user)).task_id;
    expect((await cancelTask(apiEvent(user, byId(taskId)))).statusCode).toBe(200);
    const cancelled = await storedTask(taskId);

    // The record of the cancel, and its redelivery: neither image is written back.
    const first = await publishMetrics(cancelled);
    const second = await publishMetrics(cancelled);
    const marker = await ddb.send(new GetCommand({
      TableName: process.env.BUDGET_TABLE_NAME,
      Key: { scope_key: `TASK#${taskId}`, period: 'METRICS' },
      ConsistentRead: true,
    }));

    expect(first.published).toBe(true);
    const line = JSON.parse(first.written);
    expect(line.task_id).toBe(taskId);
    // A cancel by a person: the handler stores no message, and the scoreboard reads that as the touchpoint.
    expect(line).toMatchObject({
      Outcome: 'cancelled',
      Work: 'coding',
      HumanTouchpoints: 1,
      UntouchedVerifiedPrs: 0,
      user_id: user,
      repo: REPO,
      workflow: 'coding/new-task-v1',
    });
    expect(line).not.toHaveProperty('CostUsd');
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe('ABCA/Factory');
    expect(await storedTask(taskId)).toEqual(cancelled);
    expect(marker.Item).toMatchObject({ scope_key: `TASK#${taskId}`, period: 'METRICS' });
    expect(second).toEqual({ published: false, written: '' });
  });

  test('scoreboard metrics: the record of a task that the table does not hold claims nothing and creates no item', async () => {
    const taskId = `task-${randomUUID()}`;

    const result = await publishMetrics({ task_id: { S: taskId }, status: { S: 'COMPLETED' }, completed_at: { S: platformStamp(Date.now()) } });
    const marker = await ddb.send(new GetCommand({
      TableName: process.env.BUDGET_TABLE_NAME,
      Key: { scope_key: `TASK#${taskId}`, period: 'METRICS' },
      ConsistentRead: true,
    }));

    expect(result).toEqual({ published: false, written: '' });
    expect(await storedTask(taskId)).toBeUndefined();
    expect(marker.Item).toBeUndefined();
  });
});
