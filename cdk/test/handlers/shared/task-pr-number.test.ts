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

// `readTaskPrNumber` is the deduped replacement for two copies that swallowed a
// failed TaskRecord read into a bare `null` (#756 Cat 2), which the restack
// cascade then read as "dependent has no PR yet — skip". The behaviour that
// matters is therefore the *shape* on each path: found vs genuinely-absent vs
// read-failed, never absent-because-it-broke.

import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isLookupAbsent, isLookupFailure } from '../../../src/handlers/shared/lookup-result';
import { prNumberFromTask, readTaskPrNumber } from '../../../src/handlers/shared/task-pr-number';

/** Minimal doc-client stub: only `send` is exercised. */
const ddbWith = (impl: jest.Mock): DynamoDBDocumentClient =>
  ({ send: impl } as unknown as DynamoDBDocumentClient);

const resolving = (Item?: Record<string, unknown>) => jest.fn().mockResolvedValue({ Item });

// One rule for every reader of a task's PR: the Linear and Jira comment paths,
// the terminal reply of an iteration and `readTaskPrNumber` below.
describe('prNumberFromTask', () => {
  test.each([
    ['the numeric pr_number', { pr_number: 12 }, 12],
    ['pr_number before pr_url', { pr_number: 7, pr_url: 'https://github.com/o/r/pull/9' }, 7],
    ['the number in pr_url', { pr_url: 'https://github.com/o/r/pull/123' }, 123],
    ['the number in a pr_url that goes on', { pr_url: 'https://github.com/o/r/pull/99/files' }, 99],
    ['pr_url when pr_number is not a PR number', { pr_number: 0, pr_url: 'https://github.com/o/r/pull/8' }, 8],
  ])('returns %s', (_what, task, expected) => {
    expect(prNumberFromTask(task)).toBe(expected);
  });

  test.each([
    ['no PR fields', {}],
    ['a pr_url without /pull/<n>', { pr_url: 'https://github.com/o/r/tree/main' }],
    ['a pr_number of 0', { pr_number: 0, pr_url: 'not-a-pr' }],
    ['a negative pr_number', { pr_number: -1 }],
    ['a fractional pr_number', { pr_number: 1.5 }],
    ['/pull/0', { pr_url: 'https://github.com/o/r/pull/0' }],
    ['a number too large to be exact', { pr_url: 'https://github.com/o/r/pull/99999999999999999999' }],
  ])('returns null for %s', (_what, task) => {
    expect(prNumberFromTask(task)).toBeNull();
  });
});

describe('readTaskPrNumber', () => {
  test('reads the numeric pr_number by task id', async () => {
    const send = resolving({ pr_number: 42 });

    await expect(readTaskPrNumber(ddbWith(send), 'tasks', 'task-1'))
      .resolves.toEqual({ ok: true, value: 42 });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input).toEqual({ TableName: 'tasks', Key: { task_id: 'task-1' } });
  });

  test('falls back to parsing pr_url when pr_number is absent', async () => {
    // Orchestration child tasks commonly persist only pr_url — the case the two
    // original copies existed to handle.
    const send = resolving({ pr_url: 'https://github.com/o/r/pull/1234' });

    await expect(readTaskPrNumber(ddbWith(send), 'tasks', 'task-1'))
      .resolves.toEqual({ ok: true, value: 1234 });
  });

  test('prefers pr_number over pr_url when both are present', async () => {
    const send = resolving({ pr_number: 7, pr_url: 'https://github.com/o/r/pull/9' });

    await expect(readTaskPrNumber(ddbWith(send), 'tasks', 'task-1'))
      .resolves.toEqual({ ok: true, value: 7 });
  });

  test('parses pr_url even when pr_number is explicitly null', async () => {
    const send = resolving({ pr_number: null, pr_url: 'https://github.com/o/r/pull/8' });

    await expect(readTaskPrNumber(ddbWith(send), 'tasks', 'task-1'))
      .resolves.toEqual({ ok: true, value: 8 });
  });

  test('reports ABSENT when the task exists but has no PR yet', async () => {
    const r = await readTaskPrNumber(ddbWith(resolving({ task_id: 'task-1' })), 'tasks', 'task-1');

    expect(isLookupAbsent(r)).toBe(true);
    expect(isLookupFailure(r)).toBe(false);
  });

  test('reports ABSENT when there is no such task row', async () => {
    const r = await readTaskPrNumber(ddbWith(resolving(undefined)), 'tasks', 'missing');

    expect(isLookupAbsent(r)).toBe(true);
  });

  test('reports ABSENT when pr_url carries no /pull/<n> segment', async () => {
    // A non-PR URL is a genuine "no PR number here", not a broken read.
    const send = resolving({ pr_url: 'https://github.com/o/r/commit/abc123' });
    const r = await readTaskPrNumber(ddbWith(send), 'tasks', 'task-1');

    expect(isLookupAbsent(r)).toBe(true);
  });

  test('reports ABSENT when pr_url is a non-string (malformed row)', async () => {
    const r = await readTaskPrNumber(ddbWith(resolving({ pr_url: 12 })), 'tasks', 'task-1');

    expect(isLookupAbsent(r)).toBe(true);
  });

  test('reports ABSENT when pr_number is not a PR number (0) and there is no pr_url', async () => {
    // PR #0 does not exist: handed on, the restack cascade would ask task creation for it and be refused.
    const r = await readTaskPrNumber(ddbWith(resolving({ pr_number: 0 })), 'tasks', 'task-1');

    expect(isLookupAbsent(r)).toBe(true);
  });

  test('reports FAILURE, not absence, when the DynamoDB read throws', async () => {
    // The regression this module exists to prevent: an outage must never read as
    // "no PR yet" to the restack cascade.
    const err = new Error('ProvisionedThroughputExceededException');
    const send = jest.fn().mockRejectedValue(err);

    const r = await readTaskPrNumber(ddbWith(send), 'tasks', 'task-1');

    expect(isLookupFailure(r)).toBe(true);
    expect(isLookupAbsent(r)).toBe(false);
    expect(r).toEqual({ ok: false, error: err });
  });

  test('never throws — the failure is always returned as a result', async () => {
    const send = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(readTaskPrNumber(ddbWith(send), 'tasks', 'task-1')).resolves.toBeDefined();
  });
});
