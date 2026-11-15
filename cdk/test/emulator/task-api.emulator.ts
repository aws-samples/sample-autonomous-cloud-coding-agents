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
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { apiEvent, emulatorTables } from './harness';
import { RepoTable } from '../../src/constructs/repo-table';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskTable } from '../../src/constructs/task-table';

// Handlers read their table names at module load, so the environment is set
// before any handler is imported. Names are unique to this file's run.
const run = randomUUID().slice(0, 8);
process.env.TASK_TABLE_NAME = `emu-${run}-tasks`;
process.env.TASK_EVENTS_TABLE_NAME = `emu-${run}-events`;
process.env.REPO_TABLE_NAME = `emu-${run}-repos`;

import { handler as cancelTask } from '../../src/handlers/cancel-task';
import { handler as createTask } from '../../src/handlers/create-task';
import { handler as getTask } from '../../src/handlers/get-task';
import { handler as getTaskEvents } from '../../src/handlers/get-task-events';
import { handler as listTasks } from '../../src/handlers/list-tasks';
import { makeDocClient } from '../../src/handlers/shared/ua';

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
async function list(userId: string, query?: Record<string, string>) {
  const result = await listTasks(apiEvent(userId, { queryStringParameters: query ?? null }));
  expect(result.statusCode).toBe(200);
  return JSON.parse(result.body) as { data: { task_id: string; status: string }[]; pagination: { next_token: string | null; has_more: boolean } };
}

describe('task API against the AWS Emulator', () => {
  emulatorTables((stack) => {
    new TaskTable(stack, 'Tasks', { tableName: process.env.TASK_TABLE_NAME });
    new TaskEventsTable(stack, 'Events', { tableName: process.env.TASK_EVENTS_TABLE_NAME });
    new RepoTable(stack, 'Repos', { tableName: process.env.REPO_TABLE_NAME });
  }, () => {
    // The row a Blueprint writes at deploy time; create-task gates on it.
    const now = new Date().toISOString();
    return makeDocClient().send(new PutCommand({
      TableName: process.env.REPO_TABLE_NAME,
      Item: { repo: REPO, status: 'active', onboarded_at: now, updated_at: now },
    }));
  });

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

    // The cancel rewrote the index sort key, so the task has moved between status filters.
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

  // KNOWN FAILURES: executable witnesses for #51, which was found by hand on a
  // deployed stack. `list-tasks` queries UserStatusIndex, whose sort key is
  // `{status}#{timestamp}`, so results come back grouped by status rather than
  // newest first, and a status filter is applied after `Limit` has already cut
  // the page (the short page does carry a next_token, which `bgagent list` does
  // not follow). Kept as `test.failing` so the suite stays green and flags the
  // day the handler is fixed. Each was run once as a plain `test` to confirm it
  // fails on its last assertion and not on setup.
  test.failing('#51: list returns the newest task first (API_CONTRACT.md: "ordered by created_at descending")', async () => {
    const user = newUser();
    const older: string = data(await submit(user)).task_id;
    await pause(5);
    const newer: string = data(await submit(user)).task_id;
    await cancelTask(apiEvent(user, byId(newer)));

    expect((await list(user)).data.map((t) => t.task_id)).toEqual([newer, older]);
  });

  test.failing('#51: a status filter returns the matching task when it fits the page', async () => {
    const user = newUser();
    const first: string = data(await submit(user)).task_id;
    await submit(user);
    await submit(user);
    await cancelTask(apiEvent(user, byId(first)));

    expect((await list(user, { status: 'CANCELLED', limit: '2' })).data.map((t) => t.task_id)).toEqual([first]);
  });
});
