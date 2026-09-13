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

// ONE shared send, not a fresh `jest.fn()` per client construction: the payload
// PUT and the finalize DELETE are both assertions this file needs to make, and a
// per-instance mock silently discards them.
const mockS3Send = jest.fn().mockResolvedValue({});
const mockDdbSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));
const mockResolveAsset = jest.fn();
jest.mock('../../src/handlers/shared/registry/factory', () => ({
  makeRegistryClient: () => ({ resolve: mockResolveAsset }),
}));
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  hydrateContext: jest.fn().mockResolvedValue({ sources: [], token_estimate: 0, truncated: false }),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://payloads.s3.us-east-1.amazonaws.com/task/payload.json?X-Amz-Signature=' + Date.now() }));
const mockObjects = new Map<string, string>();
jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn((input: unknown) => ({ _type: 'GetObject', input })),
  S3Client: jest.fn(() => ({ send: mockS3Send, config: { credentials: async () => ({ accessKeyId: 'EXAMPLE', secretAccessKey: 'unused' }) } })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ _type: 'DeleteObject', input })),
}));

const mockReleaseTaskSlot = jest.fn().mockResolvedValue(false);
jest.mock('../../src/handlers/shared/task-concurrency', () => ({
  acquireTaskSlot: jest.fn().mockResolvedValue(true),
  releaseTaskSlot: (...args: unknown[]) => mockReleaseTaskSlot(...args),
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
const mockLoadTask = jest.fn();
const mockClaimStart = jest.fn();
const mockSaveHandle = jest.fn();
const mockHydrateAndTransition = jest.fn();
const mockLoadBlueprint = jest.fn();
jest.mock('../../src/handlers/shared/microvm-start', () => ({
  ...jest.requireActual('../../src/handlers/shared/microvm-start'),
  claimMicrovmStart: (...args: unknown[]) => mockClaimStart(...args),
  saveMicrovmStartHandle: (...args: unknown[]) => mockSaveHandle(...args),
}));
jest.mock('../../src/handlers/shared/orchestrator', () => ({
  admissionControl: jest.fn().mockResolvedValue(true),
  emitTaskEvent: (...a: unknown[]) => mockEmitTaskEvent(...a),
  envelopeFor: () => ({
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    correlation: { user_id: 'user-1', repo: 'org/repo' },
  }),
  failTask: (...a: unknown[]) => mockFailTask(...a),
  finalizeTask: (...a: unknown[]) => mockFinalizeTask(...a),
  hydrateAndTransition: (...a: unknown[]) => mockHydrateAndTransition(...a),
  loadBlueprintConfig: (...a: unknown[]) => mockLoadBlueprint(...a),
  loadTask: (...args: unknown[]) => mockLoadTask(...args),
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

// platform_config (ADR-021 P2): the four REQUIRED identifiers the MicroVM
// strategy refuses to start a session without — they are the agent's only
// channel for them, since a snapshot must not bake configuration in. Read at
// call time by `buildMicrovmPlatformConfig`, but set here alongside the rest
// for clarity.
process.env.GITHUB_TOKEN_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:abca/github-token-AbCdEf';
process.env.AGENT_SESSION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaAgentSessionRole';

import { TaskStatus } from '../../src/constructs/task-status';
import { handler } from '../../src/handlers/orchestrate-task';
import { LambdaMicrovmComputeStrategy, MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES } from '../../src/handlers/shared/strategies/lambda-microvm-strategy';

/**
 * Minimal stand-in for the durable-execution context: `step` runs its body
 * inline, `waitForCondition` runs the poll body ONCE and returns the resulting
 * state (enough to exercise the substrate cross-check without looping).
 */
function fakeContext(opts: { pollOnce?: boolean } = {}) {
  const steps: string[] = [];
  const stepConfigs: Record<string, any> = {};
  return {
    steps,
    stepConfigs,
    ctx: {
      step: async (name: string, fn: () => Promise<unknown>, config?: unknown) => {
        steps.push(name);
        stepConfigs[name] = config;
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

/**
 * A context that HONORS `waitStrategy`, so the poll loop's exit decision is part
 * of the test rather than assumed.
 *
 * `fakeContext` above runs the poll body once and ignores `waitStrategy` entirely,
 * which means the composition the heartbeat work exists FOR — a stale heartbeat
 * stops the poll, finalize runs, and `TerminateMicrovm` reclaims the reservation —
 * was never asserted end to end for any backend. This drives real iterations until
 * the strategy says stop (bounded, so a broken exit condition fails as a timeout
 * rather than hanging the suite).
 */
function loopingContext(maxIterations = 10) {
  const steps: string[] = [];
  const iterations: Array<Record<string, unknown>> = [];
  return {
    steps,
    iterations,
    ctx: {
      step: async (name: string, fn: () => Promise<unknown>) => {
        steps.push(name);
        return fn();
      },
      waitForCondition: async (
        name: string,
        fn: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
        cfg: {
          initialState: Record<string, unknown>;
          waitStrategy: (state: Record<string, unknown>) => { shouldContinue: boolean };
        },
      ) => {
        steps.push(name);
        let state = cfg.initialState;
        for (let i = 0; i < maxIterations; i++) {
          state = await fn(state);
          iterations.push(state);
          if (!cfg.waitStrategy(state).shouldContinue) return state;
        }
        throw new Error(`waitStrategy never stopped after ${maxIterations} iterations`);
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

/** S3 commands of a given type — the payload bucket lives on its own client. */
function s3CommandsOfType(type: string) {
  return mockS3Send.mock.calls.map(c => c[0]).filter(c => c._type === type);
}

function failedTransition() {
  return mockTransitionTask.mock.calls.find(([, , to]) => to === TaskStatus.FAILED)!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockReset().mockResolvedValue({});
  mockResolveAsset.mockReset();
  mockHydrateAndTransition.mockReset().mockResolvedValue({ repo_url: 'org/repo', task_id: 'TASK001' });
  mockLoadBlueprint.mockReset().mockResolvedValue({ compute_type: 'lambda-microvm', runtime_arn: '' });
  mockTransitionTask.mockReset().mockResolvedValue(undefined);
  mockEmitTaskEvent.mockReset().mockResolvedValue(undefined);
  mockFinalizeTask.mockReset().mockResolvedValue(undefined);
  mockFailTask.mockReset().mockResolvedValue(undefined);
  mockLoadTask.mockReset().mockImplementation(async (_id: string, consistentRead?: boolean) => ({
    task_id: 'TASK001',
    user_id: 'user-1',
    status: consistentRead ? 'HYDRATING' : 'SUBMITTED',
    repo: 'org/repo',
  }));
  mockClaimStart.mockReset().mockImplementation(async (taskId: string) => ({ clientToken: taskId, closed: false }));
  mockSaveHandle.mockReset().mockResolvedValue(undefined);
  mockObjects.clear();
  mockS3Send.mockReset().mockImplementation(async ({ _type: type, input: command }) => {
    if (type === 'GetObject') {
      if (!mockObjects.has(command.Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => mockObjects.get(command.Key) } };
    }
    if (type === 'DeleteObject') { mockObjects.delete(command.Key); return {}; }
    if (command.IfNoneMatch === '*' && mockObjects.has(command.Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
    mockObjects.set(command.Key, command.Body);
    return {};
  });
  mockMicrovmSend.mockReset();
  mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.COMPLETED });
  mockReconcile.mockResolvedValue({ taskFailed: false });
});

describe('orchestrate-task for a lambda-microvm task', () => {
  test('registry assets alone exceed the hook cap and survive real hydration and v2 S3 delivery (#818)', async () => {
    const runtime = {
      transport: 'http',
      url: 'https://mcp.example.com/tools',
      headers: { 'X-Registry-Context': 'x'.repeat(6000) },
    };
    const asset = { kind: 'mcp_server', namespace: 'acme', name: 'large', version: '1.0.0', runtime };
    mockResolveAsset.mockResolvedValue({ ...asset, warnings: [] });
    mockLoadBlueprint.mockResolvedValue({
      compute_type: 'lambda-microvm',
      runtime_arn: '',
      mcp_servers: ['registry://mcp_server/acme/large@1.0.0'],
    });
    // Exercise the real registry resolution, payload assembly and audit writes;
    // only external service boundaries are stubbed on this hydration path.
    mockHydrateAndTransition.mockImplementationOnce(realOrchestrator.hydrateAndTransition);
    runMicrovmOk();

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(mockResolveAsset).toHaveBeenCalledTimes(1);
    const upload = s3CommandsOfType('PutObject').find(c => c.input.Key === 'TASK001/payload.json');
    const document = JSON.parse(upload.input.Body);
    expect(document.agent_payload.resolved_assets).toEqual([asset]);
    const { resolved_assets: assets, ...basePayload } = document.agent_payload;
    expect(Buffer.byteLength(JSON.stringify(basePayload))).toBeLessThan(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(assets))).toBeGreaterThan(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
    const run = commandsOfType('RunMicrovm');
    expect(run).toHaveLength(1);
    const wire = run[0].input.runHookPayload;
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
    expect(JSON.parse(wire)).toMatchObject({ version: 2, task_id: 'TASK001', payload_url: expect.any(String) });
    expect(wire).not.toContain('X-Registry-Context');
    const audit = mockDdbSend.mock.calls.find(([c]) => c.input.ExpressionAttributeValues?.[':ra']);
    expect(audit![0].input.ExpressionAttributeValues[':ra']).toEqual([
      { kind: 'mcp_server', id: 'acme/large', version: '1.0.0' },
    ]);
  });

  test.each([2, 3])('cancellation on task read %s checks release before leaving the pipeline', async (cancelOnRead) => {
    let reads = 0;
    mockLoadTask.mockImplementation(async () => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: ++reads >= cancelOnRead ? TaskStatus.CANCELLED : TaskStatus.SUBMITTED,
    }));
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
    expect(commandsOfType('RunMicrovm')).toHaveLength(0);
    expect(mockReleaseTaskSlot).toHaveBeenCalledWith('TASK001', 'user-1');
  });

  test('replaying a persisted start failure reaches finalization once without an earlier slot release', async () => {
    let failed = false;
    mockMicrovmSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    mockClaimStart.mockImplementation(async () => ({ clientToken: 'TASK001', closed: failed }));
    mockTransitionTask.mockImplementation(async (_id, _from, to) => { failed = to === TaskStatus.FAILED; });
    mockLoadTask.mockImplementation(async (_id, consistentRead) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead ? (failed ? TaskStatus.FAILED : TaskStatus.HYDRATING) : TaskStatus.SUBMITTED,
    }));
    const { ctx } = fakeContext();
    await handler({ task_id: 'TASK001' }, {
      ...ctx,
      step: async (name: string, fn: () => Promise<unknown>, config?: unknown) => {
        if (name === 'start-session') await fn();
        return ctx.step(name, fn, config);
      },
    } as never);
    expect(commandsOfType('RunMicrovm')).toHaveLength(1);
    expect(mockTransitionTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).not.toHaveBeenCalled();
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
  });

  test('durable replay after registration recovers one computer without a second transition', async () => {
    runMicrovmOk();
    let savedHandle: unknown;
    let registered = false;
    mockClaimStart.mockImplementation(async () => ({
      clientToken: 'TASK001', closed: false, ...(savedHandle ? { handle: savedHandle } : {}),
    }));
    mockSaveHandle.mockImplementation(async (_taskId, _token, handle) => { savedHandle = handle; });
    mockTransitionTask.mockImplementationOnce(async () => { registered = true; });
    mockLoadTask.mockImplementation(async (_id, consistentRead) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead ? (registered ? TaskStatus.RUNNING : TaskStatus.HYDRATING) : TaskStatus.SUBMITTED,
      ...(registered && { session_id: MICROVM_ID }),
    }));
    const { ctx, stepConfigs } = fakeContext();
    const replayContext = {
      ...ctx,
      step: async (name: string, fn: () => Promise<unknown>, config?: unknown) => {
        if (name === 'start-session') await fn(); // response/checkpoint lost
        return ctx.step(name, fn, config);
      },
    };
    await handler({ task_id: 'TASK001' }, replayContext as never);
    expect(commandsOfType('RunMicrovm')).toHaveLength(1);
    expect(mockTransitionTask).toHaveBeenCalledTimes(1);
    expect(stepConfigs['start-session'].retryStrategy(new Error('failed'), 1)).toEqual({ shouldRetry: false });
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  test('a lost task-transition response is reconciled before stopping a registered computer', async () => {
    runMicrovmOk();
    let registered = false;
    mockTransitionTask.mockImplementationOnce(async () => {
      registered = true;
      throw new Error('DynamoDB response lost');
    });
    mockLoadTask.mockImplementation(async (_id, consistentRead) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead ? (registered ? TaskStatus.RUNNING : TaskStatus.HYDRATING) : TaskStatus.SUBMITTED,
      ...(registered && { session_id: MICROVM_ID }),
    }));
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
    expect(mockFailTask).not.toHaveBeenCalled();
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
    expect(commandsOfType('RunMicrovm')).toHaveLength(1);
  });

  test('cancellation after creation terminates and finalizes without restoring RUNNING', async () => {
    runMicrovmOk();
    mockLoadTask.mockImplementation(async (_id, consistentRead) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead && commandsOfType('RunMicrovm').length > 0 ? TaskStatus.CANCELLED : TaskStatus.SUBMITTED,
    }));
    const { ctx, steps } = fakeContext();
    await handler({ task_id: 'TASK001' }, ctx as never);
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockFailTask).not.toHaveBeenCalled();
    expect(commandsOfType('TerminateMicrovm')).toHaveLength(1);
    expect(mockFinalizeTask).toHaveBeenCalledWith('TASK001', { attempts: 0 }, 'user-1');
    expect(steps).toContain('finalize-before-session');
    expect(mockPollTaskStatus).not.toHaveBeenCalled();
  });

  test('a session_started audit-event failure does not destroy a registered session', async () => {
    runMicrovmOk();
    mockEmitTaskEvent.mockImplementationOnce(async (_id, eventType) => {
      if (eventType === 'session_started') throw new Error('event write failed');
    });
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
    expect(mockFailTask).not.toHaveBeenCalled();
    const terminateIndex = mockMicrovmSend.mock.calls.findIndex(([command]) => command._type === 'TerminateMicrovm');
    expect(mockMicrovmSend.mock.invocationCallOrder[terminateIndex])
      .toBeGreaterThan(mockFinalizeTask.mock.invocationCallOrder[0]);
  });

  test('two unanswered starts persist an unknown outcome instead of inviting another task', async () => {
    const timeout = Object.assign(new Error('response lost'), { name: 'TimeoutError' });
    mockMicrovmSend.mockRejectedValue(timeout);
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
    expect(commandsOfType('RunMicrovm')).toHaveLength(2);
    expect(failedTransition()[3].error_message).toContain('MICROVM_START_OUTCOME_UNKNOWN:');
  });

  test('an unanswered start remains visible if the agent already changed the task to RUNNING', async () => {
    mockMicrovmSend.mockRejectedValue(Object.assign(new Error('response lost'), { name: 'TimeoutError' }));
    mockLoadTask.mockImplementation(async (_id, consistentRead) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead ? TaskStatus.RUNNING : TaskStatus.SUBMITTED,
    }));
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
    expect(failedTransition()[1]).toBe(TaskStatus.RUNNING);
    expect(failedTransition()[3].error_message).toContain('MICROVM_START_OUTCOME_UNKNOWN:');
  });

  test('cancellation after a lost response records the unknown computer without starting another', async () => {
    mockClaimStart.mockResolvedValueOnce({ clientToken: 'TASK001', closed: false })
      .mockResolvedValueOnce({ clientToken: 'TASK001', closed: false })
      .mockResolvedValue({ clientToken: 'TASK001', closed: true });
    mockMicrovmSend.mockRejectedValue(Object.assign(new Error('response lost'), { name: 'TimeoutError' }));
    mockLoadTask.mockImplementation(async (_id, consistentRead) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead && commandsOfType('RunMicrovm').length > 0 ? TaskStatus.CANCELLED : TaskStatus.SUBMITTED,
    }));
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
    expect(commandsOfType('RunMicrovm')).toHaveLength(1);
    expect(mockEmitTaskEvent).toHaveBeenCalledWith('TASK001', 'microvm_start_outcome_unknown',
      { client_token: 'TASK001', task_status: TaskStatus.CANCELLED }, expect.any(Object));
    expect(mockFailTask).not.toHaveBeenCalled();
  });

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

  // --- finalize-time payload delete (review NB3) ---

  test('deletes its own payload and saved capability on finalize', async () => {
    // Revoke the signed payload link and remove its private replay record.
    // The one-day lifecycle remains a cleanup backstop.
    runMicrovmOk();

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    const deletes = s3CommandsOfType('DeleteObject');
    expect(deletes).toHaveLength(2);
    expect(deletes[0].input).toEqual({
      Bucket: 'test-microvm-payload-bucket',
      Key: 'TASK001/payload.json',
    });
    expect(deletes[1].input).toEqual({
      Bucket: 'test-microvm-payload-bucket',
      Key: 'TASK001/launch.json',
    });
    // ...and it did not reach for the ECS deleter.
    expect(mockDeleteEcsPayload).not.toHaveBeenCalled();
  });

  // --- heartbeat -> stop polling -> finalize -> TerminateMicrovm (review test gap) ---
  //
  // The composition the heartbeat change EXISTS for: a hung guest inside a healthy
  // VM is invisible to `GetMicrovm`, so only the stale heartbeat can stop the poll —
  // and if it stops the poll but nothing terminates, the 8-hour reservation is still
  // billed. `fakeContext` runs one iteration and ignores `waitStrategy`, so this
  // needed `loopingContext` to be assertable at all.

  test('a stale agent heartbeat stops the poll AND reclaims the MicroVM', async () => {
    runMicrovmOk();
    // The substrate stays healthy throughout — this is the blind spot.
    mockMicrovmSend.mockResolvedValue({ microvmId: MICROVM_ID, state: 'RUNNING' });
    mockReconcile.mockResolvedValue({ taskFailed: false, suspendAnomalyReported: false });
    mockPollTaskStatus.mockResolvedValue({
      attempts: 1,
      lastStatus: TaskStatus.RUNNING,
      sessionUnhealthy: true,
    });

    const looping = loopingContext();
    await handler({ task_id: 'TASK001' }, looping.ctx as never);

    // Exited on the FIRST unhealthy observation — not after burning the 8.5 h window.
    expect(looping.iterations).toHaveLength(1);
    // finalize ran, and it saw the unhealthy flag (that is what writes FAILED).
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
    expect(mockFinalizeTask.mock.calls[0][1]).toMatchObject({ sessionUnhealthy: true });
    // ...and the reservation was actually reclaimed. This is the billing outcome.
    expect(commandsOfType('TerminateMicrovm')).toHaveLength(1);
    expect(commandsOfType('TerminateMicrovm')[0].input)
      .toEqual({ microvmIdentifier: MICROVM_ID });
  });

  test('a healthy heartbeat keeps polling until a terminal task status', async () => {
    // The other side of the same predicate: without this, a `sessionUnhealthy: true`
    // hard-coded into the poll would pass the test above.
    runMicrovmOk();
    mockMicrovmSend.mockResolvedValue({ microvmId: MICROVM_ID, state: 'RUNNING' });
    mockReconcile.mockResolvedValue({ taskFailed: false, suspendAnomalyReported: false });
    mockPollTaskStatus
      .mockResolvedValueOnce({ attempts: 1, lastStatus: TaskStatus.RUNNING, sessionUnhealthy: false })
      .mockResolvedValueOnce({ attempts: 2, lastStatus: TaskStatus.RUNNING, sessionUnhealthy: false })
      .mockResolvedValue({ attempts: 3, lastStatus: TaskStatus.COMPLETED, sessionUnhealthy: false });

    const looping = loopingContext();
    await handler({ task_id: 'TASK001' }, looping.ctx as never);

    expect(looping.iterations).toHaveLength(3);
    expect(mockFinalizeTask.mock.calls[0][1]).toMatchObject({ lastStatus: TaskStatus.COMPLETED });
    // Terminate happens on every finalize, healthy or not — the VM does not
    // self-terminate on this substrate.
    expect(commandsOfType('TerminateMicrovm')).toHaveLength(1);
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

  test('threads suspendAnomalyReported into the reconcile call so the event fires once', async () => {
    runMicrovmOk();
    mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.RUNNING });
    mockMicrovmSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'SUSPENDED' });
    mockReconcile.mockResolvedValue({ taskFailed: false, suspendAnomalyReported: true });

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    // First poll of the task: nothing reported yet.
    expect(mockReconcile.mock.calls[0][0].suspendAnomalyReported).toBe(false);
    // ...and the reconciler's answer is carried into the state the next poll reads.
    expect(mockFinalizeTask).toHaveBeenCalledWith(
      'TASK001',
      expect.objectContaining({ microvmSuspendAnomalyReported: true }),
      'user-1',
    );
  });

  test('a MicroVM poll failure carries the anomaly flag forward rather than re-arming it', async () => {
    // A GetMicrovm hiccup is not evidence that the anomaly ended, so it must not
    // silently re-arm the event and produce a duplicate on the next cycle.
    runMicrovmOk();
    mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.RUNNING });
    mockMicrovmSend.mockRejectedValueOnce(new Error('transient'));

    const { ctx } = fakeContext();
    // Seed the poll state as if a previous cycle had already reported.
    const seededCtx = {
      ...ctx,
      waitForCondition: async (
        _name: string,
        fn: (state: Record<string, unknown>) => Promise<unknown>,
      ) => fn({ attempts: 1, microvmSuspendAnomalyReported: true }),
    };

    await handler({ task_id: 'TASK001' }, seededCtx as never);

    expect(mockFinalizeTask).toHaveBeenCalledWith(
      'TASK001',
      expect.objectContaining({ microvmSuspendAnomalyReported: true }),
      'user-1',
    );
  });

  describe('orphan reap when session start fails AFTER RunMicrovm succeeded', () => {
    test('terminates the known MicroVM when registration fails before committing', async () => {
      // The service created the computer, but registration did not commit.
      // Its start receipt retains the ID; normal task polling has not started.
      runMicrovmOk();
      mockTransitionTask.mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));

      await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
      expect(failedTransition()[3].error_message).toContain('ConditionalCheckFailedException');

      const terminates = commandsOfType('TerminateMicrovm');
      expect(terminates).toHaveLength(1);
      expect(terminates[0].input).toEqual({ microvmIdentifier: MICROVM_ID });
    });

    test('still fails the task with the ORIGINAL error — the reap never masks it', async () => {
      runMicrovmOk();
      mockTransitionTask.mockRejectedValueOnce(new Error('persist exploded'));

      await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
      expect(failedTransition()[3].error_message).toContain('persist exploded');

      expect(mockFailTask).not.toHaveBeenCalled();
      expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
      const [, fromStatus, , attrs] = failedTransition();
      const reason = attrs.error_message;
      expect(fromStatus).toBe(TaskStatus.HYDRATING);
      expect(reason).toContain('Session start failed');
      expect(reason).toContain('persist exploded');
    });

    test('a failing TerminateMicrovm does not replace the original error', async () => {
      runMicrovmOk();
      mockTransitionTask.mockRejectedValueOnce(new Error('persist exploded'));
      const reapErr = new Error('terminate denied');
      reapErr.name = 'AccessDeniedException';
      mockMicrovmSend.mockRejectedValueOnce(reapErr);

      // stopSession is internally best-effort (it logs AccessDenied at error level
      // and returns), so the reap is a no-op here — the user must still see why
      // session start actually failed.
      await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
      expect(failedTransition()[3].error_message).toContain('persist exploded');
    });

    test('even a stopSession that BREAKS its no-throw contract cannot mask the original error', async () => {
      // Defense in depth for the handler's inner try/catch: `stopSession` is
      // contractually non-throwing for this backend, but "contractually" is not
      // "structurally". If it ever regresses, the reap must still not become the
      // error the user is shown — the session-start failure is the actionable one.
      runMicrovmOk();
      mockTransitionTask.mockRejectedValueOnce(new Error('persist exploded'));
      const stopSpy = jest.spyOn(LambdaMicrovmComputeStrategy.prototype, 'stopSession')
        .mockRejectedValueOnce(new Error('stopSession itself threw'));

      try {
        await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);
        expect(failedTransition()[3].error_message).toContain('persist exploded');
      } finally {
        stopSpy.mockRestore();
      }
    });

    test('does NOT terminate when RunMicrovm itself failed (there is nothing to reap)', async () => {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      mockMicrovmSend.mockRejectedValueOnce(err);

      await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

      expect(commandsOfType('TerminateMicrovm')).toHaveLength(0);
    });

    test('does not reap on a healthy start (no spurious terminate before the task runs)', async () => {
      runMicrovmOk();
      mockPollTaskStatus.mockResolvedValue({ attempts: 1, lastStatus: TaskStatus.RUNNING });
      mockMicrovmSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'RUNNING' });

      await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

      // Exactly ONE terminate — the finalize one, not an extra reap.
      expect(commandsOfType('TerminateMicrovm')).toHaveLength(1);
    });
  });
});
