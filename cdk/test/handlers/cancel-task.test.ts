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

import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
const mockAgentCoreSend = jest.fn();
const mockEcsSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentCoreSend })),
  StopRuntimeSessionCommand: jest.fn((input: unknown) => ({ _type: 'StopRuntimeSession', input })),
}));
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn(() => ({ send: mockEcsSend })),
  StopTaskCommand: jest.fn((input: unknown) => ({ _type: 'StopTask', input })),
}));
const mockMicrovmSend = jest.fn();
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockMicrovmSend })),
  TerminateMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'TerminateMicrovm', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ _type: 'TransactWrite', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.TASK_RETENTION_DAYS = '90';
process.env.RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/default';
process.env.ECS_CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster';

import { handler } from '../../src/handlers/cancel-task';

const RUNNING_TASK = {
  task_id: 'task-1',
  user_id: 'user-123',
  status: 'RUNNING',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'RUNNING#2025-03-15T10:30:00Z',
  created_at: '2025-03-15T10:30:00Z',
  updated_at: '2025-03-15T10:31:00Z',
  session_id: '550e8400-e29b-41d4-a716-446655440000',
  agent_runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/task-runtime',
};

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'DELETE',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
      httpMethod: 'DELETE',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test/1.0',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      path: '/v1/tasks/task-1',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks/{task_id}',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAgentCoreSend.mockResolvedValue({});
  mockEcsSend.mockResolvedValue({});
  mockSend
    .mockResolvedValueOnce({ Item: RUNNING_TASK })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({});
});

describe('cancel-task handler', () => {
  test.each(['HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'])('stops an AgentCore session when cancelling %s', async (status) => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    const cmd = mockAgentCoreSend.mock.calls[0][0];
    expect(cmd.input.runtimeSessionId).toBe(RUNNING_TASK.session_id);
    expect(cmd.input.agentRuntimeArn).toBe(RUNNING_TASK.agent_runtime_arn);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('task-1');
    expect(body.data.status).toBe('CANCELLED');
    expect(body.data.cancelled_at).toBeDefined();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]._type).toBe('TransactWrite');
  });

  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
  });

  test('returns 400 when task_id is missing', async () => {
    const event = makeEvent({ pathParameters: null });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  test('returns 404 when task does not exist', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TASK_NOT_FOUND');
  });

  test('returns 403 when task belongs to another user', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, user_id: 'other-user' } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  test('returns 409 when task is already in terminal state', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status: 'COMPLETED' } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('TASK_ALREADY_TERMINAL');
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  });

  test.each(['RUNNING', 'AWAITING_APPROVAL'])('does not stop %s compute when cancellation loses a terminal race', async (status) => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status, compute_type: 'lambda-microvm' } });
    const condError = Object.assign(new Error('Transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    mockSend.mockRejectedValueOnce(condError);

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('TASK_ALREADY_TERMINAL');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  });

  test('returns 500 on unexpected DynamoDB error', async () => {
    mockSend.mockReset();
    mockSend.mockRejectedValueOnce(new Error('DB failure'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
  });

  test('cancels the task and writes its event in one transaction, both with a TTL', async () => {
    await handler(makeEvent());

    const [update, put] = mockSend.mock.calls[1][0].input.TransactItems;
    expect(update.Update.UpdateExpression).toContain('#ttl = :ttl');
    expect(update.Update.ExpressionAttributeNames['#ttl']).toBe('ttl');
    expect(typeof update.Update.ExpressionAttributeValues[':ttl']).toBe('number');
    expect(update.Update.ConditionExpression).toContain('NOT #status IN');

    expect(put.Put.TableName).toBe('TaskEvents');
    expect(put.Put.Item.event_type).toBe('task_cancelled');
    expect(put.Put.Item.metadata).toEqual({ cancelled_by: 'user-123' });
    expect(typeof put.Put.Item.ttl).toBe('number');
  });

  const conflict = () => Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
  });

  test('a transaction conflict with a concurrent write to the task row is retried, not a 500', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK })
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    const eventIds = mockSend.mock.calls.slice(1).map((c) => c[0].input.TransactItems[1].Put.Item.event_id);
    expect(eventIds).toHaveLength(3);
    expect(new Set(eventIds).size).toBe(1);
  });

  test('a conflict that then finds the task terminal is a 409, not a cancel', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK })
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(Object.assign(new Error('Transaction cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(409);
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test('a conflict that never clears gives up after a bounded number of attempts', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: RUNNING_TASK });
    mockSend.mockRejectedValue(conflict());

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(mockSend).toHaveBeenCalledTimes(1 + 4);
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test('returns 500 and stops no compute when the cancel transaction fails for another reason', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: RUNNING_TASK });
    mockSend.mockRejectedValueOnce(Object.assign(new Error('throttled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ThrottlingError' }, { Code: 'None' }],
    }));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test.each(['SUBMITTED', 'QUEUED', 'PENDING_UPLOADS'])('cancels %s without stopping compute', async (status) => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  });

  test.each(['RUNNING', 'AWAITING_APPROVAL'])('does not call StopRuntimeSession when %s has no session_id', async (status) => {
    mockSend.mockReset();
    const noSession = { ...RUNNING_TASK, status };
    delete (noSession as { session_id?: string }).session_id;
    mockSend
      .mockResolvedValueOnce({ Item: noSession })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test('uses RUNTIME_ARN when agent_runtime_arn is not on the task record', async () => {
    mockSend.mockReset();
    const withoutArn = { ...RUNNING_TASK };
    delete (withoutArn as { agent_runtime_arn?: string }).agent_runtime_arn;
    mockSend
      .mockResolvedValueOnce({ Item: withoutArn })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    const cmd = mockAgentCoreSend.mock.calls[0][0];
    expect(cmd.input.agentRuntimeArn).toBe(process.env.RUNTIME_ARN);
  });

  test('returns 200 when StopRuntimeSession fails', async () => {
    mockSend.mockReset();
    mockAgentCoreSend.mockRejectedValueOnce(new Error('Throttling'));
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockAgentCoreSend).toHaveBeenCalled();
  });

  test.each(['HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'])('stops an ECS session when cancelling %s', async (status) => {
    mockSend.mockReset();
    const ecsTask = {
      ...RUNNING_TASK,
      status,
      compute_type: 'ecs',
      compute_metadata: {
        clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
      },
    };
    mockSend
      .mockResolvedValueOnce({ Item: ecsTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockEcsSend).toHaveBeenCalledTimes(1);
    const cmd = mockEcsSend.mock.calls[0][0];
    expect(cmd.input.cluster).toBe('arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster');
    expect(cmd.input.task).toBe('arn:aws:ecs:us-east-1:123456789012:task/abc123');
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test('skips ECS StopTask when compute_metadata.taskArn is missing', async () => {
    mockSend.mockReset();
    const ecsTask = {
      ...RUNNING_TASK,
      compute_type: 'ecs',
      compute_metadata: {
        clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
      },
    };
    mockSend
      .mockResolvedValueOnce({ Item: ecsTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test.each(['HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'])('terminates only the MicroVM session when cancelling %s', async (status) => {
    mockSend.mockReset();
    const microvmTask = {
      ...RUNNING_TASK,
      status,
      compute_type: 'lambda-microvm',
      session_id: 'mvm-0123456789abcdef',
      compute_metadata: {
        microvmId: 'mvm-0123456789abcdef',
        endpoint: 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com',
      },
    };
    mockSend
      .mockResolvedValueOnce({ Item: microvmTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockMicrovmSend).toHaveBeenCalledTimes(1);
    const cmd = mockMicrovmSend.mock.calls[0][0];
    expect(cmd._type).toBe('TerminateMicrovm');
    expect(cmd.input).toEqual({ microvmIdentifier: 'mvm-0123456789abcdef' });
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
    expect(mockEcsSend).not.toHaveBeenCalled();
  });

  test('skips TerminateMicrovm when compute_metadata.microvmId is missing', async () => {
    mockSend.mockReset();
    const microvmTask = { ...RUNNING_TASK, compute_type: 'lambda-microvm', compute_metadata: {} };
    mockSend
      .mockResolvedValueOnce({ Item: microvmTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockMicrovmSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  test.each(['RUNNING', 'AWAITING_APPROVAL'])('keeps cancellation committed when TerminateMicrovm fails for %s', async (status) => {
    mockSend.mockReset();
    const microvmTask = {
      ...RUNNING_TASK,
      status,
      compute_type: 'lambda-microvm',
      compute_metadata: { microvmId: 'mvm-0123456789abcdef', endpoint: 'https://x' },
    };
    mockSend
      .mockResolvedValueOnce({ Item: microvmTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mockMicrovmSend.mockRejectedValueOnce(new Error('ResourceNotFoundException'));

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockMicrovmSend).toHaveBeenCalledTimes(1);
  });

  test('falls back to AgentCore stop when compute_type is unrecognized but RUNTIME_ARN is available', async () => {
    mockSend.mockReset();
    const unknownTask = {
      ...RUNNING_TASK,
      compute_type: 'unknown',
    };
    delete (unknownTask as { agent_runtime_arn?: string }).agent_runtime_arn;
    mockSend
      .mockResolvedValueOnce({ Item: unknownTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
  });

  test('returns 200 when ECS StopTask fails', async () => {
    mockSend.mockReset();
    mockEcsSend.mockRejectedValueOnce(new Error('ECS error'));
    const ecsTask = {
      ...RUNNING_TASK,
      compute_type: 'ecs',
      compute_metadata: {
        clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
      },
    };
    mockSend
      .mockResolvedValueOnce({ Item: ecsTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockEcsSend).toHaveBeenCalled();
  });
});
