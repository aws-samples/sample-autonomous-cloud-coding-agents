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

/** Real transaction conditions; loopback endpoint and dummy credentials only. */
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.ABCA_DDB_LOCAL_ENDPOINT;
if (process.env.CI === 'true' && !endpoint) throw new Error('CI requires ABCA_DDB_LOCAL_ENDPOINT');
if (endpoint && (new URL(endpoint).hostname !== '127.0.0.1' || new URL(endpoint).protocol !== 'http:')) {
  throw new Error('Approval integration tests require an http://127.0.0.1 endpoint');
}
const mockBeforeTransaction = jest.fn();
let mockClient: DynamoDBDocumentClient;
jest.mock('../../src/handlers/shared/ua', () => ({
  makeDocClient: () => ({
    send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) await mockBeforeTransaction();
      return mockClient.send(command as GetCommand);
    },
  }),
}));
const suffix = randomUUID();
const tasks = `approval-tasks-${suffix}`;
const approvals = `approval-requests-${suffix}`;
Object.assign(process.env, { TASK_TABLE_NAME: tasks, TASK_APPROVALS_TABLE_NAME: approvals });
import { recordWorkerRequest } from '../../src/handlers/request-approval';

const raw = new DynamoDBClient({
  endpoint: endpoint ?? 'http://127.0.0.1:1',
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
mockClient = DynamoDBDocumentClient.from(raw);
const local = endpoint ? describe : describe.skip;
jest.setTimeout(30_000);

local('Trusted approval writer against DynamoDB Local', () => {
  let taskId: string;
  const gate = 'gate';
  const row = () => ({
    task_id: taskId,
    request_id: gate,
    user_id: 'owner',
    repo: 'owner/repo',
    tool_name: 'Bash',
    tool_input_preview: '{"command":"git push"}',
    tool_input_sha256: 'a'.repeat(64),
    reason: 'Protected operation',
    severity: 'high',
    matching_rule_ids: ['protected'],
    status: 'PENDING',
    created_at: new Date().toISOString(),
    timeout_s: 0,
  });
  const create = () => recordWorkerRequest({
    operation: 'create', task_id: taskId, request_id: gate, worker_attempt_id: 'worker', approval: row(),
  });
  const timeout = () => recordWorkerRequest({
    operation: 'timeout', task_id: taskId, request_id: gate, worker_attempt_id: 'worker',
  });
  const read = async (table: string) => (await mockClient.send(new GetCommand({
    TableName: table,
    Key: { task_id: taskId, ...(table === approvals ? { request_id: gate } : {}) },
    ConsistentRead: true,
  }))).Item;
  const change = async (table: string, field: string, value: string, lease = false) =>
    mockClient.send(new UpdateCommand({
      TableName: table,
      Key: { task_id: lease ? `worker-lease#${taskId}` : taskId, ...(table === approvals ? { request_id: gate } : {}) },
      UpdateExpression: 'SET #field = :value',
      ExpressionAttributeNames: { '#field': field },
      ExpressionAttributeValues: { ':value': value },
    }));
  beforeAll(async () => {
    for (const table of [tasks, approvals]) {
      await raw.send(new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'task_id', AttributeType: 'S' },
          ...(table === approvals ? [{ AttributeName: 'request_id', AttributeType: 'S' as const }] : [])],
        KeySchema: [{ AttributeName: 'task_id', KeyType: 'HASH' },
          ...(table === approvals ? [{ AttributeName: 'request_id', KeyType: 'RANGE' as const }] : [])],
      }));
    }
  });
  afterAll(async () => {
    try { for (const table of [tasks, approvals]) await raw.send(new DeleteTableCommand({ TableName: table })); } finally { raw.destroy(); }
  });
  beforeEach(async () => {
    taskId = randomUUID();
    mockBeforeTransaction.mockReset();
    await mockClient.send(new PutCommand({
      TableName: tasks,
      Item: {
        task_id: taskId, status: 'RUNNING', user_id: 'owner', repo: 'owner/repo', compute_type: 'lambda-microvm',
      },
    }));
    await mockClient.send(new PutCommand({
      TableName: tasks,
      Item: {
        task_id: `worker-lease#${taskId}`, lease_state: 'ACTIVE', lease_attempt_id: 'worker', lease_user_id: 'owner',
      },
    }));
  });

  test('creates a durable pending request and its task pointer atomically', async () => {
    expect(await create()).toEqual({ ok: true });
    expect(await read(approvals)).toMatchObject({ status: 'PENDING', timeout_s: 0 });
    expect(await read(approvals)).not.toHaveProperty('ttl');
    expect(await read(tasks)).toMatchObject({ status: 'AWAITING_APPROVAL', awaiting_approval_request_id: gate });
  });
  test.each(['APPROVED', 'DENIED', 'CANCELLED'])('timeout preserves an existing %s decision', async status => {
    await create();
    await change(approvals, 'status', status);
    const before = await read(approvals);
    expect(await timeout()).toMatchObject({
      ok: false,
      code: 'TransactionCanceledException',
      cancellation_reasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    });
    expect(await read(approvals)).toEqual(before);
  });
  test('only pending requests can transition to a non-human timeout', async () => {
    await create();
    expect(await timeout()).toEqual({ ok: true });
    expect(await read(approvals)).toMatchObject({ status: 'TIMED_OUT' });
    expect(await read(approvals)).not.toHaveProperty('decision_source');
  });
  test('cancellation between read and write prevents both request and task changes', async () => {
    mockBeforeTransaction.mockImplementationOnce(() => change(tasks, 'status', 'CANCELLED'));
    expect(await create()).toMatchObject({ ok: false, code: 'TransactionCanceledException' });
    expect(await read(approvals)).toBeUndefined();
    expect(await read(tasks)).toMatchObject({ status: 'CANCELLED' });
  });
  test.each(['create', 'timeout'])('retirement revokes a stale worker during %s', async operation => {
    if (operation === 'timeout') await create();
    const before = await read(approvals);
    mockBeforeTransaction.mockImplementationOnce(() => change(tasks, 'lease_state', 'PARKED', true));
    const result = await (operation === 'create' ? create() : timeout());
    expect(result).toMatchObject({ ok: false, code: 'TransactionCanceledException' });
    expect(result.cancellation_reasons).toEqual([
      { Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' },
    ]);
    expect(await read(approvals)).toEqual(before);
  });
  test('a second request cannot replace the first while the task waits', async () => {
    await create();
    const result = await recordWorkerRequest({
      operation: 'create',
      task_id: taskId,
      request_id: 'replacement',
      worker_attempt_id: 'worker',
      approval: { ...row(), request_id: 'replacement' },
    });
    expect(result).toMatchObject({ ok: false, code: 'TransactionCanceledException' });
    expect(await read(tasks)).toMatchObject({ awaiting_approval_request_id: gate });
    expect((await mockClient.send(new GetCommand({
      TableName: approvals, Key: { task_id: taskId, request_id: 'replacement' },
    }))).Item).toBeUndefined();
  });
});
