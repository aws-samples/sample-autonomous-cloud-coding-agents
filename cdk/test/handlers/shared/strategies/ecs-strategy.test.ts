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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn(() => ({ send: mockSend })),
  RunTaskCommand: jest.fn((input: unknown) => ({ _type: 'RunTask', input })),
  DescribeTasksCommand: jest.fn((input: unknown) => ({ _type: 'DescribeTasks', input })),
  StopTaskCommand: jest.fn((input: unknown) => ({ _type: 'StopTask', input })),
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

      // AGENT_PAYLOAD contains the full orchestrator payload for direct run_task() invocation
      const agentPayload = envVars.find((e: { name: string }) => e.name === 'AGENT_PAYLOAD');
      expect(agentPayload).toBeDefined();
      const parsed = JSON.parse(agentPayload.value);
      expect(parsed.repo_url).toBe('org/repo');
      expect(parsed.prompt).toBe('Fix the bug');

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
