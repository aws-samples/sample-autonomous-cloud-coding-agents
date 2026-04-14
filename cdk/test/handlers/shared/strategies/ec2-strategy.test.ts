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

const FLEET_TAG_KEY = 'bgagent:fleet';
const FLEET_TAG_VALUE = 'test-fleet';
const PAYLOAD_BUCKET = 'test-payload-bucket';
const ECR_IMAGE = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:latest';
const INSTANCE_ID = 'i-0123456789abcdef0';
const COMMAND_ID = 'cmd-0123456789abcdef0';

// Set env vars BEFORE import — Ec2ComputeStrategy reads them as module-level constants
process.env.EC2_FLEET_TAG_KEY = FLEET_TAG_KEY;
process.env.EC2_FLEET_TAG_VALUE = FLEET_TAG_VALUE;
process.env.EC2_PAYLOAD_BUCKET = PAYLOAD_BUCKET;
process.env.ECR_IMAGE_URI = ECR_IMAGE;

const mockEc2Send = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockEc2Send })),
  DescribeInstancesCommand: jest.fn((input) => ({ _type: 'DescribeInstances', input })),
  CreateTagsCommand: jest.fn((input) => ({ _type: 'CreateTags', input })),
  DeleteTagsCommand: jest.fn((input) => ({ _type: 'DeleteTags', input })),
}));

const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  SendCommandCommand: jest.fn((input) => ({ _type: 'SendCommand', input })),
  GetCommandInvocationCommand: jest.fn((input) => ({ _type: 'GetCommandInvocation', input })),
  CancelCommandCommand: jest.fn((input) => ({ _type: 'CancelCommand', input })),
}));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ _type: 'PutObject', input })),
}));

import { Ec2ComputeStrategy } from '../../../../src/handlers/shared/strategies/ec2-strategy';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Ec2ComputeStrategy', () => {
  test('type is ec2', () => {
    const strategy = new Ec2ComputeStrategy();
    expect(strategy.type).toBe('ec2');
  });

  describe('startSession', () => {
    test('finds idle instance, tags as busy, verifies claim, uploads to S3, sends SSM command, returns handle', async () => {
      // S3 upload
      mockS3Send.mockResolvedValueOnce({});
      // DescribeInstances — return one idle instance
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID }] }],
      });
      // CreateTags (mark busy)
      mockEc2Send.mockResolvedValueOnce({});
      // DescribeInstances — verify claim (tag matches our task-id)
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID, Tags: [{ Key: 'bgagent:task-id', Value: 'TASK001' }] }] }],
      });
      // SSM SendCommand
      mockSsmSend.mockResolvedValueOnce({
        Command: { CommandId: COMMAND_ID },
      });

      const strategy = new Ec2ComputeStrategy();
      const handle = await strategy.startSession({
        taskId: 'TASK001',
        payload: { repo_url: 'org/repo', prompt: 'Fix the bug', issue_number: 42, max_turns: 50 },
        blueprintConfig: { compute_type: 'ec2', runtime_arn: '' },
      });

      expect(handle.sessionId).toBe(COMMAND_ID);
      expect(handle.strategyType).toBe('ec2');
      const ec2Handle = handle as Extract<typeof handle, { strategyType: 'ec2' }>;
      expect(ec2Handle.instanceId).toBe(INSTANCE_ID);
      expect(ec2Handle.commandId).toBe(COMMAND_ID);

      // Verify S3 upload
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const s3Call = mockS3Send.mock.calls[0][0];
      expect(s3Call.input.Bucket).toBe(PAYLOAD_BUCKET);
      expect(s3Call.input.Key).toBe('tasks/TASK001/payload.json');

      // Verify EC2 calls: DescribeInstances (find idle), CreateTags (claim), DescribeInstances (verify)
      expect(mockEc2Send).toHaveBeenCalledTimes(3);
      const describeCall = mockEc2Send.mock.calls[0][0];
      expect(describeCall.input.Filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ Name: `tag:${FLEET_TAG_KEY}`, Values: [FLEET_TAG_VALUE] }),
        expect.objectContaining({ Name: 'instance-state-name', Values: ['running'] }),
        expect.objectContaining({ Name: 'tag:bgagent:status', Values: ['idle'] }),
      ]));

      // Verify CreateTags (busy)
      const tagCall = mockEc2Send.mock.calls[1][0];
      expect(tagCall.input.Resources).toEqual([INSTANCE_ID]);
      expect(tagCall.input.Tags).toEqual(expect.arrayContaining([
        { Key: 'bgagent:status', Value: 'busy' },
        { Key: 'bgagent:task-id', Value: 'TASK001' },
      ]));

      // Verify SSM SendCommand
      expect(mockSsmSend).toHaveBeenCalledTimes(1);
      const ssmCall = mockSsmSend.mock.calls[0][0];
      expect(ssmCall.input.DocumentName).toBe('AWS-RunShellScript');
      expect(ssmCall.input.InstanceIds).toEqual([INSTANCE_ID]);
      expect(ssmCall.input.TimeoutSeconds).toBe(32400);
    });

    test('tries next candidate when race is lost on first instance', async () => {
      const INSTANCE_ID_2 = 'i-0987654321fedcba0';
      // S3 upload
      mockS3Send.mockResolvedValueOnce({});
      // DescribeInstances — return two idle instances
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID }, { InstanceId: INSTANCE_ID_2 }] }],
      });
      // CreateTags on first instance
      mockEc2Send.mockResolvedValueOnce({});
      // Verify first instance — another task claimed it
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID, Tags: [{ Key: 'bgagent:task-id', Value: 'OTHER_TASK' }] }] }],
      });
      // CreateTags on second instance
      mockEc2Send.mockResolvedValueOnce({});
      // Verify second instance — our task-id stuck
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID_2, Tags: [{ Key: 'bgagent:task-id', Value: 'TASK001' }] }] }],
      });
      // SSM SendCommand
      mockSsmSend.mockResolvedValueOnce({
        Command: { CommandId: COMMAND_ID },
      });

      const strategy = new Ec2ComputeStrategy();
      const handle = await strategy.startSession({
        taskId: 'TASK001',
        payload: { repo_url: 'org/repo' },
        blueprintConfig: { compute_type: 'ec2', runtime_arn: '' },
      });

      const ec2Handle = handle as Extract<typeof handle, { strategyType: 'ec2' }>;
      expect(ec2Handle.instanceId).toBe(INSTANCE_ID_2);
      expect(mockEc2Send).toHaveBeenCalledTimes(5); // describe + 2*(tag + verify)
    });

    test('throws when no idle instances available', async () => {
      // S3 upload
      mockS3Send.mockResolvedValueOnce({});
      // DescribeInstances — return empty
      mockEc2Send.mockResolvedValueOnce({ Reservations: [] });

      const strategy = new Ec2ComputeStrategy();
      await expect(
        strategy.startSession({
          taskId: 'TASK001',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: { compute_type: 'ec2', runtime_arn: '' },
        }),
      ).rejects.toThrow('No idle EC2 instances available in fleet');
    });

    test('throws when SSM SendCommand fails', async () => {
      // S3 upload
      mockS3Send.mockResolvedValueOnce({});
      // DescribeInstances
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID }] }],
      });
      // CreateTags
      mockEc2Send.mockResolvedValueOnce({});
      // DescribeInstances — verify claim
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID, Tags: [{ Key: 'bgagent:task-id', Value: 'TASK001' }] }] }],
      });
      // SSM SendCommand — return no CommandId
      mockSsmSend.mockResolvedValueOnce({ Command: {} });

      const strategy = new Ec2ComputeStrategy();
      await expect(
        strategy.startSession({
          taskId: 'TASK001',
          payload: { repo_url: 'org/repo' },
          blueprintConfig: { compute_type: 'ec2', runtime_arn: '' },
        }),
      ).rejects.toThrow('SSM SendCommand returned no CommandId');
    });
  });

  describe('pollSession', () => {
    const makeHandle = () => ({
      sessionId: COMMAND_ID,
      strategyType: 'ec2' as const,
      instanceId: INSTANCE_ID,
      commandId: COMMAND_ID,
    });

    test('returns running for InProgress status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'InProgress' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('returns running for Pending status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'Pending' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('returns running for Delayed status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'Delayed' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('returns completed for Success status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'Success' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'completed' });
    });

    test('returns failed for Failed status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'Failed', StatusDetails: 'Script exited with code 1' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'failed', error: 'Script exited with code 1' });
    });

    test('returns failed for Cancelled status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'Cancelled', StatusDetails: 'Cancelled by user' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'failed', error: 'Cancelled by user' });
    });

    test('returns failed for TimedOut status', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'TimedOut', StatusDetails: 'Command timed out' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'failed', error: 'Command timed out' });
    });

    test('returns running for Cancelling status (transient)', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'Cancelling', StatusDetails: 'Command is being cancelled' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('returns running for unknown status (default case)', async () => {
      mockSsmSend.mockResolvedValueOnce({ Status: 'SomeUnknownStatus' });

      const strategy = new Ec2ComputeStrategy();
      const result = await strategy.pollSession(makeHandle());
      expect(result).toEqual({ status: 'running' });
    });

    test('throws InvocationDoesNotExist so orchestrator retry counter handles it', async () => {
      const err = new Error('Invocation does not exist');
      err.name = 'InvocationDoesNotExist';
      mockSsmSend.mockRejectedValueOnce(err);

      const strategy = new Ec2ComputeStrategy();
      await expect(strategy.pollSession(makeHandle())).rejects.toThrow('Invocation does not exist');
    });

    test('throws when handle is not ec2 type', async () => {
      const strategy = new Ec2ComputeStrategy();
      await expect(
        strategy.pollSession({
          sessionId: 'test',
          strategyType: 'agentcore',
          runtimeArn: 'arn:test',
        }),
      ).rejects.toThrow('pollSession called with non-ec2 handle');
    });
  });

  describe('stopSession', () => {
    test('cancels SSM command and tags instance idle', async () => {
      // CancelCommand
      mockSsmSend.mockResolvedValueOnce({});
      // CreateTags (idle)
      mockEc2Send.mockResolvedValueOnce({});
      // DeleteTags (task-id)
      mockEc2Send.mockResolvedValueOnce({});

      const strategy = new Ec2ComputeStrategy();
      await strategy.stopSession({
        sessionId: COMMAND_ID,
        strategyType: 'ec2',
        instanceId: INSTANCE_ID,
        commandId: COMMAND_ID,
      });

      expect(mockSsmSend).toHaveBeenCalledTimes(1);
      const ssmCall = mockSsmSend.mock.calls[0][0];
      expect(ssmCall.input.CommandId).toBe(COMMAND_ID);
      expect(ssmCall.input.InstanceIds).toEqual([INSTANCE_ID]);

      // Verify instance tagged back to idle
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });

    test('handles already-cancelled command gracefully', async () => {
      const err = new Error('Invalid command');
      err.name = 'InvalidCommandId';
      mockSsmSend.mockRejectedValueOnce(err);
      // Cleanup tags still attempted
      mockEc2Send.mockResolvedValueOnce({});
      mockEc2Send.mockResolvedValueOnce({});

      const strategy = new Ec2ComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: COMMAND_ID,
          strategyType: 'ec2',
          instanceId: INSTANCE_ID,
          commandId: COMMAND_ID,
        }),
      ).resolves.toBeUndefined();
    });

    test('throws when handle is not ec2 type', async () => {
      const strategy = new Ec2ComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: 'test',
          strategyType: 'agentcore',
          runtimeArn: 'arn:test',
        }),
      ).rejects.toThrow('stopSession called with non-ec2 handle');
    });

    test('swallows tag cleanup errors gracefully', async () => {
      // CancelCommand succeeds
      mockSsmSend.mockResolvedValueOnce({});
      // CreateTags fails (instance terminated)
      mockEc2Send.mockRejectedValueOnce(new Error('Instance terminated'));

      const strategy = new Ec2ComputeStrategy();
      await expect(
        strategy.stopSession({
          sessionId: COMMAND_ID,
          strategyType: 'ec2',
          instanceId: INSTANCE_ID,
          commandId: COMMAND_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
