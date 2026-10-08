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

import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { workerLeaseKey, type WorkerLease } from './microvm-continuation-types';
import { makeDocClient } from './ua';

const ddb = makeDocClient();
const TABLE = process.env.TASK_TABLE_NAME!;

export function continuationEnabled(): boolean {
  return Boolean(process.env.CONTINUATION_BUCKET_NAME);
}

/** Create authority once. Replays must never reactivate a fenced worker. */
export async function ensureWorkerLease(input: {
  taskId: string; userId: string; repo: string; attemptId: string; requestHash: string;
}): Promise<void> {
  if (!continuationEnabled()) return;
  const lease: WorkerLease = {
    ...workerLeaseKey(input.taskId),
    lease_attempt_id: input.attemptId,
    lease_state: 'ACTIVE',
    lease_user_id: input.userId,
    lease_repo: input.repo,
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE,
            Key: { task_id: input.taskId },
            ConditionExpression: 'user_id = :user AND microvm_start.clientToken = :attempt '
              + 'AND microvm_start.requestHash = :hash AND #status IN (:hydrating, :awaiting)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':user': input.userId,
              ':attempt': input.attemptId,
              ':hash': input.requestHash,
              ':hydrating': 'HYDRATING',
              ':awaiting': 'AWAITING_APPROVAL',
            },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: lease,
            ConditionExpression: 'attribute_not_exists(task_id)',
          },
        },
      ],
    }));
  } catch (error) {
    const result = await ddb.send(new GetCommand({
      TableName: TABLE, Key: workerLeaseKey(input.taskId), ConsistentRead: true,
    }));
    const current = result.Item as WorkerLease | undefined;
    if (current?.lease_state !== 'ACTIVE' || current.lease_attempt_id !== input.attemptId
      || current.lease_user_id !== input.userId || current.lease_repo !== input.repo) throw error;
  }
}

/** Bind a returned physical handle without altering whether the lease is fenced. */
export function leaseHandleUpdate(taskId: string, attemptId: string, microvmId: string) {
  return {
    Update: {
      TableName: TABLE,
      Key: workerLeaseKey(taskId),
      UpdateExpression: 'SET lease_microvm_id = :id',
      ConditionExpression: 'lease_attempt_id = :attempt AND '
        + '(attribute_not_exists(lease_microvm_id) OR lease_microvm_id = :id)',
      ExpressionAttributeValues: { ':attempt': attemptId, ':id': microvmId },
    },
  };
}
