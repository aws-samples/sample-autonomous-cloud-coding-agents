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

import { EC2Client, DescribeInstancesCommand, CreateTagsCommand, DeleteTagsCommand } from '@aws-sdk/client-ec2';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand, CancelCommandCommand } from '@aws-sdk/client-ssm';
import type { ComputeStrategy, SessionHandle, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import type { BlueprintConfig } from '../repo-config';

let sharedEc2Client: EC2Client | undefined;
function getEc2Client(): EC2Client {
  if (!sharedEc2Client) {
    sharedEc2Client = new EC2Client({});
  }
  return sharedEc2Client;
}

let sharedSsmClient: SSMClient | undefined;
function getSsmClient(): SSMClient {
  if (!sharedSsmClient) {
    sharedSsmClient = new SSMClient({});
  }
  return sharedSsmClient;
}

let sharedS3Client: S3Client | undefined;
function getS3Client(): S3Client {
  if (!sharedS3Client) {
    sharedS3Client = new S3Client({});
  }
  return sharedS3Client;
}

const EC2_FLEET_TAG_KEY = process.env.EC2_FLEET_TAG_KEY;
const EC2_FLEET_TAG_VALUE = process.env.EC2_FLEET_TAG_VALUE;
const EC2_PAYLOAD_BUCKET = process.env.EC2_PAYLOAD_BUCKET;
const ECR_IMAGE_URI = process.env.ECR_IMAGE_URI;
const EC2_CONTAINER_NAME = process.env.EC2_CONTAINER_NAME ?? 'AgentContainer';

export class Ec2ComputeStrategy implements ComputeStrategy {
  readonly type = 'ec2';

  async startSession(input: {
    taskId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
  }): Promise<SessionHandle> {
    if (!EC2_FLEET_TAG_KEY || !EC2_FLEET_TAG_VALUE || !EC2_PAYLOAD_BUCKET || !ECR_IMAGE_URI) {
      throw new Error(
        'EC2 compute strategy requires EC2_FLEET_TAG_KEY, EC2_FLEET_TAG_VALUE, EC2_PAYLOAD_BUCKET, and ECR_IMAGE_URI environment variables',
      );
    }

    const { taskId, payload, blueprintConfig } = input;
    const payloadJson = JSON.stringify(payload);

    // 1. Upload payload to S3
    const payloadKey = `tasks/${taskId}/payload.json`;
    await getS3Client().send(new PutObjectCommand({
      Bucket: EC2_PAYLOAD_BUCKET,
      Key: payloadKey,
      Body: payloadJson,
      ContentType: 'application/json',
    }));

    // 2. Find an idle instance
    const describeResult = await getEc2Client().send(new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${EC2_FLEET_TAG_KEY}`, Values: [EC2_FLEET_TAG_VALUE] },
        { Name: 'instance-state-name', Values: ['running'] },
        { Name: 'tag:bgagent:status', Values: ['idle'] },
      ],
    }));

    const instances = (describeResult.Reservations ?? []).flatMap(r => r.Instances ?? []);
    if (instances.length === 0 || !instances[0]?.InstanceId) {
      throw new Error('No idle EC2 instances available in fleet');
    }

    const instanceId = instances[0].InstanceId;

    // 3. Tag instance as busy
    await getEc2Client().send(new CreateTagsCommand({
      Resources: [instanceId],
      Tags: [
        { Key: 'bgagent:status', Value: 'busy' },
        { Key: 'bgagent:task-id', Value: taskId },
      ],
    }));

    // 4. Build the boot script
    // All task data is read from the S3 payload at runtime to avoid shell
    // injection — no untrusted values are interpolated into the script.
    // Only infrastructure constants (bucket name, ECR URI) are embedded.
    const bootScript = [
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# Derive region from IMDS (SSM does not always set AWS_REGION)',
      'export AWS_REGION=$(ec2-metadata --availability-zone | cut -d" " -f2 | sed \'s/.$/\'\'/)\'',
      'export AWS_DEFAULT_REGION="$AWS_REGION"',
      '',
      '# Resolve instance ID for tag cleanup',
      'INSTANCE_ID=$(ec2-metadata -i | cut -d" " -f2)',
      '',
      '# Cleanup trap — always retag instance as idle on exit (success, error, or signal)',
      'cleanup() {',
      '  docker system prune -f || true',
      '  rm -f /tmp/payload.json',
      `  aws ec2 create-tags --resources "$INSTANCE_ID" --region "$AWS_REGION" --tags Key=bgagent:status,Value=idle || true`,
      `  aws ec2 delete-tags --resources "$INSTANCE_ID" --region "$AWS_REGION" --tags Key=bgagent:task-id || true`,
      '}',
      'trap cleanup EXIT',
      '',
      '# Fetch payload from S3',
      `aws s3 cp "s3://${EC2_PAYLOAD_BUCKET}/${payloadKey}" /tmp/payload.json`,
      'export AGENT_PAYLOAD=$(cat /tmp/payload.json)',
      'export CLAUDE_CODE_USE_BEDROCK=1',
      '',
      '# ECR login and pull',
      `aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin $(echo '${ECR_IMAGE_URI}' | cut -d/ -f1)`,
      `docker pull '${ECR_IMAGE_URI}'`,
      '',
      '# Run the agent container — all config is read from AGENT_PAYLOAD inside the container',
      `docker run --rm -e AGENT_PAYLOAD -e CLAUDE_CODE_USE_BEDROCK -e AWS_REGION -e AWS_DEFAULT_REGION '${ECR_IMAGE_URI}' \\`,
      '  python -c \'import json, os, sys; sys.path.insert(0, "/app"); from entrypoint import run_task; p = json.loads(os.environ["AGENT_PAYLOAD"]); r = run_task(repo_url=p.get("repo_url",""), task_description=p.get("prompt",""), issue_number=str(p.get("issue_number","")), github_token=p.get("github_token",""), anthropic_model=p.get("model_id",""), max_turns=int(p.get("max_turns",100)), max_budget_usd=p.get("max_budget_usd"), aws_region=os.environ.get("AWS_REGION",""), task_id=p.get("task_id",""), hydrated_context=p.get("hydrated_context"), system_prompt_overrides=p.get("system_prompt_overrides",""), prompt_version=p.get("prompt_version",""), memory_id=p.get("memory_id",""), task_type=p.get("task_type","new_task"), branch_name=p.get("branch_name",""), pr_number=str(p.get("pr_number",""))); sys.exit(0 if r.get("status")=="success" else 1)\'',
    ].join('\n');

    // 5. Send SSM Run Command — rollback instance tags on failure
    let commandId: string;
    try {
      const ssmResult = await getSsmClient().send(new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [instanceId],
        Parameters: {
          commands: [bootScript],
        },
        TimeoutSeconds: 32400, // 9 hours, matches orchestrator max
      }));

      if (!ssmResult.Command?.CommandId) {
        throw new Error('SSM SendCommand returned no CommandId');
      }
      commandId = ssmResult.Command.CommandId;
    } catch (err) {
      // Rollback: retag instance as idle so it's not stuck as busy
      try {
        await getEc2Client().send(new CreateTagsCommand({
          Resources: [instanceId],
          Tags: [{ Key: 'bgagent:status', Value: 'idle' }],
        }));
        await getEc2Client().send(new DeleteTagsCommand({
          Resources: [instanceId],
          Tags: [{ Key: 'bgagent:task-id' }],
        }));
      } catch {
        logger.warn('Failed to rollback instance tags after dispatch failure', { instance_id: instanceId, task_id: taskId });
      }
      throw err;
    }

    logger.info('EC2 SSM command dispatched', {
      task_id: taskId,
      instance_id: instanceId,
      command_id: commandId,
      container_name: EC2_CONTAINER_NAME,
    });

    return {
      sessionId: commandId,
      strategyType: 'ec2',
      instanceId,
      commandId,
    };
  }

  async pollSession(handle: SessionHandle): Promise<SessionStatus> {
    if (handle.strategyType !== 'ec2') {
      throw new Error('pollSession called with non-ec2 handle');
    }
    const { commandId, instanceId } = handle;

    try {
      const result = await getSsmClient().send(new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId,
      }));

      const status = result.Status;

      switch (status) {
        case 'InProgress':
        case 'Pending':
        case 'Delayed':
          return { status: 'running' };
        case 'Success':
          return { status: 'completed' };
        case 'Failed':
        case 'Cancelled':
        case 'TimedOut':
        case 'Cancelling':
          return { status: 'failed', error: result.StatusDetails ?? `SSM command ${status}` };
        default:
          // Covers any unexpected status values — treat as running to avoid
          // premature failure on transient states.
          return { status: 'running' };
      }
    } catch (err) {
      const errName = err instanceof Error ? err.name : undefined;
      if (errName === 'InvocationDoesNotExist') {
        return { status: 'failed', error: 'SSM command invocation not found' };
      }
      throw err;
    }
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    if (handle.strategyType !== 'ec2') {
      throw new Error('stopSession called with non-ec2 handle');
    }
    const { commandId, instanceId } = handle;

    try {
      await getSsmClient().send(new CancelCommandCommand({
        CommandId: commandId,
        InstanceIds: [instanceId],
      }));
      logger.info('EC2 SSM command cancelled', { command_id: commandId, instance_id: instanceId });
    } catch (err) {
      const errName = err instanceof Error ? err.name : undefined;
      if (errName === 'InvalidCommandId' || errName === 'InvalidInstanceId') {
        logger.info('EC2 SSM command already cancelled or not found', { command_id: commandId, instance_id: instanceId });
      } else {
        logger.error('Failed to cancel EC2 SSM command', {
          command_id: commandId,
          instance_id: instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Best-effort: tag instance back to idle
    try {
      await getEc2Client().send(new CreateTagsCommand({
        Resources: [instanceId],
        Tags: [{ Key: 'bgagent:status', Value: 'idle' }],
      }));
      await getEc2Client().send(new DeleteTagsCommand({
        Resources: [instanceId],
        Tags: [{ Key: 'bgagent:task-id' }],
      }));
    } catch {
      // Swallow — instance may already be terminated
    }
  }
}
