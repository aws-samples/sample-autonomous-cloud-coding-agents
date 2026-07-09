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

const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster';
const TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/agent:1';
const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123';

// Set env vars BEFORE import — EcsComputeStrategy reads them as module-level constants
process.env.ECS_CLUSTER_ARN = CLUSTER_ARN;
process.env.ECS_TASK_DEFINITION_ARN = TASK_DEF_ARN;
process.env.ECS_SUBNETS = 'subnet-aaa,subnet-bbb';
process.env.ECS_SECURITY_GROUP = 'sg-12345';
process.env.ECS_CONTAINER_NAME = 'AgentContainer';
// The top-of-file import's inline-fallback / no-op tests assume these OPTIONAL
// vars are ABSENT at load time. They are unset in a dev shell but the real ECS
// agent container HAS ECS_PAYLOAD_BUCKET set (#502) — so leaving this to ambient
// env made the build pass locally yet FAIL on ECS ("works local, dies on ECS").
// The #502 / #299 describe blocks below set these via isolateModules; delete them
// here so the top-of-file import is hermetic regardless of the runner's env.
delete process.env.ECS_PAYLOAD_BUCKET;
delete process.env.ECS_PLANNING_TASK_DEFINITION_ARN;

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn(() => ({ send: mockSend })),
  RunTaskCommand: jest.fn((input: unknown) => ({ _type: 'RunTask', input })),
  DescribeTasksCommand: jest.fn((input: unknown) => ({ _type: 'DescribeTasks', input })),
  StopTaskCommand: jest.fn((input: unknown) => ({ _type: 'StopTask', input })),
}));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ _type: 'DeleteObject', input })),
}));

import { EcsComputeStrategy } from '../../../../src/handlers/shared/strategies/ecs-strategy';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('EcsComputeStrategy', () => {
  test('type is ecs', () => {
    const strategy = new EcsComputeStrategy();
    expect(strategy.type).toBe('ecs');
  });

  describe('startSession', () => {
    test('sends RunTaskCommand with correct params and returns SessionHandle', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{ taskArn: TASK_ARN }],
      });

      const strategy = new EcsComputeStrategy();
      const handle = await strategy.startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo', prompt: 'Fix the bug', issue_number: 42, max_turns: 50 },
        blueprintConfig: { compute_type: 'ecs', runtime_arn: '' },
      });

      expect(handle.sessionId).toBe(TASK_ARN);
      expect(handle.strategyType).toBe('ecs');
      const ecsHandle = handle as Extract<typeof handle, { strategyType: 'ecs' }>;
      expect(ecsHandle.clusterArn).toBe(CLUSTER_ARN);
      expect(ecsHandle.taskArn).toBe(TASK_ARN);
      expect(mockSend).toHaveBeenCalledTimes(1);

      const call = mockSend.mock.calls[0][0];
      expect(call.input.cluster).toBe(CLUSTER_ARN);
      expect(call.input.taskDefinition).toBe(TASK_DEF_ARN);
      expect(call.input.launchType).toBe('FARGATE');
      expect(call.input.networkConfiguration.awsvpcConfiguration.subnets).toEqual(['subnet-aaa', 'subnet-bbb']);
      expect(call.input.networkConfiguration.awsvpcConfiguration.securityGroups).toEqual(['sg-12345']);
      expect(call.input.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe('DISABLED');

      const override = call.input.overrides.containerOverrides[0];
      const envVars = override.environment;
      expect(envVars).toEqual(expect.arrayContaining([
        { name: 'TASK_ID', value: 'TASK001' },
        { name: 'REPO_URL', value: 'org/repo' },
        { name: 'TASK_DESCRIPTION', value: 'Fix the bug' },
        { name: 'ISSUE_NUMBER', value: '42' },
        { name: 'MAX_TURNS', value: '50' },
        { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
      ]));

      // No ECS_PAYLOAD_BUCKET in this module's env → inline fallback (#502): the
      // full payload rides in AGENT_PAYLOAD and nothing is written to S3.
      const agentPayload = envVars.find((e: { name: string }) => e.name === 'AGENT_PAYLOAD');
      expect(agentPayload).toBeDefined();
      const parsed = JSON.parse(agentPayload.value);
      expect(parsed.repo_url).toBe('org/repo');
      expect(parsed.prompt).toBe('Fix the bug');
      expect(envVars.find((e: { name: string }) => e.name === 'AGENT_PAYLOAD_S3_URI')).toBeUndefined();
      expect(mockS3Send).not.toHaveBeenCalled();

      // Container command override — runs Python directly instead of uvicorn
      expect(override.command).toBeDefined();
      expect(override.command[0]).toBe('python');
    });

    test('throws when RunTask returns no task', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [],
        failures: [{ arn: 'arn:test', reason: 'RESOURCE:ENI' }],
      });

      const strategy = new EcsComputeStrategy();
      await expect(
        strategy.startSession({
          taskId: 'TASK001',
          userId: 'cognito-test',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: { compute_type: 'ecs', runtime_arn: '' },
        }),
      ).rejects.toThrow('ECS RunTask returned no task: arn:test: RESOURCE:ENI');
    });

    test('includes model_id and system_prompt_overrides from blueprintConfig', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{ taskArn: TASK_ARN }],
      });

      const strategy = new EcsComputeStrategy();
      await strategy.startSession({
        taskId: 'TASK001',
        userId: 'cognito-test',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: {
          compute_type: 'ecs',
          runtime_arn: '',
          model_id: 'anthropic.claude-sonnet-4-6',
          system_prompt_overrides: 'Be concise',
        },
      });

      const call = mockSend.mock.calls[0][0];
      const envVars = call.input.overrides.containerOverrides[0].environment;
      expect(envVars).toEqual(expect.arrayContaining([
        { name: 'ANTHROPIC_MODEL', value: 'anthropic.claude-sonnet-4-6' },
        { name: 'SYSTEM_PROMPT_OVERRIDES', value: 'Be concise' },
      ]));
    });
  });

  describe('pollSession', () => {
    const makeHandle = () => ({
      sessionId: TASK_ARN,
      strategyType: 'ecs' as const,
      clusterArn: CLUSTER_ARN,
      taskArn: TASK_ARN,
    });

    test('returns running for RUNNING status', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: 'RUNNING' }],
      });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('returns running for PENDING status', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{ lastStatus: 'PENDING' }],
      });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('returns completed for STOPPED with exit code 0', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{
          lastStatus: 'STOPPED',
          containers: [{ exitCode: 0 }],
        }],
      });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'completed' });
    });

    test('returns failed for STOPPED with undefined exit code (container never started)', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{
          lastStatus: 'STOPPED',
          stoppedReason: 'CannotPullContainerError',
          containers: [{}],
        }],
      });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({
        status: 'failed',
        error: 'Task stopped: CannotPullContainerError',
      });
    });

    test('returns failed for STOPPED with no containers', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{
          lastStatus: 'STOPPED',
          stoppedReason: 'EssentialContainerExited',
          containers: [],
        }],
      });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({
        status: 'failed',
        error: 'Task stopped: EssentialContainerExited',
      });
    });

    test('returns failed for STOPPED with non-zero exit code', async () => {
      mockSend.mockResolvedValueOnce({
        tasks: [{
          lastStatus: 'STOPPED',
          stoppedReason: 'OutOfMemoryError',
          containers: [{ exitCode: 137 }],
        }],
      });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({
        status: 'failed',
        error: 'Exit code 137: OutOfMemoryError',
      });
    });

    test('returns failed when task not found', async () => {
      mockSend.mockResolvedValueOnce({ tasks: [] });

      const strategy = new EcsComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({
        status: 'failed',
        error: `ECS task ${TASK_ARN} not found`,
      });
    });

    test('throws when handle is not ecs type', async () => {
      const strategy = new EcsComputeStrategy();
      await expect(
        strategy.pollSession({
          sessionId: 'test',
          strategyType: 'agentcore',
          runtimeArn: 'arn:test',
        }),
      ).rejects.toThrow('pollSession called with non-ecs handle');
    });
  });

  describe('stopSession', () => {
    test('sends StopTaskCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      const strategy = new EcsComputeStrategy();
      await strategy.stopSession({
        sessionId: TASK_ARN,
        strategyType: 'ecs',
        clusterArn: CLUSTER_ARN,
        taskArn: TASK_ARN,
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.input.cluster).toBe(CLUSTER_ARN);
      expect(call.input.task).toBe(TASK_ARN);
      expect(call.input.reason).toBe('Stopped by orchestrator');
    });

    test('handles InvalidParameterException gracefully', async () => {
      const err = new Error('Invalid');
      err.name = 'InvalidParameterException';
      mockSend.mockRejectedValueOnce(err);

      const strategy = new EcsComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: TASK_ARN,
          strategyType: 'ecs',
          clusterArn: CLUSTER_ARN,
          taskArn: TASK_ARN,
        }),
      ).resolves.toBeUndefined();
    });

    test('handles ResourceNotFoundException gracefully', async () => {
      const err = new Error('Not found');
      err.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(err);

      const strategy = new EcsComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: TASK_ARN,
          strategyType: 'ecs',
          clusterArn: CLUSTER_ARN,
          taskArn: TASK_ARN,
        }),
      ).resolves.toBeUndefined();
    });

    test('throws when handle is not ecs type', async () => {
      const strategy = new EcsComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: 'test',
          strategyType: 'agentcore',
          runtimeArn: 'arn:test',
        }),
      ).rejects.toThrow('stopSession called with non-ecs handle');
    });

    test('logs error for unknown errors (best-effort)', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network error'));

      const strategy = new EcsComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: TASK_ARN,
          strategyType: 'ecs',
          clusterArn: CLUSTER_ARN,
          taskArn: TASK_ARN,
        }),
      ).resolves.toBeUndefined();
    });
  });
});

// #502: the S3-pointer path requires ECS_PAYLOAD_BUCKET to be set BEFORE the
// module is imported (it's a module-level constant). Re-import under
// jest.isolateModules with the env var set so these tests don't perturb the
// inline-fallback tests above.
describe('EcsComputeStrategy with ECS_PAYLOAD_BUCKET (S3-pointer path, #502)', () => {
  const PAYLOAD_BUCKET = 'test-ecs-payload-bucket';

  function loadStrategyWithBucket(): {
    EcsComputeStrategy: typeof import('../../../../src/handlers/shared/strategies/ecs-strategy').EcsComputeStrategy;
    deleteEcsPayload: typeof import('../../../../src/handlers/shared/strategies/ecs-strategy').deleteEcsPayload;
    ecsPayloadKey: typeof import('../../../../src/handlers/shared/strategies/ecs-strategy').ecsPayloadKey;
  } {
    let mod!: ReturnType<typeof loadStrategyWithBucket>;
    jest.isolateModules(() => {
      process.env.ECS_PAYLOAD_BUCKET = PAYLOAD_BUCKET;
      process.env.ECS_CLUSTER_ARN = CLUSTER_ARN;
      process.env.ECS_TASK_DEFINITION_ARN = TASK_DEF_ARN;
      process.env.ECS_SUBNETS = 'subnet-aaa,subnet-bbb';
      process.env.ECS_SECURITY_GROUP = 'sg-12345';
      process.env.ECS_CONTAINER_NAME = 'AgentContainer';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../../../../src/handlers/shared/strategies/ecs-strategy');
    });
    return mod;
  }

  afterEach(() => {
    delete process.env.ECS_PAYLOAD_BUCKET;
  });

  test('writes payload to S3 and passes AGENT_PAYLOAD_S3_URI, not the inline blob', async () => {
    mockS3Send.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ tasks: [{ taskArn: TASK_ARN }] });

    const { EcsComputeStrategy: Strategy } = loadStrategyWithBucket();
    const strategy = new Strategy();
    await strategy.startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo', prompt: 'Fix the bug', hydrated_context: { big: 'x'.repeat(10000) } },
      blueprintConfig: { compute_type: 'ecs', runtime_arn: '' },
    });

    // PutObject to the payload bucket at <task_id>/payload.json
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const put = mockS3Send.mock.calls[0][0];
    expect(put._type).toBe('PutObject');
    expect(put.input.Bucket).toBe(PAYLOAD_BUCKET);
    expect(put.input.Key).toBe('TASK001/payload.json');
    expect(JSON.parse(put.input.Body).repo_url).toBe('org/repo');

    // Override carries the URI pointer, NOT the inline payload
    const envVars = mockSend.mock.calls[0][0].input.overrides.containerOverrides[0].environment;
    const uri = envVars.find((e: { name: string }) => e.name === 'AGENT_PAYLOAD_S3_URI');
    expect(uri.value).toBe(`s3://${PAYLOAD_BUCKET}/TASK001/payload.json`);
    expect(envVars.find((e: { name: string }) => e.name === 'AGENT_PAYLOAD')).toBeUndefined();
  });

  test('boot command loads payload from S3 when the URI is set, else inline', async () => {
    mockS3Send.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ tasks: [{ taskArn: TASK_ARN }] });

    const { EcsComputeStrategy: Strategy } = loadStrategyWithBucket();
    await new Strategy().startSession({
      taskId: 'TASK001',
      userId: 'cognito-test',
      payload: { repo_url: 'org/repo' },
      blueprintConfig: { compute_type: 'ecs', runtime_arn: '' },
    });

    const cmd = mockSend.mock.calls[0][0].input.overrides.containerOverrides[0].command;
    const src = cmd[2];
    // Reads the URI, fetches via boto3 S3 when set, falls back to inline env.
    expect(src).toContain('AGENT_PAYLOAD_S3_URI');
    expect(src).toContain('get_object');
    expect(src).toContain('AGENT_PAYLOAD');
    // ABCA-487: the boot command maps the WHOLE payload via
    // run_task_from_payload (not a hand-listed kwarg subset that dropped
    // channel_source/channel_metadata → no Linear reactions on ECS). Assert we
    // call the mapper and no longer hand-pick the old prompt/model_id kwargs.
    expect(src).toContain('run_task_from_payload(p)');
    expect(src).not.toContain('task_description=p.get');
    expect(src).not.toContain('channel_source'); // never hand-listed; the mapper forwards it
  });

  test('deleteEcsPayload deletes the task payload object', async () => {
    mockS3Send.mockResolvedValueOnce({});
    const { deleteEcsPayload, ecsPayloadKey } = loadStrategyWithBucket();
    await deleteEcsPayload('TASK001');
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const del = mockS3Send.mock.calls[0][0];
    expect(del._type).toBe('DeleteObject');
    expect(del.input.Bucket).toBe(PAYLOAD_BUCKET);
    expect(del.input.Key).toBe(ecsPayloadKey('TASK001'));
    expect(ecsPayloadKey('TASK001')).toBe('TASK001/payload.json');
  });

  test('deleteEcsPayload swallows S3 errors (best-effort — lifecycle is the backstop)', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));
    const { deleteEcsPayload } = loadStrategyWithBucket();
    await expect(deleteEcsPayload('TASK001')).resolves.toBeUndefined();
  });
});

describe('deleteEcsPayload without ECS_PAYLOAD_BUCKET', () => {
  test('no-ops when no payload bucket is configured', async () => {
    // The top-of-file import has no ECS_PAYLOAD_BUCKET set.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteEcsPayload } = require('../../../../src/handlers/shared/strategies/ecs-strategy');
    await expect(deleteEcsPayload('TASK001')).resolves.toBeUndefined();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
