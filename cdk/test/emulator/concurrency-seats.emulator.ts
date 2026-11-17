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
 * Per-user concurrency seats against the AWS Emulator (ADR-013 Tier 2a).
 *
 * A seat is one unit of `active_count` in UserConcurrencyTable: admission takes
 * it with a conditional increment and finalization gives it back. The durable
 * `orchestrate-task` entry point needs the Lambda durable-execution service, so
 * these tests call the functions its steps call (`shared/orchestrator.ts`), plus
 * the real `create-task`, `get-task` and `reconcile-concurrency` handlers.
 *
 * Runs only through `jest.emulator.config.js` (see ./harness).
 */

import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { apiEvent, emulatorTables } from './harness';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskStatus } from '../../src/constructs/task-status';
import { TaskTable } from '../../src/constructs/task-table';
import { UserConcurrencyTable } from '../../src/constructs/user-concurrency-table';

const MAX_SEATS = 3;

// Handlers read their configuration at module load, so the environment is set
// before any handler is imported. Names are unique to this file's run.
const run = randomUUID().slice(0, 8);
process.env.TASK_TABLE_NAME = `emu-${run}-tasks`;
process.env.TASK_EVENTS_TABLE_NAME = `emu-${run}-events`;
process.env.USER_CONCURRENCY_TABLE_NAME = `emu-${run}-seats`;
process.env.MAX_CONCURRENT_TASKS_PER_USER = String(MAX_SEATS);

import { handler as createTask } from '../../src/handlers/create-task';
import { handler as getTask } from '../../src/handlers/get-task';
import { handler as reconcileConcurrency } from '../../src/handlers/reconcile-concurrency';
import { admissionControl, finalizeTask, loadTask, queueTask, transitionTask } from '../../src/handlers/shared/orchestrator';
import type { TaskRecord } from '../../src/handlers/shared/types';
import { makeDocClient } from '../../src/handlers/shared/ua';

const ddb = makeDocClient();

/** A user no other test has written for, so tests need no cleanup between them. */
const newUser = (): string => `user-${randomUUID()}`;

/** Submit a repo-less task through the real create-task handler and load its record. */
async function submitted(userId: string): Promise<TaskRecord> {
  const result = await createTask(apiEvent(userId, { httpMethod: 'POST', body: JSON.stringify({ task_description: 'Summarize the open issues' }) }));
  expect(result.statusCode).toBe(201);
  return loadTask(JSON.parse(result.body).data.task_id);
}

/** Take a submitted task as far as RUNNING the way the orchestrator's steps do: admit, hydrate, start. */
async function running(userId: string): Promise<string> {
  const task = await submitted(userId);
  expect(await admissionControl(task)).toBe(true);
  await transitionTask(task.task_id, TaskStatus.SUBMITTED, TaskStatus.HYDRATING);
  await transitionTask(task.task_id, TaskStatus.HYDRATING, TaskStatus.RUNNING);
  return task.task_id;
}

/** The agent's terminal write: RUNNING to COMPLETED. */
async function complete(taskId: string): Promise<void> {
  await transitionTask(taskId, TaskStatus.RUNNING, TaskStatus.FINALIZING);
  await transitionTask(taskId, TaskStatus.FINALIZING, TaskStatus.COMPLETED);
}

/** Seats the user holds according to UserConcurrencyTable. */
async function seats(userId: string): Promise<number> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: process.env.USER_CONCURRENCY_TABLE_NAME,
    Key: { user_id: userId },
    ConsistentRead: true,
  }));
  return Item?.active_count ?? 0;
}

describe('concurrency seats against the AWS Emulator', () => {
  emulatorTables((stack) => {
    new TaskTable(stack, 'Tasks', { tableName: process.env.TASK_TABLE_NAME });
    new TaskEventsTable(stack, 'Events', { tableName: process.env.TASK_EVENTS_TABLE_NAME });
    new UserConcurrencyTable(stack, 'Seats', { tableName: process.env.USER_CONCURRENCY_TABLE_NAME });
  });

  test('racing admissions never exceed the cap, and the losers queue in FIFO order', async () => {
    const user = newUser();
    const tasks: TaskRecord[] = [];
    for (let i = 0; i < MAX_SEATS + 2; i++) tasks.push(await submitted(user));

    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- fixed-size fixture, not input-derived
    const admitted = await Promise.all(tasks.map((task) => admissionControl(task)));

    expect(admitted.filter(Boolean)).toHaveLength(MAX_SEATS);
    expect(await seats(user)).toBe(MAX_SEATS);

    // The orchestrator parks a task that lost admission; GET then ranks it among the user's queued tasks.
    const losers = tasks.filter((_, i) => !admitted[i]);
    for (const task of losers) expect(await queueTask(task)).toBe(true);
    const positions: number[] = [];
    for (const task of losers) {
      const result = await getTask(apiEvent(user, { pathParameters: { task_id: task.task_id } }));
      positions.push(JSON.parse(result.body).data.queue_position);
    }
    const fifo = losers.map((task) => `${task.created_at}#${task.task_id}`);
    expect(positions).toEqual(fifo.map((key) => [...fifo].sort().indexOf(key) + 1));
    expect(await seats(user)).toBe(MAX_SEATS);
  });

  test('finalizing a completed task gives back exactly its own seat', async () => {
    const user = newUser();
    const done = await running(user);
    await running(user);
    expect(await seats(user)).toBe(2);

    await complete(done);
    await finalizeTask(done, { attempts: 1 }, user);

    expect(await seats(user)).toBe(1);
  });

  test('the concurrency reconciler repairs a leaked seat from the real index', async () => {
    const user = newUser();
    await running(user);
    // A seat with no live task behind it, as a finalize step that never ran leaves.
    expect(await admissionControl({ user_id: user } as TaskRecord)).toBe(true);
    expect(await seats(user)).toBe(2);

    await reconcileConcurrency();

    expect(await seats(user)).toBe(1);
  });

  // KNOWN FAILURES: executable witnesses for two seat defects on main, reproduced
  // here with real conditional writes rather than mocked `send` calls. Kept as
  // `test.failing` so the suite stays green and flags the day the fix lands (open
  // PR #1009 addresses both). Each was run once as a plain `test` to confirm it
  // fails on its last assertion and not on setup; the passing tests above cover
  // the same setup.
  test.failing('#1003: a replayed finalize step does not release a second seat', async () => {
    const user = newUser();
    const done = await running(user);
    await running(user);
    await complete(done);

    // Durable execution re-runs a step whose result it did not record.
    await finalizeTask(done, { attempts: 1 }, user);
    await finalizeTask(done, { attempts: 1 }, user);

    expect(await seats(user)).toBe(1);
  });

  // No issue reports this one: reconcile-concurrency counts four hard-coded
  // statuses, while the design and ACTIVE_STATUSES say a task awaiting approval
  // holds its seat.
  test.failing('the concurrency reconciler keeps the seat of a task awaiting approval', async () => {
    const user = newUser();
    const paused = await running(user);
    // The Python agent is the only writer of this status; this writes the status
    // attributes its approval-request transition writes.
    await ddb.send(new UpdateCommand({
      TableName: process.env.TASK_TABLE_NAME,
      Key: { task_id: paused },
      UpdateExpression: 'SET #status = :awaiting, status_created_at = :sca',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':awaiting': TaskStatus.AWAITING_APPROVAL,
        ':sca': `${TaskStatus.AWAITING_APPROVAL}#${new Date().toISOString()}`,
      },
    }));

    await reconcileConcurrency();

    expect(await seats(user)).toBe(1);
  });
});
