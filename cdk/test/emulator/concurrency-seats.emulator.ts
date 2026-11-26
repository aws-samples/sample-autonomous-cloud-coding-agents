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

import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskStatus } from '../../src/constructs/task-status';
import { TaskTable } from '../../src/constructs/task-table';
import { UserConcurrencyTable } from '../../src/constructs/user-concurrency-table';

const MAX_SEATS = 3;

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
import { apiEvent, emulatorTables } from './harness';

const ddb = makeDocClient();

const newUser = (): string => `user-${randomUUID()}`;

async function submitted(userId: string): Promise<TaskRecord> {
  const result = await createTask(apiEvent(userId, { httpMethod: 'POST', body: JSON.stringify({ task_description: 'Summarize the open issues' }) }));
  expect(result.statusCode).toBe(201);
  return loadTask(JSON.parse(result.body).data.task_id);
}

async function running(userId: string): Promise<string> {
  const task = await submitted(userId);
  expect(await admissionControl(task)).toBe(true);
  await transitionTask(task.task_id, TaskStatus.SUBMITTED, TaskStatus.HYDRATING);
  await transitionTask(task.task_id, TaskStatus.HYDRATING, TaskStatus.RUNNING);
  return task.task_id;
}

async function complete(taskId: string): Promise<void> {
  await transitionTask(taskId, TaskStatus.RUNNING, TaskStatus.FINALIZING);
  await transitionTask(taskId, TaskStatus.FINALIZING, TaskStatus.COMPLETED);
}

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
    expect(await admissionControl({ user_id: user } as TaskRecord)).toBe(true);
    expect(await seats(user)).toBe(2);

    await reconcileConcurrency();

    expect(await seats(user)).toBe(1);
  });

  test.failing('#1003: a replayed finalize step does not release a second seat', async () => {
    const user = newUser();
    const done = await running(user);
    await running(user);
    await complete(done);

    await finalizeTask(done, { attempts: 1 }, user);
    await finalizeTask(done, { attempts: 1 }, user);

    expect(await seats(user)).toBe(1);
  });

  test.failing('the concurrency reconciler keeps the seat of a task awaiting approval', async () => {
    const user = newUser();
    const paused = await running(user);
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
