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
 * Opt-in real DynamoDB Local tests:
 * ABCA_DDB_LOCAL_ENDPOINT=http://127.0.0.1:<port> mise run testf -- task-concurrency-local
 * The endpoint is restricted to loopback and every client uses dummy credentials.
 */
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.ABCA_DDB_LOCAL_ENDPOINT;
if (endpoint && (new URL(endpoint).hostname !== '127.0.0.1' || new URL(endpoint).protocol !== 'http:')) {
  throw new Error('Capacity integration tests require an http://127.0.0.1 DynamoDB Local endpoint');
}
const mockBeforeSend = jest.fn();
const mockAfterSend = jest.fn();
const mockClients: DynamoDBDocumentClient[] = [];
jest.mock('../../../src/handlers/shared/ua', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/ua');
  return {
    ...actual,
    makeDocClient: () => {
      const client = actual.makeDocClient({
        endpoint: process.env.ABCA_DDB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:1',
        region: 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
      const send = client.send.bind(client);
      client.send = async (command: unknown) => {
        await mockBeforeSend(command);
        const result = await send(command);
        await mockAfterSend(command, result);
        return result;
      };
      mockClients.push(client);
      return client;
    },
  };
});

const suffix = randomUUID();
const tasks = `capacity-tasks-${suffix}`;
const counters = `capacity-counters-${suffix}`;
const events = `capacity-events-${suffix}`;
Object.assign(process.env, {
  TASK_TABLE_NAME: tasks,
  USER_CONCURRENCY_TABLE_NAME: counters,
  TASK_EVENTS_TABLE_NAME: events,
  MEMORY_ID: '',
});

import { handler as reconcile } from '../../../src/handlers/reconcile-concurrency';
import { failTask, finalizeTask } from '../../../src/handlers/shared/orchestrator';
import { acquireTaskSlot, releaseTaskSlot } from '../../../src/handlers/shared/task-concurrency';

const raw = new DynamoDBClient({
  endpoint: endpoint ?? 'http://127.0.0.1:1',
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const admin = DynamoDBDocumentClient.from(raw);
const local = endpoint ? describe : describe.skip;
jest.setTimeout(30_000);

local('task capacity against DynamoDB Local', () => {
  beforeAll(async () => {
    for (const [name, key] of [[tasks, 'task_id'], [counters, 'user_id'], [events, 'task_id']]) {
      await raw.send(new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: key, AttributeType: 'S' },
          ...(name === events ? [{ AttributeName: 'event_id', AttributeType: 'S' as const }] : []),
        ],
        KeySchema: [
          { AttributeName: key, KeyType: 'HASH' },
          ...(name === events ? [{ AttributeName: 'event_id', KeyType: 'RANGE' as const }] : []),
        ],
      }));
    }
  });
  beforeEach(async () => {
    mockBeforeSend.mockReset();
    mockAfterSend.mockReset();
    for (const [name, key] of [[tasks, 'task_id'], [counters, 'user_id'], [events, 'task_id']]) {
      const page = await admin.send(new ScanCommand({ TableName: name }));
      for (const item of page.Items ?? []) {
        await admin.send(new DeleteCommand({
          TableName: name,
          Key: { [key]: item[key], ...(name === events && { event_id: item.event_id }) },
        }));
      }
    }
  });
  afterAll(async () => {
    for (const name of [tasks, counters, events]) await raw.send(new DeleteTableCommand({ TableName: name }));
    for (const client of mockClients) client.destroy();
    raw.destroy();
  });

  async function seed(id: string, initialStatus = 'SUBMITTED', user = 'user') {
    await admin.send(new PutCommand({
      TableName: tasks,
      Item: {
        task_id: id, user_id: user, status: initialStatus, memory_written: true,
      },
    }));
  }
  async function status(id: string, value: string) {
    await admin.send(new UpdateCommand({
      TableName: tasks,
      Key: { task_id: id },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': value },
    }));
  }
  async function task(id: string) {
    return (await admin.send(new GetCommand({
      TableName: tasks, Key: { task_id: id }, ConsistentRead: true,
    }))).Item!;
  }
  async function count() {
    return (await admin.send(new GetCommand({
      TableName: counters, Key: { user_id: 'user' }, ConsistentRead: true,
    }))).Item?.active_count ?? 0;
  }
  async function twoSeats() {
    await seed('one');
    await seed('two');
    await acquireTaskSlot('one', 'user', 3);
    await acquireTaskSlot('two', 'user', 3);
  }

  test('crash replay of real finalization preserves the other task reservation', async () => {
    await twoSeats();
    await status('one', 'COMPLETED');
    await finalizeTask('one', { attempts: 10 }, 'user');
    await finalizeTask('one', { attempts: 10 }, 'user');
    expect(await count()).toBe(1);
    expect((await task('one')).concurrency_slot.state).toBe('released');
    expect((await task('two')).concurrency_slot.state).toBe('held');
  });

  test('simultaneous admission of one task creates exactly one reservation', async () => {
    await seed('one');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireTaskSlot('one', 'user', 3)));
    expect(results.some(result => result.status === 'fulfilled' && result.value)).toBe(true);
    expect(await acquireTaskSlot('one', 'user', 3)).toBe(true);
    expect(await count()).toBe(1);
  });

  test('different tasks cannot exceed the admission cap', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) await seed(id);
    await Promise.allSettled(ids.map(id => acquireTaskSlot(id, 'user', 2)));
    // Retry any transaction conflicts serially, as durable execution does.
    for (const id of ids) await acquireTaskSlot(id, 'user', 2);
    expect(await count()).toBe(2);
    // Four fixed fixture reads; no input-dependent fan-out.
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const rows = await Promise.all([task('a'), task('b'), task('c'), task('d')]);
    expect(rows.filter(row => row.concurrency_slot?.state === 'held')).toHaveLength(2);
  });

  test.each(['acquire', 'release'])('a lost committed %s response is recovered from the marker', async (operation) => {
    await seed('one');
    if (operation === 'release') {
      await acquireTaskSlot('one', 'user', 3);
      await status('one', 'FAILED');
    }
    mockAfterSend.mockImplementationOnce((command) => {
      if (command.constructor.name === 'GetCommand') {
        mockAfterSend.mockImplementationOnce(() => { throw new Error('transaction response lost'); });
      }
    });
    if (operation === 'acquire') await acquireTaskSlot('one', 'user', 3);
    else await releaseTaskSlot('one', 'user');
    expect(await count()).toBe(operation === 'acquire' ? 1 : 0);
    expect((await task('one')).concurrency_slot.state).toBe(operation === 'acquire' ? 'held' : 'released');
  });

  test('competing finalizers and direct cleanup only release once', async () => {
    await twoSeats();
    await status('one', 'CANCELLED');
    await Promise.allSettled([
      finalizeTask('one', { attempts: 0 }, 'user'),
      finalizeTask('one', { attempts: 0 }, 'user'),
      releaseTaskSlot('one', 'user'),
    ]);
    await releaseTaskSlot('one', 'user');
    expect(await count()).toBe(1);
  });

  test('start failure and replay release a held slot once', async () => {
    await twoSeats();
    await status('one', 'HYDRATING');
    await failTask('one', 'HYDRATING', 'start failed', 'user', true);
    await failTask('one', 'HYDRATING', 'start failed', 'user', true);
    expect(await count()).toBe(1);
    expect((await task('one')).status).toBe('FAILED');
  });

  test('approval waits retain capacity through reconciliation', async () => {
    await twoSeats();
    await status('one', 'AWAITING_APPROVAL');
    expect(await releaseTaskSlot('one', 'user')).toBe(false);
    await reconcile();
    expect(await count()).toBe(2);
  });

  test('queued and unadmitted terminal tasks cannot release another reservation', async () => {
    await seed('running');
    await acquireTaskSlot('running', 'user', 3);
    await seed('queued', 'QUEUED');
    await seed('cancelled', 'CANCELLED');
    expect(await acquireTaskSlot('queued', 'user', 3)).toBe(false);
    await releaseTaskSlot('queued', 'user');
    await releaseTaskSlot('cancelled', 'user');
    expect(await count()).toBe(1);
  });

  test('owner mismatch changes neither the reservation nor counter', async () => {
    await seed('one');
    await expect(acquireTaskSlot('one', 'someone-else', 3)).rejects.toThrow('owner');
    expect(await count()).toBe(0);
    expect((await task('one')).concurrency_slot).toBeUndefined();
  });

  test('cancellation between the read and admission transaction wins', async () => {
    await seed('one');
    mockBeforeSend.mockImplementation(async (command) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        mockBeforeSend.mockReset();
        await status('one', 'CANCELLED');
      }
    });
    expect(await acquireTaskSlot('one', 'user', 3)).toBe(false);
    expect(await count()).toBe(0);
  });

  test('an empty counter release preserves an admission that races into the empty-counter branch', async () => {
    await seed('one');
    await acquireTaskSlot('one', 'user', 3);
    await status('one', 'FAILED');
    await admin.send(new DeleteCommand({ TableName: counters, Key: { user_id: 'user' } }));
    await seed('two');
    mockBeforeSend.mockImplementation(async (command) => {
      if (command.constructor.name === 'TransactWriteCommand'
        && command.input.TransactItems[1].Update.UpdateExpression.includes('if_not_exists')) {
        mockBeforeSend.mockReset();
        await acquireTaskSlot('two', 'user', 3);
      }
    });
    await releaseTaskSlot('one', 'user');
    expect(await count()).toBe(1);
    expect((await task('one')).concurrency_slot.state).toBe('released');
    expect((await task('two')).concurrency_slot.state).toBe('held');
  });

  test('periodic cleanup recovers a crash between terminal status and release', async () => {
    await twoSeats();
    await status('one', 'TIMED_OUT');
    await reconcile();
    await finalizeTask('one', { attempts: 10 }, 'user');
    expect(await count()).toBe(1);
  });

  test('an ambiguous legacy active task prevents guessing a replacement count', async () => {
    await twoSeats();
    await seed('legacy', 'AWAITING_APPROVAL');
    await reconcile();
    expect(await count()).toBe(2);
    expect((await task('legacy')).concurrency_slot).toBeUndefined();
  });

  test('a revision change blocks stale repair even when the counter returns to its original number', async () => {
    await seed('one');
    await acquireTaskSlot('one', 'user', 3);
    await admin.send(new UpdateCommand({
      TableName: counters,
      Key: { user_id: 'user' },
      UpdateExpression: 'SET active_count = :zero',
      ExpressionAttributeValues: { ':zero': 0 },
    }));
    mockAfterSend.mockImplementation(async (command) => {
      if (command.constructor.name === 'ScanCommand' && command.input.TableName === tasks) {
        mockAfterSend.mockReset();
        await seed('two');
        await acquireTaskSlot('two', 'user', 3);
        await status('one', 'COMPLETED');
        await releaseTaskSlot('one', 'user');
      }
    });
    await reconcile();
    // Admission then release brought the count back to zero, but changed its
    // revision. The old scan must not write its answer into this new state.
    expect(await count()).toBe(0);
    await reconcile();
    expect(await count()).toBe(1);
  });
});
