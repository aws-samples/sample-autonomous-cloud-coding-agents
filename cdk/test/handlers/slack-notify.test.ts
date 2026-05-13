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

import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.TASK_TABLE_NAME = 'Tasks';

import { handler } from '../../src/handlers/slack-notify';

function makeInsertRecord(
  taskId: string,
  eventType: string,
  metadata?: Record<string, unknown>,
): DynamoDBRecord {
  return {
    eventID: `evt-${Math.random()}`,
    eventName: 'INSERT',
    dynamodb: {
      NewImage: {
        task_id: { S: taskId },
        event_type: { S: eventType },
        ...(metadata && { metadata: { S: JSON.stringify(metadata) } }),
      },
    },
  };
}

function withRecords(records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

describe('slack-notify handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    smSend.mockResolvedValue({ SecretString: 'xoxb-test' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, ts: '1234.0001' }),
    });
  });

  test('skips non-slack tasks without touching DDB beyond the task read', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: { task_id: 't1', channel_source: 'api', channel_metadata: {} },
    });

    await handler(withRecords([makeInsertRecord('t1', 'task_completed')]));

    // Only the initial GetCommand ran — no dedup update, no Slack call.
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('dedup write runs only after channel_source is confirmed slack', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand for dedup

    await handler(withRecords([makeInsertRecord('t1', 'task_completed')]));

    // GetCommand first, then UpdateCommand (dedup). Order matters (item 17).
    expect(ddbSend.mock.calls[0][0]._type).toBe('Get');
    expect(ddbSend.mock.calls[1][0]._type).toBe('Update');
    expect(fetchMock).toHaveBeenCalled();
  });

  test('skips terminal notification when dedup marker already exists', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
        },
      })
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));

    await handler(withRecords([makeInsertRecord('t1', 'task_failed')]));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('swallows Slack API errors without failing the batch', async () => {
    ddbSend.mockResolvedValue({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });

    await expect(
      handler(withRecords([makeInsertRecord('t1', 'task_created')])),
    ).resolves.toBeUndefined();
  });

  test('rethrows infra errors so Lambda retries the batch (item 4)', async () => {
    ddbSend.mockRejectedValueOnce(Object.assign(new Error('throttle'), { name: 'ProvisionedThroughputExceededException' }));

    await expect(
      handler(withRecords([makeInsertRecord('t1', 'task_completed')])),
    ).rejects.toThrow('throttle');
  });

  test('ignores non-INSERT stream events', async () => {
    const modifyRecord: DynamoDBRecord = {
      eventID: 'evt-modify',
      eventName: 'MODIFY',
      dynamodb: { NewImage: { task_id: { S: 't1' }, event_type: { S: 'task_completed' } } },
    };
    await handler(withRecords([modifyRecord]));
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('ignores non-notifiable event types', async () => {
    await handler(withRecords([makeInsertRecord('t1', 'agent_heartbeat')]));
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('logs and continues when event metadata JSON is malformed (item 20)', async () => {
    const record: DynamoDBRecord = {
      eventID: 'evt-bad-meta',
      eventName: 'INSERT',
      dynamodb: {
        NewImage: {
          task_id: { S: 't1' },
          event_type: { S: 'task_failed' },
          metadata: { S: 'not-json{' },
        },
      },
    };
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
          error_message: 'agent crashed',
        },
      })
      .mockResolvedValueOnce({}); // dedup

    await handler(withRecords([record]));

    // Still posts to Slack — bad metadata is not fatal.
    expect(fetchMock).toHaveBeenCalled();
    const postBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(postBody.text).toContain('org/repo');
  });
});
