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
 * Runs only through `jest.emulator.config.js` (see ./harness).
 */

import { randomUUID } from 'node:crypto';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { RepoTable } from '../../src/constructs/repo-table';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskTable } from '../../src/constructs/task-table';

// Handlers read their table names at module load, so the environment is set
// before any handler is imported. Names are unique to this file's run.
const run = randomUUID().slice(0, 8);
process.env.TASK_TABLE_NAME = `emu-${run}-tasks`;
process.env.TASK_EVENTS_TABLE_NAME = `emu-${run}-events`;
process.env.REPO_TABLE_NAME = `emu-${run}-repos`;
/** A task table as a stack has it before the deploy that adds UserCreatedAtIndex (#51). */
const TASKS_BEFORE_51 = `emu-${run}-tasks-before-51`;

import { handler as cancelTask } from '../../src/handlers/cancel-task';
import { handler as createTask } from '../../src/handlers/create-task';
import { handler as getTask } from '../../src/handlers/get-task';
import { handler as getTaskEvents } from '../../src/handlers/get-task-events';
import { handler as listTasks } from '../../src/handlers/list-tasks';
import { makeDocClient } from '../../src/handlers/shared/ua';
import { apiEvent, emulatorTables } from './harness';

const REPO = 'acme/widgets';
const CONCURRENT_CANCELS = 8;

/** A user no other test has written for, so tests need no cleanup between them. */
const newUser = (): string => `user-${randomUUID()}`;
const data = (result: APIGatewayProxyResult) => JSON.parse(result.body).data;
const byId = (taskId: string) => ({ pathParameters: { task_id: taskId } });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('task API against the AWS Emulator', () => {
  const addIndex = emulatorTables((stack) => {
    new TaskTable(stack, 'Tasks', { tableName: process.env.TASK_TABLE_NAME });
    new TaskTable(stack, 'TasksBefore51', { tableName: TASKS_BEFORE_51 });
    new TaskEventsTable(stack, 'Events', { tableName: process.env.TASK_EVENTS_TABLE_NAME });
    new RepoTable(stack, 'Repos', { tableName: process.env.REPO_TABLE_NAME });
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
});
