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
import { classifyError } from '../../../src/handlers/shared/error-classifier';
import { renderFailureReply, renderPanelFailureReason } from '../../../src/handlers/shared/failure-reply';
import { buildComputeMetadata, reconcileMicrovmSubstrateState } from '../../../src/handlers/shared/orchestrator';
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

/**
 * Prime the mocked doc client: the FIRST Get returns a task row with
 * ``rereadStatus``; every Put/Update resolves empty. Mirrors the single re-read
 * `reconcileMicrovmSubstrateState` performs before failing a task.
 */
function primeReread(rereadStatus: string): void {
  mockDdbSend.mockImplementation((cmd: { _type: string }) => {
    if (cmd._type === 'Get') {
      return Promise.resolve({
        Item: { task_id: 'TASK001', user_id: 'user-1', repo: 'org/repo', status: rereadStatus },
      });
    }
    return Promise.resolve({});
  });
}

const CORRELATION = { user_id: 'user-1', repo: 'org/repo' };

function reconcile(substrate: SessionStatus, ddbStatus: string, suspendAnomalyReported?: boolean) {
  return reconcileMicrovmSubstrateState({
    taskId: 'TASK001',
    ddbStatus: ddbStatus as never,
    substrate,
    microvmId: MICROVM_ID,
    userId: 'user-1',
    correlation: CORRELATION,
    log: mockLogger,
    repo: 'org/repo',
    ...(suspendAnomalyReported !== undefined && { suspendAnomalyReported }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
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

describe('reconcileMicrovmSubstrateState', () => {
  describe('running substrate', () => {
    test('is a no-op: no DDB reads, no events, task not failed', async () => {
      const result = await reconcile({ status: 'running' }, TaskStatus.RUNNING);

      // `suspendAnomalyReported: false` RE-ARMS the once-per-episode event: a VM
      // that resumed and is later suspended again earns a fresh anomaly event.
      expect(result).toEqual({ taskFailed: false, suspendAnomalyReported: false });
      expect(mockDdbSend).not.toHaveBeenCalled();
    });
  });

  describe('suspended substrate', () => {
    test('is healthy while the task is AWAITING_APPROVAL — no event, no failure', async () => {
      const result = await reconcile({ status: 'suspended' }, TaskStatus.AWAITING_APPROVAL);

      // The orchestrator-intended suspend during an approval wait is the whole
      // economic point of the backend: it must be silent — and it re-arms the
      // anomaly event, because leaving AWAITING_APPROVAL while still suspended
      // would be a new, genuinely reportable episode.
      expect(result).toEqual({ taskFailed: false, suspendAnomalyReported: false });
      expect(mockDdbSend).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('writes an anomaly event and does NOT fail the task when the status is RUNNING', async () => {
      const result = await reconcile({ status: 'suspended' }, TaskStatus.RUNNING);

      expect(result).toEqual({ taskFailed: false, suspendAnomalyReported: true });

      const puts = commandsOfType('Put');
      expect(puts).toHaveLength(1);
      expect(puts[0].input.TableName).toBe('TaskEvents');
      const item = puts[0].input.Item as Record<string, unknown>;
      expect(item.event_type).toBe('microvm_suspend_anomaly');
      expect(item.task_id).toBe('TASK001');
      // Correlation envelope (#245) stamped as top-level fields.
      expect(item.user_id).toBe('user-1');
      expect(item.repo).toBe('org/repo');
      expect(item.metadata).toEqual({
        microvm_id: MICROVM_ID,
        task_status: TaskStatus.RUNNING,
        reason: 'suspended_outside_approval_wait',
      });

      // Crucially: no status transition — a suspended VM is resumable, so
      // failing the task would destroy recoverable work.
      expect(commandsOfType('Update')).toHaveLength(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test.each([
      TaskStatus.HYDRATING,
      TaskStatus.RUNNING,
      TaskStatus.FINALIZING,
    ])('treats suspended + %s as an anomaly rather than a failure', async (status) => {
      const result = await reconcile({ status: 'suspended' }, status);

      expect(result).toEqual({ taskFailed: false, suspendAnomalyReported: true });
      expect(commandsOfType('Put')[0].input.Item).toMatchObject({
        event_type: 'microvm_suspend_anomaly',
        metadata: { task_status: status },
      });
    });

    test('emits the anomaly event ONCE across repeated polls of the same episode', async () => {
      // The poll runs every ~30 s for up to 8.5 h; without the flag an
      // out-of-band suspend would write ~960 identical TaskEvents, burying the
      // first informative one. The caller threads the returned flag back in.
      let reported: boolean | undefined;
      for (let poll = 0; poll < 5; poll += 1) {
        const result = await reconcile({ status: 'suspended' }, TaskStatus.RUNNING, reported);
        reported = result.suspendAnomalyReported;
        // The no-fail-fast behaviour is unchanged on EVERY poll — that is the
        // property the suppression must not break.
        expect(result.taskFailed).toBe(false);
        expect(result.suspendAnomalyReported).toBe(true);
      }

      expect(commandsOfType('Put')).toHaveLength(1);
      expect((commandsOfType('Put')[0].input.Item as Record<string, unknown>).event_type)
        .toBe('microvm_suspend_anomaly');
      // The WARN log is deliberately NOT suppressed: per-poll evidence is what a
      // timeline investigation needs, and CloudWatch is not a user-facing surface.
      expect(mockLogger.warn).toHaveBeenCalledTimes(5);
    });

    test('the repeat-suppressed polls record that the event was already reported', async () => {
      await reconcile({ status: 'suspended' }, TaskStatus.RUNNING, true);

      expect(commandsOfType('Put')).toHaveLength(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('suspended while the task is not awaiting approval'),
        expect.objectContaining({ anomaly_already_reported: true }),
      );
    });

    test('RE-ARMS after the VM resumes, so a second episode emits again', async () => {
      // Recovery genuinely re-arms (documented decision): a flapping suspend loop
      // is the pathology an operator most needs to see, and latching forever
      // would hide it after the first occurrence.
      const first = await reconcile({ status: 'suspended' }, TaskStatus.RUNNING, false);
      expect(first.suspendAnomalyReported).toBe(true);

      const recovered = await reconcile({ status: 'running' }, TaskStatus.RUNNING, first.suspendAnomalyReported);
      expect(recovered.suspendAnomalyReported).toBe(false);

      const second = await reconcile({ status: 'suspended' }, TaskStatus.RUNNING, recovered.suspendAnomalyReported);
      expect(second.suspendAnomalyReported).toBe(true);

      // Two episodes → two events.
      expect(commandsOfType('Put')).toHaveLength(2);
    });

    test('RE-ARMS when the task enters AWAITING_APPROVAL, so a later out-of-band suspend reports', async () => {
      const first = await reconcile({ status: 'suspended' }, TaskStatus.RUNNING, false);
      expect(first.suspendAnomalyReported).toBe(true);

      // The gate opened: this suspend is now the intended one.
      const intended = await reconcile(
        { status: 'suspended' }, TaskStatus.AWAITING_APPROVAL, first.suspendAnomalyReported);
      expect(intended.suspendAnomalyReported).toBe(false);
      expect(commandsOfType('Put')).toHaveLength(1);

      // The gate closed but the VM is still suspended — a new anomaly.
      const third = await reconcile(
        { status: 'suspended' }, TaskStatus.RUNNING, intended.suspendAnomalyReported);
      expect(third.suspendAnomalyReported).toBe(true);
      expect(commandsOfType('Put')).toHaveLength(2);
    });

    test('defaults to NOT-yet-reported when the caller omits the flag', async () => {
      // Back-compat for any caller (and the first poll of every task) that has no
      // prior state: the event must fire, not be suppressed by an undefined flag.
      const result = await reconcile({ status: 'suspended' }, TaskStatus.RUNNING);
      expect(result.suspendAnomalyReported).toBe(true);
      expect(commandsOfType('Put')).toHaveLength(1);
    });
  });

  describe('terminal substrate', () => {
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
    ])('persists a stable failure code and consistent user guidance for %s', async (reason, code, category, retryable) => {
      primeReread(TaskStatus.RUNNING);
      await reconcile({ status: 'completed', reason }, TaskStatus.RUNNING);
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

    test('fails the task when the re-read status is still non-terminal', async () => {
      primeReread(TaskStatus.RUNNING);

      const result = await reconcile({ status: 'completed' }, TaskStatus.RUNNING);

      expect(result).toEqual({ taskFailed: true, suspendAnomalyReported: false });

      // Re-read before acting (guards the "agent wrote terminal, VM torn down"
      // race), then the FAILED transition.
      expect(commandsOfType('Get')).toHaveLength(1);
      const updates = commandsOfType('Update');
      expect(updates).toHaveLength(1);
      expect(updates[0].input.TableName).toBe('Tasks');
      const values = updates[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':toStatus']).toBe(TaskStatus.FAILED);
      expect(values[':fromStatus']).toBe(TaskStatus.RUNNING);
      // The reason string is what error-classifier keys the substrate-failure
      // classification on — keep the two in lockstep.
      expect(values[':attr_error_message']).toBe(
        'MICROVM_SUBSTRATE_TERMINATED: MicroVM substrate terminated before the agent wrote a terminal status: substrate state completed',
      );

      // Plus the task_failed audit event.
      const puts = commandsOfType('Put');
      expect(puts).toHaveLength(1);
      expect((puts[0].input.Item as Record<string, unknown>).event_type).toBe('task_failed');
    });

    test('does NOT fail the task when the re-read shows the agent already wrote a terminal status', async () => {
      primeReread(TaskStatus.COMPLETED);

      const result = await reconcile({ status: 'completed' }, TaskStatus.RUNNING);

      // Normal shutdown ordering: agent writes COMPLETED, exits, VM terminates.
      // Without the re-read this would have failed a successful task.
      expect(result).toEqual({ taskFailed: false, suspendAnomalyReported: false });
      expect(commandsOfType('Update')).toHaveLength(0);
      expect(commandsOfType('Put')).toHaveLength(0);
    });

    test.each([
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.CANCELLED,
      TaskStatus.TIMED_OUT,
    ])('accepts a re-read terminal status of %s without failing the task', async (status) => {
      primeReread(status);

      const result = await reconcile({ status: 'completed' }, TaskStatus.RUNNING);

      expect(result).toEqual({ taskFailed: false, suspendAnomalyReported: false });
      expect(commandsOfType('Update')).toHaveLength(0);
    });

    test('carries the substrate error detail into the failure reason', async () => {
      primeReread(TaskStatus.RUNNING);

      const result = await reconcile({ status: 'failed', error: 'host fault' }, TaskStatus.RUNNING);

      expect(result).toEqual({ taskFailed: true, suspendAnomalyReported: false });
      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':attr_error_message']).toBe(
        'MICROVM_SUBSTRATE_TERMINATED: MicroVM substrate terminated before the agent wrote a terminal status: host fault',
      );
    });

    // --- stateReason in the detail (review B1) ---

    test('appends the substrate reason so the DOMINANT failure names its real cause', async () => {
      // The exact live shape: a /run hook 4xx self-terminates the VM in ~12 s
      // (645-p2-smoke-runbook.md §6.1). Without the reason this read "substrate
      // state completed" and the classifier's remedy named a session duration cap, a
      // host fault, or an external terminate — none of which happened.
      primeReread(TaskStatus.RUNNING);
      const reason = 'Run lifecycle hook returned HTTP status 400. Please check your hook endpoint '
        + 'and application logs for more details.';

      await reconcile({ status: 'completed', reason }, TaskStatus.RUNNING);

      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':attr_error_message']).toBe(
        'MICROVM_RUN_HOOK_REJECTED: MicroVM substrate terminated before the agent wrote a terminal status: '
        + `substrate state completed (${reason})`,
      );
    });

    test('appends the reason to a failed substrate report too, without losing the error', async () => {
      primeReread(TaskStatus.RUNNING);

      await reconcile(
        { status: 'failed', error: 'host fault', reason: 'hypervisor evicted the guest' },
        TaskStatus.RUNNING,
      );

      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':attr_error_message']).toBe(
        'MICROVM_SUBSTRATE_TERMINATED: MicroVM substrate terminated before the agent wrote a terminal status: '
        + 'host fault (hypervisor evicted the guest)',
      );
    });

    test('keeps a stable code when the substrate supplies no reason', async () => {
      primeReread(TaskStatus.RUNNING);

      await reconcile({ status: 'completed' }, TaskStatus.RUNNING);

      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':attr_error_message']).toBe(
        'MICROVM_SUBSTRATE_TERMINATED: MicroVM substrate terminated before the agent wrote a terminal status: substrate state completed',
      );
    });

    test('a hook 4xx selects the non-retryable failure code', async () => {
      primeReread(TaskStatus.RUNNING);
      await reconcile({ status: 'completed', reason: 'Run lifecycle hook returned HTTP status 400.' }, TaskStatus.RUNNING);
      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;

      const classification = classifyError(String(values[':attr_error_message']));

      expect(classification!.title).toBe('The MicroVM rejected its own run payload');
      expect(classification!.retryable).toBe(false);
    });

    test('a NON-hook reason keeps the generic retryable substrate-failure entry', async () => {
      // An ordinary service reason must not select the hook-rejection code.
      primeReread(TaskStatus.RUNNING);
      await reconcile(
        { status: 'completed', reason: 'host fault (hypervisor evicted the guest)' },
        TaskStatus.RUNNING,
      );
      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;

      const classification = classifyError(String(values[':attr_error_message']));

      expect(classification!.title).toBe('The MicroVM stopped before the agent reported a result');
      expect(classification!.retryable).toBe(true);
    });

    test('fails from AWAITING_APPROVAL too — a terminated VM cannot resume the gate', async () => {
      primeReread(TaskStatus.AWAITING_APPROVAL);

      const result = await reconcile({ status: 'completed' }, TaskStatus.AWAITING_APPROVAL);

      expect(result).toEqual({ taskFailed: true, suspendAnomalyReported: false });
      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':fromStatus']).toBe(TaskStatus.AWAITING_APPROVAL);
      expect(values[':toStatus']).toBe(TaskStatus.FAILED);
    });

    test('transitions from the RE-READ status, not the stale polled status', async () => {
      // Task moved HYDRATING → RUNNING between the poll read and the re-read; the
      // conditional transition must use the fresh value or it fails its own
      // ConditionExpression and the task is left stuck.
      primeReread(TaskStatus.RUNNING);

      await reconcile({ status: 'completed' }, TaskStatus.HYDRATING);

      const values = commandsOfType('Update')[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':fromStatus']).toBe(TaskStatus.RUNNING);
    });

    test('does not decrement concurrency — the finalize step owns the release', async () => {
      primeReread(TaskStatus.RUNNING);

      await reconcile({ status: 'completed' }, TaskStatus.RUNNING);

      // Matches the ECS substrate-failure branch: failTask(..., releaseConcurrency=false).
      const concurrencyWrites = commandsOfType('Update').filter(
        c => c.input.TableName === 'Concurrency',
      );
      expect(concurrencyWrites).toHaveLength(0);
    });
  });
});
