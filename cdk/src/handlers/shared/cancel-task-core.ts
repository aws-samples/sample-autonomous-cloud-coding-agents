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

import { BedrockAgentCoreClient, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { TaskStatus } from '../../constructs/task-status';
import { logger } from './logger';
import type { TaskRecord } from './types';
import { makeClient } from './ua';
import { computeTtlEpoch } from './validation';

const agentCoreClient = makeClient(BedrockAgentCoreClient);
const ecsClient = makeClient(ECSClient);
const microvmClient = makeClient(LambdaMicrovmsClient);

export interface CancelTaskTables {
  readonly ddb: DynamoDBDocumentClient;
  readonly taskTableName: string;
  readonly taskEventsTableName: string;
  readonly retentionDays: number;
}

/**
 * Move a task to CANCELLED and write its ``task_cancelled`` event in ONE
 * transaction, so a cancel can never commit without the event that tells the
 * fan-out channels about it (a retry after a half-applied cancel would see a
 * terminal task and never write the event).
 *
 * Returns ``'already_terminal'`` when the task reached COMPLETED / FAILED /
 * CANCELLED / TIMED_OUT first (or the row is gone) — the caller lost a race and
 * nothing was written. Any other DynamoDB error propagates.
 *
 * ``extraMetadata`` lets an entry point tag the event (e.g. a Linear session
 * stop, whose confirmation the caller already posted).
 *
 * The agent runtime polls its task record between turns and exits on CANCELLED
 * (``agent/src/hooks.py``), but that alone lets the current turn finish and
 * push: callers follow up with {@link stopTaskCompute}.
 */
export async function cancelTask(
  tables: CancelTaskTables,
  taskId: string,
  cancelledBy: string,
  now: string = new Date().toISOString(),
  extraMetadata: Record<string, string> = {},
): Promise<'cancelled' | 'already_terminal'> {
  const ttl = computeTtlEpoch(tables.retentionDays);
  try {
    await tables.ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.taskTableName,
            Key: { task_id: taskId },
            UpdateExpression: 'SET #status = :cancelled, updated_at = :now, completed_at = :now, status_created_at = :sca, #ttl = :ttl',
            ConditionExpression: 'attribute_exists(task_id) AND NOT #status IN (:s1, :s2, :s3, :s4)',
            ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':cancelled': TaskStatus.CANCELLED,
              ':now': now,
              ':sca': `${TaskStatus.CANCELLED}#${now}`,
              ':s1': TaskStatus.COMPLETED,
              ':s2': TaskStatus.FAILED,
              ':s3': TaskStatus.CANCELLED,
              ':s4': TaskStatus.TIMED_OUT,
              ':ttl': ttl,
            },
          },
        },
        {
          Put: {
            TableName: tables.taskEventsTableName,
            Item: {
              task_id: taskId,
              event_id: ulid(),
              event_type: 'task_cancelled',
              timestamp: now,
              ttl,
              metadata: { ...extraMetadata, cancelled_by: cancelledBy },
            },
          },
        },
      ],
    }));
    return 'cancelled';
  } catch (err) {
    const cancelled = err as { name?: string; CancellationReasons?: ReadonlyArray<{ Code?: string }> };
    if (cancelled?.name === 'TransactionCanceledException'
      && cancelled.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
      return 'already_terminal';
    }
    throw err;
  }
}

/** The task fields {@link stopTaskCompute} reads — as they were BEFORE the cancel. */
export type CancelledTaskCompute = Pick<
  TaskRecord,
  'task_id' | 'status' | 'session_id' | 'agent_runtime_arn' | 'compute_type' | 'compute_metadata'
>;

/**
 * Stop the compute behind a task that was just cancelled, so the container
 * winds down instead of finishing its turn. Best-effort and never throws: the
 * CANCELLED transition already committed and must stand.
 *
 * Shared by ``DELETE /tasks/{id}`` and the Linear agent-session ``stop`` signal
 * so both stop the same backends. Reads ``RUNTIME_ARN`` / ``ECS_CLUSTER_ARN``
 * from the environment as fallbacks for a task whose container has not written
 * its session info yet; a caller without the matching IAM grant gets a logged
 * warning, not a failure.
 *
 * A task that never reached a compute status (SUBMITTED) has nothing to stop:
 * the orchestrator's admission step re-reads the record and does not start a
 * session for a CANCELLED task.
 */
export async function stopTaskCompute(
  tables: CancelTaskTables,
  record: CancelledTaskCompute,
  now: string = new Date().toISOString(),
  requestId?: string,
): Promise<void> {
  // A task waiting for approval may own a suspended MicroVM: stop that too.
  const mayHaveCompute = record.status === TaskStatus.HYDRATING
    || record.status === TaskStatus.RUNNING
    || record.status === TaskStatus.AWAITING_APPROVAL
    || record.status === TaskStatus.FINALIZING;
  const runtimeSessionId = record.session_id;
  if (!mayHaveCompute || !runtimeSessionId) return;

  const taskId = record.task_id;
  const computeType = record.compute_type;
  // Prefer the ARN recorded on the task record (agent container writes
  // this when the session starts). Fall back to the stack's single
  // runtime ARN for the pre-session window — the task was admitted but
  // the container hasn't written its session info yet.
  const agentRuntimeArn = record.agent_runtime_arn ?? process.env.RUNTIME_ARN;

  if (computeType === 'ecs') {
    // ECS-backed task — stop the Fargate task
    const clusterArn = record.compute_metadata?.clusterArn ?? process.env.ECS_CLUSTER_ARN;
    const taskArn = record.compute_metadata?.taskArn;
    if (clusterArn && taskArn) {
      try {
        await ecsClient.send(new StopTaskCommand({
          cluster: clusterArn,
          task: taskArn,
          reason: 'Cancelled by user',
        }));
        logger.info('ECS StopTask invoked after cancel', { task_id: taskId, ecs_task_arn: taskArn, request_id: requestId });
      } catch (stopErr) {
        logger.warn('ECS StopTask failed after cancel (task may already be stopped)', {
          task_id: taskId,
          request_id: requestId,
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    } else {
      logger.warn('ECS task cancel skipped: missing clusterArn or taskArn in compute_metadata', {
        task_id: taskId,
        request_id: requestId,
        has_cluster: !!clusterArn,
        has_task: !!taskArn,
      });
    }
    return;
  }

  if (computeType === 'lambda-microvm') {
    // ADR-021: `terminate-microvm` is the ACTIVE cleanup path — a cancelled
    // MicroVM must not be left to the 8-hour `maximumDurationInSeconds` cap
    // (with `idlePolicy` omitted there is no tighter substrate bound), both
    // for cost and because running/suspended VMs count against the account
    // memory quota that gates admission of new tasks.
    //
    // This branch MUST come before the `agentRuntimeArn` branch below.
    // `agentRuntimeArn` falls back to the stack-level RUNTIME_ARN env var,
    // which is set whenever AgentCore stop-session is wired — so in a mixed
    // agentcore+lambda-microvm deployment a MicroVM task would otherwise fall
    // into the AgentCore branch and call StopRuntimeSession against an
    // unrelated runtime ARN, silently leaving the MicroVM running.
    const microvmId = record.compute_metadata?.microvmId;
    if (microvmId) {
      try {
        await microvmClient.send(new TerminateMicrovmCommand({
          microvmIdentifier: microvmId,
        }));
        logger.info('TerminateMicrovm invoked after cancel', { task_id: taskId, microvm_id: microvmId, request_id: requestId });
      } catch (stopErr) {
        logger.warn('TerminateMicrovm failed after cancel (MicroVM may already be gone)', {
          task_id: taskId,
          microvm_id: microvmId,
          request_id: requestId,
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    } else {
      logger.warn('MicroVM cancel skipped: missing microvmId in compute_metadata', {
        task_id: taskId,
        request_id: requestId,
      });
    }
    return;
  }

  if (agentRuntimeArn) {
    // AgentCore-backed task (default)
    try {
      await agentCoreClient.send(new StopRuntimeSessionCommand({
        runtimeSessionId: runtimeSessionId,
        agentRuntimeArn: agentRuntimeArn,
      }));
      logger.info('StopRuntimeSession invoked after cancel', { task_id: taskId, request_id: requestId });
    } catch (stopErr) {
      logger.warn('StopRuntimeSession failed after cancel (session may already be gone)', {
        task_id: taskId,
        request_id: requestId,
        error: stopErr instanceof Error ? stopErr.message : String(stopErr),
      });
    }
    return;
  }

  // Task status was flipped to CANCELLED in DDB but we have no
  // compute handle to actually stop the container. This is a
  // resource-leak risk: the container may still be running and
  // consuming tokens/concurrency. Emit a dedicated event so ops
  // dashboards / alarms can surface the orphan.
  logger.error('Active task has no recognized compute backend to stop — possible orphan', {
    task_id: taskId,
    request_id: requestId,
    compute_type: computeType,
    has_runtime_arn: !!agentRuntimeArn,
  });
  try {
    await tables.ddb.send(new PutCommand({
      TableName: tables.taskEventsTableName,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'task_cancel_compute_orphan',
        timestamp: now,
        ttl: computeTtlEpoch(tables.retentionDays),
        metadata: {
          compute_type: computeType,
          reason: 'missing_runtime_handle',
        },
      },
    }));
  } catch (eventErr) {
    logger.warn('Failed to write task_cancel_compute_orphan event', {
      task_id: taskId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    });
  }
}
