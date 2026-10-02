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

import { createHash } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionControlOptions } from './compute-strategy';
import { logger } from './logger';
import type { ContinuableTask } from './microvm-continuation-retirement';
import type { MicrovmContinuationEvent } from './microvm-continuation-runner';
import { admitContinuation } from './microvm-continuation-start';
import { CONTINUATION_IO_TIMEOUT_MS } from './microvm-continuation-timing';
import { validAttemptId } from './microvm-continuation-types';
import { microvmErrorIdentity } from './microvm-control';
import { continuationEnabled } from './microvm-worker-lease';
import { makeClient, makeDocClient } from './ua';
import { TaskStatus } from '../../constructs/task-status';

const ddb = makeDocClient();
const MAX_VALIDATION_DETAIL_LENGTH = 512;
let lambda: LambdaClient | undefined;

/**
 * True means this is a retired/restoring worker; callers must not /resume its
 * source handle. Admission and invocation can be retried by the periodic scan.
 */
export async function dispatchMicrovmContinuation(
  taskId: string, userId: string, requestId: string,
  options: SessionControlOptions = { abortSignal: AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS) },
): Promise<boolean> {
  if (!continuationEnabled()) return false;
  const response = await ddb.send(new GetCommand({
    TableName: process.env.TASK_TABLE_NAME!, Key: { task_id: taskId }, ConsistentRead: true,
  }), options);
  const task = response.Item as ContinuableTask | undefined;
  if (!task || task.user_id !== userId || task.compute_type !== 'lambda-microvm'
    || task.status !== TaskStatus.AWAITING_APPROVAL || task.awaiting_approval_request_id !== requestId) return false;
  if (!['FENCED', 'PARKED', 'STARTING', 'RESTORING'].includes(task.continuation?.state ?? '')) return false;
  // Retirement still owns termination and capacity release.
  if (task.continuation?.state === 'FENCED') return true;
  const version = task.continuation_launch?.orchestrator_version;
  const configuredArn = process.env.ORCHESTRATOR_FUNCTION_ARN ?? '';
  const match = /^(arn:[^:]+:lambda:[^:]+:\d+:function:[^:]+)(?::[^:]+)?$/.exec(configuredArn);
  if (!version || !/^\d+$/.test(version) || !match) {
    throw new Error('MICROVM_CONTINUATION_COORDINATOR_INVALID: original published function is unavailable');
  }
  const admission = await admitContinuation(
    taskId, userId, requestId, Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10'), options,
  );
  if (admission.kind !== 'ready') return true;
  const attemptId = admission.task.continuation?.attempt_id;
  if (!validAttemptId(attemptId)) throw new Error('MICROVM_CONTINUATION_ASSIGNMENT_INVALID');
  const event: MicrovmContinuationEvent = {
    task_id: taskId, continuation_request_id: requestId, continuation_attempt_id: attemptId,
  };
  const payload = JSON.stringify(event);
  // Lambda accepts at most 64 characters. Keep the complete 256-bit identity;
  // a descriptive prefix would exceed the service limit and strand admission.
  const name = createHash('sha256').update(payload).digest('hex');
  lambda ??= makeClient(LambdaClient);
  try {
    const result = await lambda.send(new InvokeCommand({
      FunctionName: `${match[1]}:${version}`,
      InvocationType: 'Event',
      DurableExecutionName: name,
      Payload: Buffer.from(payload),
    }), options);
    if (result.StatusCode !== 202) throw new Error('MICROVM_CONTINUATION_DISPATCH_FAILED: invocation was not accepted');
    logger.info('Saved task continuation dispatched', {
      task_id: taskId,
      request_id: requestId,
      attempt_id: attemptId,
      coordinator_version: version,
      durable_execution_name: name,
    });
  } catch (error) {
    logger.warn('Saved task continuation dispatch needs reconciliation', {
      task_id: taskId,
      request_id: requestId,
      attempt_id: attemptId,
      operation: 'Invoke',
      coordinator_version: version,
      durable_execution_name_length: name.length,
      // This Invoke carries only task/request/attempt identifiers, never a
      // prompt, credential or signed URL. Its validation message is safe and
      // necessary to diagnose errors that a class name alone cannot explain.
      ...(error instanceof Error && error.name === 'ValidationException'
        ? { validation_detail: error.message.slice(0, MAX_VALIDATION_DETAIL_LENGTH) } : {}),
      ...microvmErrorIdentity(error),
    });
    throw error;
  }
  return true;
}
