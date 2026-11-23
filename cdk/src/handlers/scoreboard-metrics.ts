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
 * redelivered, so a task is claimed before it is counted: one conditional put of a
 * marker in the budget table. That table has no stream this consumer reads, so the
 * claim is not delivered back as another record of the task. The line is built from
 * a consistent read of the task; the stream image only decides whether to claim.
 *
 * A line is written at most once per task. It is lost when the process dies between
 * the claim and the line, and when the SDK retries a claim whose response was lost
 * (the retry reads as "already claimed"). The marker is not released: a later
 * delivery of the same task finds it taken.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';
import { TERMINAL_STATUSES } from '../constructs/task-status';
import { BUDGET_METRICS_PERIOD, BUDGET_ROLLUP_RETENTION_DAYS, taskBudgetMarkerKey } from './shared/budgets';
import { finishTimeMs, taskFacts, taskMetricLine } from './shared/scoreboard';
import type { TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';

const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const BUDGET_TABLE_NAME = process.env.BUDGET_TABLE_NAME!;
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
 * line was written; false when the record is not one to count, when the table holds no
 * finished task, or when another delivery holds the claim. Throws when the read or the
 * claim fails for any other reason: the caller logs and counts that.
 */
export async function publishTaskMetrics(record: DynamoDBRecord): Promise<boolean> {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return false;
  const image = record.dynamodb?.NewImage;
  const taskId = image?.task_id?.S;
  const finished = TERMINAL_STATUSES.some((status) => status === image?.status?.S);
  if (!image || !taskId || !finished) return false;
  const nowMs = Date.now();
  // An image without a finish time is not too old (NaN compares false): the claim decides.
  const finishedAtMs = finishTimeMs({ completed_at: image.completed_at?.S, updated_at: image.updated_at?.S });
  if (nowMs - finishedAtMs > MAX_FINISH_AGE_MS) return false;

  // The read first: a stream image of a task the table does not hold claims nothing.
  const got = await ddb.send(new GetCommand({
    TableName: TASK_TABLE_NAME,
    Key: { task_id: taskId },
    ConsistentRead: true,
  }));
  const task = got.Item as TaskRecord | undefined;
  const facts = task && taskFacts(task);
  if (!task || !facts) return false;

  try {
    await ddb.send(new PutCommand({
      TableName: BUDGET_TABLE_NAME,
      Item: {
        scope_key: taskBudgetMarkerKey(taskId),
        period: BUDGET_METRICS_PERIOD,
        // Outlives the task record, so a rewrite of it during retention cannot count twice.
        ttl: Math.floor(nowMs / 1000) + BUDGET_ROLLUP_RETENTION_DAYS * 24 * 3600,
      },
      ConditionExpression: 'attribute_not_exists(scope_key)',
    }));
  } catch (err) {
    // Another delivery holds the claim: there is nothing to count.
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }

  const context = { user_id: task.user_id, repo: task.repo, workflow: task.resolved_workflow?.id };
  process.stdout.write(taskMetricLine(facts, context, nowMs) + '\n');
  return true;
}
