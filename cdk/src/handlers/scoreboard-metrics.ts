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

/**
 * Scoreboard step of the TaskTable stream consumer: one metric line per finished
 * task, in the `ABCA/Factory` namespace.
 *
 * A finished record is rewritten for as long as it lives and its stream records are
 * redelivered, so a task is claimed before it is counted: one conditional write of
 * `metrics_emitted_at` to the task's own record. That write returns the current
 * record, already unmarshalled, and the line is built from it; the stream image
 * only decides whether to claim.
 *
 * A line is written at most once per task. It is lost when the process dies between
 * the claim and the line, and when the SDK retries a claim whose response was lost
 * (the retry reads as "already claimed"). The claim is never released: a release is
 * a write to the stream's own table and wakes the consumer again.
 */

import { UpdateCommand, type UpdateCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';
import { TERMINAL_STATUSES } from '../constructs/task-status';
import { finishTimeMs, taskFacts, taskMetricLine } from './shared/scoreboard';
import type { TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';

const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const ddb = makeDocClient();

/**
 * The age past which a finish is not claimed. A stream keeps a record for 24 hours, so a
 * finish is first delivered within that time: an older one is a later rewrite of a task
 * that finished before this step was deployed, or whose first claim failed. CloudWatch
 * drops a timestamp older than 14 days, and a younger one would land as data from before
 * the deployment.
 */
const MAX_FINISH_AGE_MS = 24 * 3600 * 1000;

/**
 * Publish one finished task's facts to the metric stream, at most once per task. True when a
 * line was written; false when the record is not one to count, or when another delivery holds
 * the claim. Throws when the claim fails, and when it lands on a record that holds no
 * finished task: the caller logs and counts both.
 */
export async function publishTaskMetrics(record: DynamoDBRecord): Promise<boolean> {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return false;
  const image = record.dynamodb?.NewImage;
  const taskId = image?.task_id?.S;
  const finished = TERMINAL_STATUSES.some((status) => status === image?.status?.S);
  if (!image || !taskId || !finished || image.metrics_emitted_at) return false;
  const nowMs = Date.now();
  // An image without a finish time is not too old (NaN compares false): the claim decides.
  const finishedAtMs = finishTimeMs({ completed_at: image.completed_at?.S, updated_at: image.updated_at?.S });
  if (nowMs - finishedAtMs > MAX_FINISH_AGE_MS) return false;

  let claimed: UpdateCommandOutput;
  try {
    claimed = await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE_NAME,
      Key: { task_id: taskId },
      // Nothing else is set: `updated_at` is the finish time of a record without
      // `completed_at`, and `ttl` is the record's retention, stamped by the terminal
      // write or by the orchestrator after it.
      UpdateExpression: 'SET metrics_emitted_at = :now',
      ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(metrics_emitted_at)',
      ExpressionAttributeValues: { ':now': new Date(nowMs).toISOString() },
      ReturnValues: 'ALL_NEW',
    }));
  } catch (err) {
    // Another delivery holds the claim, or the task is gone: there is nothing to count.
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }

  const task = claimed.Attributes as TaskRecord | undefined;
  const facts = task && taskFacts(task);
  // The claim is spent and is never given back: a task that leaves the metrics here has to say so.
  if (!task || !facts) throw new Error('Scoreboard claim landed on a record that holds no finished task');
  const context = { user_id: task.user_id, repo: task.repo, workflow: task.resolved_workflow?.id };
  process.stdout.write(taskMetricLine(facts, context, nowMs) + '\n');
  return true;
}
