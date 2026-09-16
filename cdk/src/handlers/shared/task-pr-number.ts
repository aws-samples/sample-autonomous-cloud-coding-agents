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
 * Read a task's PR number from its TaskRecord. Prefers the numeric
 * ``pr_number``; orchestration child tasks commonly persist only ``pr_url``
 * (``.../pull/N``) with ``pr_number`` null — fall back to parsing it.
 *
 * Deduplicated from the byte-for-byte-equivalent copies that previously lived
 * in orchestration-reconciler (``resolvePrNumber``) and linear-webhook-processor
 * (``resolveChildPrNumber``) — both swallowed the read failure into a bare
 * ``null`` (#756 Cat 2). Returns a {@link LookupResult} so callers can tell
 * "dependent has no PR yet" (absent) from "the TaskRecord read broke" (error):
 * the restack cascade must not misreport an outage as "no PR — skipping".
 *
 * This helper deliberately does NOT log the failure itself: the cause travels in
 * the result, and every caller holds orchestration/task context worth logging
 * alongside it (all four current callers do). That makes logging a **caller
 * obligation** — a caller that neither logs the failure nor branches on
 * ``isLookupFailure`` re-creates the silent drop this extraction removed.
 */
export async function readTaskPrNumber(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
): Promise<LookupResult<number>> {
  try {
    const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { task_id: taskId } }));
    const pr = res.Item?.pr_number;
    if (typeof pr === 'number') return lookupFound(pr);
    const url = res.Item?.pr_url;
    if (typeof url === 'string') {
      const m = url.match(/\/pull\/(\d+)\b/);
      if (m) return lookupFound(Number(m[1]));
    }
    return LOOKUP_ABSENT;
  } catch (err) {
    return lookupFailed(err);
  }
}
