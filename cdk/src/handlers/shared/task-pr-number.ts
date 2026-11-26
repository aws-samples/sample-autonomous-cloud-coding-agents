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

import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type LookupResult, LOOKUP_ABSENT, lookupFailed, lookupFound } from './lookup-result';

/**
 * A task's PR number: the numeric ``pr_number`` (preferred), else the number in
 * ``pr_url`` (``.../pull/N``). Null when neither yields a positive integer.
 */
export function prNumberFromTask(task: { pr_number?: unknown; pr_url?: unknown }): number | null {
  if (
    typeof task.pr_number === 'number'
    && Number.isInteger(task.pr_number)
    && task.pr_number > 0
  ) {
    return task.pr_number;
  }
  if (typeof task.pr_url === 'string') {
    const match = task.pr_url.match(/\/pull\/(\d+)\b/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

/**
 * Read a task's PR number from its TaskRecord ({@link prNumberFromTask}).
 * Returns a {@link LookupResult}: absent when the task has no PR, error when
 * the TaskRecord read failed. Never throws, and does not log the failure: the
 * cause travels in the result.
 */
export async function readTaskPrNumber(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
): Promise<LookupResult<number>> {
  try {
    const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { task_id: taskId } }));
    const pr = prNumberFromTask(res.Item ?? {});
    return pr === null ? LOOKUP_ABSENT : lookupFound(pr);
  } catch (err) {
    return lookupFailed(err);
  }
}
