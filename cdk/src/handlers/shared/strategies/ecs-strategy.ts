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
import type { ComputeStrategy, SessionControlOptions, SessionHandle, SessionLifecycleResult, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import { deletePayloadReference, preparePayloadReference, redactPayloadUrls } from '../payload-bootstrap';
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

const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;
const ECS_TASK_DEFINITION_ARN = process.env.ECS_TASK_DEFINITION_ARN;
/**
 * The smaller, read-only "planning" task definition. Read-only workflows (which
 * clone and read the repo to produce a plan but never build) run here instead of
 * on the large build task. Falls back to the build task definition when unset
 * (e.g. a deployment that hasn't provisioned the planning task) — never worse
 * than running everything on the build task.
 */
const ECS_PLANNING_TASK_DEFINITION_ARN = process.env.ECS_PLANNING_TASK_DEFINITION_ARN;
const ECS_SUBNETS = process.env.ECS_SUBNETS;

/**
 * Reduce a task-definition reference to its FAMILY (drop the `:revision` suffix),
 * so `RunTask` always resolves the LATEST ACTIVE revision instead of a pinned one.
 *
 * Why: the orchestrator env carries a revision-pinned ARN
 * (`…:task-definition/<family>:<rev>`, from `taskDefinition.taskDefinitionArn`).
 * Every deploy that rebuilds the agent image registers a NEW revision and CDK/ECS
 * deregisters the old one. A task dispatched against the now-stale pinned revision
 * (e.g. minutes after a deploy) fails at RunTask with
 * "InvalidParameterException: TaskDefinition is inactive". ECS accepts `family`
 * (bare, no revision) and resolves it to the latest ACTIVE revision at call time,
 * which is immune to that deploy race. We accept either a full ARN
 * (`arn:aws:ecs:…:task-definition/<family>:<rev>`) or a plain `<family>:<rev>` and
 * return just `<family>`; a value with no `/` and no `:` is returned unchanged.
 */
export function toTaskDefinitionFamily(ref: string): string {
  // Take the segment after `task-definition/` when it's a full ARN, else the whole
  // value; then strip a trailing `:<digits>` revision suffix.
  const afterSlash = ref.includes('task-definition/')
    ? ref.slice(ref.lastIndexOf('task-definition/') + 'task-definition/'.length)
    : ref;
  return afterSlash.replace(/:\d+$/, '');
}
const ECS_SECURITY_GROUP = process.env.ECS_SECURITY_GROUP;
const ECS_CONTAINER_NAME = process.env.ECS_CONTAINER_NAME ?? 'AgentContainer';
const ECS_PAYLOAD_BUCKET = process.env.ECS_PAYLOAD_BUCKET;
const ECS_OVERRIDES_LIMIT_BYTES = 8192;

function safeLaunchError(error: unknown): Error {
  const safe = new Error(redactPayloadUrls(error instanceof Error ? error.message : String(error)));
  safe.name = error instanceof Error ? error.name : 'Error';
  return safe;
}

/**
 * Delete a task's ECS payload and private launch reference. A failed delete must never
 * fail the task — the bucket's 1-day lifecycle rule reaps it regardless. Called
 * from the orchestrator's ``finalize`` step once the task is terminal. No-ops
 * when the payload bucket isn't configured (AgentCore-only deployments).
 */
export async function deleteEcsPayload(taskId: string): Promise<void> {
  if (!ECS_PAYLOAD_BUCKET) return;
  await deletePayloadReference(ECS_PAYLOAD_BUCKET, taskId);
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
    /** Accepted to satisfy the ComputeStrategy interface; ECS doesn't
     *  use a workload-token-injecting runtime so this is unused. */
    userId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
    readOnly?: boolean;
  }): Promise<SessionHandle> {
    if (!ECS_CLUSTER_ARN || !ECS_TASK_DEFINITION_ARN || !ECS_SUBNETS || !ECS_SECURITY_GROUP) {
      // Config/deploy mismatch: this repo is compute_type=ecs but the stack was
      // deployed WITHOUT the ECS substrate (no `--context compute_type=ecs`), so
      // the orchestrator has no ECS_* env vars. Name the root cause + remedy so an
      // admin doesn't have to reverse-engineer it from a bare env-var list. (The
      // CLI `repo onboard --compute-type ecs` guard normally prevents this; a repo
      // onboarded before that guard, or edited directly, can still reach here.)
      throw new Error(
        'This repository is configured compute_type=ecs, but this stack was deployed without the ECS '
        + 'substrate (missing ECS_CLUSTER_ARN/ECS_TASK_DEFINITION_ARN/ECS_SUBNETS/ECS_SECURITY_GROUP). '
        + 'Redeploy the stack with `--context compute_type=ecs` to provision the Fargate substrate, or '
        + 'set this repo to compute_type=agentcore (bgagent repo onboard <repo> --compute-type agentcore).',
      );
    }

    const subnets = ECS_SUBNETS.split(',').map(s => s.trim()).filter(Boolean);
    const { taskId, payload, blueprintConfig, readOnly } = input;

    // A read-only workflow (e.g. planning that only clones and reads the repo)
    // runs on the smaller planning task def when it's wired; everything else runs
    // on the large build def. Falls back to the build def if the planning def
    // isn't configured — safe, just runs planning on the build-sized task.
    const taskDefinitionRef = readOnly && ECS_PLANNING_TASK_DEFINITION_ARN
      ? ECS_PLANNING_TASK_DEFINITION_ARN
      : ECS_TASK_DEFINITION_ARN;
    // Dispatch against the task-def FAMILY (not the pinned revision) so ECS
    // resolves the latest ACTIVE revision at call time. A deploy that rebuilds the
    // agent image registers a new revision + deregisters the old one; a task
    // dispatched minutes after a deploy against the stale pinned revision fails
    // with "InvalidParameterException: TaskDefinition is inactive". Using the
    // family is immune to that deploy race.
    const taskDefinition = toTaskDefinitionFamily(taskDefinitionRef);

    // The ECS container's default CMD starts the FastAPI server (uvicorn) which
    // waits for HTTP POST to /invocations — but in standalone ECS nobody sends
    // that request. We override the container command to invoke run_task_from_payload()
    // directly with the full orchestrator payload (including hydrated_context).
    // This avoids the server entirely and runs the agent in batch mode.
    if (!ECS_PAYLOAD_BUCKET) {
      throw new Error('PAYLOAD_BOOTSTRAP_INVALID: ECS_PAYLOAD_BUCKET is required; deploy matching infrastructure');
    }
    const reference = await preparePayloadReference({
      bucket: ECS_PAYLOAD_BUCKET, taskId, backend: 'ecs', payload,
    }).catch((error: unknown) => {
      throw safeLaunchError(error);
    });

    const containerEnv = [
      { name: 'TASK_ID', value: taskId },
      { name: 'REPO_URL', value: String(payload.repo_url ?? '') },
      ...(payload.issue_number ? [{ name: 'ISSUE_NUMBER', value: String(payload.issue_number) }] : []),
      // Single source of truth with the hydrate path in `orchestrator.ts`, which
      // resolves the same default via `DEFAULT_MAX_TURNS`. A literal here would
      // silently disagree with it whenever the payload omits `max_turns`, and a
      // turn ceiling that depends on which code path filled it in is a bug.
      { name: 'MAX_TURNS', value: String(payload.max_turns ?? DEFAULT_MAX_TURNS) },
      ...(payload.max_budget_usd !== undefined ? [{ name: 'MAX_BUDGET_USD', value: String(payload.max_budget_usd) }] : []),
      ...(blueprintConfig.model_id ? [{ name: 'ANTHROPIC_MODEL', value: blueprintConfig.model_id }] : []),
      ...(blueprintConfig.system_prompt_overrides ? [{ name: 'SYSTEM_PROMPT_OVERRIDES', value: blueprintConfig.system_prompt_overrides }] : []),
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
      { name: 'AGENT_PAYLOAD_REF', value: JSON.stringify(reference) },
      ...(payload.github_token_secret_arn
        ? [{ name: 'GITHUB_TOKEN_SECRET_ARN', value: String(payload.github_token_secret_arn) }]
        : []),
      ...(payload.memory_id ? [{ name: 'MEMORY_ID', value: String(payload.memory_id) }] : []),
    ];

    // Consume the one-object capability before importing/running the pipeline.
    // The helper removes it from os.environ so repo subprocesses do not inherit it.
    const bootCommand = [
      'python', '-c',
      'import sys; sys.path.insert(0, "/app/src"); '
      + 'from payload_bootstrap import load_ecs_payload; p = load_ecs_payload(); '
      + 'from entrypoint import run_task_from_payload; '
      + 'r = run_task_from_payload(p); '
      + 'sys.exit(0 if r.get("status")=="success" else 1)',
    ];

    const overrides = {
      containerOverrides: [{
        name: ECS_CONTAINER_NAME,
        environment: containerEnv,
        command: bootCommand,
      }],
    };
    if (Buffer.byteLength(JSON.stringify(overrides), 'utf8') > ECS_OVERRIDES_LIMIT_BYTES) {
      throw new Error('PAYLOAD_BOOTSTRAP_TOO_LARGE: ECS container overrides exceed 8192 bytes');
    }
    const command = new RunTaskCommand({
      cluster: ECS_CLUSTER_ARN,
      taskDefinition,
      launchType: 'FARGATE',
      // ECS RunTask idempotency. Without a clientToken, a client-side timeout on a
      // RunTask that ACTUALLY launched (the SDK send() threw after AWS accepted it)
      // makes the session-start auto-retry fire a SECOND RunTask with the same
      // TASK_ID env — two Fargate containers cloning/committing/PRing in parallel,
      // the first untrackable. clientToken makes AWS itself dedup an identical
      // RunTask within its window: the retry returns the SAME task instead of
      // launching another. taskId is a ULID (26 chars, well under the 64-char
      // clientToken limit) and unique per task — the natural token.
      clientToken: taskId,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups: [ECS_SECURITY_GROUP],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides,
    });

    const result = await getClient().send(command).catch((error: unknown) => {
      throw safeLaunchError(error);
    });

    const ecsTask = result.tasks?.[0];
    if (!ecsTask?.taskArn) {
      const failures = result.failures?.map(f => `${f.arn}: ${f.reason}`).join('; ') ?? 'unknown';
      throw new Error(`ECS RunTask returned no task: ${redactPayloadUrls(failures)}`);
    }

    logger.info('ECS Fargate task started', {
      task_id: taskId,
      ecs_task_arn: ecsTask.taskArn,
      cluster: ECS_CLUSTER_ARN,
      // Which task def was selected — planning (read-only) vs build.
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
