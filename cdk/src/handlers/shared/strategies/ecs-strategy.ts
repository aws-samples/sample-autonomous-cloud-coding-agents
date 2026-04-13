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
import type { ComputeStrategy, SessionHandle, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import type { BlueprintConfig } from '../repo-config';

let sharedClient: ECSClient | undefined;
function getClient(): ECSClient {
  if (!sharedClient) {
    sharedClient = new ECSClient({});
  }
  return sharedClient;
}

const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;
const ECS_TASK_DEFINITION_ARN = process.env.ECS_TASK_DEFINITION_ARN;
const ECS_SUBNETS = process.env.ECS_SUBNETS;
const ECS_SECURITY_GROUP = process.env.ECS_SECURITY_GROUP;
const ECS_CONTAINER_NAME = process.env.ECS_CONTAINER_NAME ?? 'AgentContainer';

export class EcsComputeStrategy implements ComputeStrategy {
  readonly type = 'ecs';

  async startSession(input: {
    taskId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
  }): Promise<SessionHandle> {
    if (!ECS_CLUSTER_ARN || !ECS_TASK_DEFINITION_ARN || !ECS_SUBNETS || !ECS_SECURITY_GROUP) {
      throw new Error(
        'ECS compute strategy requires ECS_CLUSTER_ARN, ECS_TASK_DEFINITION_ARN, ECS_SUBNETS, and ECS_SECURITY_GROUP environment variables',
      );
    }

    const subnets = ECS_SUBNETS.split(',').map(s => s.trim()).filter(Boolean);
    const { taskId, payload, blueprintConfig } = input;

    // The ECS container's default CMD starts the FastAPI server (uvicorn) which
    // waits for HTTP POST to /invocations — but in standalone ECS nobody sends
    // that request. We override the container command to invoke run_task()
    // directly with the full orchestrator payload (including hydrated_context).
    // This avoids the server entirely and runs the agent in batch mode.
    const payloadJson = JSON.stringify(payload);

    const containerEnv = [
      { name: 'TASK_ID', value: taskId },
      { name: 'REPO_URL', value: String(payload.repo_url ?? '') },
      ...(payload.prompt ? [{ name: 'TASK_DESCRIPTION', value: String(payload.prompt) }] : []),
      ...(payload.issue_number ? [{ name: 'ISSUE_NUMBER', value: String(payload.issue_number) }] : []),
      { name: 'MAX_TURNS', value: String(payload.max_turns ?? 100) },
      ...(payload.max_budget_usd !== undefined ? [{ name: 'MAX_BUDGET_USD', value: String(payload.max_budget_usd) }] : []),
      ...(blueprintConfig.model_id ? [{ name: 'ANTHROPIC_MODEL', value: blueprintConfig.model_id }] : []),
      ...(blueprintConfig.system_prompt_overrides ? [{ name: 'SYSTEM_PROMPT_OVERRIDES', value: blueprintConfig.system_prompt_overrides }] : []),
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
      // Full orchestrator payload as JSON — the Python wrapper reads this to
      // call run_task() with all fields including hydrated_context.
      { name: 'AGENT_PAYLOAD', value: payloadJson },
      ...(payload.github_token_secret_arn
        ? [{ name: 'GITHUB_TOKEN_SECRET_ARN', value: String(payload.github_token_secret_arn) }]
        : []),
      ...(payload.memory_id ? [{ name: 'MEMORY_ID', value: String(payload.memory_id) }] : []),
    ];

    // Override the container command to run a Python one-liner that:
    // 1. Reads the AGENT_PAYLOAD env var (full orchestrator payload JSON)
    // 2. Calls entrypoint.run_task() directly with all fields
    // 3. Exits with code 0 on success, 1 on failure
    // This bypasses the uvicorn server entirely — no HTTP, no OTEL noise.
    const bootCommand = [
      'python', '-c',
      'import json, os, sys; '
      + 'sys.path.insert(0, "/app"); '
      + 'from entrypoint import run_task; '
      + 'p = json.loads(os.environ["AGENT_PAYLOAD"]); '
      + 'r = run_task('
      + 'repo_url=p.get("repo_url",""), '
      + 'task_description=p.get("prompt",""), '
      + 'issue_number=str(p.get("issue_number","")), '
      + 'github_token=p.get("github_token",""), '
      + 'anthropic_model=p.get("model_id",""), '
      + 'max_turns=int(p.get("max_turns",100)), '
      + 'max_budget_usd=p.get("max_budget_usd"), '
      + 'aws_region=os.environ.get("AWS_REGION",""), '
      + 'task_id=p.get("task_id",""), '
      + 'hydrated_context=p.get("hydrated_context"), '
      + 'system_prompt_overrides=p.get("system_prompt_overrides",""), '
      + 'prompt_version=p.get("prompt_version",""), '
      + 'memory_id=p.get("memory_id",""), '
      + 'task_type=p.get("task_type","new_task"), '
      + 'branch_name=p.get("branch_name",""), '
      + 'pr_number=str(p.get("pr_number",""))'
      + '); '
      + 'sys.exit(0 if r.get("status")=="success" else 1)',
    ];

    const command = new RunTaskCommand({
      cluster: ECS_CLUSTER_ARN,
      taskDefinition: ECS_TASK_DEFINITION_ARN,
      launchType: 'FARGATE',
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
    });

    return {
      sessionId: ecsTask.taskArn,
      strategyType: 'ecs',
      clusterArn: ECS_CLUSTER_ARN,
      taskArn: ecsTask.taskArn,
    };
  }

  async pollSession(handle: SessionHandle): Promise<SessionStatus> {
    if (handle.strategyType !== 'ecs') {
      throw new Error('pollSession called with non-ecs handle');
    }
    const { clusterArn, taskArn } = handle;

    const result = await getClient().send(new DescribeTasksCommand({
      cluster: clusterArn,
      tasks: [taskArn],
    }));

    const ecsTask = result.tasks?.[0];
    if (!ecsTask) {
      return { status: 'failed', error: `ECS task ${taskArn} not found` };
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

    // PENDING, PROVISIONING, ACTIVATING, RUNNING, DEACTIVATING, DEPROVISIONING
    return { status: 'running' };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    if (handle.strategyType !== 'ecs') {
      throw new Error('stopSession called with non-ecs handle');
    }
    const { clusterArn, taskArn } = handle;

    try {
      await getClient().send(new StopTaskCommand({
        cluster: clusterArn,
        task: taskArn,
        reason: 'Stopped by orchestrator',
      }));
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
