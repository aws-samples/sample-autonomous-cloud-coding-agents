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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  ...jest.requireActual('@aws-sdk/client-dynamodb'),
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
}));

import { GetItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { blueprintProvisioningMode, parseConfiguration } from '../../../src/blueprints/configuration';
import { BlueprintEvent, onEvent } from '../../../src/handlers/blueprint-provisioning/index';

const base: BlueprintEvent = {
  RequestType: 'Create',
  StackId: 'stack-identity',
  LogicalResourceId: 'Blueprint',
  RequestId: 'create-request',
  ResourceProperties: {
    TableName: 'repos',
    Repo: 'org/repo',
    Mode: 'adopt',
    Configuration: JSON.stringify({ model_id: { S: 'model' }, max_turns: { N: '50' }, skills: { L: [{ S: 'registry://skill/org/name@1' }] } }),
  },
};
const timestamp = '2026-09-17T12:00:00.000Z';
let physicalId: string;
let owned: Record<string, any>;
let initialTransaction: any;
const transactions = () => mockSend.mock.calls.map(([command]) => command)
  .filter(command => command instanceof TransactWriteItemsCommand).map(command => command.input.TransactItems);
const event = (overrides: Partial<BlueprintEvent> = {}): BlueprintEvent => ({
  ...base, RequestType: 'Update', RequestId: 'update-request', PhysicalResourceId: physicalId, ...overrides,
});
const cancellation = (...codes: string[]) => Object.assign(new Error('transaction cancelled'), {
  name: 'TransactionCanceledException', CancellationReasons: codes.map(Code => ({ Code })),
});

beforeAll(async () => {
  process.env.OWNERSHIP_TABLE = 'ownership';
  mockSend.mockResolvedValue({});
  physicalId = (await onEvent(base)).PhysicalResourceId;
  initialTransaction = transactions()[0];
  const values = initialTransaction[0].Update.ExpressionAttributeValues;
  owned = {
    owner: values[':owner'],
    family: values[':family'],
    revision: values[':revision'],
    mode: values[':mode'],
    state: values[':state'],
  };
});
beforeEach(() => {
  mockSend.mockReset();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(timestamp));
  process.env.OWNERSHIP_TABLE = 'ownership';
});
afterEach(() => { jest.useRealTimers(); });

test('adoption atomically claims ownership, reconciles the row and records the request', async () => {
  mockSend.mockResolvedValue({});
  expect(await onEvent(base)).toEqual({ PhysicalResourceId: physicalId });
  const transaction = transactions()[0];
  expect(transaction).toHaveLength(3);
  expect(transaction[0].Update.TableName).toBe('ownership');
  expect(transaction[0].Update.ConditionExpression).toBe('attribute_not_exists(#target)');
  const repo = transaction[1].Update;
  expect(repo.TableName).toBe('repos');
  expect(repo.Key).toEqual({ repo: { S: 'org/repo' } });
  expect(repo.UpdateExpression).toContain('#onboarded = if_not_exists(#onboarded, :now)');
  expect(repo.UpdateExpression).toContain('REMOVE #ttl, #mcp_servers, #cedar_policy_modules');
  expect(repo.ExpressionAttributeValues[':now']).toEqual({ S: timestamp });
  expect(repo.ExpressionAttributeValues[':max_turns']).toEqual({ N: '50' });
  expect(repo.ExpressionAttributeNames).not.toHaveProperty('#runtime_arn');
  expect(repo.ConditionExpression).toBeUndefined();
  expect(transaction[2].Put.TableName).toBe('ownership');
  expect(transaction[2].Put.Item.physical_id).toEqual({ S: physicalId });
  expect(transaction[2].Put.ConditionExpression).toBe('attribute_not_exists(#target)');
  // No metadata in RepoTable for older CLI PutItem writers to erase.
  expect(Object.values(repo.ExpressionAttributeNames)).not.toContain('owner');
  expect(mockSend.mock.calls.filter(([command]) => command instanceof GetItemCommand)
    .every(([command]) => command.input.ConsistentRead === true)).toBe(true);
});

test('a managed fresh create refuses to overwrite a pre-existing unowned row', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({})
    .mockRejectedValueOnce(cancellation('None', 'ConditionalCheckFailed', 'None'));
  await expect(onEvent({ ...base, ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }))
    .rejects.toThrow(/Existing repository requires the prepare\/adopt/);
  expect(transactions()[0][1].Update.ConditionExpression).toBe('attribute_not_exists(#repo)');
  expect(mockSend).toHaveBeenCalledTimes(3);
});

test('an old completed request is a no-op even after subsequent releases', async () => {
  mockSend.mockResolvedValue({ Item: { physical_id: { S: physicalId }, request_type: { S: 'Create' } } });
  expect(await onEvent(base)).toEqual({ PhysicalResourceId: physicalId });
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(transactions()).toHaveLength(0);
});

test('updates keep physical identity, preserve omitted overrides and fence the ledger revision', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: owned }).mockResolvedValueOnce({});
  const request = event({ ResourceProperties: { ...base.ResourceProperties, Configuration: '{}' } });
  expect(await onEvent(request)).toEqual({ PhysicalResourceId: physicalId });
  const transaction = transactions()[0];
  expect(transaction[0].Update.ConditionExpression).toBe('#revision = :previous');
  expect(transaction[0].Update.ExpressionAttributeValues[':previous']).toEqual({ N: '1' });
  expect(transaction[0].Update.ExpressionAttributeValues[':revision']).toEqual({ N: '2' });
  const repo = transaction[1].Update;
  expect(repo.UpdateExpression).toContain('REMOVE #ttl, #mcp_servers, #cedar_policy_modules, #skills');
  expect(repo.ExpressionAttributeNames).not.toHaveProperty('#model_id');
});

test('activation and its rollback update deletion authority without replacing the resource', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: owned }).mockResolvedValueOnce({});
  expect(await onEvent(event({ ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }))).toEqual({ PhysicalResourceId: physicalId });
  expect(transactions()[0][0].Update.ExpressionAttributeValues[':mode']).toEqual({ S: 'managed' });
  mockSend.mockReset().mockResolvedValueOnce({})
    .mockResolvedValueOnce({ Item: { ...owned, mode: { S: 'managed' }, revision: { N: '2' } } }).mockResolvedValueOnce({});
  await onEvent(event({ RequestId: 'rollback' }));
  expect(transactions()[0][0].Update.ExpressionAttributeValues[':mode']).toEqual({ S: 'adopt' });
});

test('rollback deletion in adoption mode cannot touch repository or ownership state', async () => {
  expect(await onEvent(event({ RequestType: 'Delete' }))).toEqual({ PhysicalResourceId: physicalId });
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['superseded owner', 'deletion disabled', 'already removed', 'missing ledger'])('managed Delete is harmless for %s', async name => {
  const states: Record<string, unknown> = {
    'superseded owner': { ...owned, owner: { S: `blueprint-v2:${'a'.repeat(64)}:${'b'.repeat(64)}` }, mode: { S: 'managed' } },
    'deletion disabled': owned,
    'already removed': { ...owned, mode: { S: 'managed' }, state: { S: 'removed' } },
    'missing ledger': undefined,
  };
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: states[name] });
  await onEvent(event({ RequestType: 'Delete', ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }));
  expect(transactions()).toHaveLength(0);
});

test('managed Delete soft-deletes only the current owner using execution-time TTL', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { ...owned, mode: { S: 'managed' } } })
    .mockResolvedValueOnce({ Item: { repo: { S: 'org/repo' } } }).mockResolvedValueOnce({});
  await onEvent(event({ RequestType: 'Delete', ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }));
  const transaction = transactions()[0];
  expect(transaction[0].Update.ExpressionAttributeValues[':state']).toEqual({ S: 'removed' });
  expect(transaction[1].Update.ConditionExpression).toBe('attribute_exists(#repo)');
  expect(transaction[1].Update.ExpressionAttributeValues[':ttl']).toEqual({ N: String(Date.parse(timestamp) / 1000 + 30 * 86400) });
});

test('deleting an already absent repo cannot create a tombstone', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { ...owned, mode: { S: 'managed' } } })
    .mockResolvedValueOnce({}).mockResolvedValueOnce({});
  await onEvent(event({ RequestType: 'Delete', ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }));
  expect(transactions()[0][1]).toEqual({
    ConditionCheck: {
      TableName: 'repos',
      Key: { repo: { S: 'org/repo' } },
      ConditionExpression: 'attribute_not_exists(#repo)',
      ExpressionAttributeNames: { '#repo': 'repo' },
    },
  });
});

test('repository changes publish a new physical identity; the old Delete remains scoped to its old key', async () => {
  mockSend.mockResolvedValue({});
  const changed = await onEvent(event({ ResourceProperties: { ...base.ResourceProperties, Repo: 'org/other' } }));
  expect(changed.PhysicalResourceId).not.toBe(physicalId);
  expect(transactions()[0][1].Update.Key).toEqual({ repo: { S: 'org/other' } });
  mockSend.mockReset().mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { ...owned, mode: { S: 'managed' } } })
    .mockResolvedValueOnce({ Item: { repo: { S: 'org/repo' } } }).mockResolvedValueOnce({});
  await onEvent(event({ RequestType: 'Delete', ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }));
  expect(transactions()[0][1].Update.Key).toEqual({ repo: { S: 'org/repo' } });
});

test('a competing active Blueprint cannot claim a row', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { ...owned, family: { S: 'other-family' } } });
  await expect(onEvent(base)).rejects.toThrow(/another active Blueprint/);
  expect(transactions()).toHaveLength(0);
});

test('an old generation cannot update a newly adopted owner', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { ...owned, owner: { S: `blueprint-v2:${'a'.repeat(64)}:${'b'.repeat(64)}` } } });
  await expect(onEvent(event())).rejects.toThrow(/no longer owns/);
  expect(transactions()).toHaveLength(0);
});

test('a concurrent revision is reread before retrying the atomic update', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: owned })
    .mockRejectedValueOnce(cancellation('ConditionalCheckFailed', 'None', 'None'))
    .mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { ...owned, revision: { N: '2' } } }).mockResolvedValueOnce({});
  await onEvent(event());
  expect(transactions()).toHaveLength(2);
  expect(transactions()[1][0].Update.ExpressionAttributeValues[':previous']).toEqual({ N: '2' });
});

test('a concurrent duplicate returns the committed receipt instead of writing again', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: owned })
    .mockRejectedValueOnce(cancellation('ConditionalCheckFailed', 'None', 'ConditionalCheckFailed'))
    .mockResolvedValueOnce({ Item: { physical_id: { S: physicalId }, request_type: { S: 'Update' } } });
  expect(await onEvent(event())).toEqual({ PhysicalResourceId: physicalId });
  expect(transactions()).toHaveLength(1);
});

test('a duplicate fresh create accepts its receipt when all three transaction conditions race', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({})
    .mockRejectedValueOnce(cancellation('ConditionalCheckFailed', 'ConditionalCheckFailed', 'ConditionalCheckFailed'))
    .mockResolvedValueOnce({ Item: { physical_id: { S: physicalId }, request_type: { S: 'Create' } } });
  expect(await onEvent({ ...base, ResourceProperties: { ...base.ResourceProperties, Mode: 'managed' } }))
    .toEqual({ PhysicalResourceId: physicalId });
  expect(transactions()).toHaveLength(1);
  expect(mockSend).toHaveBeenCalledTimes(4);
});

test.each([
  Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
  cancellation('ValidationError', 'None', 'None'),
])('service failures propagate without being accepted as retries', async error => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: owned }).mockRejectedValueOnce(error);
  await expect(onEvent(event())).rejects.toBe(error);
  expect(transactions()).toHaveLength(1);
});

test('contention retries are bounded', async () => {
  mockSend.mockImplementation(async command => {
    if (command instanceof TransactWriteItemsCommand) throw cancellation('TransactionConflict', 'None', 'None');
    return command.input.Key.target.S.startsWith('request:') ? {} : { Item: owned };
  });
  await expect(onEvent(event())).rejects.toThrow(/concurrent operations must finish/);
  expect(transactions()).toHaveLength(4);
});

test('Delete rejects a mismatched target and tolerates a failed-Create placeholder', async () => {
  await expect(onEvent(event({ RequestType: 'Delete', ResourceProperties: { ...base.ResourceProperties, Repo: 'org/wrong' } })))
    .rejects.toThrow(/target does not match/);
  expect(await onEvent(event({ RequestType: 'Delete', PhysicalResourceId: 'failed-create-placeholder' })))
    .toEqual({ PhysicalResourceId: 'failed-create-placeholder' });
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['{"status":{"S":"removed"}}', '{"__proto__":{"L":[]}}', '{"constructor":{"L":[]}}',
  '{"max_turns":{"N":"NaN"}}', '{"max_turns":{"N":"0x10"}}', '{"skills":{"L":[{"N":"1"}]}}', '[]'])(
  'rejects invalid configuration %s before any writes', json => {
    expect(() => parseConfiguration(json)).toThrow();
  },
);

test('provisioning mode is explicit and defaults to compatibility', () => {
  expect(blueprintProvisioningMode(undefined)).toBe('legacy');
  for (const mode of ['legacy', 'prepare', 'adopt', 'managed']) expect(blueprintProvisioningMode(mode)).toBe(mode);
  expect(() => blueprintProvisioningMode(true)).toThrow(/blueprintProvisioning/);
  expect(() => blueprintProvisioningMode('unknown')).toThrow(/blueprintProvisioning/);
});
