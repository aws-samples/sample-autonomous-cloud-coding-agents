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

import { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { ComputeStrategy, SessionControlOptions, SessionHandle, SessionLifecycleResult, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import type { BlueprintConfig } from '../repo-config';
import { makeClient } from '../ua';
import { DEFAULT_MAX_TURNS } from '../validation';

let sharedClient: ECSClient | undefined;
function getClient(): ECSClient {
  if (!sharedClient) {
    sharedClient = makeClient(ECSClient);
  }
  return sharedClient;
}

let sharedS3Client: S3Client | undefined;
function getS3Client(): S3Client {
  if (!sharedS3Client) {
    sharedS3Client = makeClient(S3Client);
  }
  return sharedS3Client;
}

const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;
const ECS_TASK_DEFINITION_ARN = process.env.ECS_TASK_DEFINITION_ARN;
const ECS_PLANNING_TASK_DEFINITION_ARN = process.env.ECS_PLANNING_TASK_DEFINITION_ARN;
const ECS_SUBNETS = process.env.ECS_SUBNETS;

/**
 * ECS accepts `family` (bare, no revision) and resolves it to the latest ACTIVE
 * revision at call time. A deregistered pinned revision fails at RunTask with
 * "InvalidParameterException: TaskDefinition is inactive".
 */
function toTaskDefinitionFamily(ref: string): string {
  const afterSlash = ref.includes('task-definition/')
    ? ref.slice(ref.lastIndexOf('task-definition/') + 'task-definition/'.length)
    : ref;
  return afterSlash.replace(/:\d+$/, '');
}
const ECS_SECURITY_GROUP = process.env.ECS_SECURITY_GROUP;
const ECS_CONTAINER_NAME = process.env.ECS_CONTAINER_NAME ?? 'AgentContainer';
const ECS_PAYLOAD_BUCKET = process.env.ECS_PAYLOAD_BUCKET;

/**
 * ECS caps the TOTAL containerOverrides blob at 8192 bytes; the other env vars +
 * command consume some of that.
 */
const INLINE_PAYLOAD_WARN_BYTES = 6144;

function ecsPayloadKey(taskId: string): string {
  return `${taskId}/payload.json`;
}

/**
 * Delete a task's ECS payload object. Best-effort: a failed delete never
 * fails the task. No-ops when the payload bucket isn't configured.
 */
export async function deleteEcsPayload(taskId: string): Promise<void> {
  if (!ECS_PAYLOAD_BUCKET) return;
  try {
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: ECS_PAYLOAD_BUCKET,
      Key: ecsPayloadKey(taskId),
    }));
    logger.info('Deleted ECS payload object', { task_id: taskId });
  } catch (err) {
    logger.warn('Failed to delete ECS payload object (non-fatal)', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class EcsComputeStrategy implements ComputeStrategy {
  readonly type = 'ecs';

  async suspendSession(handle: SessionHandle): Promise<SessionLifecycleResult> {
    if (handle.strategyType !== 'ecs') throw new Error('suspendSession called with non-ecs handle');
    return { supported: false };
  }

  async resumeSession(handle: SessionHandle): Promise<SessionLifecycleResult> {
    if (handle.strategyType !== 'ecs') throw new Error('resumeSession called with non-ecs handle');
    return { supported: false };
  }

  async startSession(input: {
    taskId: string;
    userId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
    readOnly?: boolean;
  }): Promise<SessionHandle> {
    if (!ECS_CLUSTER_ARN || !ECS_TASK_DEFINITION_ARN || !ECS_SUBNETS || !ECS_SECURITY_GROUP) {
      throw new Error(
        'This repository is configured compute_type=ecs, but this stack was deployed without the ECS '
        + 'substrate (missing ECS_CLUSTER_ARN/ECS_TASK_DEFINITION_ARN/ECS_SUBNETS/ECS_SECURITY_GROUP). '
        + 'Redeploy the stack with `--context compute_type=ecs` to provision the Fargate substrate, or '
        + 'set this repo to compute_type=agentcore (bgagent repo onboard <repo> --compute-type agentcore).',
      );
    }

    const subnets = ECS_SUBNETS.split(',').map(s => s.trim()).filter(Boolean);
    const { taskId, payload, blueprintConfig, readOnly } = input;

    const taskDefinitionRef = readOnly && ECS_PLANNING_TASK_DEFINITION_ARN
      ? ECS_PLANNING_TASK_DEFINITION_ARN
      : ECS_TASK_DEFINITION_ARN;
    const taskDefinition = toTaskDefinitionFamily(taskDefinitionRef);

    const payloadJson = JSON.stringify(payload);

    let payloadS3Uri: string | undefined;
    if (ECS_PAYLOAD_BUCKET) {
      const key = ecsPayloadKey(taskId);
      await getS3Client().send(new PutObjectCommand({
        Bucket: ECS_PAYLOAD_BUCKET,
        Key: key,
        Body: payloadJson,
        ContentType: 'application/json',
      }));
      payloadS3Uri = `s3://${ECS_PAYLOAD_BUCKET}/${key}`;
      logger.info('Wrote ECS payload to S3', {
        task_id: taskId,
        bytes: payloadJson.length,
        uri: payloadS3Uri,
      });
    } else if (payloadJson.length > INLINE_PAYLOAD_WARN_BYTES) {
      logger.warn('ECS payload is large but ECS_PAYLOAD_BUCKET is not set — RunTask may reject it (see #502)', {
        task_id: taskId,
        bytes: payloadJson.length,
      });
    }

    const containerEnv = [
      { name: 'TASK_ID', value: taskId },
      { name: 'REPO_URL', value: String(payload.repo_url ?? '') },
      ...(payload.prompt ? [{ name: 'TASK_DESCRIPTION', value: String(payload.prompt) }] : []),
      ...(payload.issue_number ? [{ name: 'ISSUE_NUMBER', value: String(payload.issue_number) }] : []),
      { name: 'MAX_TURNS', value: String(payload.max_turns ?? DEFAULT_MAX_TURNS) },
      ...(payload.max_budget_usd !== undefined ? [{ name: 'MAX_BUDGET_USD', value: String(payload.max_budget_usd) }] : []),
      ...(blueprintConfig.model_id ? [{ name: 'ANTHROPIC_MODEL', value: blueprintConfig.model_id }] : []),
      ...(blueprintConfig.system_prompt_overrides ? [{ name: 'SYSTEM_PROMPT_OVERRIDES', value: blueprintConfig.system_prompt_overrides }] : []),
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
      ...(payloadS3Uri
        ? [{ name: 'AGENT_PAYLOAD_S3_URI', value: payloadS3Uri }]
        : [{ name: 'AGENT_PAYLOAD', value: payloadJson }]),
      ...(payload.github_token_secret_arn
        ? [{ name: 'GITHUB_TOKEN_SECRET_ARN', value: String(payload.github_token_secret_arn) }]
        : []),
      ...(payload.memory_id ? [{ name: 'MEMORY_ID', value: String(payload.memory_id) }] : []),
    ];

    const bootCommand = [
      'python', '-c',
      'import json, os, sys; '
      + 'sys.path.insert(0, "/app/src"); '
      + 'from entrypoint import run_task_from_payload; '
      + '_uri = os.environ.get("AGENT_PAYLOAD_S3_URI"); '
      + 'p = ('
      + 'json.loads(__import__("boto3").client("s3").get_object('
      + 'Bucket=_uri.split("/",3)[2], Key=_uri.split("/",3)[3])["Body"].read()) '
      + 'if _uri else json.loads(os.environ["AGENT_PAYLOAD"])'
      + '); '
      + 'r = run_task_from_payload(p); '
      + 'sys.exit(0 if r.get("status")=="success" else 1)',
    ];

    const command = new RunTaskCommand({
      cluster: ECS_CLUSTER_ARN,
      taskDefinition,
      launchType: 'FARGATE',
      // ECS dedups an identical RunTask on clientToken (64-char limit) within its
      // window: a retry returns the SAME task instead of launching another.
      clientToken: taskId,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups: [ECS_SECURITY_GROUP],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [{
          name: ECS_CONTAINER_NAME,
          environment: containerEnv,
          command: bootCommand,
        }],
      },
    });

    const result = await getClient().send(command);

    const ecsTask = result.tasks?.[0];
    if (!ecsTask?.taskArn) {
      const failures = result.failures?.map(f => `${f.arn}: ${f.reason}`).join('; ') ?? 'unknown';
      throw new Error(`ECS RunTask returned no task: ${failures}`);
    }

    logger.info('ECS Fargate task started', {
      task_id: taskId,
      ecs_task_arn: ecsTask.taskArn,
      cluster: ECS_CLUSTER_ARN,
      task_definition: taskDefinition,
      read_only: Boolean(readOnly),
    });

    return {
      sessionId: ecsTask.taskArn,
      strategyType: 'ecs',
      clusterArn: ECS_CLUSTER_ARN,
      taskArn: ecsTask.taskArn,
    };
  }

  async pollSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionStatus> {
    if (handle.strategyType !== 'ecs') {
      throw new Error('pollSession called with non-ecs handle');
    }
    const { clusterArn, taskArn } = handle;

    options?.abortSignal?.throwIfAborted();
    const result = await getClient().send(new DescribeTasksCommand({
      cluster: clusterArn,
      tasks: [taskArn],
    }), options);

    const ecsTask = result.tasks?.[0];
    if (!ecsTask) {
      // The ECS API is eventually consistent: a read right after RunTask can miss a
      // task that is starting normally.
      throw new Error(`ECS task ${taskArn} not found`);
    }

    const lastStatus = ecsTask.lastStatus;

    if (lastStatus === 'STOPPED') {
      const container = ecsTask.containers?.[0];
      const exitCode = container?.exitCode;
      const stoppedReason = ecsTask.stoppedReason ?? container?.reason ?? 'unknown';

      if (exitCode === 0) {
        return { status: 'completed' };
      }
      if (exitCode === undefined || exitCode === null) {
        return { status: 'failed', error: `Task stopped: ${stoppedReason}` };
      }
      return { status: 'failed', error: `Exit code ${exitCode}: ${stoppedReason}` };
    }

    return { status: 'running' };
  }

  async stopSession(handle: SessionHandle, options?: SessionControlOptions): Promise<void> {
    if (handle.strategyType !== 'ecs') {
      throw new Error('stopSession called with non-ecs handle');
    }
    const { clusterArn, taskArn } = handle;

    try {
      options?.abortSignal?.throwIfAborted();
      await getClient().send(new StopTaskCommand({
        cluster: clusterArn,
        task: taskArn,
        reason: 'Stopped by orchestrator',
      }), options);
      logger.info('ECS task stopped', { task_arn: taskArn });
    } catch (err) {
      const errName = err instanceof Error ? err.name : undefined;
      if (errName === 'InvalidParameterException' || errName === 'ResourceNotFoundException') {
        logger.info('ECS task already stopped or not found', { task_arn: taskArn });
      } else {
        logger.error('Failed to stop ECS task', {
          task_arn: taskArn,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
