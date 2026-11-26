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

// RunMicrovm rejects a bare image name ("Malformed ARN - doesn't start with 'arn:'"); the
// observed ARN has the colon form `microvm-image:<name>`.
const IMAGE_IDENTIFIER = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:abca-agent';
const IMAGE_VERSION = '7';
const EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaMicrovmExecution';
const EGRESS_CONNECTOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:network-connector/egress-1';
const INGRESS_CONNECTOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:network-connector/ingress-1';
const NO_INGRESS_CONNECTOR_ARN =
  'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS';
const PAYLOAD_BUCKET = 'test-microvm-payload-bucket';
const MICROVM_ID = 'mvm-0123456789abcdef';
const ENDPOINT = 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com';

const TASK_TABLE_NAME = 'abca-task-table';
const TASK_EVENTS_TABLE_NAME = 'abca-task-events-table';
const GITHUB_TOKEN_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:abca/github-token-AbCdEf';
const AGENT_SESSION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaAgentSessionRole';

process.env.MICROVM_IMAGE_IDENTIFIER = IMAGE_IDENTIFIER;
process.env.MICROVM_IMAGE_VERSION = IMAGE_VERSION;
process.env.MICROVM_EXECUTION_ROLE_ARN = EXECUTION_ROLE_ARN;
process.env.MICROVM_EGRESS_CONNECTOR_ARNS = EGRESS_CONNECTOR_ARN;
process.env.MICROVM_PAYLOAD_BUCKET = PAYLOAD_BUCKET;
process.env.AWS_REGION = 'us-east-1';
delete process.env.MICROVM_INGRESS_CONNECTOR_ARNS;

process.env.TASK_TABLE_NAME = TASK_TABLE_NAME;
process.env.TASK_EVENTS_TABLE_NAME = TASK_EVENTS_TABLE_NAME;
process.env.GITHUB_TOKEN_SECRET_ARN = GITHUB_TOKEN_SECRET_ARN;
process.env.AGENT_SESSION_ROLE_ARN = AGENT_SESSION_ROLE_ARN;
for (const optional of [
  'TASK_APPROVALS_TABLE_NAME',
  'NUDGES_TABLE_NAME',
  'LOG_GROUP_NAME',
  'ARTIFACTS_BUCKET_NAME',
  'TRACE_ARTIFACTS_BUCKET_NAME',
  'LINEAR_OAUTH_SECRET_ARN',
  'JIRA_OAUTH_SECRET_ARN',
  'AWS_SDK_UA_APP_ID',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
  'ABCA_TOOL_GATEWAY_URL',
  'LINEAR_VAULT_ENABLED',
  'LINEAR_WORKLOAD_IDENTITY_NAME',
]) {
  delete process.env[optional];
}

const mockSend = jest.fn();
const mockClaimStart = jest.fn();
const mockSaveHandle = jest.fn();
const mockSaveCapability = jest.fn();
jest.mock('../../../../src/handlers/shared/microvm/start', () => ({
  ...jest.requireActual('../../../../src/handlers/shared/microvm/start'),
  claimMicrovmStart: (...args: unknown[]) => mockClaimStart(...args),
  saveMicrovmStartHandle: (...args: unknown[]) => mockSaveHandle(...args),
  saveMicrovmImageCapability: (...args: unknown[]) => mockSaveCapability(...args),
}));
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockSend })),
  RunMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'RunMicrovm', input })),
  GetMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'GetMicrovm', input })),
  GetMicrovmImageVersionCommand: jest.fn((input: unknown) => ({ _type: 'GetMicrovmImageVersion', input })),
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

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ _type: 'DeleteObject', input })),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() };
jest.mock('../../../../src/handlers/shared/logger', () => ({ logger: mockLogger }));

import sharedConstants from '../../../../../contracts/constants.json';
import { classifyError } from '../../../../src/handlers/shared/error-classifier';
import type { BlueprintConfig } from '../../../../src/handlers/shared/repo-config';
import {
  LambdaMicrovmComputeStrategy,
  MICROVM_ERROR_MARKER,
  MICROVM_MAX_DURATION_SECONDS,
  MICROVM_PLATFORM_CONFIG_KEYS,
  MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS,
  MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES,
  buildMicrovmPlatformConfig,
  deleteMicrovmPayload,
  microvmNoIngressConnectorArnForRegion,
  microvmPayloadKey,
} from '../../../../src/handlers/shared/strategies/lambda-microvm-strategy';

const BLUEPRINT: BlueprintConfig = { compute_type: 'lambda-microvm', runtime_arn: '' };

const EXPECTED_PLATFORM_CONFIG = {
  task_table_name: TASK_TABLE_NAME,
  task_events_table_name: TASK_EVENTS_TABLE_NAME,
  github_token_secret_arn: GITHUB_TOKEN_SECRET_ARN,
  agent_session_role_arn: AGENT_SESSION_ROLE_ARN,
};

function payloadWithEnvelopeBytes(targetBytes: number): Record<string, unknown> {
  const overhead = Buffer.byteLength(
    JSON.stringify({ agent_payload: { p: '' }, platform_config: EXPECTED_PLATFORM_CONFIG }),
    'utf8',
  );
  const payload = { p: 'x'.repeat(targetBytes - overhead) };
  expect(
    Buffer.byteLength(
      JSON.stringify({ agent_payload: payload, platform_config: EXPECTED_PLATFORM_CONFIG }),
      'utf8',
    ),
  ).toBe(targetBytes);
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

const makeHandle = () => ({
  sessionId: MICROVM_ID,
  strategyType: 'lambda-microvm' as const,
  microvmId: MICROVM_ID,
  endpoint: ENDPOINT,
});

function withRegion(env: { AWS_REGION?: string; AWS_DEFAULT_REGION?: string }, body: () => void): void {
  const saved = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };
  try {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    body();
  } finally {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withRegionAsync(
  env: { AWS_REGION?: string; AWS_DEFAULT_REGION?: string },
  body: () => Promise<void>,
): Promise<void> {
  const saved = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };
  try {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await body();
  } finally {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withoutEnvAsync(keys: string[], body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync(env: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset();
  mockS3Send.mockReset().mockResolvedValue({});
  mockClaimStart.mockReset().mockImplementation(async (taskId: string) => ({ clientToken: taskId, closed: false }));
  mockSaveHandle.mockReset().mockResolvedValue(undefined);
  mockSaveCapability.mockReset().mockResolvedValue(undefined);
});

describe('per-worker image capability', () => {
  const input = {
    taskId: 'CAP001',
    userId: 'cognito-test',
    payload: { task_id: 'CAP001' },
    blueprintConfig: BLUEPRINT,
  };
  const identity = { imageArn: IMAGE_IDENTIFIER, imageVersion: 'actual-3.0' };
  const version = () => ({
    ...identity,
    environmentVariables: {
      [sharedConstants.microvm_lifecycle.image_protocol_env]: String(sharedConstants.microvm_lifecycle.protocol_version),
    },
    hooks: {
      port: sharedConstants.microvm_lifecycle.hook_port,
      microvmImageHooks: { ready: 'ENABLED', validate: 'ENABLED' },
      microvmHooks: {
        run: 'ENABLED',
        terminate: 'ENABLED',
        suspend: 'ENABLED',
        resume: 'ENABLED',
        suspendTimeoutInSeconds: sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds,
        resumeTimeoutInSeconds: sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds,
      },
    },
  });

  test('saves the known worker before querying its actual image and conditionally enriching it', async () => {
    mockSend.mockResolvedValueOnce({ ...makeHandle(), ...identity })
      .mockImplementationOnce(async (command, options) => {
        expect(mockSaveHandle).toHaveBeenCalledWith(input.taskId, input.taskId, { ...makeHandle(), ...identity });
        expect(command).toEqual({
          _type: 'GetMicrovmImageVersion',
          input: { imageIdentifier: IMAGE_IDENTIFIER, imageVersion: identity.imageVersion },
        });
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        return version();
      });
    const result = await new LambdaMicrovmComputeStrategy().startSession(input);
    const expected = { ...makeHandle(), ...identity, lifecycleProtocol: '1' };
    expect(result).toEqual(expected);
    expect(mockSaveCapability).toHaveBeenCalledWith(input.taskId, input.taskId, expected);
    expect(mockSaveHandle.mock.invocationCallOrder[0]).toBeLessThan(mockSaveCapability.mock.invocationCallOrder[0]);
  });

  test.each(['lookup', 'marker', 'persistence'])('failed %s keeps the saved worker usable without enabling sleep', async failure => {
    mockSend.mockResolvedValueOnce({ ...makeHandle(), ...identity, lifecycleProtocol: '1' });
    if (failure === 'lookup') {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('do-not-log-secret'), { name: 'AbortError' }));
    } else {
      const response = version();
      if (failure === 'marker') response.environmentVariables = {};
      mockSend.mockResolvedValueOnce(response);
      if (failure === 'persistence') mockSaveCapability.mockRejectedValueOnce(new Error('do-not-log-secret'));
    }
    expect(await new LambdaMicrovmComputeStrategy().startSession(input)).toEqual({ ...makeHandle(), ...identity });
    expect(mockSaveHandle.mock.calls[0][2]).not.toHaveProperty('lifecycleProtocol');
    expect(mockSend.mock.calls.filter(([command]) => command._type === 'RunMicrovm')).toHaveLength(1);
    expect(mockSend.mock.calls.filter(([command]) => command._type === 'TerminateMicrovm')).toHaveLength(0);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('do-not-log-secret');
  });

  test.each([{}, { imageArn: IMAGE_IDENTIFIER }, { ...identity, imageArn: 'arn:other-image' }])(
    'missing or mismatched returned identity cannot borrow deployment capability: %j', async returned => {
      mockSend.mockResolvedValueOnce({ ...makeHandle(), ...returned });
      const result = await new LambdaMicrovmComputeStrategy().startSession(input);
      expect(result).not.toHaveProperty('lifecycleProtocol');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSaveCapability).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, '1'])('replay preserves saved capability %s without querying the current deployment', async lifecycleProtocol => {
    const saved = lifecycleProtocol ? { ...makeHandle(), ...identity, lifecycleProtocol } : makeHandle();
    mockClaimStart.mockResolvedValue({ clientToken: input.taskId, handle: saved, closed: false });
    expect(await new LambdaMicrovmComputeStrategy().startSession(input)).toEqual(saved);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSaveCapability).not.toHaveBeenCalled();
  });
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

      expect(mockSend).toHaveBeenCalledTimes(2);
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
        imageArn: IMAGE_IDENTIFIER,
        imageVersion: IMAGE_VERSION,
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
      // All three idlePolicy fields are required when the block is present, so omission is the unambiguous disabled state.
      expect(Object.keys(input)).not.toContain('idlePolicy');
      expect('idlePolicy' in input).toBe(false);
    });

    test('passes the explicit NO_INGRESS connector when no ingress is configured', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: BLUEPRINT,
      });

      const input = mockSend.mock.calls[0][0].input;
      // RunMicrovm attaches the public HTTP_INGRESS connector when ingressNetworkConnectors is omitted.
      expect('ingressNetworkConnectors' in input).toBe(true);
      expect(input.ingressNetworkConnectors).toEqual([NO_INGRESS_CONNECTOR_ARN]);
      expect(JSON.stringify(input)).not.toContain('HTTP_INGRESS');
      expect(JSON.stringify(input)).not.toContain('SHELL_INGRESS');
    });

    test('derives the NO_INGRESS fallback ARN from the running Region', () => {
      expect(microvmNoIngressConnectorArnForRegion()).toBe(NO_INGRESS_CONNECTOR_ARN);
    });

    test.each([
      ['us-east-1', 'aws'],
      ['ap-northeast-1', 'aws'],
      ['cn-north-1', 'aws-cn'],
      ['us-gov-west-1', 'aws-us-gov'],
    ])('the NO_INGRESS fallback uses the right partition in %s', (region, partition) => {
      withRegion({ AWS_REGION: region }, () => {
        expect(microvmNoIngressConnectorArnForRegion()).toBe(
          `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:NO_INGRESS`,
        );
      });
    });

    test('the NO_INGRESS fallback reads AWS_DEFAULT_REGION when AWS_REGION is unset', () => {
      withRegion({ AWS_DEFAULT_REGION: 'eu-west-1' }, () => {
        expect(microvmNoIngressConnectorArnForRegion())
          .toContain(':lambda:eu-west-1:aws:network-connector:');
      });
    });

    test('the NO_INGRESS fallback never splices `undefined` into the ARN', () => {
      withRegion({}, () => {
        expect(microvmNoIngressConnectorArnForRegion()).not.toContain('undefined');
      });
    });

    test('the fallback reaches the RunMicrovm INPUT, per-Region, not just the helper', async () => {
      runMicrovmOk();

      await withRegionAsync({ AWS_REGION: 'eu-west-1' }, async () => {
        await new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        });
      });

      expect(mockSend.mock.calls[0][0].input.ingressNetworkConnectors).toEqual([
        'arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:NO_INGRESS',
      ]);
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
      expect(envelope.platform_config).toEqual(EXPECTED_PLATFORM_CONFIG);
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

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const put = mockS3Send.mock.calls[0][0];
      expect(put._type).toBe('PutObject');
      expect(put.input.Bucket).toBe(PAYLOAD_BUCKET);
      expect(put.input.Key).toBe('TASK001/payload.json');
      expect(put.input.ContentType).toBe('application/json');
      expect(JSON.parse(put.input.Body)).toEqual({ ...big, platform_config: EXPECTED_PLATFORM_CONFIG });

      const runHookPayload = mockSend.mock.calls[0][0].input.runHookPayload;
      const envelope = JSON.parse(runHookPayload);
      expect(envelope.agent_payload_s3_uri).toBe(`s3://${PAYLOAD_BUCKET}/TASK001/payload.json`);
      expect(envelope.agent_payload).toBeUndefined();
      expect(envelope.platform_config).toEqual(EXPECTED_PLATFORM_CONFIG);
      expect(Buffer.byteLength(runHookPayload, 'utf8')).toBeLessThan(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
    });

    test('the inline/S3 branch point IS the 4096-byte service cap, with no headroom', () => {
      // The service rejects 4097 bytes ("Member must have length less than or equal to 4096"); the SDK docs say 16,384.
      // The cap counts runHookPayload alone; the 8192-byte ECS cap also counts env vars and command.
      expect(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES).toBe(4_096);
    });

    test('a payload whose envelope is EXACTLY 4096 bytes stays inline', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(4_096),
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      const runHookPayload = mockSend.mock.calls[0][0].input.runHookPayload;
      expect(Buffer.byteLength(runHookPayload, 'utf8')).toBe(4_096);
      expect(JSON.parse(runHookPayload).agent_payload).toBeDefined();
    });

    test('a payload whose envelope is 4097 bytes — one over — goes to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(4_097),
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const envelope = JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload);
      expect(envelope.agent_payload_s3_uri).toBe(`s3://${PAYLOAD_BUCKET}/TASK001/payload.json`);
      expect(envelope.agent_payload).toBeUndefined();
    });

    test('a mid-sized envelope the SDK-documented 16KB cap would have inlined goes to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: payloadWithEnvelopeBytes(13_000),
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const envelope = JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload);
      expect(envelope.agent_payload_s3_uri).toBeDefined();
      expect(envelope.agent_payload).toBeUndefined();
    });

    test('measures the serialized envelope in BYTES, so a multi-byte payload still goes to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      const payload = { prompt: '\u4f60'.repeat(2_000) };
      expect(JSON.stringify({ agent_payload: payload, platform_config: EXPECTED_PLATFORM_CONFIG }).length)
        .toBeLessThan(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
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

    test('MARKS the incomplete-response throw so the classifier can see the backend', async () => {
      mockSend.mockResolvedValueOnce({ endpoint: ENDPOINT, state: 'PENDING' });

      await expect(
        new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        }),
      ).rejects.toThrow(
        `${MICROVM_ERROR_MARKER} RunMicrovm failed: RunMicrovm returned an incomplete response`,
      );
    });

    test('platform_config COUNTS toward the 4 KB boundary — an otherwise-inlineable payload goes to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});
      runMicrovmOk();

      const overheadWithoutConfig = Buffer.byteLength(JSON.stringify({ agent_payload: { p: '' } }), 'utf8');
      const payload = { p: 'x'.repeat(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES - overheadWithoutConfig) };
      expect(Buffer.byteLength(JSON.stringify({ agent_payload: payload }), 'utf8'))
        .toBe(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload,
        blueprintConfig: BLUEPRINT,
      });

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const runHookPayload = mockSend.mock.calls[0][0].input.runHookPayload;
      expect(JSON.parse(runHookPayload).agent_payload_s3_uri).toBeDefined();
      expect(Buffer.byteLength(runHookPayload, 'utf8'))
        .toBeLessThanOrEqual(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES);
    });

    test('fails BEFORE the upload when even the POINTER envelope cannot fit (no orphan object)', async () => {
      await withEnvAsync({ LOG_GROUP_NAME: `/aws/${'x'.repeat(5_000)}` }, async () => {
        const start = new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: payloadWithEnvelopeBytes(20_000),
          blueprintConfig: BLUEPRINT,
        });

        await expect(start).rejects.toThrow(/pointer envelope is \d+ bytes/);
        await expect(start).rejects.toThrow(/shorten the stack name/);
        expect(mockS3Send).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
      });
    });

    test('microvmPayloadKey matches the ECS payload key shape', () => {
      expect(microvmPayloadKey('TASK001')).toBe('TASK001/payload.json');
    });

    test('REAPS the MicroVM when the response carries an id but no endpoint', async () => {
      mockSend
        .mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'RUNNING' })
        .mockResolvedValueOnce({});

      await expect(
        new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        }),
      ).rejects.toThrow(`${MICROVM_ERROR_MARKER} RunMicrovm failed`);

      const terminate = mockSend.mock.calls.find(c => c[0]._type === 'TerminateMicrovm');
      expect(terminate).toBeDefined();
      expect(terminate![0].input).toEqual({ microvmIdentifier: MICROVM_ID });
    });

    test('a failing reap does not mask the incomplete-response error', async () => {
      mockSend
        .mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'RUNNING' })
        .mockRejectedValueOnce(new Error('terminate blew up'));

      await expect(
        new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        }),
      ).rejects.toThrow('RunMicrovm returned an incomplete response');
    });

    test('does NOT attempt a reap when there is no id to reap', async () => {
      mockSend.mockResolvedValueOnce({ endpoint: ENDPOINT, state: 'PENDING' });

      await expect(
        new LambdaMicrovmComputeStrategy().startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: BLUEPRINT,
        }),
      ).rejects.toThrow();

      expect(mockSend.mock.calls.filter(c => c[0]._type === 'TerminateMicrovm')).toHaveLength(0);
    });

    test.each(MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS.map(key => [key]))(
      'refuses to start — before any AWS call — when required platform config %s is missing',
      async (key) => {
        const envVar = sharedConstants.microvm_platform_config.env_by_key[key];

        await withoutEnvAsync([envVar], async () => {
          const start = new LambdaMicrovmComputeStrategy().startSession({
            taskId: 'TASK001',
            userId: 'cognito-test',
            payload: { prompt: 'x'.repeat(20_000) },
            blueprintConfig: BLUEPRINT,
          });

          await expect(start).rejects.toThrow(new RegExp(`${key} <- ${envVar}`));
          await expect(start).rejects.toThrow(/redeploy the stack/);
          expect(mockSend).not.toHaveBeenCalled();
          expect(mockS3Send).not.toHaveBeenCalled();
        });
      },
    );

    test('logs which platform_config KEYS a session received, and never their values', async () => {
      runMicrovmOk();

      await new LambdaMicrovmComputeStrategy().startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: BLUEPRINT,
      });

      const started = mockLogger.info.mock.calls
        .find(([message]) => message === 'Lambda MicroVM session started')!;
      expect(started[1].platform_config_keys).toEqual(Object.keys(EXPECTED_PLATFORM_CONFIG));
      expect(JSON.stringify(started[1])).not.toContain(GITHUB_TOKEN_SECRET_ARN);
    });
  });

  describe('deleteMicrovmPayload — closes the cross-task payload-read window', () => {
    test('deletes the task\'s own object from the payload bucket', async () => {
      await deleteMicrovmPayload('TASK001');

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const call = mockS3Send.mock.calls[0][0];
      expect(call._type).toBe('DeleteObject');
      expect(call.input).toEqual({
        Bucket: PAYLOAD_BUCKET,
        Key: microvmPayloadKey('TASK001'),
      });
    });

    test('is best-effort — a failed delete never throws', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(deleteMicrovmPayload('TASK001')).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to delete MicroVM payload object (non-fatal)',
        expect.objectContaining({ task_id: 'TASK001', error: 'AccessDenied' }),
      );
    });

    test('deletes ONLY the given task\'s key — never a prefix or the bucket', async () => {
      await deleteMicrovmPayload('TASK001');

      const { input } = mockS3Send.mock.calls[0][0];
      expect(input.Key).toBe('TASK001/payload.json');
      expect(input.Key).not.toContain('*');
      expect(input).not.toHaveProperty('Prefix');
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
      expect(result).toEqual({ status: expected, microvmState: state });
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

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());
      expect(result).toEqual({ status: 'suspended', microvmState: 'SUSPENDED' });
    });

    test('treats ResourceNotFoundException as completed (a reaped MicroVM is gone, not broken)', async () => {
      const err = new Error('MicroVM mvm-0123456789abcdef not found');
      err.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(err);

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());
      expect(result).toEqual({ status: 'completed', microvmState: 'NOT_FOUND' });
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
      expect(result).toEqual({ status: 'running', microvmState: 'UNKNOWN' });
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

    test('carries stateReason through on a terminal state', async () => {
      const reason = 'Run lifecycle hook returned HTTP status 400. Please check your hook endpoint '
        + 'and application logs for more details.';
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'TERMINATED', stateReason: reason });

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());

      expect(result).toEqual({ status: 'completed', microvmState: 'TERMINATED', reason });
    });

    test('logs a WARNING when a terminal MicroVM carries a reason', async () => {
      const reason = 'Run lifecycle hook returned HTTP status 400.';
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'TERMINATED', stateReason: reason });

      await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'MicroVM reached a terminal state with a substrate reason',
        expect.objectContaining({ microvm_id: MICROVM_ID, state: 'TERMINATED', state_reason: reason }),
      );
    });

    test('normalizes the service\'s "Success." away rather than appending noise', async () => {
      mockSend.mockResolvedValueOnce({
        microvmId: MICROVM_ID, state: 'TERMINATED', stateReason: 'Success.',
      });

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());

      expect(result).toEqual({ status: 'completed', microvmState: 'TERMINATED' });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('omits reason entirely when the substrate supplies none', async () => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state: 'RUNNING' });

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());

      expect(result).toEqual({ status: 'running', microvmState: 'RUNNING' });
      expect('reason' in result).toBe(false);
    });

    test.each([
      ['RUNNING', 'running'],
      ['SUSPENDED', 'suspended'],
      ['HIBERNATING_SOMEDAY', 'running'],
    ])('carries stateReason on %s too, not just terminal states', async (state, expected) => {
      mockSend.mockResolvedValueOnce({ microvmId: MICROVM_ID, state, stateReason: 'because' });

      const result = await new LambdaMicrovmComputeStrategy().pollSession(makeHandle());

      expect(result).toEqual({ status: expected, microvmState: state === 'HIBERNATING_SOMEDAY' ? 'UNKNOWN' : state, reason: 'because' });
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

    test.each(['TERMINATED', 'TERMINATING', 'RUNNING'])('confirms termination conflicts against %s', async state => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConflictException' }))
        .mockResolvedValueOnce({ state });
      const result = await new LambdaMicrovmComputeStrategy().stopSession(makeHandle());
      expect(result).toEqual(state === 'TERMINATED' ? { outcome: 'terminated' }
        : { outcome: 'unconfirmed', error_type: 'ConflictException' });
      expect(mockSend.mock.calls[1][0]._type).toBe('GetMicrovm');
    });

    test('confirms an absent worker after a termination conflict', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConflictException' }))
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }));
      await expect(new LambdaMicrovmComputeStrategy().stopSession(makeHandle())).resolves.toEqual({ outcome: 'not-found' });
    });

    test.each([
      ['ResourceNotFoundException', 'info'],
      ['ConflictException', 'warn'],
      ['ThrottlingException', 'error'],
      ['AccessDeniedException', 'error'],
      ['InternalServerException', 'warn'],
    ])('logs %s at %s level and never throws', async (errName, expectedLevel) => {
      const err = new Error('boom');
      err.name = errName;
      mockSend.mockRejectedValueOnce(err);

      await expect(new LambdaMicrovmComputeStrategy().stopSession(makeHandle())).resolves.toEqual(
        errName === 'ResourceNotFoundException' ? { outcome: 'not-found' }
          : { outcome: 'unconfirmed', error_type: errName },
      );

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
      await expect(start).rejects.toThrow('MicroVM RunMicrovm failed: ThrottlingException: Rate exceeded');
    });

    test('preserves the AWS error name in a sanitized cause', async () => {
      const err = new Error('quota');
      err.name = 'ServiceQuotaExceededException';
      mockSend.mockRejectedValueOnce(err);

      await new LambdaMicrovmComputeStrategy()
        .startSession({ taskId: 'TASK001', userId: 'u', payload: {}, blueprintConfig: BLUEPRINT })
        .catch((thrown: Error) => {
          expect(thrown.cause).not.toBe(err);
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
        payload: { prompt: 'x'.repeat(20_000) },
        blueprintConfig: BLUEPRINT,
      });

      await expect(start).rejects.toThrow('MicroVM payload upload failed: AccessDenied: Access Denied');
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

    await expect(start).rejects.toThrow(/compute_type=lambda-microvm/);
    await expect(start).rejects.toThrow(/deployed without the Lambda MicroVMs substrate/);
    await expect(start).rejects.toThrow(/--context compute_type=lambda-microvm/);
    await expect(start).rejects.toThrow(/--compute-type agentcore/);
    await expect(start).rejects.toThrow(new RegExp(envVar));
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

    expect(mockSend.mock.calls[0][0].input.ingressNetworkConnectors).toEqual([
      INGRESS_CONNECTOR_ARN,
      `${INGRESS_CONNECTOR_ARN}-b`,
    ]);
  });

  test('a BLANK env var still yields NO_INGRESS, never an omitted field', async () => {
    let Strategy!: typeof LambdaMicrovmComputeStrategy;
    jest.isolateModules(() => {
      process.env.MICROVM_INGRESS_CONNECTOR_ARNS = '  ,  ';
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

    expect(mockSend.mock.calls[0][0].input.ingressNetworkConnectors)
      .toEqual([NO_INGRESS_CONNECTOR_ARN]);
  });
});

describe('LambdaMicrovmComputeStrategy image-identifier validation', () => {
  function loadStrategyWithIdentifier(identifier: string): typeof LambdaMicrovmComputeStrategy {
    let Strategy!: typeof LambdaMicrovmComputeStrategy;
    const saved = process.env.MICROVM_IMAGE_IDENTIFIER;
    jest.isolateModules(() => {
      process.env.MICROVM_IMAGE_IDENTIFIER = identifier;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Strategy = require('../../../../src/handlers/shared/strategies/lambda-microvm-strategy').LambdaMicrovmComputeStrategy;
    });
    if (saved !== undefined) process.env.MICROVM_IMAGE_IDENTIFIER = saved;
    return Strategy;
  }

  test.each([
    ['abca-agent'],
    ['backgroundagent-dev-abca-agent'],
    ['microvm-image:abca-agent'],
  ])('rejects the bare identifier %s BEFORE any AWS call', async (identifier) => {
    const Strategy = loadStrategyWithIdentifier(identifier);

    const start = new Strategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { prompt: 'x'.repeat(20_000) },
      blueprintConfig: BLUEPRINT,
    });

    await expect(start).rejects.toThrow(/must be a full MicroVM image ARN/);
    await expect(start).rejects.toThrow(/Malformed ARN/);
    await expect(start).rejects.toThrow(/--context compute_type=lambda-microvm/);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('accepts a full image ARN', async () => {
    const Strategy = loadStrategyWithIdentifier(IMAGE_IDENTIFIER);
    runMicrovmOk();

    await new Strategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo' },
      blueprintConfig: BLUEPRINT,
    });

    expect(mockSend.mock.calls[0][0].input.imageIdentifier).toBe(IMAGE_IDENTIFIER);
  });
});

describe('buildMicrovmPlatformConfig — the MicroVM substitute for a deploy-time env block', () => {
  const FULL_ENV: NodeJS.ProcessEnv = {
    TASK_TABLE_NAME: 'tasks',
    TASK_EVENTS_TABLE_NAME: 'events',
    TASK_APPROVALS_TABLE_NAME: 'approvals',
    NUDGES_TABLE_NAME: 'nudges',
    LOG_GROUP_NAME: '/aws/abca/application',
    ARTIFACTS_BUCKET_NAME: 'artifacts-bucket',
    TRACE_ARTIFACTS_BUCKET_NAME: 'trace-bucket',
    GITHUB_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf',
    LINEAR_OAUTH_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bgagent-linear-oauth-acme-XyZ',
    JIRA_OAUTH_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bgagent-jira-oauth-cloud1-XyZ',
    AGENT_SESSION_ROLE_ARN: 'arn:aws:iam::123456789012:role/SessionRole',
    AWS_SDK_UA_APP_ID: 'uksb-wt64nei4u6#backgroundagent-dev',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ANTHROPIC_MODEL: 'us.anthropic.claude-opus-5',
    ABCA_TOOL_GATEWAY_URL: 'https://gateway.example/mcp',
    LINEAR_VAULT_ENABLED: 'true',
    LINEAR_WORKLOAD_IDENTITY_NAME: 'abca_linear_oauth_test',
  };

  test('sources the wire key allow-list from the cross-language contract', () => {
    expect([...MICROVM_PLATFORM_CONFIG_KEYS])
      .toEqual(Object.keys(sharedConstants.microvm_platform_config.env_by_key));
    expect([...MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS])
      .toEqual(sharedConstants.microvm_platform_config.required);

    expect([...MICROVM_PLATFORM_CONFIG_KEYS]).toEqual([
      'task_table_name',
      'task_events_table_name',
      'task_approvals_table_name',
      'nudges_table_name',
      'log_group_name',
      'artifacts_bucket_name',
      'trace_artifacts_bucket_name',
      'github_token_secret_arn',
      'linear_oauth_secret_arn',
      'jira_oauth_secret_arn',
      'agent_session_role_arn',
      'aws_sdk_ua_app_id',
      'anthropic_default_haiku_model',
      'anthropic_model',
      'tool_gateway_url',
      'linear_vault_enabled',
      'linear_workload_identity_name',
    ]);
    expect(MICROVM_PLATFORM_CONFIG_KEYS).toHaveLength(17);
    for (const key of MICROVM_PLATFORM_CONFIG_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test('pins the REQUIRED subset — these four are what a task cannot start without', () => {
    expect([...MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS]).toEqual([
      'task_table_name',
      'task_events_table_name',
      'github_token_secret_arn',
      'agent_session_role_arn',
    ]);
    for (const key of MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS) {
      expect(MICROVM_PLATFORM_CONFIG_KEYS).toContain(key);
    }
  });

  test('emits all seventeen keys, in declaration order, from a full environment', () => {
    const config = buildMicrovmPlatformConfig(FULL_ENV);
    expect(Object.keys(config)).toEqual([...MICROVM_PLATFORM_CONFIG_KEYS]);
    expect(config.task_table_name).toBe('tasks');
    expect(config.nudges_table_name).toBe('nudges');
    expect(config.agent_session_role_arn).toBe('arn:aws:iam::123456789012:role/SessionRole');
    expect(config.anthropic_default_haiku_model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(config.anthropic_model).toBe('us.anthropic.claude-opus-5');
    expect(config.tool_gateway_url).toBe('https://gateway.example/mcp');
    expect(config.linear_vault_enabled).toBe('true');
    expect(config.linear_workload_identity_name).toBe('abca_linear_oauth_test');
  });

  test('OMITS optional keys the orchestrator does not carry (no `undefined` placeholders)', () => {
    const config = buildMicrovmPlatformConfig({
      TASK_TABLE_NAME: 'tasks',
      TASK_EVENTS_TABLE_NAME: 'events',
      GITHUB_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf',
      AGENT_SESSION_ROLE_ARN: 'arn:aws:iam::123456789012:role/SessionRole',
    });

    expect(Object.keys(config)).toEqual([
      'task_table_name',
      'task_events_table_name',
      'github_token_secret_arn',
      'agent_session_role_arn',
    ]);
    expect('nudges_table_name' in config).toBe(false);
    expect(JSON.stringify(config)).not.toContain('null');
  });

  test('treats an EMPTY value as absent', () => {
    const config = buildMicrovmPlatformConfig({ ...FULL_ENV, NUDGES_TABLE_NAME: '' });
    expect('nudges_table_name' in config).toBe(false);
  });

  test('is a closed map: an environment variable outside the allow-list can never leak', () => {
    const config = buildMicrovmPlatformConfig({
      ...FULL_ENV,
      GITHUB_TOKEN: 'ghp_averysecrettokenvalue',
      ANTHROPIC_API_KEY: 'dummy-anthropic-credential-do-not-log',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI',
      MICROVM_PAYLOAD_BUCKET: 'some-bucket',
    });

    expect(Object.keys(config)).toEqual([...MICROVM_PLATFORM_CONFIG_KEYS]);
    const rendered = JSON.stringify(config);
    expect(rendered).not.toContain('ghp_');
    expect(rendered).not.toContain('dummy-anthropic-credential-do-not-log');
    expect(rendered).not.toContain('wJalrXUtnFEMI');
  });

  test.each([
    ['TASK_TABLE_NAME', 'task_table_name'],
    ['TASK_EVENTS_TABLE_NAME', 'task_events_table_name'],
    ['GITHUB_TOKEN_SECRET_ARN', 'github_token_secret_arn'],
    ['AGENT_SESSION_ROLE_ARN', 'agent_session_role_arn'],
  ])('throws naming %s when it is missing', (envVar, wireKey) => {
    const env = { ...FULL_ENV };
    delete env[envVar];

    expect(() => buildMicrovmPlatformConfig(env)).toThrow(new RegExp(`${wireKey} <- ${envVar}`));
    expect(() => buildMicrovmPlatformConfig(env)).toThrow(/redeploy the stack/);
    expect(() => buildMicrovmPlatformConfig(env)).toThrow(/ADR-021 sub-decision 3/);
  });

  test('names EVERY missing required key at once, not just the first', () => {
    expect(() => buildMicrovmPlatformConfig({})).toThrow(
      /task_table_name.*task_events_table_name.*github_token_secret_arn.*agent_session_role_arn/s,
    );
  });

  test('the throw carries the MicroVM marker so the classifier can scope it', () => {
    expect(() => buildMicrovmPlatformConfig({})).toThrow(
      new RegExp(`${MICROVM_ERROR_MARKER} platform config failed`),
    );
  });

  test('classifies as a non-retryable CONFIG fault, NOT a transient compute one', () => {
    let thrown: unknown;
    try {
      buildMicrovmPlatformConfig({});
    } catch (err) {
      thrown = err;
    }

    const classification = classifyError(String(thrown));

    expect(classification).not.toBeNull();
    expect(classification!.retryable).toBe(false);
    expect(classification!.errorClass).toBe('service');
    expect(classification!.category).toBe('config');
    expect(classification!.title).toBe('The orchestrator is missing MicroVM platform configuration');
    expect(classification!.remedy).not.toMatch(/AgentCore Runtime or ECS cluster health/);
    expect(classification!.remedy).toMatch(/redeploy the stack/i);
  });

  test('survives the `Session start failed:` prefix the failure path adds', () => {
    let raw = '';
    try {
      buildMicrovmPlatformConfig({});
    } catch (err) {
      raw = err instanceof Error ? err.message : String(err);
    }

    const classification = classifyError(`Session start failed: ${raw}`);

    expect(classification!.retryable).toBe(false);
    expect(classification!.errorClass).toBe('service');
    expect(classification!.remedy).not.toMatch(/AgentCore Runtime or ECS cluster health/);
  });

  test('does NOT throw for a missing OPTIONAL key', () => {
    const env = { ...FULL_ENV };
    for (const optional of [
      'TASK_APPROVALS_TABLE_NAME', 'NUDGES_TABLE_NAME', 'LOG_GROUP_NAME',
      'ARTIFACTS_BUCKET_NAME', 'TRACE_ARTIFACTS_BUCKET_NAME', 'LINEAR_OAUTH_SECRET_ARN',
      'JIRA_OAUTH_SECRET_ARN', 'AWS_SDK_UA_APP_ID', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_MODEL',
      'ABCA_TOOL_GATEWAY_URL',
      'LINEAR_VAULT_ENABLED',
      'LINEAR_WORKLOAD_IDENTITY_NAME',
    ]) {
      delete env[optional];
    }
    expect(() => buildMicrovmPlatformConfig(env)).not.toThrow();
    expect(Object.keys(buildMicrovmPlatformConfig(env))).toEqual([
      ...MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS,
    ]);
  });

  test('defaults to process.env when no environment is passed', () => {
    const config = buildMicrovmPlatformConfig();
    expect(config).toEqual(EXPECTED_PLATFORM_CONFIG);
  });

  test('the full thirteen-key block fits the pointer envelope inside the 4 KB cap', () => {
    const pointerEnvelope = JSON.stringify({
      agent_payload_s3_uri: `s3://${PAYLOAD_BUCKET}/TASK001/payload.json`,
      platform_config: buildMicrovmPlatformConfig(FULL_ENV),
    });
    expect(Buffer.byteLength(pointerEnvelope, 'utf8'))
      .toBeLessThan(MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES / 2);
  });
});

describe('LambdaMicrovmComputeStrategy with the FULL platform_config environment', () => {
  const OPTIONAL_ENV: Record<string, string> = {
    TASK_APPROVALS_TABLE_NAME: 'approvals',
    NUDGES_TABLE_NAME: 'nudges',
    LOG_GROUP_NAME: '/aws/abca/application',
    ARTIFACTS_BUCKET_NAME: 'artifacts-bucket',
    TRACE_ARTIFACTS_BUCKET_NAME: 'trace-bucket',
    LINEAR_OAUTH_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bgagent-linear-oauth-acme-XyZ',
    JIRA_OAUTH_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bgagent-jira-oauth-cloud1-XyZ',
    AWS_SDK_UA_APP_ID: 'uksb-wt64nei4u6#backgroundagent-dev',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  };

  beforeEach(() => {
    Object.assign(process.env, OPTIONAL_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(OPTIONAL_ENV)) delete process.env[key];
  });

  test('delivers every configured identifier on the wire, in both envelope halves', async () => {
    mockS3Send.mockResolvedValueOnce({});
    runMicrovmOk();

    await new LambdaMicrovmComputeStrategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo', hydrated_context: { blob: 'x'.repeat(10_000) } },
      blueprintConfig: BLUEPRINT,
    });

    const expected = { ...EXPECTED_PLATFORM_CONFIG, ...buildMicrovmPlatformConfig() };
    const envelope = JSON.parse(mockSend.mock.calls[0][0].input.runHookPayload);
    expect(envelope.platform_config).toEqual(expected);
    expect(Object.keys(envelope.platform_config)).toHaveLength(13);
    expect(JSON.parse(mockS3Send.mock.calls[0][0].input.Body).platform_config).toEqual(expected);
  });
});
