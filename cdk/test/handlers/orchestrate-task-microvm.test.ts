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
 * Drives the FULL orchestrate-task durable handler for a `lambda-microvm` task
 * with a fake durable-execution context, so the wiring the unit tests can't see
 * is covered end to end: strategy resolution → RunMicrovm → compute_metadata
 * persistence → substrate poll cross-check → **TerminateMicrovm on finalize**.
 *
 * The finalize terminate is an ADR-021 normative requirement ("When the
 * orchestrator finalizes a `lambda-microvm` task, the orchestrator shall call
 * terminate-microvm") and is invisible to strategy-level unit tests, which is
 * exactly how it was missed the first time.
 */

// `withDurableExecution` wraps the handler at import time; unwrap it so the raw
// (event, context) function is testable (same trick as orchestrate-task-feedback).
jest.mock('@aws/durable-execution-sdk-js', () => ({
  withDurableExecution: (fn: unknown) => fn,
}));

const MICROVM_ID = 'mvm-0123456789abcdef';
const ENDPOINT = 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com';

const mockMicrovmSend = jest.fn();
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockMicrovmSend })),
  RunMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'RunMicrovm', input })),
  GetMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'GetMicrovm', input })),
  TerminateMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'TerminateMicrovm', input })),
  MicrovmState: {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    SUSPENDED: 'SUSPENDED',
    SUSPENDING: 'SUSPENDING',
    TERMINATED: 'TERMINATED',
    TERMINATING: 'TERMINATING',
  },
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ _type: 'DeleteObject', input })),
}));

// Real orchestrator helpers would talk to DynamoDB; stub them and assert on the
// calls. `buildComputeMetadata` is kept REAL (re-exported from the actual module)
// so the persisted metadata shape is genuinely exercised, not mirrored.
const realOrchestrator = jest.requireActual('../../src/handlers/shared/orchestrator');
const mockTransitionTask = jest.fn();
const mockEmitTaskEvent = jest.fn();
const mockFinalizeTask = jest.fn();
const mockPollTaskStatus = jest.fn();
const mockReconcile = jest.fn();
const mockFailTask = jest.fn();
jest.mock('../../src/handlers/shared/orchestrator', () => ({
  admissionControl: jest.fn().mockResolvedValue(true),
  emitTaskEvent: (...a: unknown[]) => mockEmitTaskEvent(...a),
  envelopeFor: () => ({
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    correlation: { user_id: 'user-1', repo: 'org/repo' },
  }),
  failTask: (...a: unknown[]) => mockFailTask(...a),
  finalizeTask: (...a: unknown[]) => mockFinalizeTask(...a),
  hydrateAndTransition: jest.fn().mockResolvedValue({ repo_url: 'org/repo', task_id: 'TASK001' }),
  loadBlueprintConfig: jest.fn().mockResolvedValue({ compute_type: 'lambda-microvm', runtime_arn: '' }),
  loadTask: jest.fn().mockResolvedValue({
    task_id: 'TASK001', user_id: 'user-1', status: 'SUBMITTED', repo: 'org/repo',
  }),
  pollTaskStatus: (...a: unknown[]) => mockPollTaskStatus(...a),
  reconcileMicrovmSubstrateState: (...a: unknown[]) => mockReconcile(...a),
  transitionTask: (...a: unknown[]) => mockTransitionTask(...a),
  buildComputeMetadata: realOrchestrator.buildComputeMetadata,
}));

jest.mock('../../src/handlers/shared/preflight', () => ({
  runPreflightChecks: jest.fn().mockResolvedValue({ passed: true, checks: {} }),
}));

const mockDeleteEcsPayload = jest.fn();
jest.mock('../../src/handlers/shared/strategies/ecs-strategy', () => ({
  deleteEcsPayload: (...a: unknown[]) => mockDeleteEcsPayload(...a),
  EcsComputeStrategy: jest.fn(),
}));

// MICROVM_* env must be set before the strategy module is imported.
process.env.MICROVM_IMAGE_IDENTIFIER = 'arn:aws:lambda:us-east-1:123456789012:microvm-image/abca-agent';
process.env.MICROVM_EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaMicrovmExecution';
process.env.MICROVM_EGRESS_CONNECTOR_ARNS = 'arn:aws:lambda:us-east-1:123456789012:network-connector/egress-1';
process.env.MICROVM_PAYLOAD_BUCKET = 'test-microvm-payload-bucket';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';
process.env.TASK_RETENTION_DAYS = '90';

import { TaskStatus } from '../../src/constructs/task-status';
import { handler } from '../../src/handlers/orchestrate-task';

/**
 * Minimal stand-in for the durable-execution context: `step` runs its body
 * inline, `waitForCondition` runs the poll body ONCE and returns the resulting
 * state (enough to exercise the substrate cross-check without looping).
 */
function fakeContext(opts: { pollOnce?: boolean } = {}) {
  const steps: string[] = [];
  return {
    steps,
    ctx: {
      step: async (name: string, fn: () => Promise<unknown>) => {
        steps.push(name);
        return fn();
      },
      waitForCondition: async (
        name: string,
        fn: (state: { attempts: number }) => Promise<unknown>,
        cfg: { initialState: { attempts: number } },
      ) => {
        steps.push(name);
        if (opts.pollOnce === false) return cfg.initialState;
        return fn(cfg.initialState);
      },
    },
  };
}

function runMicrovmOk() {
  mockMicrovmSend.mockResolvedValueOnce({
    microvmId: MICROVM_ID,
    endpoint: ENDPOINT,
    state: 'RUNNING',
    imageArn: 'arn:image',
    imageVersion: '7',
  });
}

function commandsOfType(type: string) {
  return mockMicrovmSend.mock.calls.map(c => c[0]).filter(c => c._type === type);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMicrovmSend.mockReset();
  mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.COMPLETED });
  mockReconcile.mockResolvedValue({ taskFailed: false });
});

describe('orchestrate-task for a lambda-microvm task', () => {
  test('persists microvmId and endpoint in compute_metadata on the RUNNING transition', async () => {
    runMicrovmOk();
    const { ctx } = fakeContext();

    await handler({ task_id: 'TASK001' }, ctx as never);

    // RunMicrovm actually went out.
    expect(commandsOfType('RunMicrovm')).toHaveLength(1);

    expect(mockTransitionTask).toHaveBeenCalledTimes(1);
    const [, from, to, attrs] = mockTransitionTask.mock.calls[0];
    expect(from).toBe(TaskStatus.HYDRATING);
    expect(to).toBe(TaskStatus.RUNNING);
    expect(attrs.compute_type).toBe('lambda-microvm');
    // ADR-021: the P3 approve/deny Lambdas resume from exactly these two keys.
    expect(attrs.compute_metadata).toEqual({ microvmId: MICROVM_ID, endpoint: ENDPOINT });
    // sessionId is the microvmId (substrate identifier, mirroring ECS).
    expect(attrs.session_id).toBe(MICROVM_ID);
    // agent_runtime_arn is an AgentCore-only attribute and must not appear.
    expect(attrs.agent_runtime_arn).toBeUndefined();
  });

  test('sends TerminateMicrovm on finalize (ADR-021 active-cleanup requirement)', async () => {
    runMicrovmOk();
    const { ctx, steps } = fakeContext();

    await handler({ task_id: 'TASK001' }, ctx as never);

    expect(steps).toContain('finalize');
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);

    const terminates = commandsOfType('TerminateMicrovm');
    expect(terminates).toHaveLength(1);
    expect(terminates[0].input).toEqual({ microvmIdentifier: MICROVM_ID });
  });

  test('terminates AFTER finalizeTask, so the task row is already terminal', async () => {
    const order: string[] = [];
    mockFinalizeTask.mockImplementation(async () => { order.push('finalizeTask'); });
    mockMicrovmSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'RunMicrovm') {
        return { microvmId: MICROVM_ID, endpoint: ENDPOINT, state: 'RUNNING' };
      }
      if (cmd._type === 'TerminateMicrovm') order.push('terminate');
      return {};
    });

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(order).toEqual(['finalizeTask', 'terminate']);
  });

  test('a TerminateMicrovm failure does not fail the finalize step (best-effort)', async () => {
    runMicrovmOk();
    const err = new Error('boom');
    err.name = 'InternalServerException';
    mockMicrovmSend.mockRejectedValueOnce(err);

    // stopSession swallows every failure internally, so the handler resolves.
    await expect(handler({ task_id: 'TASK001' }, fakeContext().ctx as never)).resolves.toBeUndefined();
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
  });

  test('does not call deleteEcsPayload for a microvm task', async () => {
    runMicrovmOk();

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(mockDeleteEcsPayload).not.toHaveBeenCalled();
  });

  test('cross-checks the substrate through reconcileMicrovmSubstrateState while non-terminal', async () => {
    runMicrovmOk();
    mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.RUNNING });
    // GetMicrovm during the poll, then TerminateMicrovm on finalize.
    mockMicrovmSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'SUSPENDED' });

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(commandsOfType('GetMicrovm')).toHaveLength(1);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    const args = mockReconcile.mock.calls[0][0];
    expect(args.microvmId).toBe(MICROVM_ID);
    expect(args.ddbStatus).toBe(TaskStatus.RUNNING);
    // The strategy's mechanical mapping is what the orchestrator interprets.
    expect(args.substrate).toEqual({ status: 'suspended' });
  });

  test('returns a failed poll state when reconciliation fails the task', async () => {
    runMicrovmOk();
    mockPollTaskStatus.mockResolvedValue({ attempts: 3, lastStatus: TaskStatus.RUNNING });
    mockMicrovmSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'TERMINATED' });
    mockReconcile.mockResolvedValue({ taskFailed: true });

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(mockFinalizeTask).toHaveBeenCalledWith(
      'TASK001',
      { attempts: 3, lastStatus: TaskStatus.FAILED },
      'user-1',
    );
  });

  test('skips the substrate cross-check once the DDB status is terminal', async () => {
    runMicrovmOk();
    mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.COMPLETED });

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(commandsOfType('GetMicrovm')).toHaveLength(0);
    expect(mockReconcile).not.toHaveBeenCalled();
    // Finalize still terminates.
    expect(commandsOfType('TerminateMicrovm')).toHaveLength(1);
  });

  test('a GetMicrovm poll failure is non-fatal and finalize still terminates', async () => {
    runMicrovmOk();
    mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.RUNNING });
    mockMicrovmSend.mockRejectedValueOnce(new Error('transient'));

    await expect(handler({ task_id: 'TASK001' }, fakeContext().ctx as never)).resolves.toBeUndefined();

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(commandsOfType('TerminateMicrovm')).toHaveLength(1);
  });
});
