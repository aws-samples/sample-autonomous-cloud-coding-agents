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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { TaskStatus, TERMINAL_STATUSES } from '../constructs/task-status';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { TaskRecord } from './shared/types';
import { computeTtlEpoch } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentCoreClient = new BedrockAgentCoreClient({});
const ecsClient = new ECSClient({});
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;

/**
 * DELETE /v1/tasks/{task_id} — Cancel a task.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract authenticated user
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Extract task_id from path
    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    // 3. Get current task state
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!result.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }

    // 4. Ownership check
    const record = result.Item as TaskRecord;
    if (record.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }

    // 5. Check if already terminal
    if (TERMINAL_STATUSES.includes(record.status)) {
      return errorResponse(409, ErrorCode.TASK_ALREADY_TERMINAL, `Task ${taskId} is already in terminal state ${record.status}.`, requestId);
    }

    const wasRunning = record.status === TaskStatus.RUNNING;
    const runtimeSessionId = record.session_id;
    const agentRuntimeArn = record.agent_runtime_arn ?? RUNTIME_ARN;

    // 6. Update task to CANCELLED with condition to prevent race
    const now = new Date().toISOString();
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
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
          ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS),
        },
      }));
    } catch (condErr: any) {
      if (condErr.name === 'ConditionalCheckFailedException') {
        return errorResponse(409, ErrorCode.TASK_ALREADY_TERMINAL, `Task ${taskId} transitioned to a terminal state.`, requestId);
      }
      throw condErr;
    }

    // 6b. Stop the compute session so the container winds down (best-effort)
    if (wasRunning && runtimeSessionId) {
      const computeType = record.compute_type;
      if (computeType === 'ecs') {
        // ECS-backed task — stop the Fargate task
        const clusterArn = record.compute_metadata?.clusterArn ?? ECS_CLUSTER_ARN;
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
      } else if (agentRuntimeArn) {
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
      } else {
        logger.warn('Running task has no recognized compute backend to stop', {
          task_id: taskId,
          request_id: requestId,
          compute_type: computeType,
          has_runtime_arn: !!agentRuntimeArn,
        });
      }
    }

    // 7. Write task_cancelled event
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE_NAME,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'task_cancelled',
        timestamp: now,
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: { cancelled_by: userId },
      },
    }));

    logger.info('Task cancelled', { task_id: taskId, user_id: userId, request_id: requestId });

    return successResponse(200, {
      task_id: taskId,
      status: TaskStatus.CANCELLED,
      cancelled_at: now,
    }, requestId);
  } catch (err) {
    logger.error('Failed to cancel task', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
