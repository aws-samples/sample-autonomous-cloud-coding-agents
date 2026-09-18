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

/** Opt-in DynamoDB Local: loopback endpoint and dummy credentials only. */
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.ABCA_DDB_LOCAL_ENDPOINT;
if (process.env.CI === 'true' && !endpoint) {
  throw new Error('CI requires ABCA_DDB_LOCAL_ENDPOINT; lifecycle transaction tests must not skip');
}
if (endpoint && (new URL(endpoint).hostname !== '127.0.0.1' || new URL(endpoint).protocol !== 'http:')) {
  throw new Error('Lifecycle integration tests require an http://127.0.0.1 DynamoDB Local endpoint');
}
const mockBeforeSend = jest.fn();
const mockAfterSend = jest.fn();
const mockClients: DynamoDBDocumentClient[] = [];
jest.mock('../../../src/handlers/shared/microvm-suspend-config', () => ({
  readMicrovmSuspendEnabled: async () => true,
}));
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
      client.send = async (command: unknown, options: unknown) => {
        await mockBeforeSend(command);
        const result = await send(command, options);
        await mockAfterSend(command, result);
        return result;
      };
      mockClients.push(client);
      return client;
    },
  };
});
const suffix = randomUUID();
const tasks = `lifecycle-tasks-${suffix}`;
const approvals = `lifecycle-approvals-${suffix}`;
Object.assign(process.env, { TASK_TABLE_NAME: tasks, TASK_APPROVALS_TABLE_NAME: approvals });
import { readMicrovmLifecycleSnapshot, saveMicrovmLifecycleIntent } from '../../../src/handlers/shared/microvm-lifecycle';
import { claimMicrovmStart, saveMicrovmImageCapability, saveMicrovmStartHandle } from '../../../src/handlers/shared/microvm-start';
import { superviseMicrovm, type MicrovmSupervisorState } from '../../../src/handlers/shared/microvm-supervisor';

const raw = new DynamoDBClient({
  endpoint: endpoint ?? 'http://127.0.0.1:1',
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const admin = DynamoDBDocumentClient.from(raw);
const local = endpoint ? describe : describe.skip;
jest.setTimeout(30_000);

local('MicroVM lifecycle against DynamoDB Local', () => {
  beforeAll(async () => {
    for (const name of [tasks, approvals]) {
      await raw.send(new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'task_id', AttributeType: 'S' },
          ...(name === approvals ? [{ AttributeName: 'request_id', AttributeType: 'S' as const }] : [])],
        KeySchema: [{ AttributeName: 'task_id', KeyType: 'HASH' },
          ...(name === approvals ? [{ AttributeName: 'request_id', KeyType: 'RANGE' as const }] : [])],
      }));
    }
  });
  beforeEach(async () => {
    mockBeforeSend.mockReset();
    mockAfterSend.mockReset();
    for (const name of [tasks, approvals]) {
      const result = await admin.send(new ScanCommand({ TableName: name }));
      for (const item of result.Items ?? []) {
        await admin.send(new DeleteCommand({
          TableName: name,
          Key: {
            task_id: item.task_id,
            ...(name === approvals ? { request_id: item.request_id } : {}),
          },
        }));
      }
    }
    await admin.send(new PutCommand({
      TableName: tasks,
      Item: {
        task_id: 'task',
        microvm_sleep_after_s: 30,
        user_id: 'user',
        status: 'AWAITING_APPROVAL',
        compute_type: 'lambda-microvm',
        session_id: 'vm',
        compute_metadata: {
          microvmId: 'vm',
          endpoint: 'https://vm.example',
          imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
          imageVersion: '3.0',
          lifecycleProtocol: '1',
        },
        awaiting_approval_request_id: 'gate',
      },
    }));
    await approval('gate');
  });
  afterAll(async () => {
    try { for (const name of [tasks, approvals]) await raw.send(new DeleteTableCommand({ TableName: name })); } finally { for (const client of mockClients) client.destroy(); raw.destroy(); }
  });
  async function approval(requestId: string) {
    await admin.send(new PutCommand({
      TableName: approvals,
      Item: {
        task_id: 'task',
        request_id: requestId,
        user_id: 'user',
        status: 'PENDING',
        created_at: new Date(Date.now() - 45_000).toISOString(),
        timeout_s: 600,
      },
    }));
  }
  async function current() {
    const value = await readMicrovmLifecycleSnapshot('task', 'user');
    if (!value) throw new Error('Expected a MicroVM task');
    return value;
  }

  test('real supervisor and store preserve approval-during-suspend wake across serialized polls', async () => {
    const handle = (await current()).handle;
    let observed = 'RUNNING';
    const strategy = {
      type: 'lambda-microvm' as const,
      startSession: jest.fn(),
      pollSession: jest.fn(async () => ({
        status: 'running' as const,
        microvmState: observed as 'RUNNING' | 'SUSPENDING' | 'SUSPENDED',
        microvmStartedAtMs: Date.now() - 60_000,
        microvmMaximumDurationSeconds: 28_800,
      })),
      stopSession: jest.fn(),
      suspendSession: jest.fn(async () => {
        expect((await current()).intent?.action).toBe('suspend');
        await admin.send(new UpdateCommand({
          TableName: approvals,
          Key: { task_id: 'task', request_id: 'gate' },
          UpdateExpression: 'SET #s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'APPROVED' },
        }));
        return { supported: true as const };
      }),
      resumeSession: jest.fn(async () => ({ supported: true as const })),
    };
    const cycle = (previous?: MicrovmSupervisorState) => superviseMicrovm({
      taskId: 'task',
      userId: 'user',
      handle,
      strategy,
      suspendEnabled: true,
      pollIntervalMs: 30_000,
      previous: previous ? JSON.parse(JSON.stringify(previous)) : undefined,
    });
    const first = await cycle();
    expect(first.kind).toBe('continue');
    const savedWake = (await current()).intent;
    expect(savedWake?.action).toBe('resume');
    observed = 'SUSPENDING';
    const second = await cycle(first.state);
    expect(strategy.resumeSession.mock.calls).toHaveLength(0);
    observed = 'SUSPENDED';
    const third = await cycle(second.state);
    expect(strategy.resumeSession.mock.calls).toHaveLength(1);
    expect((await current()).intent).toEqual(savedWake);
    await admin.send(new UpdateCommand({
      TableName: tasks,
      Key: { task_id: 'task' },
      UpdateExpression: 'SET #s = :s, agent_heartbeat_at = :now REMOVE awaiting_approval_request_id',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'RUNNING', ':now': new Date().toISOString() },
    }));
    observed = 'RUNNING';
    const restored = await cycle(third.state);
    expect((await current()).intent).toMatchObject({ action: 'resume', request_id: null });
    expect((await cycle(restored.state)).state.recovery).toBeUndefined();
    expect(strategy.suspendSession.mock.calls).toHaveLength(1);
  });

  test('real pre-command read prevents Suspend when approval wins just after intent commit', async () => {
    mockAfterSend.mockImplementation(async command => {
      const intent = command instanceof TransactWriteCommand
        ? command.input.TransactItems?.[0].Update?.ExpressionAttributeValues?.[':intent'] : undefined;
      if (intent?.action === 'suspend') {
        await admin.send(new UpdateCommand({
          TableName: approvals,
          Key: { task_id: 'task', request_id: 'gate' },
          UpdateExpression: 'SET #s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'APPROVED' },
        }));
      }
    });
    const strategy = {
      type: 'lambda-microvm' as const,
      startSession: jest.fn(),
      stopSession: jest.fn(),
      pollSession: jest.fn(async () => ({
        status: 'running' as const,
        microvmState: 'RUNNING' as const,
        microvmStartedAtMs: Date.now() - 60_000,
        microvmMaximumDurationSeconds: 28_800,
      })),
      suspendSession: jest.fn(),
      resumeSession: jest.fn(),
    };
    const result = await superviseMicrovm({
      taskId: 'task',
      userId: 'user',
      handle: (await current()).handle,
      strategy,
      suspendEnabled: true,
      pollIntervalMs: 30_000,
    });
    expect(result.kind).toBe('continue');
    expect(strategy.suspendSession.mock.calls).toHaveLength(0);
    expect(strategy.resumeSession.mock.calls).toHaveLength(0);
    expect(await current()).toMatchObject({
      status: 'AWAITING_APPROVAL', approval: { status: 'APPROVED' }, intent: { action: 'resume' },
    });
  });
  async function taskRow() {
    return (await admin.send(new GetCommand({ TableName: tasks, Key: { task_id: 'task' }, ConsistentRead: true }))).Item!;
  }
  async function set(table: string, field: string, value: unknown) {
    await admin.send(new UpdateCommand({
      TableName: table,
      Key: { task_id: 'task', ...(table === approvals && { request_id: 'gate' }) },
      UpdateExpression: 'SET #field = :value',
      ExpressionAttributeNames: { '#field': field },
      ExpressionAttributeValues: { ':value': value },
    }));
  }

  test('suspend atomically records only coordinator intent and original deadline', async () => {
    const observed = await current();
    const result = await saveMicrovmLifecycleIntent(observed, 'suspend');
    expect(result.status).toBe('saved');
    const saved = await taskRow();
    expect(saved.status).toBe('AWAITING_APPROVAL');
    expect(saved.compute_metadata).toEqual({
      microvmId: 'vm',
      endpoint: 'https://vm.example',
      imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
      imageVersion: '3.0',
      lifecycleProtocol: '1',
    });
    expect(saved.microvm_lifecycle).toMatchObject({
      action: 'suspend',
      request_id: 'gate',
      microvm_id: 'vm',
      deadline_ms: observed.approval.kind === 'present' ? observed.approval.deadlineMs : NaN,
    });
  });
  test.each([
    ['imageArn', 'arn:aws:lambda:us-east-1:123456789012:microvm-image:replacement'],
    ['imageVersion', '4.0'], ['lifecycleProtocol', '999'], ['lifecycleProtocol', undefined],
  ])('changed image %s fences an already planned suspend', async (field, value) => {
    const old = await current();
    const metadata = { ...(await taskRow()).compute_metadata, [field]: value };
    if (value === undefined) delete metadata[field];
    await set(tasks, 'compute_metadata', metadata);
    expect(await saveMicrovmLifecycleIntent(old, 'suspend')).toEqual({ status: 'stale' });
    expect((await taskRow()).microvm_lifecycle).toBeUndefined();
  });
  test('legacy image cannot sleep but can be recovered with a wake', async () => {
    await set(tasks, 'compute_metadata', { microvmId: 'vm', endpoint: 'https://vm.example' });
    const legacy = await current();
    expect(await saveMicrovmLifecycleIntent(legacy, 'suspend')).toEqual({ status: 'ineligible' });
    expect((await saveMicrovmLifecycleIntent(legacy, 'resume')).status).toBe('saved');
  });
  describe('image capability enrichment', () => {
    const handle = {
      strategyType: 'lambda-microvm' as const,
      sessionId: 'vm',
      microvmId: 'vm',
      endpoint: 'https://vm.example',
      imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
      imageVersion: '3.0',
    };
    const capable = { ...handle, lifecycleProtocol: '1' };
    beforeEach(async () => {
      await set(tasks, 'status', 'HYDRATING');
      await set(tasks, 'microvm_start', {
        clientToken: 'task', requestHash: 'original', expiresAt: Date.now() + 120_000,
      });
      await saveMicrovmStartHandle('task', 'task', handle);
    });
    test('persists support in both records without changing a concurrent terminal state', async () => {
      await set(tasks, 'status', 'CANCELLED');
      await saveMicrovmImageCapability('task', 'task', capable);
      const saved = await taskRow();
      expect(saved.status).toBe('CANCELLED');
      expect(saved.microvm_start.handle).toEqual(capable);
      expect(saved.compute_metadata).toEqual({
        microvmId: handle.microvmId,
        endpoint: handle.endpoint,
        imageArn: handle.imageArn,
        imageVersion: handle.imageVersion,
        lifecycleProtocol: '1',
      });
      expect(await claimMicrovmStart('task', 'user', 'changed-request')).toEqual({
        clientToken: 'task', closed: true, handle: capable,
      });
    });
    test.each([
      'session_id', 'microvm_start.clientToken', 'microvm_start.handle.microvmId',
      'microvm_start.handle.imageArn', 'microvm_start.handle.imageVersion',
      'compute_metadata.microvmId', 'compute_metadata.imageArn', 'compute_metadata.imageVersion',
    ])('changed %s rejects the entire capability update', async path => {
      const changed = await taskRow();
      const fields = path.split('.');
      let parent = changed;
      for (const field of fields.slice(0, -1)) parent = parent[field];
      parent[fields[fields.length - 1]] = 'replacement';
      await admin.send(new PutCommand({ TableName: tasks, Item: changed }));
      await expect(saveMicrovmImageCapability('task', 'task', capable))
        .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
      expect(await taskRow()).toEqual(changed);
    });
    test('lost committed reply is recovered by the original start receipt', async () => {
      mockAfterSend.mockImplementationOnce(() => {
        throw Object.assign(new Error('lost reply'), { name: 'TimeoutError' });
      });
      await expect(saveMicrovmImageCapability('task', 'task', capable)).rejects.toThrow('lost reply');
      expect(await claimMicrovmStart('task', 'user', 'original')).toEqual({
        clientToken: 'task', closed: false, handle: capable,
      });
    });
    test('incomplete capability rejects before a database mutation', async () => {
      const saved = await taskRow();
      mockBeforeSend.mockClear();
      await expect(saveMicrovmImageCapability('task', 'task', handle)).rejects.toThrow('incomplete');
      expect(mockBeforeSend).not.toHaveBeenCalled();
      expect(await taskRow()).toEqual(saved);
    });
  });
  test('a wake blocks an older absent-record sleep and remains sticky on fresh reads', async () => {
    const old = await current();
    await saveMicrovmLifecycleIntent(await current(), 'resume');
    expect(await saveMicrovmLifecycleIntent(old, 'suspend')).toEqual({ status: 'stale' });
    expect(await saveMicrovmLifecycleIntent(await current(), 'suspend')).toEqual({ status: 'ineligible' });
    expect((await taskRow()).microvm_lifecycle.action).toBe('resume');
  });
  test('a new wake generation fences a previously recorded suspend', async () => {
    await saveMicrovmLifecycleIntent(await current(), 'suspend');
    const oldSleep = await current();
    await saveMicrovmLifecycleIntent(await current(), 'resume');
    expect(await saveMicrovmLifecycleIntent(oldSleep, 'suspend')).toEqual({ status: 'stale' });
    expect((await taskRow()).microvm_lifecycle.generation).not.toBe(oldSleep.intent?.generation);
  });
  test('a later gate may sleep without allowing a late writer from the earlier gate', async () => {
    await saveMicrovmLifecycleIntent(await current(), 'resume');
    const oldGate = await current();
    await approval('gate-two');
    await set(tasks, 'awaiting_approval_request_id', 'gate-two');
    expect(await saveMicrovmLifecycleIntent(oldGate, 'resume')).toEqual({ status: 'stale' });
    expect((await saveMicrovmLifecycleIntent(await current(), 'suspend')).status).toBe('saved');
    expect((await taskRow()).microvm_lifecycle.request_id).toBe('gate-two');
  });
  test.each([
    ['status', 'CANCELLED'], ['user_id', 'other-user'], ['session_id', 'other-vm'],
    ['compute_type', 'ecs'], ['awaiting_approval_request_id', 'different-gate'],
    ['compute_metadata', { microvmId: 'vm', endpoint: 'https://replacement.example' }],
  ])('task %s changing after the read rejects intent', async (field, value) => {
    const old = await current();
    await set(tasks, field as string, value);
    expect(await saveMicrovmLifecycleIntent(old, 'suspend')).toEqual({ status: 'stale' });
    expect((await taskRow()).microvm_lifecycle).toBeUndefined();
  });
  test.each([
    ['status', 'APPROVED'], ['status', 'DENIED'], ['status', 'TIMED_OUT'],
    ['created_at', '2020-01-01T00:00:00Z'], ['timeout_s', 10], ['user_id', 'other-user'],
  ])('approval %s changing after the read rolls back the entire suspend write', async (field, value) => {
    const old = await current();
    await set(approvals, field as string, value);
    expect(await saveMicrovmLifecycleIntent(old, 'suspend')).toEqual({ status: 'stale' });
    expect((await taskRow()).microvm_lifecycle).toBeUndefined();
  });
  test('missing gate rejects sleep but permits conservative wake', async () => {
    const old = await current();
    await admin.send(new DeleteCommand({ TableName: approvals, Key: { task_id: 'task', request_id: 'gate' } }));
    expect(await saveMicrovmLifecycleIntent(old, 'suspend')).toEqual({ status: 'stale' });
    expect((await saveMicrovmLifecycleIntent(await current(), 'resume')).status).toBe('saved');
  });
  test('lost committed reply recovers the exact generation from the database', async () => {
    const observed = await current();
    mockAfterSend.mockImplementationOnce(async command => {
      expect(command).toBeInstanceOf(TransactWriteCommand);
      throw new Error('lost committed response');
    });
    const result = await saveMicrovmLifecycleIntent(observed, 'suspend');
    expect(result).toEqual({ status: 'saved', intent: (await taskRow()).microvm_lifecycle });
  });
  test.each(['cancel', 'approve'])('%s after a committed write but before lost-reply recovery is stale', async change => {
    const observed = await current();
    mockAfterSend.mockImplementationOnce(async command => {
      expect(command).toBeInstanceOf(TransactWriteCommand);
      await set(change === 'cancel' ? tasks : approvals, 'status', change === 'cancel' ? 'CANCELLED' : 'APPROVED');
      throw new Error('lost committed response');
    });
    expect(await saveMicrovmLifecycleIntent(observed, 'suspend')).toEqual({ status: 'stale' });
  });
  test('fresh module/client observes the saved wake without resetting age or generation', async () => {
    await saveMicrovmLifecycleIntent(await current(), 'resume');
    const saved = (await taskRow()).microvm_lifecycle;
    let restarted: typeof import('../../../src/handlers/shared/microvm-lifecycle');
    jest.isolateModules(() => { restarted = jest.requireActual('../../../src/handlers/shared/microvm-lifecycle'); });
    const observed = await restarted!.readMicrovmLifecycleSnapshot('task', 'user');
    expect(observed?.intent).toEqual(saved);
    expect(await restarted!.saveMicrovmLifecycleIntent(observed!, 'resume')).toEqual({ status: 'saved', intent: saved });
    expect((await taskRow()).microvm_lifecycle).toEqual(saved);
  });
  test('competing sleepers converge; a later wake fences both old snapshots', async () => {
    const first = await current();
    const second = await current();
    const results = await Promise.allSettled([saveMicrovmLifecycleIntent(first, 'suspend'), saveMicrovmLifecycleIntent(second, 'suspend')]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value.status === 'saved')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason.name).toBe('TransactionCanceledException');
    }
    await saveMicrovmLifecycleIntent(await current(), 'resume');
    expect(await saveMicrovmLifecycleIntent(first, 'suspend')).toEqual({ status: 'stale' });
    expect(await saveMicrovmLifecycleIntent(second, 'suspend')).toEqual({ status: 'stale' });
  });
  test('approval-read failure is explicit and cannot prevent recording a wake', async () => {
    mockBeforeSend.mockImplementation(async command => {
      if (command instanceof GetCommand && command.input.TableName === approvals) {
        throw Object.assign(new Error('simulated authorization failure'), { name: 'AccessDeniedException' });
      }
    });
    const observed = await current();
    expect(observed.approval).toEqual({ kind: 'unavailable', errorType: 'AccessDeniedException' });
    expect(await saveMicrovmLifecycleIntent(observed, 'suspend')).toEqual({ status: 'ineligible' });
    expect((await saveMicrovmLifecycleIntent(observed, 'resume')).status).toBe('saved');
  });
});
