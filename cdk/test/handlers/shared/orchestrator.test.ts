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

// --- Mocks ---
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => ({ send: jest.fn() })) }));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: mockLogger }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Concurrency';
process.env.TASK_RETENTION_DAYS = '90';

import { TaskStatus } from '../../../src/constructs/task-status';
import type { SessionHandle, SessionStatus } from '../../../src/handlers/shared/compute-strategy';
// The real classifier: the reason-append must not break the anchor the substrate
// -failure classification keys on.
import { classifyError, formatMicrovmTerminalFailure } from '../../../src/handlers/shared/error-classifier';
import { renderFailureReply, renderPanelFailureReason } from '../../../src/handlers/shared/failure-reply';
import { buildComputeMetadata, finalizeTask } from '../../../src/handlers/shared/orchestrator';
import { toTaskDetail, type TaskRecord } from '../../../src/handlers/shared/types';

const MICROVM_ID = 'mvm-0123456789abcdef';
const ENDPOINT = 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com';

/** Commands the mocked document client received, in order. */
function sentCommands(): Array<{ _type: string; input: Record<string, unknown> }> {
  return mockDdbSend.mock.calls.map(c => c[0]);
}

function commandsOfType(type: string): Array<{ _type: string; input: Record<string, unknown> }> {
  return sentCommands().filter(c => c._type === type);
}

/** Strong finalization observes this committed task before choosing an outcome. */
function primeReread(status: string): void {
  mockDdbSend.mockImplementation((cmd: { _type: string }) => Promise.resolve(cmd._type === 'Get' ? {
    Item: {
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status,
      memory_written: true,
      compute_type: 'lambda-microvm',
      session_id: MICROVM_ID,
      compute_metadata: { microvmId: MICROVM_ID, endpoint: ENDPOINT },
    },
  } : {}));
}
const mockRelease = jest.fn();
jest.mock('../../../src/handlers/shared/task-concurrency', () => ({
  acquireTaskSlot: jest.fn(), releaseTaskSlot: (...args: unknown[]) => mockRelease(...args),
}));
function finish(substrate: SessionStatus, polledStatus = TaskStatus.RUNNING) {
  return finalizeTask('TASK001', {
    attempts: 1,
    lastStatus: polledStatus,
    microvmFailureReason: 'substrate-terminal',
    microvmFailureMessage: formatMicrovmTerminalFailure(
      substrate.status === 'failed' ? substrate.error : `substrate state ${substrate.status}`, substrate.reason,
    ),
    microvmSupervisor: {
      version: 1,
      microvmId: MICROVM_ID,
      firstObservedAtMs: 1,
      sessionDeadlineMs: 28_800_001,
      lifetimeVerified: true,
      consecutivePollFailures: 0,
      consecutiveResumeFailures: 0,
      anomalyReported: false,
      nextPollInMs: 5_000,
    },
  }, 'user-1');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogger.child.mockReturnValue(mockLogger);
  mockRelease.mockResolvedValue(false);
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({});
});

describe('buildComputeMetadata', () => {
  test('persists clusterArn and taskArn for an ECS handle (unchanged behaviour)', () => {
    const handle: SessionHandle = {
      sessionId: 'arn:aws:ecs:us-east-1:123456789012:task/c/abc',
      strategyType: 'ecs',
      clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/c',
      taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/c/abc',
    };
    // cancel-task.ts reads exactly these two keys — do not rename them.
    expect(buildComputeMetadata(handle)).toEqual({
      clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/c',
      taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/c/abc',
    });
  });

  test('persists runtimeArn for an AgentCore handle (unchanged behaviour)', () => {
    const handle: SessionHandle = {
      sessionId: 'a-uuid',
      strategyType: 'agentcore',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r',
    };
    expect(buildComputeMetadata(handle)).toEqual({
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r',
    });
  });

  test('persists microvmId and endpoint for a lambda-microvm handle', () => {
    const handle: SessionHandle = {
      sessionId: MICROVM_ID,
      strategyType: 'lambda-microvm',
      microvmId: MICROVM_ID,
      endpoint: ENDPOINT,
    };
    // ADR-021: the P3 approve/deny Lambdas load the resume handle from these keys.
    expect(buildComputeMetadata(handle)).toEqual({ microvmId: MICROVM_ID, endpoint: ENDPOINT });
  });

  test('preserves actual image identity and verified capability for later policy decisions', () => {
    const metadata = buildComputeMetadata({
      sessionId: MICROVM_ID,
      strategyType: 'lambda-microvm',
      microvmId: MICROVM_ID,
      endpoint: ENDPOINT,
      imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
      imageVersion: '3.0',
      lifecycleProtocol: '1',
    });
    expect(metadata).toEqual({
      microvmId: MICROVM_ID,
      endpoint: ENDPOINT,
      imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
      imageVersion: '3.0',
      lifecycleProtocol: '1',
    });
  });

  test('produces only string values (compute_metadata is Record<string, string> in DDB)', () => {
    for (const handle of [
      { sessionId: 's', strategyType: 'agentcore', runtimeArn: 'a' },
      { sessionId: 's', strategyType: 'ecs', clusterArn: 'c', taskArn: 't' },
      { sessionId: 's', strategyType: 'lambda-microvm', microvmId: 'm', endpoint: 'e' },
    ] as SessionHandle[]) {
      for (const value of Object.values(buildComputeMetadata(handle))) {
        expect(typeof value).toBe('string');
      }
    }
  });

  test('throws for an unrecognized strategyType (exhaustive-never guard)', () => {
    expect(() =>
      buildComputeMetadata({ sessionId: 's', strategyType: 'firecracker-v2' } as unknown as SessionHandle),
    ).toThrow(/Unknown strategyType on session handle/);
  });
});

describe('MicroVM terminal finalization', () => {
  test.each([
    ['MicroVM host unavailable.', 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ['capacity unavailable in this Availability Zone.', 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ['MicroVM unavailable in this region.', 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ['INSUFFICIENT_GITHUB_REPO_PERMISSIONS', 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ['BLOCKED[missing_secret]: diagnostic text', 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ["agent_status='success', build_ok=False", 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ["agent_status='success', build_ok=timeout [auto-retried]", 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
    ['Run lifecycle hook returned HTTP status 400.', 'MICROVM_RUN_HOOK_REJECTED', 'config', false],
    ['Run lifecycle hook returned HTTP status 500.', 'MICROVM_SUBSTRATE_TERMINATED', 'compute', true],
  ])('persists stable classification and consistent user guidance for %s', async (reason, code, category, retryable) => {
    primeReread(TaskStatus.RUNNING);
    await finish({ status: 'completed', reason });
    const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
    const errorMessage = String(values[':attr_error_message']);
    expect(errorMessage).toMatch(new RegExp(`^${code}: `));
    expect(errorMessage).toContain(reason);
    expect(toTaskDetail({
      task_id: 'TASK001', status: TaskStatus.FAILED, error_message: errorMessage,
    } as TaskRecord).error_classification).toMatchObject({ category, retryable });
    const input = { status: TaskStatus.FAILED, errorMessage, taskId: 'TASK001' };
    for (const reply of [renderFailureReply(input), renderPanelFailureReason(input)]) {
      expect(reply).toMatch(retryable ? /reply here to try again/i : /needs your ABCA admin/i);
      expect(reply).not.toContain('Lambda MicroVMs is not available in this Region');
      expect(reply).not.toContain('I automatically tried again');
    }
  });

  test.each([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT])(
    'preserves a committed %s winner after a stale active poll', async status => {
      primeReread(status);
      await finish({ status: 'completed' });
      expect(commandsOfType('Get')[0].input.ConsistentRead).toBe(true);
      for (const command of commandsOfType('Update')) {
        expect(command.input.ConditionExpression).toBeUndefined(); // terminal TTL stamp only
      }
      expect((commandsOfType('Put')[0].input.Item as Record<string, unknown>).event_type).toBe(`task_${status.toLowerCase()}`);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    },
  );

  test('transitions from the strong current status, retaining the original service error', async () => {
    primeReread(TaskStatus.AWAITING_APPROVAL);
    await finish({ status: 'failed', error: 'host fault', reason: 'hypervisor evicted the guest' });
    const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':fromStatus']).toBe(TaskStatus.AWAITING_APPROVAL);
    expect(values[':toStatus']).toBe(TaskStatus.FAILED);
    expect(values[':attr_error_message']).toBe(
      'MICROVM_SUBSTRATE_TERMINATED: MicroVM substrate terminated before the agent wrote a terminal status: host fault (hypervisor evicted the guest)',
    );
    expect(classifyError(String(values[':attr_error_message']))?.retryable).toBe(true);
    expect(mockRelease).toHaveBeenCalledWith('TASK001', 'user-1');
  });
});
