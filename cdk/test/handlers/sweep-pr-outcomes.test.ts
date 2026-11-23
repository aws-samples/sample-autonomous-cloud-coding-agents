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

import { PutCommand, QueryCommand, type PutCommandInput, type UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';

// DynamoDB is the only AWS service the handler calls itself. GitHub is the `fetch` stub
// below: the read of a pull request runs as it is, on answers as GitHub gives them.
const sendMock = jest.fn();
jest.mock('../../src/handlers/shared/ua', () => ({
  ...jest.requireActual('../../src/handlers/shared/ua'),
  makeDocClient: () => ({ send: sendMock }),
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

// Everything of the module but the call to Secrets Manager: the failures below are the resolver's own errors.
const resolveGitHubTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  ...jest.requireActual('../../src/handlers/shared/context-hydration'),
  resolveGitHubToken: (...args: unknown[]) => resolveGitHubTokenMock(...args),
}));

// The handler reads its configuration when it loads.
const TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:GitHubTokenSecret-AbCdEf';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_STATUS_INDEX_NAME = 'StatusIndexOfTheStack';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.GITHUB_TOKEN_SECRET_ARN = TOKEN_SECRET_ARN;

import { TaskStatus } from '../../src/constructs/task-status';
import { MissingSecretError, SecretUnreadableError } from '../../src/handlers/shared/context-hydration';
import { formatBlockerReason } from '../../src/handlers/shared/error-classifier';
import { INTEGRATION_NODE_SUFFIX } from '../../src/handlers/shared/orchestration-integration-node';
import { emitTaskEvent } from '../../src/handlers/shared/orchestrator';
import { SCOREBOARD_PROJECTION } from '../../src/handlers/shared/scoreboard';
import type { TaskRecord } from '../../src/handlers/shared/types';
import { handler } from '../../src/handlers/sweep-pr-outcomes';

const TOKEN = 'platform-token-value';
/**
 * The hour of this time is a multiple of 60 since the epoch, so a run of up to six candidates
 * starts at the first of them by task id: the tests below can name the order of reads. A test
 * with more candidates asserts which pull requests were read, not in which order: the start is
 * then another one, and `task-100` sorts before `task-12`.
 */
const NOW = Date.parse('2026-11-18T00:20:00.000Z');
const SECOND_MS = 1000;
const HOUR_MS = 3600 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;

/** ISO time `ms` milliseconds before NOW, in whole seconds as GitHub writes one. */
const ago = (ms: number): string => new Date(NOW - ms).toISOString().replace('.000Z', 'Z');

/** What EventBridge sends on a schedule; the handler does not read it. */
const EVENT = { 'source': 'aws.events', 'detail-type': 'Scheduled Event' };
/** A Lambda context with five minutes left at every reading. */
const context = { getRemainingTimeInMillis: () => 300_000 } as Context;

/**
 * A whole task record, `task-<number>`: new work that ended in pull request `number` of its
 * repository, which nobody has read yet. The candidate query returns such records.
 */
function task(number: number, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const repo = overrides.repo ?? 'acme/widgets';
  return {
    task_id: `task-${number}`,
    user_id: 'user-1',
    status: TaskStatus.COMPLETED,
    repo,
    resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
    workflow_ref: 'coding/new-task-v1',
    branch_name: `bgagent/task-${number}/add-a-retry`,
    channel_source: 'api',
    status_created_at: 'COMPLETED#2026-11-16T10:24:00Z',
    created_at: '2026-11-16T10:00:00.000Z',
    started_at: '2026-11-16T10:00:41.000Z',
    completed_at: '2026-11-16T10:24:00Z',
    updated_at: '2026-11-16T10:24:00Z',
    ttl: 1_802_600_000,
    pr_url: `https://github.com/${repo}/pull/${number}`,
    build_passed: true,
    cost_usd: '3.87',
    ...overrides,
  };
}

/** An answer of GitHub's GraphQL endpoint: JSON, with the status. */
const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

type Answer = () => Response;

/**
 * The pull request of `task-<number>` as GitHub returns it: open, opened by ABCA's account
 * from the task's branch in the repository itself, not reviewed. `remaining` is what GitHub
 * says is left of the token's budget; null leaves it out of the answer.
 */
const found = (number: number, fields: Record<string, unknown> = {}, remaining: number | null = 4990): Answer => () => answer({
  data: {
    ...(remaining !== null && { rateLimit: { remaining } }),
    repository: {
      pullRequest: {
        state: 'OPEN',
        mergedAt: null,
        closedAt: null,
        headRefName: `bgagent/task-${number}/add-a-retry`,
        isCrossRepository: false,
        author: { login: 'abca-agent' },
        reviews: { nodes: [] },
        ...fields,
      },
    },
  },
});

/** A review as GitHub returns it, by an account that can push to the repository. */
const review = (state: string, submittedAt: string, login: string) =>
  ({ state, submittedAt, authorCanPushToRepository: true, author: { login, __typename: 'User' } });

/** Merged a day after the task was created, sent back once and then approved by one person. */
const MERGED = {
  state: 'MERGED',
  mergedAt: '2026-11-17T10:00:00Z',
  closedAt: '2026-11-17T10:00:01Z',
  reviews: {
    nodes: [
      review('CHANGES_REQUESTED', '2026-11-16T16:24:00Z', 'octocat'),
      review('COMMENTED', '2026-11-16T17:00:00Z', 'abca-agent'),
      review('APPROVED', '2026-11-17T09:30:00Z', 'octocat'),
    ],
  },
};
/** What the final write of that merge leaves on the record. */
const MERGED_FIELDS: Partial<TaskRecord> = {
  pr_state: 'merged',
  pr_closed_at: '2026-11-17T10:00:00Z',
  pr_first_review_at: '2026-11-16T16:24:00Z',
  pr_changes_requested: 1,
};

const REPOSITORY_NOT_FOUND: Answer = () => answer({
  data: { rateLimit: { remaining: 4980 }, repository: null },
  errors: [{
    type: 'NOT_FOUND',
    path: ['repository'],
    locations: [{ line: 3, column: 3 }],
    message: "Could not resolve to a Repository with the name 'acme/private'.",
  }],
});
const PULL_REQUEST_NOT_FOUND: Answer = () => answer({
  data: { rateLimit: { remaining: 4980 }, repository: { pullRequest: null } },
  errors: [{
    type: 'NOT_FOUND',
    path: ['repository', 'pullRequest'],
    locations: [{ line: 4, column: 5 }],
    message: 'Could not resolve to a PullRequest with the number of 12.',
  }],
});
const QUERY_FAILED: Answer = () => answer({
  data: null,
  errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `C0DE:1F2E3D:4C5B6A:7F8E9D:691F0A2B` when reporting this issue.' }],
});
const BAD_CREDENTIALS: Answer = () =>
  answer({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql', status: '401' }, 401);
/** A 200 that asks to wait, in a body that is no JSON: the header alone says it. */
const ASKS_TO_WAIT: Answer = () =>
  new Response('<html><body>Please wait a few minutes before you try again.</body></html>', { status: 200, headers: { 'retry-after': '60' } });
/** Three ways GitHub gives a read no usable answer: it gives up on the query, it does not answer in time, something else answers in its place. */
const SERVER_ERROR: Answer = () => answer({
  data: null,
  errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `C0DE:1F2E3D:4C5B6A:7F8E9D:691F0A2B` when reporting this issue.' }],
}, 502);
const TIMES_OUT: Answer = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
const NOT_JSON: Answer = () => new Response('<html><body>Sign in to the proxy of octocat</body></html>', { status: 200 });

let fetchMock: jest.SpiedFunction<typeof fetch>;
let stdout: jest.SpiedFunction<typeof process.stdout.write>;
/** The answer of the table to each update; nothing by default, as an update that returns no values answers. */
const updateMock = jest.fn();
/** The answer of the events table to each event that is put there. */
const eventMock = jest.fn();

/** GitHub, as far as the sweep asks: an answer per pull-request number. A number without one gets no answer, as from a network that is down. */
function github(answers: Record<number, Answer>): void {
  fetchMock.mockImplementation(async (_url, init) => {
    const { number } = JSON.parse(init?.body as string).variables as { number: number };
    if (!(number in answers)) throw new TypeError(`no answer is stubbed for pull request ${number}`);
    return answers[number]();
  });
}

/** The pull-request numbers GitHub was asked about, in the order of the requests. */
const asked = (): number[] => fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string).variables.number);

/** The tables: the pages of the candidate query in turn, `updateMock` for every update and `eventMock` for every event. */
function table(...pages: { Items: TaskRecord[]; ScannedCount: number; LastEvaluatedKey?: Record<string, unknown> }[]): void {
  const queue = [...pages];
  sendMock.mockImplementation(async (command: QueryCommand | UpdateCommand | PutCommand) => {
    if (command instanceof QueryCommand) return queue.shift();
    return command instanceof PutCommand ? eventMock(command.input) : updateMock(command.input);
  });
}

/** A table whose candidate query returns `tasks` in one page. */
const candidates = (...tasks: TaskRecord[]): void => table({ Items: tasks, ScannedCount: tasks.length });

/** The inputs of the updates the run sent, in order. */
const updates = (): UpdateCommandInput[] => updateMock.mock.calls.map(([input]) => input);

/** The inputs of the events the run put, in order. */
const events = (): PutCommandInput[] => eventMock.mock.calls.map(([input]) => input);

/** A DynamoDB error as the SDK throws it: the name tells the kind. */
const ddbError = (name: string): Error => Object.assign(new Error(name), { name });

/** The run's summary line: its level and its fields. */
function summary(): { level: string; data: Record<string, unknown> } {
  const lines = (['info', 'warn', 'error'] as const).flatMap((level) => loggerMock[level].mock.calls
    .filter(([message]) => message === 'PR outcome sweep summary')
    .map(([, data]) => ({ level, data })));
  expect(lines).toHaveLength(1);
  return lines[0];
}

/** The fields of a summary line of a run that found nothing to do, with `counts` in place. */
const counted = (counts: Record<string, unknown>): Record<string, unknown> => ({
  scanned: 0,
  candidates: 0,
  read: 0,
  merged: 0,
  closed: 0,
  open: 0,
  repo_not_visible: 0,
  pr_not_found: 0,
  failed: 0,
  left_out: 0,
  not_emitted: 0,
  stopped: 'none',
  ...counts,
});

/** The metric lines the run wrote, parsed. */
const lines = (): Record<string, unknown>[] => stdout.mock.calls.map(([chunk]) => JSON.parse(chunk as string));

beforeEach(() => {
  sendMock.mockReset();
  updateMock.mockReset().mockResolvedValue({});
  eventMock.mockReset().mockResolvedValue({});
  resolveGitHubTokenMock.mockReset().mockResolvedValue(TOKEN);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // A read without a stubbed answer fails here, and never reaches the network.
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('no answer is stubbed'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the candidates', () => {
  test('are read from every page of the COMPLETED tasks in the status index, filtered to pull requests without a final state', async () => {
    const firstKey = { task_id: 'task-12', status: 'COMPLETED', created_at: '2026-11-16T10:00:00.000Z' };
    const secondKey = { task_id: 'task-800', status: 'COMPLETED', created_at: '2026-11-17T08:00:00.000Z' };
    table(
      { Items: [task(12)], ScannedCount: 400, LastEvaluatedKey: firstKey },
      // A page whose records the filter all removed still has a next page.
      { Items: [], ScannedCount: 400, LastEvaluatedKey: secondKey },
      { Items: [task(13)], ScannedCount: 12 },
    );
    github({ 12: found(12), 13: found(13) });

    await handler(EVENT, context);

    const queries = sendMock.mock.calls.map(([command]) => command).filter((command) => command instanceof QueryCommand);
    expect(queries).toHaveLength(3);
    const firstPage = {
      TableName: 'Tasks',
      IndexName: 'StatusIndexOfTheStack',
      KeyConditionExpression: '#status = :completed',
      FilterExpression: 'attribute_exists(pr_url) AND (attribute_not_exists(pr_state) OR pr_state = :open)',
      ExpressionAttributeValues: { ':completed': 'COMPLETED', ':open': 'open' },
      ...SCOREBOARD_PROJECTION,
    };
    expect(queries.map((query) => query.input)).toEqual([
      firstPage,
      { ...firstPage, ExclusiveStartKey: firstKey },
      { ...firstPage, ExclusiveStartKey: secondKey },
    ]);
    // What the read cannot do without: the key of the write, and where the pull request is.
    expect(firstPage.ExpressionAttributeNames).toMatchObject({ '#status': 'status', '#task_id': 'task_id', '#repo': 'repo', '#pr_url': 'pr_url', '#pr_number': 'pr_number', '#pr_state': 'pr_state' });
    expect(asked()).toEqual([12, 13]);
    expect(summary().data).toMatchObject({ scanned: 812, candidates: 2, read: 2 });
  });

  test('are the pull requests the sweep follows, not every task the filter lets through: the others are neither read nor written', async () => {
    candidates(
      task(12),
      // Finished tasks with a pull request of another kind: a follow-up on pull request 12,
      // and the tasks of an orchestration, a sub-task whose build failed and the node that combines them.
      task(13, { resolved_workflow: { id: 'coding/pr-iteration-v1', version: '1.0.0' }, workflow_ref: undefined, pr_number: 12 }),
      task(14, { channel_metadata: { orchestration_id: 'orch_1', orchestration_sub_issue_id: 'issue-1' }, build_passed: false }),
      task(15, { channel_metadata: { orchestration_id: 'orch_1', orchestration_sub_issue_id: `issue-1${INTEGRATION_NODE_SUFFIX}` } }),
    );
    github({ 12: found(12) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12]);
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-12' }]);
    expect(summary().data).toMatchObject({ scanned: 4, candidates: 1, read: 1 });
  });

  test('without one, the run ends with its summary: no token, no request, no write', async () => {
    table({ Items: [], ScannedCount: 57 });

    await handler(EVENT, context);

    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 57 }) });
  });

  test('a query that fails fails the run, before anything is read', async () => {
    sendMock.mockRejectedValue(ddbError('ProvisionedThroughputExceededException'));

    await expect(handler(EVENT, context)).rejects.toThrow('ProvisionedThroughputExceededException');

    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the token', () => {
  test('is the platform token, taken once from the secret the environment names, and sent to GitHub as a bearer', async () => {
    candidates(task(12), task(13));
    github({ 12: found(12), 13: found(13) });
    // As a secret holds it that was stored from a file: a byte-order mark in front, a line end after.
    resolveGitHubTokenMock.mockResolvedValue(`${String.fromCharCode(0xfeff)}${TOKEN}\n`);

    await handler(EVENT, context);

    expect(resolveGitHubTokenMock).toHaveBeenCalledTimes(1);
    expect(resolveGitHubTokenMock).toHaveBeenCalledWith(TOKEN_SECRET_ARN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.github.com/graphql');
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
  });

  test.each<[string, Error, string | undefined]>([
    [
      'is empty',
      new MissingSecretError(formatBlockerReason('missing_secret', 'the required GitHub token secret is empty', TOKEN_SECRET_ARN)),
      undefined,
    ],
    [
      'cannot be read',
      new SecretUnreadableError(formatBlockerReason('auth_failure', 'the required GitHub token secret could not be read', TOKEN_SECRET_ARN), {
        cause: Object.assign(new Error('The function is not authorized to perform: secretsmanager:GetSecretValue'), { name: 'AccessDeniedException' }),
      }),
      'AccessDeniedException',
    ],
  ])('a secret that %s ends the run with an error, which names its cause when it has one, and the summary: nothing is read', async (_what, failure, cause) => {
    candidates(task(12), task(13));
    resolveGitHubTokenMock.mockRejectedValue(failure);

    await handler(EVENT, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerMock.error.mock.calls).toEqual([
      ['PR outcome sweep: the secret of the platform GitHub token cannot be read', { error: failure.message, cause }],
      ['PR outcome sweep summary', counted({ scanned: 2, candidates: 2, left_out: 2, stopped: 'secret' })],
    ]);
  });

  // An empty value is no token. `fetch` refuses the other three as a header before any request,
  // and a run that got that far would read as GitHub being away.
  test.each([
    ['is empty but for white space', ' \n'],
    ['holds a second line', `${TOKEN}\nsecond-line`],
    ['holds a character that no header can carry', `${TOKEN}${String.fromCharCode(0)}`],
    // Where printable ASCII ends: the delete character is the one after the tilde.
    ['holds the first character above those a token can have', `${TOKEN}${String.fromCharCode(0x7f)}`],
  ])('a secret whose value %s ends the run with an error that does not hold it, before any request', async (_what, secret) => {
    candidates(task(12), task(13));
    resolveGitHubTokenMock.mockResolvedValue(secret);

    await handler(EVENT, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerMock.error.mock.calls).toEqual([
      [
        'PR outcome sweep: the secret of the platform GitHub token holds no usable token',
        { error: 'the value is empty, or holds a character that a request header cannot carry' },
      ],
      ['PR outcome sweep summary', counted({ scanned: 2, candidates: 2, left_out: 2, stopped: 'secret' })],
    ]);
  });

  /** A made-up token of a kind GitHub issues: its prefix and twenty characters, the fewest that read as one. */
  const madeUp = (prefix: string): string => `${prefix}Made_up_token_value9`;

  // A token with something around it was meant to be one: a mistake to say, not a stack without a token.
  test.each([
    ['in quotes', `"${madeUp('ghp_')}"`],
    ['as a JSON object', `{"GITHUB_TOKEN":"${madeUp('github_pat_')}"}`],
    ['after the word Bearer', `Bearer ${madeUp('gho_')}`],
    ['as a shell assignment', `GITHUB_TOKEN=${madeUp('ghu_')}`],
    ['with a remark after it', `${madeUp('ghs_')} # production`],
    ['after the word token', `token ${madeUp('ghr_')}`],
  ])('a secret that holds a GitHub token %s ends the run with an error that does not hold it, before any request', async (_what, secret) => {
    candidates(task(12), task(13));
    resolveGitHubTokenMock.mockResolvedValue(secret);

    await handler(EVENT, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerMock.error.mock.calls).toEqual([
      [
        'PR outcome sweep: the secret of the platform GitHub token holds no usable token',
        { error: 'the value holds a GitHub token with other characters around it' },
      ],
      ['PR outcome sweep summary', counted({ scanned: 2, candidates: 2, left_out: 2, stopped: 'secret' })],
    ]);
  });

  // A stack that was never given a platform token: its secret holds the value it was created with.
  test.each([
    ['holds punctuation, as a generated value does', 'generated(value);with=punctuation'],
    ['holds a space', 'not a token'],
    ['holds a slash', 'path/like-value'],
    ['is a note someone left there', '<your token here>'],
    // One character short of the twenty: the start of a token, and no token.
    ['holds a GitHub prefix with fewer characters after it than a token has', `"${madeUp('ghp_').slice(0, -1)}"`],
  ])('no GitHub token is a printable value that %s: the summary alone, as information, and no request', async (_what, secret) => {
    candidates(task(12), task(13));
    resolveGitHubTokenMock.mockResolvedValue(secret);

    await handler(EVENT, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.info.mock.calls).toEqual([
      ['PR outcome sweep summary', counted({ scanned: 2, candidates: 2, left_out: 2, stopped: 'no_token' })],
    ]);
  });

  test('a value of letters of both cases, digits, an underscore, a dot and a hyphen is a token and is sent, also when it starts as a GitHub token does', async () => {
    const token = `${madeUp('ghs_')}.and-more`;
    candidates(task(12));
    github({ 12: found(12) });
    resolveGitHubTokenMock.mockResolvedValue(token);

    await handler(EVENT, context);

    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toMatchObject([{ Authorization: `Bearer ${token}` }]);
    expect(summary().data).toMatchObject({ read: 1, stopped: 'none' });
  });
});

describe('a pull request found open', () => {
  test('is recorded as open on its first read: one conditional write that sets nothing else, and no event', async () => {
    candidates(task(12));
    github({ 12: found(12) });

    await handler(EVENT, context);

    // The whole input: no `updated_at`, no `ttl`, no other attribute.
    expect(updates()).toEqual([{
      TableName: 'Tasks',
      Key: { task_id: 'task-12' },
      UpdateExpression: 'SET pr_state = :open',
      ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(pr_state)',
      ExpressionAttributeValues: { ':open': 'open' },
    }]);
    expect(stdout).not.toHaveBeenCalled();
    expect(eventMock).not.toHaveBeenCalled();
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 1, candidates: 1, read: 1, open: 1 }) });
  });

  test('is read again and not written again once it is recorded as open', async () => {
    candidates(task(12, { pr_state: 'open' }));
    github({ 12: found(12) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(summary().data).toMatchObject({ read: 1, open: 1 });
  });

  test('counts as open when another run recorded it first', async () => {
    candidates(task(12));
    github({ 12: found(12) });
    updateMock.mockRejectedValueOnce(ddbError('ConditionalCheckFailedException'));

    await handler(EVENT, context);

    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 1, candidates: 1, read: 1, open: 1 }) });
  });

  test('fails, and is not counted as open, when its write fails for another reason', async () => {
    candidates(task(12), task(13));
    github({ 12: found(12), 13: found(13) });
    updateMock.mockRejectedValueOnce(ddbError('ProvisionedThroughputExceededException'));

    await handler(EVENT, context);

    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: a pull request failed', { task_id: 'task-12', error: 'ProvisionedThroughputExceededException' }],
      ['PR outcome sweep summary', counted({ scanned: 2, candidates: 2, read: 2, open: 1, failed: 1 })],
    ]);
  });
});

describe('a pull request found merged or closed', () => {
  test('merged: the four fields are written once, and one line and one event are built from the record the write returns', async () => {
    candidates(task(12, { pr_state: 'open' }));
    github({ 12: found(12, MERGED) });
    // What the candidate query does not project, and what a writer changed since: the line and the event have to come from here.
    updateMock.mockResolvedValueOnce({ Attributes: task(12, { ...MERGED_FIELDS, user_id: 'user-7', repo: 'Acme/Widgets' }) });

    await handler(EVENT, context);

    // The whole input: no `updated_at`, no `ttl`, no other attribute.
    expect(updates()).toEqual([{
      TableName: 'Tasks',
      Key: { task_id: 'task-12' },
      UpdateExpression: 'SET pr_state = :state, pr_closed_at = :closed_at, pr_changes_requested = :changes_requested, pr_first_review_at = :first_review_at',
      ConditionExpression: 'attribute_exists(task_id) AND (attribute_not_exists(pr_state) OR pr_state = :open)',
      ExpressionAttributeValues: {
        ':state': 'merged',
        ':closed_at': '2026-11-17T10:00:00Z',
        ':changes_requested': 1,
        ':first_review_at': '2026-11-16T16:24:00Z',
        ':open': 'open',
      },
      ReturnValues: 'ALL_NEW',
    }]);
    expect(stdout).toHaveBeenCalledTimes(1);
    const [written] = stdout.mock.calls[0] as [string];
    expect(written.endsWith('\n')).toBe(true);
    expect(written.indexOf('\n')).toBe(written.length - 1);
    // The line itself is pinned where it is built (test/handlers/shared/scoreboard.test.ts).
    expect(JSON.parse(written)).toMatchObject({
      _aws: { Timestamp: Date.parse('2026-11-17T10:00:00Z') },
      PrOutcome: 'merged',
      PullRequestsResolved: 1,
      TimeToMergeSeconds: 86400,
      task_id: 'task-12',
      user_id: 'user-7',
      repo: 'Acme/Widgets',
      workflow: 'coding/new-task-v1',
    });
    // The whole event, as the platform's other writers put one: kept 90 days from the run, with what the write recorded.
    expect(events()).toEqual([{
      TableName: 'TaskEvents',
      Item: {
        task_id: 'task-12',
        event_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        event_type: 'pr_outcome_recorded',
        timestamp: '2026-11-18T00:20:00.000Z',
        ttl: NOW / SECOND_MS + 90 * 24 * 3600,
        user_id: 'user-7',
        repo: 'Acme/Widgets',
        metadata: {
          pr_state: 'merged',
          pr_closed_at: '2026-11-17T10:00:00Z',
          pr_changes_requested: 1,
          pr_first_review_at: '2026-11-16T16:24:00Z',
        },
      },
    }]);
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 1, candidates: 1, read: 1, merged: 1 }) });
  });

  test('closed for an hour, with no review: recorded without a first review, and its line carries no time to merge', async () => {
    const closedAt = ago(HOUR_MS);
    candidates(task(12, { pr_state: 'open' }));
    github({ 12: found(12, { state: 'CLOSED', closedAt }) });
    updateMock.mockResolvedValueOnce({ Attributes: task(12, { pr_state: 'closed', pr_closed_at: closedAt, pr_changes_requested: 0 }) });

    await handler(EVENT, context);

    // Strictly: the document client refuses a value that is undefined, so the first review is not named at all.
    expect(updates()).toStrictEqual([{
      TableName: 'Tasks',
      Key: { task_id: 'task-12' },
      UpdateExpression: 'SET pr_state = :state, pr_closed_at = :closed_at, pr_changes_requested = :changes_requested',
      ConditionExpression: 'attribute_exists(task_id) AND (attribute_not_exists(pr_state) OR pr_state = :open)',
      ExpressionAttributeValues: { ':state': 'closed', ':closed_at': closedAt, ':changes_requested': 0, ':open': 'open' },
      ReturnValues: 'ALL_NEW',
    }]);
    expect(lines()).toMatchObject([{ _aws: { Timestamp: NOW - HOUR_MS }, PrOutcome: 'closed', PullRequestsResolved: 1, task_id: 'task-12' }]);
    expect(lines()[0]).not.toHaveProperty('TimeToMergeSeconds');
    // Strictly, for the same reason: the event names no first review either.
    expect(events().map((event) => event.Item?.metadata)).toStrictEqual([{ pr_state: 'closed', pr_closed_at: closedAt, pr_changes_requested: 0 }]);
    expect(summary().data).toMatchObject({ read: 1, closed: 1, merged: 0, not_emitted: 0 });
  });

  test('closed less than an hour ago: nothing is recorded yet, as it can be reopened', async () => {
    candidates(task(12, { pr_state: 'open' }), task(13));
    github({
      12: found(12, { state: 'CLOSED', closedAt: ago(HOUR_MS - SECOND_MS) }),
      13: found(13, { state: 'CLOSED', closedAt: ago(SECOND_MS) }),
    });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 2, candidates: 2, read: 2 }) });
  });

  test.each([
    ['12 days', 12 * DAY_MS],
    ['exactly 13 days', 13 * DAY_MS],
  ])('merged %s before the run: recorded, with its line', async (_when, mergedForMs) => {
    const mergedAt = ago(mergedForMs);
    candidates(task(12));
    github({ 12: found(12, { state: 'MERGED', mergedAt, closedAt: mergedAt }) });
    updateMock.mockResolvedValueOnce({ Attributes: task(12, { pr_state: 'merged', pr_closed_at: mergedAt, pr_changes_requested: 0 }) });

    await handler(EVENT, context);

    expect(updates()).toHaveLength(1);
    expect(lines()).toMatchObject([{ _aws: { Timestamp: NOW - mergedForMs }, PrOutcome: 'merged', task_id: 'task-12' }]);
    expect(summary().data).toMatchObject({ merged: 1, not_emitted: 0 });
  });

  test.each([
    ['a second more than 13 days', 13 * DAY_MS + SECOND_MS],
    ['14 days', 14 * DAY_MS],
  ])('merged %s before the run: recorded, with its event and without a line that CloudWatch would drop', async (_when, mergedForMs) => {
    const mergedAt = ago(mergedForMs);
    candidates(task(12));
    github({ 12: found(12, { state: 'MERGED', mergedAt, closedAt: mergedAt }) });
    updateMock.mockResolvedValueOnce({ Attributes: task(12, { pr_state: 'merged', pr_closed_at: mergedAt, pr_changes_requested: 0 }) });

    await handler(EVENT, context);

    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ ExpressionAttributeValues: { ':state': 'merged', ':closed_at': mergedAt } });
    expect(stdout).not.toHaveBeenCalled();
    // The event is stamped when it is put, which no age rule concerns.
    expect(events()).toMatchObject([{ Item: { task_id: 'task-12', metadata: { pr_state: 'merged', pr_closed_at: mergedAt } } }]);
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 1, candidates: 1, read: 1, merged: 1, not_emitted: 1 }) });
  });

  test('a final write that the table refuses is said and skipped: no metric line, no event, no count', async () => {
    candidates(task(12));
    github({ 12: found(12, MERGED) });
    updateMock.mockRejectedValueOnce(ddbError('ConditionalCheckFailedException'));

    await handler(EVENT, context);

    expect(stdout).not.toHaveBeenCalled();
    expect(eventMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.info.mock.calls).toEqual([
      ['PR outcome sweep: a final write was refused', { task_id: 'task-12', state: 'merged' }],
      ['PR outcome sweep summary', counted({ scanned: 1, candidates: 1, read: 1 })],
    ]);
  });

  // The helper lives in the orchestrator's module, which this function does not bundle: the
  // handler puts the item itself, and this holds the two together.
  test('the event is the item the platform\'s event helper puts for the same outcome: the same members, and none that is undefined', async () => {
    const closedAt = ago(HOUR_MS);
    candidates(task(12, { pr_state: 'open' }));
    github({ 12: found(12, { state: 'CLOSED', closedAt }) });
    updateMock.mockResolvedValueOnce({ Attributes: task(12, { pr_state: 'closed', pr_closed_at: closedAt, pr_changes_requested: 0 }) });

    await handler(EVENT, context);
    // The same outcome through the helper, with the first review that this pull request does not have.
    await emitTaskEvent(
      'task-12',
      'pr_outcome_recorded',
      { pr_state: 'closed', pr_closed_at: closedAt, pr_changes_requested: 0, pr_first_review_at: undefined },
      { user_id: 'user-1', repo: 'acme/widgets' },
    );

    const [mine, helpers] = events();
    // Whole, apart from the id and the instant of the put, which no two events share: of those, that each is text.
    const comparable = ({ Item }: PutCommandInput) => ({ ...Item, event_id: typeof Item?.event_id, timestamp: typeof Item?.timestamp });
    expect(mine.TableName).toBe(helpers.TableName);
    expect(comparable(mine)).toStrictEqual(comparable(helpers));
  });

  test('the event carries the instant of its put, not the start of the run', async () => {
    let clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    candidates(task(12, { pr_state: 'open' }));
    // The read takes a hundred seconds.
    github({
      12: () => {
        clock = NOW + 100 * SECOND_MS;
        return found(12, MERGED)();
      },
    });
    updateMock.mockResolvedValueOnce({ Attributes: task(12, MERGED_FIELDS) });

    await handler(EVENT, context);

    expect(events().map((event) => event.Item?.timestamp)).toEqual(['2026-11-18T00:21:40.000Z']);
  });

  test('a final state whose event cannot be written stays recorded: one warning, and no failed pull request', async () => {
    candidates(task(12), task(13));
    github({ 12: found(12, MERGED), 13: found(13) });
    updateMock.mockResolvedValueOnce({ Attributes: task(12, MERGED_FIELDS) });
    eventMock.mockRejectedValueOnce(ddbError('ProvisionedThroughputExceededException'));

    await handler(EVENT, context);

    // The metric line was written before the event, and the run went on to the next pull request.
    expect(lines()).toMatchObject([{ PrOutcome: 'merged', task_id: 'task-12' }]);
    expect(stdout.mock.invocationCallOrder[0]).toBeLessThan(eventMock.mock.invocationCallOrder[0]);
    expect(asked()).toEqual([12, 13]);
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: the event of a recorded state was not written', { task_id: 'task-12', error: 'ProvisionedThroughputExceededException' }],
    ]);
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 2, candidates: 2, read: 2, merged: 1, open: 1 }) });
  });
});

describe('a pull request that is not the task\'s', () => {
  /** The line that names the task. */
  const NOT_THE_TASKS = 'PR outcome sweep: no pull request of the task under the recorded number';
  /** The write that records it, whole: no `updated_at`, no `ttl`, no other attribute. */
  const RECORDED_NOT_FOUND = {
    TableName: 'Tasks',
    Key: { task_id: 'task-12' },
    UpdateExpression: 'SET pr_state = :not_found',
    ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(pr_state)',
    ExpressionAttributeValues: { ':not_found': 'not_found' },
  };

  // The task of the fixture finished two days before the run.
  test('is recorded as not found, once, and says which task, when GitHub has no pull request under the number: no line, no event', async () => {
    candidates(task(12));
    github({ 12: PULL_REQUEST_NOT_FOUND });

    await handler(EVENT, context);

    expect(updates()).toEqual([RECORDED_NOT_FOUND]);
    expect(stdout).not.toHaveBeenCalled();
    expect(eventMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.info.mock.calls).toEqual([
      [NOT_THE_TASKS, { task_id: 'task-12', repo: 'acme/widgets', pr_number: 12, why: 'not_found' }],
      ['PR outcome sweep summary', counted({ scanned: 1, candidates: 1, read: 1, pr_not_found: 1 })],
    ]);
  });

  test.each([
    ['open', {}],
    ['merged', MERGED],
  ])('is recorded as not found, with a warning, when the %s pull request under the number was opened from the branch of another task', async (_state, fields) => {
    candidates(task(12));
    // The record of task-12 names pull request 12, which task-13 opened.
    github({ 12: found(13, fields) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12]);
    expect(updates()).toEqual([RECORDED_NOT_FOUND]);
    expect(stdout).not.toHaveBeenCalled();
    expect(eventMock).not.toHaveBeenCalled();
    // The branch is GitHub's text: the line says that it is another one, not which.
    expect(loggerMock.warn.mock.calls).toEqual([
      [NOT_THE_TASKS, { task_id: 'task-12', repo: 'acme/widgets', pr_number: 12, why: 'other_head_branch' }],
    ]);
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 1, candidates: 1, read: 1, pr_not_found: 1 }) });
  });

  test.each<[string, Partial<TaskRecord>]>([
    ['whose task finished less than an hour ago', { completed_at: ago(HOUR_MS - SECOND_MS), updated_at: ago(HOUR_MS - SECOND_MS) }],
    ['that an earlier read recorded as open', { pr_state: 'open' }],
  ])('is counted and named, and not recorded, for a pull request %s', async (_what, fields) => {
    candidates(task(12, fields));
    github({ 12: PULL_REQUEST_NOT_FOUND });

    await handler(EVENT, context);

    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerMock.info.mock.calls).toEqual([
      [NOT_THE_TASKS, { task_id: 'task-12', repo: 'acme/widgets', pr_number: 12, why: 'not_found' }],
      ['PR outcome sweep summary', counted({ scanned: 1, candidates: 1, read: 1, pr_not_found: 1 })],
    ]);
  });

  test('is counted and named all the same when another run recorded a state first: the write is refused, and nothing fails', async () => {
    candidates(task(12));
    github({ 12: PULL_REQUEST_NOT_FOUND });
    updateMock.mockRejectedValueOnce(ddbError('ConditionalCheckFailedException'));

    await handler(EVENT, context);

    expect(updates()).toEqual([RECORDED_NOT_FOUND]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.info.mock.calls).toEqual([
      [NOT_THE_TASKS, { task_id: 'task-12', repo: 'acme/widgets', pr_number: 12, why: 'not_found' }],
      ['PR outcome sweep summary', counted({ scanned: 1, candidates: 1, read: 1, pr_not_found: 1 })],
    ]);
  });

  test('fails, and is not counted as not found, when the write that records it fails for another reason than its condition', async () => {
    candidates(task(12), task(13));
    github({ 12: PULL_REQUEST_NOT_FOUND, 13: found(13) });
    updateMock.mockRejectedValueOnce(ddbError('ProvisionedThroughputExceededException'));

    await handler(EVENT, context);

    expect(loggerMock.info.mock.calls.map(([message]) => message)).not.toContain(NOT_THE_TASKS);
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: a pull request failed', { task_id: 'task-12', error: 'ProvisionedThroughputExceededException' }],
      ['PR outcome sweep summary', counted({ scanned: 2, candidates: 2, read: 2, open: 1, failed: 1 })],
    ]);
  });
});

describe('a repository GitHub does not show to the token', () => {
  test('is named once, and its other pull requests are not read in this run', async () => {
    candidates(
      task(12, { repo: 'acme/private' }),
      task(13),
      // The same repository, as another task spells it.
      task(14, { repo: 'Acme/Private' }),
      task(15, { repo: 'acme/private' }),
      task(16),
    );
    github({ 12: REPOSITORY_NOT_FOUND, 13: found(13), 16: found(16) });

    await handler(EVENT, context);

    // Each pull request is asked for in the repository of its own task.
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string).variables)).toEqual([
      { owner: 'acme', name: 'private', number: 12 },
      { owner: 'acme', name: 'widgets', number: 13 },
      { owner: 'acme', name: 'widgets', number: 16 },
    ]);
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: GitHub does not show a repository to the platform token', { repo: 'acme/private' }],
    ]);
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-13' }, { task_id: 'task-16' }]);
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 5, candidates: 5, read: 3, open: 2, repo_not_visible: 3 }) });
  });

  test('a name that is not owner/name is the same count and the same warning, and it costs no request', async () => {
    candidates(task(12, { repo: 'not a repo' }), task(13, { repo: 'not a repo' }), task(14));
    github({ 14: found(14) });

    await handler(EVENT, context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: GitHub does not show a repository to the platform token', { repo: 'not a repo' }],
    ]);
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 3, candidates: 3, read: 1, open: 1, repo_not_visible: 2 }) });
  });
});

describe('the failure of one pull request', () => {
  test('is logged with its task and counted, the run goes on to the next, and its summary is a warning', async () => {
    candidates(task(12), task(13), task(14));
    github({ 12: QUERY_FAILED, 13: found(13, MERGED), 14: found(14) });
    updateMock.mockRejectedValueOnce(ddbError('ProvisionedThroughputExceededException'));

    await expect(handler(EVENT, context)).resolves.toBeUndefined();

    expect(asked()).toEqual([12, 13, 14]);
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: a pull request failed', { task_id: 'task-12', error: 'GitHub answered with errors: untyped' }],
      ['PR outcome sweep: a pull request failed', { task_id: 'task-13', error: 'ProvisionedThroughputExceededException' }],
      ['PR outcome sweep summary', counted({ scanned: 3, candidates: 3, read: 3, open: 1, failed: 2 })],
    ]);
    // The merge of task-13 was not recorded: it is neither counted nor sent to CloudWatch.
    expect(stdout).not.toHaveBeenCalled();
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-13' }, { task_id: 'task-14' }]);
  });

  test('of every pull request the run read makes its summary an error, though nothing stopped it', async () => {
    candidates(task(12), task(13));
    github({ 12: found(12), 13: found(13) });
    // What a table that refuses every write does: no stop sees it.
    updateMock.mockRejectedValue(ddbError('AccessDeniedException'));

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13]);
    expect(summary()).toEqual({ level: 'error', data: counted({ scanned: 2, candidates: 2, read: 2, failed: 2 }) });
  });
});

describe('the run stops', () => {
  test('before a read when less than 30 seconds of its time are left', async () => {
    candidates(task(12), task(13), task(14));
    github({ 12: found(12), 13: found(13), 14: found(14) });
    const left = jest.fn().mockReturnValueOnce(31_000).mockReturnValueOnce(30_000).mockReturnValue(29_999);

    await handler(EVENT, { getRemainingTimeInMillis: left } as unknown as Context);

    expect(asked()).toEqual([12, 13]);
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-12' }, { task_id: 'task-13' }]);
    expect(summary()).toEqual({ level: 'warn', data: counted({ scanned: 3, candidates: 3, read: 2, open: 2, left_out: 1, stopped: 'deadline' }) });
  });

  test('before the next read when the token has fewer than 1,000 points left, after it recorded the read that said so', async () => {
    candidates(task(12), task(13), task(14));
    github({ 12: found(12, {}, 1000), 13: found(13, {}, 999), 14: found(14) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13]);
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-12' }, { task_id: 'task-13' }]);
    expect(summary()).toEqual({ level: 'warn', data: counted({ scanned: 3, candidates: 3, read: 2, open: 2, left_out: 1, stopped: 'floor' }) });
  });

  test('not for an answer that does not say what is left of the budget', async () => {
    candidates(task(12), task(13));
    github({ 12: found(12, {}, null), 13: found(13, {}, null) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13]);
    expect(summary()).toMatchObject({ level: 'info', data: { read: 2, stopped: 'none' } });
  });

  // Which answers stop a run is the read's rule: here, what the run does with one of each kind.
  test('when GitHub refuses the token: an error that names the pull request it stopped on, and nothing more is read or written', async () => {
    candidates(task(12), task(13), task(14));
    github({ 12: found(12), 13: BAD_CREDENTIALS, 14: found(14, MERGED) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13]);
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-12' }]);
    expect(stdout).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error.mock.calls).toEqual([
      ['PR outcome sweep: stopped by GitHub', { task_id: 'task-13', http_status: 401, error: 'GitHub refused the token (HTTP 401)' }],
      ['PR outcome sweep summary', counted({ scanned: 3, candidates: 3, read: 2, open: 1, left_out: 1, stopped: 'token' })],
    ]);
  });

  test('at once when GitHub asks to wait, whatever its answer holds: a warning with the pull request and the status, and nothing more is read or written', async () => {
    candidates(task(12), task(13), task(14));
    github({ 12: found(12), 13: ASKS_TO_WAIT, 14: found(14, MERGED) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13]);
    expect(updates().map((update) => update.Key)).toEqual([{ task_id: 'task-12' }]);
    expect(stdout).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: stopped by GitHub', { task_id: 'task-13', http_status: 200, error: 'GitHub answered HTTP 200 and asked to wait' }],
      ['PR outcome sweep summary', counted({ scanned: 3, candidates: 3, read: 2, open: 1, left_out: 1, stopped: 'unavailable' })],
    ]);
  });
});

describe('a read that GitHub gives no usable answer to', () => {
  test('three times in a row stops the run, whatever kept GitHub from answering each time: nothing more is read or written', async () => {
    candidates(task(12), task(13), task(14), task(15));
    github({ 12: SERVER_ERROR, 13: TIMES_OUT, 14: NOT_JSON, 15: found(15, MERGED) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13, 14]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    // Every read of the run failed, and its summary is a warning all the same: the stop says why.
    expect(loggerMock.error).not.toHaveBeenCalled();
    // Each failed read with the status GitHub gave, where it gave one; then why the run stopped, and on which pull request.
    expect(loggerMock.warn.mock.calls).toEqual([
      ['PR outcome sweep: a pull request failed', { task_id: 'task-12', http_status: 502, error: 'GitHub answered HTTP 502' }],
      ['PR outcome sweep: a pull request failed', { task_id: 'task-13', error: 'GitHub gave no usable answer (TimeoutError)' }],
      ['PR outcome sweep: a pull request failed', { task_id: 'task-14', http_status: 200, error: 'GitHub gave no usable answer (SyntaxError)' }],
      ['PR outcome sweep: stopped by GitHub', { task_id: 'task-14', error: 'GitHub gave no usable answer to 3 reads in a row' }],
      ['PR outcome sweep summary', counted({ scanned: 4, candidates: 4, read: 3, failed: 3, left_out: 1, stopped: 'unavailable' })],
    ]);
  });

  // GitHub is there when it answers, whatever the answer does to the one pull request.
  test.each<[string, Answer, Record<string, number>]>([
    ['an answer with an error about the pull request', QUERY_FAILED, { failed: 5 }],
    ['an answer that holds the pull request', found(14), { failed: 4, open: 2 }],
    ['the answer that there is no such pull request', PULL_REQUEST_NOT_FOUND, { failed: 4, pr_not_found: 1 }],
  ])('twice, then %s, then twice more does not stop the run: the count starts again at none', async (_what, answered, counts) => {
    candidates(task(12), task(13), task(14), task(15), task(16), task(17));
    github({ 12: TIMES_OUT, 13: SERVER_ERROR, 14: answered, 15: TIMES_OUT, 16: NOT_JSON, 17: found(17) });

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13, 14, 15, 16, 17]);
    expect(summary()).toEqual({ level: 'warn', data: counted({ scanned: 6, candidates: 6, read: 6, open: 1, ...counts }) });
  });
});

describe('a run with more candidates than it may ask GitHub about', () => {
  /** 251 pull requests that were read as open before, numbered from 1000: the ids of their tasks sort as the numbers do. */
  const NUMBERS = Array.from({ length: 251 }, (_, index) => 1000 + index);
  const TASKS = NUMBERS.map((number) => task(number, { pr_state: 'open' }));
  const OPEN = Object.fromEntries(NUMBERS.map((number) => [number, found(number)]));

  test('asks about 250 of them, ends without a stop, and counts the rest as left out', async () => {
    candidates(...TASKS);
    // The 250th answer says that the budget is low: the run has ended by then, and is not stopped by it.
    github({ ...OPEN, 1249: found(1249, {}, 999) });

    await handler(EVENT, context);

    expect(asked()).toEqual(NUMBERS.slice(0, 250));
    expect(summary()).toEqual({ level: 'info', data: counted({ scanned: 251, candidates: 251, read: 250, open: 250, left_out: 1 }) });
  });

  test('is an error when every pull request it asked about failed, though it did not reach them all', async () => {
    candidates(...TASKS);
    // An answer with an error fails its pull request and stops nothing.
    github(Object.fromEntries(NUMBERS.map((number) => [number, QUERY_FAILED])));

    await handler(EVENT, context);

    expect(summary()).toEqual({ level: 'error', data: counted({ scanned: 251, candidates: 251, read: 250, failed: 250, left_out: 1 }) });
  });

  test('starts where the clock of the run says: the one a run leaves out is read an hour later', async () => {
    github(OPEN);

    candidates(...TASKS);
    await handler(EVENT, context);
    const first = asked();
    const leftOut = NUMBERS.filter((number) => !first.includes(number));
    expect(leftOut).toHaveLength(1);

    fetchMock.mockClear();
    jest.spyOn(Date, 'now').mockReturnValue(NOW + HOUR_MS);
    candidates(...TASKS);
    await handler(EVENT, context);

    // A rotation that did not follow the clock would leave the same one out in every run, for good.
    expect(asked()).toHaveLength(250);
    expect(asked()).toContain(leftOut[0]);
  });

  test('gives no place to a pull request it passes over without a request: 100 readable ones among 2,000 of a hidden repository are all read', async () => {
    const hidden = Array.from({ length: 2000 }, (_, index) => task(10_000 + index, { repo: 'acme/private' }));
    const readable = Array.from({ length: 100 }, (_, index) => task(20_000 + index));
    candidates(...hidden, ...readable);
    github({
      ...Object.fromEntries(hidden.map((_, index) => [10_000 + index, REPOSITORY_NOT_FOUND])),
      ...Object.fromEntries(readable.map((_, index) => [20_000 + index, found(20_000 + index)])),
    });

    await handler(EVENT, context);

    // One request says that the repository is hidden, and 100 read the others.
    expect(summary()).toEqual({
      level: 'info',
      data: counted({ scanned: 2100, candidates: 2100, read: 101, open: 100, repo_not_visible: 2000 }),
    });
  });
});

describe('what GitHub answers', () => {
  test('reaches no log and no line, apart from the status and the type of an error', async () => {
    candidates(task(12, { repo: 'acme/private' }), task(13), task(14), task(15), task(16), task(17));
    github({
      12: REPOSITORY_NOT_FOUND,
      13: PULL_REQUEST_NOT_FOUND,
      14: QUERY_FAILED,
      15: found(15, MERGED),
      16: NOT_JSON,
      17: BAD_CREDENTIALS,
    });
    // The write of task-13 records that its pull request is not there; the write of task-15 returns the record of the merge.
    updateMock.mockImplementation(async (input: UpdateCommandInput) => (input.Key?.task_id === 'task-15' ? { Attributes: task(15, MERGED_FIELDS) } : {}));

    await handler(EVENT, context);

    expect(asked()).toEqual([12, 13, 14, 15, 16, 17]);
    expect(summary().data).toMatchObject({ read: 6, merged: 1, repo_not_visible: 1, pr_not_found: 1, failed: 2, not_emitted: 0, stopped: 'token' });
    const written = JSON.stringify([
      loggerMock.info.mock.calls, loggerMock.warn.mock.calls, loggerMock.error.mock.calls, stdout.mock.calls, updateMock.mock.calls, eventMock.mock.calls,
    ]);
    // The token, the logins of the author and of a reviewer, and the words of whoever answered.
    for (const text of [
      TOKEN, 'abca-agent', 'octocat', 'Could not resolve', 'Something went wrong', 'C0DE:1F2E3D', 'Sign in to the proxy', 'Bad credentials', 'docs.github.com',
    ]) {
      expect(written).not.toContain(text);
    }
  });
});
