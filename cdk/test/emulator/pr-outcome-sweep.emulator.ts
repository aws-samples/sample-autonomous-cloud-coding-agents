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

import { randomUUID } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { RepoTable } from '../../src/constructs/repo-table';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { type TaskStatusType } from '../../src/constructs/task-status';
import { TaskTable } from '../../src/constructs/task-table';

const run = randomUUID().slice(0, 8);
process.env.TASK_TABLE_NAME = `emu-${run}-pr-outcome-tasks`;
process.env.TASK_EVENTS_TABLE_NAME = `emu-${run}-pr-outcome-events`;
process.env.REPO_TABLE_NAME = `emu-${run}-pr-outcome-repos`;
process.env.TASK_STATUS_INDEX_NAME = TaskTable.STATUS_INDEX;
// Secrets Manager takes the name of a secret where it takes its ARN.
process.env.GITHUB_TOKEN_SECRET_ARN = `emu-${run}-github-token`;

import { handler as createTask } from '../../src/handlers/create-task';
import { INTEGRATION_NODE_SUFFIX } from '../../src/handlers/shared/orchestration-integration-node';
import { transitionTask } from '../../src/handlers/shared/orchestrator';
import { finalStateUpdate, firstStateUpdate } from '../../src/handlers/shared/pr-outcome';
import type { TaskRecord } from '../../src/handlers/shared/types';
import { makeClient, makeDocClient } from '../../src/handlers/shared/ua';
import { handler } from '../../src/handlers/sweep-pr-outcomes';
import { apiEvent, emulatorTables } from './harness';

const REPO = 'acme/widgets';
const TOKEN = 'token-held-by-the-emulator';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_S = 90 * 24 * 3600;
/** A page of an index holds 1 MB of whole records: five of 300 KB need a second one. */
const LARGE_TASKS = 5;
const LARGE_TASK_BYTES = 300 * 1024;
const PAGING_TIMEOUT_MS = 30_000;

const ddb = makeDocClient();
const secrets = makeClient(SecretsManagerClient);
const context = { getRemainingTimeInMillis: () => 5 * MINUTE_MS } as Context;

const platformStamp = (ms: number): string => new Date(ms).toISOString();
const wholeSecondStamp = (ms: number): string => platformStamp(ms).replace(/\.\d{3}Z$/, 'Z');

type PullRequest = Record<string, unknown>;

const pullRequests = new Map<number, PullRequest>();
let nextNumber = 1;

const openedBy = (taskId: string, fields: PullRequest = {}): PullRequest => ({
  state: 'OPEN',
  mergedAt: null,
  closedAt: null,
  headRefName: `bgagent/${taskId}/add-a-retry`,
  isCrossRepository: false,
  author: { login: 'abca-agent' },
  reviews: { nodes: [] },
  ...fields,
});

const review = (state: string, submittedAt: string, login: string) =>
  ({ state, submittedAt, authorCanPushToRepository: true, author: { login, __typename: 'User' } });

function answer(number: number): Response {
  const pullRequest = pullRequests.get(number);
  const body = pullRequest
    ? { data: { rateLimit: { remaining: 4990 }, repository: { pullRequest } } }
    : {
      data: { rateLimit: { remaining: 4990 }, repository: { pullRequest: null } },
      errors: [{
        type: 'NOT_FOUND',
        path: ['repository', 'pullRequest'],
        locations: [{ line: 4, column: 5 }],
        message: `Could not resolve to a PullRequest with the number of ${number}.`,
      }],
    };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function seedTask(fields: Partial<TaskRecord> = {}): Promise<{ task: TaskRecord; number: number }> {
  const number = nextNumber++;
  const taskId = `task-${randomUUID()}`;
  const status: TaskStatusType = fields.status ?? 'COMPLETED';
  const createdAtMs = Math.floor(Date.now() / 1000) * 1000 - 2 * DAY_MS;
  const finishedAt = wholeSecondStamp(createdAtMs + 24 * MINUTE_MS);
  const task: TaskRecord = {
    task_id: taskId,
    user_id: `user-${randomUUID()}`,
    status,
    repo: REPO,
    resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
    branch_name: `bgagent/${taskId}/add-a-retry`,
    channel_source: 'api',
    status_created_at: `${status}#${finishedAt}`,
    created_at: platformStamp(createdAtMs),
    started_at: platformStamp(createdAtMs + 41 * 1000),
    completed_at: finishedAt,
    updated_at: finishedAt,
    ttl: Math.floor(createdAtMs / 1000) + RETENTION_S,
    pr_url: `https://github.com/${REPO}/pull/${number}`,
    build_passed: true,
    cost_usd: '3.87',
    ...fields,
  };
  const Item = Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined));
  await ddb.send(new PutCommand({ TableName: process.env.TASK_TABLE_NAME, Item }));
  return { task, number };
}

async function storedTask(taskId: string): Promise<Record<string, unknown> | undefined> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: process.env.TASK_TABLE_NAME,
    Key: { task_id: taskId },
    ConsistentRead: true,
  }));
  return Item;
}

async function storedEvents(taskId: string): Promise<Record<string, unknown>[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: process.env.TASK_EVENTS_TABLE_NAME,
    KeyConditionExpression: 'task_id = :task_id',
    ExpressionAttributeValues: { ':task_id': taskId },
    ConsistentRead: true,
  }));
  return Items ?? [];
}

async function sweep(): Promise<{ asked: number[]; lines: Record<string, unknown>[]; stopped: unknown }> {
  const github = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    answer((JSON.parse(init?.body as string).variables as { number: number }).number));
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await handler({}, context);
    const written = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([chunk]) => String(chunk))
      .filter((text) => text.startsWith('{'))
      .map((text) => JSON.parse(text) as Record<string, unknown>);
    for (const [url, init] of github.mock.calls) {
      expect(url).toBe('https://api.github.com/graphql');
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
    return {
      asked: github.mock.calls.map(([, init]) => (JSON.parse(init?.body as string).variables as { number: number }).number),
      lines: written.filter((line) => '_aws' in line),
      stopped: written.find((line) => line.message === 'PR outcome sweep summary')?.stopped,
    };
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
    github.mockRestore();
  }
}

describe('pull-request outcome sweep against the AWS Emulator', () => {
  emulatorTables((stack) => {
    new TaskTable(stack, 'Tasks', { tableName: process.env.TASK_TABLE_NAME });
    new TaskEventsTable(stack, 'Events', { tableName: process.env.TASK_EVENTS_TABLE_NAME });
    new RepoTable(stack, 'Repos', { tableName: process.env.REPO_TABLE_NAME });
  }, async () => {
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: process.env.REPO_TABLE_NAME,
      Item: { repo: REPO, status: 'active', onboarded_at: now, updated_at: now },
    }));
    await secrets.send(new CreateSecretCommand({ Name: process.env.GITHUB_TOKEN_SECRET_ARN, SecretString: TOKEN }));
  });

  afterAll(async () => {
    await secrets.send(new DeleteSecretCommand({ SecretId: process.env.GITHUB_TOKEN_SECRET_ARN, ForceDeleteWithoutRecovery: true }));
    secrets.destroy();
  });

  test('a task as the platform writes it is followed to its merge: its branch is the one GitHub names, and its retention stays', async () => {
    const user = `user-${randomUUID()}`;
    const created = await createTask(apiEvent(user, {
      httpMethod: 'POST',
      body: JSON.stringify({ repo: REPO, workflow_ref: 'coding/new-task-v1', task_description: 'Add a health check endpoint' }),
    }));
    expect(created.statusCode).toBe(201);
    const taskId: string = JSON.parse(created.body).data.task_id;
    await transitionTask(taskId, 'SUBMITTED', 'HYDRATING');
    await transitionTask(taskId, 'HYDRATING', 'RUNNING');
    await transitionTask(taskId, 'RUNNING', 'FINALIZING');
    const number = nextNumber++;
    await transitionTask(taskId, 'FINALIZING', 'COMPLETED', {
      completed_at: wholeSecondStamp(Date.now()),
      pr_url: `https://github.com/${REPO}/pull/${number}`,
      build_passed: true,
    });
    const finished = await storedTask(taskId);
    expect(finished).toMatchObject({ status: 'COMPLETED', ttl: expect.any(Number), branch_name: expect.stringContaining(taskId) });
    const pullRequest = { ...openedBy(taskId), headRefName: finished?.branch_name };
    pullRequests.set(number, pullRequest);

    const first = await sweep();

    expect(first.asked).toContain(number);
    expect(await storedTask(taskId)).toEqual({ ...finished, pr_state: 'open' });

    const mergedAt = wholeSecondStamp(Date.now());
    pullRequests.set(number, { ...pullRequest, state: 'MERGED', mergedAt, closedAt: mergedAt });

    const second = await sweep();

    expect(await storedTask(taskId)).toEqual({ ...finished, pr_state: 'merged', pr_closed_at: mergedAt, pr_changes_requested: 0 });
    expect(second.lines.filter((line) => line.task_id === taskId)).toMatchObject([{
      _aws: { Timestamp: Date.parse(mergedAt) },
      PrOutcome: 'merged',
      PullRequestsResolved: 1,
      user_id: user,
      repo: REPO,
      workflow: 'coding/new-task-v1',
    }]);
  });

  test('a pull request found open is recorded as open once, and reading it again writes nothing', async () => {
    const { task, number } = await seedTask();
    pullRequests.set(number, openedBy(task.task_id));

    const first = await sweep();

    expect(first.stopped).toBe('none');
    expect(first.asked).toContain(number);
    const recorded = await storedTask(task.task_id);
    expect(recorded).toEqual({ ...task, pr_state: 'open' });

    const second = await sweep();
    expect(second.asked).toContain(number);
    expect(await storedTask(task.task_id)).toEqual(recorded);
    await expect(ddb.send(new UpdateCommand(firstStateUpdate(process.env.TASK_TABLE_NAME!, task.task_id, 'open'))))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await storedTask(task.task_id)).toEqual(recorded);
    expect([...first.lines, ...second.lines].filter((line) => line.task_id === task.task_id)).toEqual([]);
  });

  test('a pull request recorded as open and then merged gets the four fields, one line and one event, and nothing else on its record moves', async () => {
    const { task, number } = await seedTask();
    pullRequests.set(number, openedBy(task.task_id));
    await sweep();
    expect(await storedTask(task.task_id)).toMatchObject({ pr_state: 'open' });

    const mergedAtMs = Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR_MS;
    const mergedAt = wholeSecondStamp(mergedAtMs);
    const firstReviewAt = wholeSecondStamp(mergedAtMs - 5 * HOUR_MS);
    pullRequests.set(number, openedBy(task.task_id, {
      state: 'MERGED',
      mergedAt,
      closedAt: mergedAt,
      reviews: {
        nodes: [
          review('CHANGES_REQUESTED', firstReviewAt, 'octocat'),
          review('COMMENTED', wholeSecondStamp(mergedAtMs - 4 * HOUR_MS), 'abca-agent'),
          review('APPROVED', wholeSecondStamp(mergedAtMs - HOUR_MS), 'octocat'),
        ],
      },
    }));

    const merged = await sweep();

    expect(merged.asked).toContain(number);
    const recorded = await storedTask(task.task_id);
    expect(recorded).toEqual({
      ...task,
      pr_state: 'merged',
      pr_closed_at: mergedAt,
      pr_first_review_at: firstReviewAt,
      pr_changes_requested: 1,
    });
    expect(merged.lines.filter((line) => line.task_id === task.task_id)).toMatchObject([{
      _aws: { Timestamp: mergedAtMs },
      PrOutcome: 'merged',
      PullRequestsResolved: 1,
      TimeToMergeSeconds: (mergedAtMs - Date.parse(task.created_at)) / 1000,
      user_id: task.user_id,
      repo: REPO,
      workflow: 'coding/new-task-v1',
    }]);
    const outcomeEvents = (await storedEvents(task.task_id)).filter((event) => event.event_type === 'pr_outcome_recorded');
    expect(outcomeEvents).toEqual([{
      task_id: task.task_id,
      event_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      event_type: 'pr_outcome_recorded',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      ttl: expect.any(Number),
      user_id: task.user_id,
      repo: REPO,
      metadata: { pr_state: 'merged', pr_closed_at: mergedAt, pr_first_review_at: firstReviewAt, pr_changes_requested: 1 },
    }]);
    expect(Math.abs((outcomeEvents[0].ttl as number) - (Date.now() / 1000 + RETENTION_S))).toBeLessThan(MINUTE_MS / 1000);

    const after = await sweep();
    expect(after.asked).not.toContain(number);
    expect(after.lines.filter((line) => line.task_id === task.task_id)).toEqual([]);
    expect((await storedEvents(task.task_id)).filter((event) => event.event_type === 'pr_outcome_recorded')).toHaveLength(1);
    const closedLater = {
      state: 'closed' as const,
      headRef: task.branch_name,
      crossRepository: false,
      closedAt: wholeSecondStamp(mergedAtMs + HOUR_MS),
      firstReviewAt: null,
      changesRequested: 0,
    };
    await expect(ddb.send(new UpdateCommand(finalStateUpdate(process.env.TASK_TABLE_NAME!, task.task_id, closedLater))))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await storedTask(task.task_id)).toEqual(recorded);
  });

  test('a pull request found closed on its first read, with no review, is recorded without a first review', async () => {
    const { task, number } = await seedTask();
    const closedAtMs = Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR_MS;
    pullRequests.set(number, openedBy(task.task_id, { state: 'CLOSED', closedAt: wholeSecondStamp(closedAtMs) }));

    const { asked, lines } = await sweep();

    expect(asked).toContain(number);
    expect(await storedTask(task.task_id)).toEqual({
      ...task,
      pr_state: 'closed',
      pr_closed_at: wholeSecondStamp(closedAtMs),
      pr_changes_requested: 0,
    });
    const mine = lines.filter((line) => line.task_id === task.task_id);
    expect(mine).toMatchObject([{ _aws: { Timestamp: closedAtMs }, PrOutcome: 'closed', PullRequestsResolved: 1 }]);
    expect(mine[0]).not.toHaveProperty('TimeToMergeSeconds');
  });

  test('a pull request GitHub does not have as the task\'s is recorded as not found, with nothing else, and is not asked about again', async () => {
    const missing = await seedTask();
    const foreign = await seedTask();
    pullRequests.set(foreign.number, openedBy(`task-${randomUUID()}`, { state: 'MERGED', mergedAt: wholeSecondStamp(Date.now() - 2 * HOUR_MS) }));

    const first = await sweep();

    expect(first.asked).toEqual(expect.arrayContaining([missing.number, foreign.number]));
    for (const { task } of [missing, foreign]) {
      expect(await storedTask(task.task_id)).toEqual({ ...task, pr_state: 'not_found' });
      expect(first.lines.filter((line) => line.task_id === task.task_id)).toEqual([]);
      expect(await storedEvents(task.task_id)).toEqual([]);
    }

    const second = await sweep();
    expect(second.asked).not.toContain(missing.number);
    expect(second.asked).not.toContain(foreign.number);
    await expect(ddb.send(new UpdateCommand(firstStateUpdate(process.env.TASK_TABLE_NAME!, missing.task.task_id, 'not_found'))))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  test('the tasks whose pull request is not followed are not asked about and not touched, in a run that reads the others', async () => {
    const tasks = [
      await seedTask({ pr_url: undefined, build_passed: undefined, answer_text: 'Which environment should this deploy to?' }),
      await seedTask({ status: 'FAILED', error_message: 'Agent session ended without a result.' }),
      await seedTask({ pr_state: 'merged', pr_closed_at: wholeSecondStamp(Date.now() - DAY_MS), pr_changes_requested: 0 }),
      await seedTask({ channel_metadata: { orchestration_id: 'orch_1', orchestration_sub_issue_id: 'issue-1' }, build_passed: false }),
      await seedTask({ channel_metadata: { orchestration_id: 'orch_1', orchestration_sub_issue_id: `issue-1${INTEGRATION_NODE_SUFFIX}` } }),
    ];
    for (const { task, number } of tasks) pullRequests.set(number, openedBy(task.task_id));
    const followed = await seedTask();
    pullRequests.set(followed.number, openedBy(followed.task.task_id));

    const { asked, stopped } = await sweep();

    expect(stopped).toBe('none');
    expect(asked).toContain(followed.number);
    for (const { task, number } of tasks) {
      expect(asked).not.toContain(number);
      expect(await storedTask(task.task_id)).toEqual(task);
    }
  });

  test('a write for a task that the table does not hold is refused and creates no item', async () => {
    const taskId = `task-${randomUUID()}`;
    const merged = {
      state: 'merged' as const,
      headRef: `bgagent/${taskId}/add-a-retry`,
      crossRepository: false,
      closedAt: wholeSecondStamp(Date.now() - HOUR_MS),
      firstReviewAt: null,
      changesRequested: 0,
    };

    await expect(ddb.send(new UpdateCommand(firstStateUpdate(process.env.TASK_TABLE_NAME!, taskId, 'open'))))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    await expect(ddb.send(new UpdateCommand(finalStateUpdate(process.env.TASK_TABLE_NAME!, taskId, merged))))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await storedTask(taskId)).toBeUndefined();
  });

  test('candidates beyond the first page of the index are read', async () => {
    const large: { task: TaskRecord; number: number }[] = [];
    for (let i = 0; i < LARGE_TASKS; i++) {
      large.push(await seedTask({ task_description: 'x'.repeat(LARGE_TASK_BYTES) }));
    }
    for (const { task, number } of large) pullRequests.set(number, openedBy(task.task_id));
    const firstPage = await ddb.send(new QueryCommand({
      TableName: process.env.TASK_TABLE_NAME,
      IndexName: TaskTable.STATUS_INDEX,
      KeyConditionExpression: '#status = :completed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':completed': 'COMPLETED' },
      Select: 'COUNT',
    }));
    expect(firstPage.LastEvaluatedKey).toBeDefined();

    const { asked } = await sweep();

    expect(asked).toEqual(expect.arrayContaining(large.map(({ number }) => number)));
    for (const { task } of large) {
      expect(await storedTask(task.task_id)).toMatchObject({ task_id: task.task_id, pr_state: 'open' });
    }
  }, PAGING_TIMEOUT_MS);
});
