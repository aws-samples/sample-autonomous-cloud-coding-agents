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

const IMAGE_IDENTIFIER = 'arn:aws:lambda:us-east-1:123456789012:microvm-image/abca-agent';
const IMAGE_VERSION = '7';
const EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaMicrovmExecution';
const EGRESS_CONNECTOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:network-connector/egress-1';
const INGRESS_CONNECTOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:network-connector/ingress-1';
const PAYLOAD_BUCKET = 'test-microvm-payload-bucket';
const MICROVM_ID = 'mvm-0123456789abcdef';
const ENDPOINT = 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com';

// Set env vars BEFORE import — LambdaMicrovmComputeStrategy reads them as
// module-level constants (same pattern as ecs-strategy). The top-of-file import
// is the FULLY-CONFIGURED substrate; the missing-config describe block below
// re-imports under jest.isolateModules with vars deleted, and the ingress block
// re-imports with the OPTIONAL ingress var set. Ingress is deliberately absent
// here so the default (no-ingress) assertions are hermetic.
process.env.MICROVM_IMAGE_IDENTIFIER = IMAGE_IDENTIFIER;
process.env.MICROVM_IMAGE_VERSION = IMAGE_VERSION;
process.env.MICROVM_EXECUTION_ROLE_ARN = EXECUTION_ROLE_ARN;
process.env.MICROVM_EGRESS_CONNECTOR_ARNS = EGRESS_CONNECTOR_ARN;
process.env.MICROVM_PAYLOAD_BUCKET = PAYLOAD_BUCKET;
delete process.env.MICROVM_INGRESS_CONNECTOR_ARNS;

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockSend })),
  RunMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'RunMicrovm', input })),
  GetMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'GetMicrovm', input })),
  TerminateMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'TerminateMicrovm', input })),
  // Mirrors the real SDK's const-object enum so the strategy's switch keys on
  // the same literals the service returns.
  MicrovmState: {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    SUSPENDED: 'SUSPENDED',
    SUSPENDING: 'SUSPENDING',
    TERMINATED: 'TERMINATED',
    TERMINATING: 'TERMINATING',
  },
}));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ _type: 'DeleteObject', input })),
}));

// The real logger writes JSON to process.stdout/stderr, so level assertions need
// the module mocked rather than console spied (see repo-config.test.ts).
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() };
jest.mock('../../../../src/handlers/shared/logger', () => ({ logger: mockLogger }));

import type { BlueprintConfig } from '../../../../src/handlers/shared/repo-config';
import {
  LambdaMicrovmComputeStrategy,
  MICROVM_ERROR_MARKER,
  MICROVM_MAX_DURATION_SECONDS,
  MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES,
  microvmPayloadKey,
} from '../../../../src/handlers/shared/strategies/lambda-microvm-strategy';

const BLUEPRINT: BlueprintConfig = { compute_type: 'lambda-microvm', runtime_arn: '' };

/**
 * Build a payload whose serialized `{"agent_payload": …}` envelope is EXACTLY
 * `targetBytes` long, so the 16 KB boundary can be probed on both sides. Asserts
 * its own arithmetic — if the envelope shape ever changes, this fails loudly
 * rather than silently testing the wrong boundary.
 */
function payloadWithEnvelopeBytes(targetBytes: number): Record<string, unknown> {
  const overhead = Buffer.byteLength(JSON.stringify({ agent_payload: { p: '' } }), 'utf8');
  const payload = { p: 'x'.repeat(targetBytes - overhead) };
  expect(Buffer.byteLength(JSON.stringify({ agent_payload: payload }), 'utf8')).toBe(targetBytes);
  return payload;
}

function runMicrovmOk() {
  mockSend.mockResolvedValueOnce({
    microvmId: MICROVM_ID,
    endpoint: ENDPOINT,
    state: 'RUNNING',
    imageArn: IMAGE_IDENTIFIER,
    imageVersion: IMAGE_VERSION,
  });
}

/** The handle shape pollSession/stopSession expect. */
const makeHandle = () => ({
  sessionId: MICROVM_ID,
  strategyType: 'lambda-microvm' as const,
  microvmId: MICROVM_ID,
  endpoint: ENDPOINT,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LambdaMicrovmComputeStrategy', () => {
  test('type is lambda-microvm', () => {
    expect(new LambdaMicrovmComputeStrategy().type).toBe('lambda-microvm');
  });

  describe('startSession', () => {
    test('sends RunMicrovm with the configured image, execution role and egress connector', async () => {
      runMicrovmOk();

      const handle = await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo', prompt: 'Fix the bug' },
        blueprintConfig: BLUEPRINT,
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call._type).toBe('RunMicrovm');
      expect(call.input.imageIdentifier).toBe(IMAGE_IDENTIFIER);
      expect(call.input.imageVersion).toBe(IMAGE_VERSION);
      expect(call.input.executionRoleArn).toBe(EXECUTION_ROLE_ARN);
      expect(call.input.egressNetworkConnectors).toEqual([EGRESS_CONNECTOR_ARN]);

      expect(handle).toEqual({
        sessionId: MICROVM_ID,
        strategyType: 'lambda-microvm',
        microvmId: MICROVM_ID,
        endpoint: ENDPOINT,
      });
    });

    test('sets maximumDurationInSeconds to the 28800s service maximum', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: BLUEPRINT,
      });

      expect(MICROVM_MAX_DURATION_SECONDS).toBe(28_800);
      expect(mockSend.mock.calls[0][0].input.maximumDurationInSeconds).toBe(28_800);
    });

    test('OMITS idlePolicy entirely — the field must be absent, not disabled (ADR-021 invariant)', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: BLUEPRINT,
      });

      const input = mockSend.mock.calls[0][0].input;
      // Absence, not `undefined`/falsy: all three idlePolicy fields are required
      // when the block is present, so omission is the unambiguous disabled state.
      // Traffic-based auto-suspend would freeze the outbound-only agent mid-build.
      expect(Object.keys(input)).not.toContain('idlePolicy');
      expect('idlePolicy' in input).toBe(false);
    });

    test('passes NO ingress connectors by default (no orchestrator to agent path in P1)', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: BLUEPRINT,
      });

      const input = mockSend.mock.calls[0][0].input;
      expect('ingressNetworkConnectors' in input).toBe(false);
    });

    test('inlines a small payload in runHookPayload and never touches S3', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo', prompt: 'Fix the bug', max_turns: 50 },
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      const envelope = JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload);
      expect(envelope.agent_payload).toEqual({ repo_url: 'org/repo', prompt: 'Fix the bug', max_turns: 50 });
      expect(envelope.agent_payload_s3_uri).toBeUndefined();
    });

    test('uploads an oversized payload to S3 and inlines only the pointer', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      const big = { repo_url: 'org/repo', hydrated_context: { blob: 'x'.repeat(20_000) } };
      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: big,
        blueprintConfig: BLUEPRINT,
      });

      // Same key shape as the ECS payload bucket: <task_id>/payload.json
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const put = mockS3Send.mock.calls[0][0];
      expect(put._type).toBe('PutObject');
      expect(put.input.Bucket).toBe(PAYLOAD_BUCKET);
      expect(put.input.Key).toBe('TASK001/payload.json');
      expect(put.input.ContentType).toBe('application/json');
      expect(JSON.parse(put.input.Body)).toEqual(big);

      const runHookPayload = mockSend.mock.calls[0][0].input.runHookPayload;
      const envelope = JSON.parse(runHookPayload);
      expect(envelope.agent_payload_s3_uri).toBe(`s3://${PAYLOAD_BUCKET}/TASK001/payload.json`);
      expect(envelope.agent_payload).toBeUndefined();
      // The whole point: the hook body must sit far under the 16 KB cap.
      expect(Buffer.byteLength(runHookPayload, 'utf8')).toBeLessThan(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
    });

    test('the inline/S3 branch point IS the 16KB service cap, with no headroom', () => {
      // Unlike ECS (whose 8192-byte cap is shared with env vars + command, so it
      // needs a margin), runHookPayload is the entire counted string — ADR-021
      // says upload only when the payload EXCEEDS 16 KB, so shipping a 13 KB
      // payload to S3 would violate the requirement.
      expect(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES).toBe(16_384);
    });

    test('a payload whose envelope is EXACTLY 16384 bytes stays inline', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(16_384),
        blueprintConfig: BLUEPRINT,
      });

      // Boundary is `<=`: 16384 is at the cap, not over it.
      expect(mockS3Send).not.toHaveBeenCalled();
      const runHookPayload = mockSend.mock.calls[0][0].input.runHookPayload;
      expect(Buffer.byteLength(runHookPayload, 'utf8')).toBe(16_384);
      expect(JSON.parse(runHookPayload).agent_payload).toBeDefined();
    });

    test('a payload whose envelope is 16385 bytes — one over — goes to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(16_385),
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const envelope = JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload);
      expect(envelope.agent_payload_s3_uri).toBe(`s3://${PAYLOAD_BUCKET}/TASK001/payload.json`);
      expect(envelope.agent_payload).toBeUndefined();
    });

    test('a mid-sized payload the old 12KB threshold would have offloaded stays inline', async () => {
      runMicrovmOk();

      // Regression guard for the compliance fix: 13 KB is under the 16 KB cap, so
      // it must NOT incur an S3 round-trip.
      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(13_000),
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload).agent_payload).toBeDefined();
    });

    test('measures the serialized envelope in BYTES, so a multi-byte payload still goes to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      // 7000 chars of 3-byte UTF-8 → ~21 KB of bytes but only 7 KB of chars.
      // Measuring String.length would have wrongly inlined this.
      const payload = { repo_url: 'org/repo', prompt: '\u4f60'.repeat(7_000) };
      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload,
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload).agent_payload_s3_uri).toBeDefined();
    });

    test('throws when RunMicrovm returns no microvmId', async () => {
      mockSend.mockResolvedValueOnce({ endpoint: ENDPOINT, state: 'PENDING' });

      await expect(
        new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        }),
      ).rejects.toThrow('RunMicrovm returned an incomplete response');
    });

    test('throws when RunMicrovm returns no endpoint', async () => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'PENDING' });

      await expect(
        new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        }),
      ).rejects.toThrow('RunMicrovm returned an incomplete response');
    });

    test('microvmPayloadKey matches the ECS payload key shape', () => {
      expect(microvmPayloadKey('TASK001')).toBe('TASK001/payload.json');
    });
  });

  describe('pollSession — mechanical state mapping, no task-state interpretation', () => {
    test.each([
      ['PENDING', 'running'],
      ['RUNNING', 'running'],
      ['SUSPENDING', 'suspended'],
      ['SUSPENDED', 'suspended'],
      ['TERMINATING', 'completed'],
      ['TERMINATED', 'completed'],
    ])('maps MicroVM state %s to session status %s', async (state, expected) => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state });

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());
      expect(result).toEqual({ status: expected });
    });

    test('sends GetMicrovm keyed on microvmIdentifier', async () => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'RUNNING' });

      await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());

      const call = mockSend.mock.calls[0][0];
      expect(call._type).toBe('GetMicrovm');
      expect(call.input).toEqual({ microvmIdentifier: MICROVM_ID });
    });

    test('reports SUSPENDED as suspended without inspecting task state', async () => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'SUSPENDED' });

      // No task id, no DDB read — the strategy cannot see the task row at all,
      // which is exactly why the health rules live in the orchestrator.
      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());
      expect(result).toEqual({ status: 'suspended' });
    });

    test('treats ResourceNotFoundException as completed (a reaped MicroVM is gone, not broken)', async () => {
      const err = new Error('MicroVM mvm-0123456789abcdef not found');
      err.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(err);

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());
      expect(result).toEqual({ status: 'completed' });
    });

    test('rethrows non-NotFound errors so the caller can count poll failures', async () => {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      mockSend.mockRejectedValueOnce(err);

      await expect(new LambdaMicrovmComputeStrategy().pollSession(makeHandle())).rejects.toThrow('Rate exceeded');
    });
    test('reports running for an unrecognized future state rather than failing the task', async () => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'HIBERNATING_SOMEDAY' });

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('throws when the handle is not a lambda-microvm handle', async () => {
      await expect(
        new LambdaMicrovmComputeStrategy().pollSession({
          sessionId: 'test',
          strategyType: 'agentcore',
          runtimeArn: 'arn:test',
        }),
      ).rejects.toThrow('pollSession called with non-lambda-microvm handle');
    });
  });

  describe('stopSession — best-effort with differentiated error handling', () => {
    test('sends TerminateMicrovm keyed on microvmIdentifier', async () => {
      mockSend.mockResolvedValueOnce({});

      await new LambdaMicrovmComputeStrategy().stopSession(makeHandle());

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call._type).toBe('TerminateMicrovm');
      expect(call.input).toEqual({ microvmIdentifier: MICROVM_ID });
    });

    test.each([
      ['ResourceNotFoundException', 'info'],
      ['ConflictException', 'info'],
      ['ThrottlingException', 'error'],
      ['AccessDeniedException', 'error'],
      ['InternalServerException', 'warn'],
    ])('logs %s at %s level and never throws', async (errName, expectedLevel) => {
      const err = new Error('boom');
      err.name = errName;
      mockSend.mockRejectedValueOnce(err);

      await expect(new LambdaMicrovmComputeStrategy().stopSession(makeHandle())).resolves.toBeUndefined();

      const byLevel: Record<string, jest.Mock> = {
        info: mockLogger.info,
        warn: mockLogger.warn,
        error: mockLogger.error,
      };
      expect(byLevel[expectedLevel]).toHaveBeenCalledTimes(1);
      for (const [level, spy] of Object.entries(byLevel)) {
        if (level !== expectedLevel) expect(spy).not.toHaveBeenCalled();
      }
    });

    test('throws when the handle is not a lambda-microvm handle', async () => {
      await expect(
        new LambdaMicrovmComputeStrategy().stopSession({
          sessionId: 'test',
          strategyType: 'ecs',
          clusterArn: 'arn:cluster',
          taskArn: 'arn:task',
        }),
      ).rejects.toThrow('stopSession called with non-lambda-microvm handle');
    });
  });

  describe('error marking — every escaping error carries the MicroVM marker', () => {
    // The marker is what lets error-classifier scope its bare AWS exception-name
    // patterns to THIS backend, so an unmarked escape is a silent classification
    // hole: the error would fall through to UNKNOWN ("Unexpected error").
    const markerRe = new RegExp(`${MICROVM_ERROR_MARKER} [\\w ]+failed`);

    test('the marker constant matches the pattern shape the classifier anchors on', () => {
      expect(MICROVM_ERROR_MARKER).toBe('MicroVM');
      expect(`${MICROVM_ERROR_MARKER} RunMicrovm failed: x`).toMatch(markerRe);
    });

    test('marks a RunMicrovm failure and splices in the SDK exception name', async () => {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      mockSend.mockRejectedValueOnce(err);

      const start = new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: BLUEPRINT,
      });

      await expect(start).rejects.toThrow(markerRe);
      // The exception NAME must appear: err.message alone omits it, and the
      // classifier keys on `<marker> … <ExceptionName>`.
      await expect(start).rejects.toThrow('MicroVM RunMicrovm failed: ThrottlingException: Rate exceeded');
    });

    test('preserves the original error as `cause` so err.name stays inspectable', async () => {
      const err = new Error('quota');
      err.name = 'ServiceQuotaExceededException';
      mockSend.mockRejectedValueOnce(err);

      await new LambdaMicrovmComputeStrategy()
        .startSession({ taskId: 'TASK001', userId: 'u', payload: {}, blueprintConfig: BLUEPRINT })
        .catch((thrown: Error) => {
          expect(thrown.cause).toBe(err);
          expect((thrown.cause as Error).name).toBe('ServiceQuotaExceededException');
        });
      expect.assertions(2);
    });

    test('marks a GetMicrovm failure', async () => {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      mockSend.mockRejectedValueOnce(err);

      await expect(new LambdaMicrovmComputeStrategy().pollSession(makeHandle()))
        .rejects.toThrow('MicroVM GetMicrovm failed: ThrottlingException: Rate exceeded');
    });

    test('marks a payload-upload failure so an S3 fault is attributed to this backend', async () => {
      const err = new Error('Access Denied');
      err.name = 'AccessDenied';
      mockS3Send.mockRejectedValueOnce(err);

      const start = new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(20_000),
        blueprintConfig: BLUEPRINT,
      });

      await expect(start).rejects.toThrow('MicroVM payload upload failed: AccessDenied: Access Denied');
      // Never reaches RunMicrovm — no half-started MicroVM on an upload fault.
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('does not double-prefix when the message already contains the exception name', async () => {
      const err = new Error('ThrottlingException: Rate exceeded');
      err.name = 'ThrottlingException';
      mockSend.mockRejectedValueOnce(err);

      await expect(new LambdaMicrovmComputeStrategy().pollSession(makeHandle()))
        .rejects.toThrow('MicroVM GetMicrovm failed: ThrottlingException: Rate exceeded');
    });

    test('marks a non-Error rejection too', async () => {
      mockSend.mockRejectedValueOnce('a bare string failure');

      await expect(new LambdaMicrovmComputeStrategy().pollSession(makeHandle()))
        .rejects.toThrow('MicroVM GetMicrovm failed: a bare string failure');
    });
  });
});

// The env-var guard reads module-level constants, so the missing-config case
// needs a fresh module graph with the vars deleted (same isolateModules pattern
// ecs-strategy's #502 tests use).
describe('LambdaMicrovmComputeStrategy without the MicroVM substrate deployed', () => {
  function loadStrategyWithout(missing: string[]): typeof LambdaMicrovmComputeStrategy {
    let Strategy!: typeof LambdaMicrovmComputeStrategy;
    const saved: Record<string, string | undefined> = {};
    jest.isolateModules(() => {
      for (const key of missing) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Strategy = require('../../../../src/handlers/shared/strategies/lambda-microvm-strategy').LambdaMicrovmComputeStrategy;
    });
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
    return Strategy;
  }

  test.each([
    ['MICROVM_IMAGE_IDENTIFIER'],
    ['MICROVM_EXECUTION_ROLE_ARN'],
    ['MICROVM_EGRESS_CONNECTOR_ARNS'],
    ['MICROVM_PAYLOAD_BUCKET'],
  ])('throws a descriptive config/deploy-mismatch error when %s is missing', async (envVar) => {
    const Strategy = loadStrategyWithout([envVar]);

    const start = new Strategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo' },
      blueprintConfig: BLUEPRINT,
    });

    // Names the root cause AND both remedies — an admin must not have to
    // reverse-engineer this from a bare env-var list.
    await expect(start).rejects.toThrow(/compute_type=lambda-microvm/);
    await expect(start).rejects.toThrow(/deployed without the Lambda MicroVMs substrate/);
    await expect(start).rejects.toThrow(/--context compute_type=lambda-microvm/);
    await expect(start).rejects.toThrow(/--compute-type agentcore/);
    await expect(start).rejects.toThrow(new RegExp(envVar));
    // Fails BEFORE any AWS call — no half-started MicroVM, no orphan S3 object.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('MICROVM_IMAGE_VERSION is optional — the field is omitted so the service picks the default', async () => {
    const Strategy = loadStrategyWithout(['MICROVM_IMAGE_VERSION']);
    runMicrovmOk();

    await new Strategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo' },
      blueprintConfig: BLUEPRINT,
    });

    expect('imageVersion' in mockSend.mock.calls[0][0].input).toBe(false);
  });
});

describe('LambdaMicrovmComputeStrategy with ingress connectors configured', () => {
  test('passes the configured ingress connectors when the env var is set', async () => {
    let Strategy!: typeof LambdaMicrovmComputeStrategy;
    jest.isolateModules(() => {
      process.env.MICROVM_INGRESS_CONNECTOR_ARNS = `${INGRESS_CONNECTOR_ARN}, ${INGRESS_CONNECTOR_ARN}-b`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Strategy = require('../../../../src/handlers/shared/strategies/lambda-microvm-strategy').LambdaMicrovmComputeStrategy;
    });
    delete process.env.MICROVM_INGRESS_CONNECTOR_ARNS;

    runMicrovmOk();
    await new Strategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo' },
      blueprintConfig: BLUEPRINT,
    });

    // Comma-separated, whitespace-trimmed — same parsing as ECS_SUBNETS.
    expect(mockSend.mock.calls[0][0].input.ingressNetworkConnectors).toEqual([
      INGRESS_CONNECTOR_ARN,
      `${INGRESS_CONNECTOR_ARN}-b`,
    ]);
  });
});
