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

import { TaskStatus } from '../../../src/constructs/task-status';
import { INTEGRATION_NODE_SUFFIX } from '../../../src/handlers/shared/orchestration-integration-node';
import {
  decideRead,
  fetchPullRequest,
  GitHubNoAnswerError,
  GitHubStopError,
  pullRequestCandidate,
  recordsNotFound,
  selectForRun,
  type PullRequestCandidate,
  type PullRequestSnapshot,
} from '../../../src/handlers/shared/pr-outcome';
import type { TaskRecord } from '../../../src/handlers/shared/types';

const TOKEN = 'platform-token-value';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const ago = (ms: number): string => new Date(NOW - ms).toISOString().replace('.000Z', 'Z');

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no answer is stubbed for this request'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'OPEN',
    mergedAt: null,
    closedAt: null,
    headRefName: 'bgagent/task-1/add-a-retry',
    isCrossRepository: false,
    author: { login: 'abca-agent' },
    reviews: { nodes: [] },
    ...overrides,
  };
}

const found = (fields: Record<string, unknown> = {}): Response =>
  answer({ data: { rateLimit: { remaining: 4990 }, repository: { pullRequest: pullRequest(fields) } } });

const person = (login: string) => ({ login, __typename: 'User' });
const review = (state: string, submittedAt: string | null, author: { login: string; __typename: string } | null, canPush = true) =>
  ({ state, submittedAt, authorCanPushToRepository: canPush, author });

const read = (): Promise<unknown> => fetchPullRequest('acme/widgets', 12, TOKEN).catch((err: unknown) => err);

async function snapshotOf(fields: Record<string, unknown>): Promise<PullRequestSnapshot> {
  fetchMock.mockResolvedValueOnce(found(fields));
  const { read: result } = await fetchPullRequest('acme/widgets', 12, TOKEN);
  if (result.kind !== 'snapshot') throw new Error(`the read answered ${result.kind}`);
  return result.snapshot;
}

describe('fetchPullRequest', () => {
  describe('the request', () => {
    test('is one POST to the GraphQL endpoint, with the token as a bearer and a five-second timeout', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValueOnce(found());

      await fetchPullRequest('acme/widgets', 12, TOKEN);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.github.com/graphql');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      });
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(5000);
      expect(init?.signal).toBe(timeout.mock.results[0].value);
    });

    test('carries the repository and the number as variables of a query that never changes', async () => {
      fetchMock.mockResolvedValueOnce(found()).mockResolvedValueOnce(found());

      await fetchPullRequest('acme/widgets', 12, TOKEN);
      await fetchPullRequest('Other-Org/next.js', 4711, TOKEN);

      const [first, second] = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
      expect(first.variables).toEqual({ owner: 'acme', name: 'widgets', number: 12 });
      expect(second.variables).toEqual({ owner: 'Other-Org', name: 'next.js', number: 4711 });
      expect(Object.keys(first)).toEqual(['query', 'variables']);
      expect(second.query).toBe(first.query);
      expect(first.query.replace(/\s+/g, ' ')).toBe(
        'query($owner: String!, $name: String!, $number: Int!) {'
        + ' rateLimit { remaining }'
        + ' repository(owner: $owner, name: $name) {'
        + ' pullRequest(number: $number) {'
        + ' state mergedAt closedAt headRefName isCrossRepository'
        + ' author { login }'
        + ' reviews(first: 100) { nodes { state submittedAt authorCanPushToRepository author { login __typename } } }'
        + ' } } }',
      );
    });

    test('is not sent for a repository whose name is not owner/name: GitHub has none to show', async () => {
      const repo = 'acme/widgets") { id } } #';

      await expect(fetchPullRequest(repo, 12, TOKEN)).resolves.toEqual({ read: { kind: 'repo_not_visible' }, rateLimitRemaining: null });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ends the run at once', () => {
    test.each<[string, Response, 'token' | 'unavailable', number, string]>([
      [
        'a refused token (401)',
        answer({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql', status: '401' }, 401),
        'token', 401, 'GitHub refused the token (HTTP 401)',
      ],
      [
        'a secondary rate limit (403)',
        answer({
          documentation_url: 'https://docs.github.com/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api#secondary-rate-limits',
          message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID C0DE:1F2E3D:4C5B6A:7F8E9D:691F0A2B.',
        }, 403),
        'unavailable', 403, 'GitHub answered HTTP 403',
      ],
      [
        'too many requests (429)',
        answer({ message: 'API rate limit exceeded for user ID 583231.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' }, 429),
        'unavailable', 429, 'GitHub answered HTTP 429',
      ],
      [
        'a 200 that says the budget is spent',
        answer({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 583231.' }] }),
        'unavailable', 200, 'GitHub answered RATE_LIMITED',
      ],
      [
        'a 200 with data and the budget spent on the way',
        answer({
          data: { rateLimit: { remaining: 0 }, repository: null },
          errors: [{ type: 'RATE_LIMITED', path: ['repository'], locations: [{ line: 3, column: 3 }], message: 'API rate limit exceeded for user ID 583231.' }],
        }),
        'unavailable', 200, 'GitHub answered RATE_LIMITED',
      ],
      [
        'a 200 that asks to wait, as the answer to a secondary rate limit can be, whatever its body holds',
        new Response('<html><body>Please wait a few minutes before you try again.</body></html>', { status: 200, headers: { 'retry-after': '60' } }),
        'unavailable', 200, 'GitHub answered HTTP 200 and asked to wait',
      ],
      [
        'a server error that asks to wait (503)',
        new Response('upstream connect error or disconnect/reset before headers', { status: 503, headers: { 'content-type': 'text/plain', 'retry-after': '120' } }),
        'unavailable', 503, 'GitHub answered HTTP 503 and asked to wait',
      ],
      [
        'a status about the one request that asks to wait (422)',
        answer({ message: 'Unprocessable Entity', documentation_url: 'https://docs.github.com/graphql' }, 422, { 'retry-after': '60' }),
        'unavailable', 422, 'GitHub answered HTTP 422 and asked to wait',
      ],
      [
        'a refused token (401), though the answer asks to wait',
        answer({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql', status: '401' }, 401, { 'retry-after': '60' }),
        'token', 401, 'GitHub refused the token (HTTP 401)',
      ],
    ])('on %s', async (_what, response, reason, status, message) => {
      fetchMock.mockResolvedValueOnce(response);

      const error = await read();

      expect(error).toBeInstanceOf(GitHubStopError);
      expect(error).toMatchObject({ name: 'GitHubStopError', reason, httpStatus: status, message });
    });
  });

  describe('gets no usable answer to this one read', () => {
    test.each<[string, Response, number]>([
      [
        'a server error (500)',
        new Response('<!DOCTYPE html><html><head><title>Unicorn! &middot; GitHub</title></head><body>We had issues producing the response to your request.</body></html>', { status: 500, headers: { 'content-type': 'text/html' } }),
        500,
      ],
      [
        'a query that GitHub gave up on (502)',
        answer({ data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `C0DE:1F2E3D:4C5B6A:7F8E9D:691F0A2B` when reporting this issue.' }] }, 502),
        502,
      ],
      [
        'a service that is down (503)',
        new Response('upstream connect error or disconnect/reset before headers', { status: 503, headers: { 'content-type': 'text/plain' } }),
        503,
      ],
    ])('on %s, naming the status and not the body', async (_what, response, status) => {
      fetchMock.mockResolvedValueOnce(response);

      const error = await read();

      expect(error).toBeInstanceOf(GitHubNoAnswerError);
      expect(error).not.toBeInstanceOf(GitHubStopError);
      expect(error).toMatchObject({ name: 'GitHubNoAnswerError', httpStatus: status, message: `GitHub answered HTTP ${status}` });
    });

    test.each<[string, Error, string]>([
      [
        'a network error',
        new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) }),
        'GitHub gave no usable answer (TypeError, ENOTFOUND)',
      ],
      [
        'a timeout',
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        'GitHub gave no usable answer (TimeoutError)',
      ],
    ])('on %s, with no status', async (_what, failure, message) => {
      fetchMock.mockRejectedValueOnce(failure);

      const error = await read();

      expect(error).toBeInstanceOf(GitHubNoAnswerError);
      expect(error).toMatchObject({ httpStatus: undefined, message });
      expect((error as GitHubNoAnswerError).cause).toBeUndefined();
    });

    test('on a redirect, which the request tells fetch not to follow: the token goes nowhere else', async () => {
      // Node's fetch rejects a 3xx answer this way when it is asked with `redirect: 'error'`.
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));

      const error = await read();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
      expect(error).toBeInstanceOf(GitHubNoAnswerError);
      expect(error).toMatchObject({ httpStatus: undefined, message: 'GitHub gave no usable answer (TypeError)' });
    });

    test('on a 200 whose body is not JSON, naming the status and not quoting the body', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html><body>Sign in to the proxy of octocat</body></html>', { status: 200 }));

      const error = await read();

      expect(error).toBeInstanceOf(GitHubNoAnswerError);
      expect(error).toMatchObject({ httpStatus: 200, message: 'GitHub gave no usable answer (SyntaxError)' });
    });

    test.each<[string, unknown]>([
      [
        'holds a message and neither data nor errors',
        {
          documentation_url: 'https://docs.github.com/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api#secondary-rate-limits',
          message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        },
      ],
      ['holds data that is null, and no errors', { data: null }],
      ['is JSON and no object', null],
    ])('on a 200 whose body %s', async (_what, body) => {
      fetchMock.mockResolvedValueOnce(answer(body));

      const error = await read();

      expect(error).toBeInstanceOf(GitHubNoAnswerError);
      expect(error).toMatchObject({ httpStatus: 200, message: 'GitHub answered HTTP 200 with neither data nor errors' });
    });
  });

  describe('says what GitHub does not show', () => {
    test.each([
      [
        'a repository that does not exist, or that the token cannot see',
        {
          data: { rateLimit: { remaining: 4987 }, repository: null },
          errors: [{
            type: 'NOT_FOUND',
            path: ['repository'],
            locations: [{ line: 3, column: 3 }],
            message: "Could not resolve to a Repository with the name 'acme/widgets'.",
          }],
        },
        { read: { kind: 'repo_not_visible' }, rateLimitRemaining: 4987 },
      ],
      [
        'a repository behind single sign-on that the token was not authorized for',
        {
          data: { rateLimit: { remaining: 4986 }, repository: null },
          errors: [{
            type: 'FORBIDDEN',
            path: ['repository'],
            extensions: { saml_failure: true },
            locations: [{ line: 3, column: 3 }],
            message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.',
          }],
        },
        { read: { kind: 'repo_not_visible' }, rateLimitRemaining: 4986 },
      ],
      [
        'a pull request that the repository does not have',
        {
          data: { rateLimit: { remaining: 4985 }, repository: { pullRequest: null } },
          errors: [{
            type: 'NOT_FOUND',
            path: ['repository', 'pullRequest'],
            locations: [{ line: 4, column: 5 }],
            message: 'Could not resolve to a PullRequest with the number of 12.',
          }],
        },
        { read: { kind: 'pr_not_found' }, rateLimitRemaining: 4985 },
      ],
      [
        'a repository whose pull requests the token may not read: the permission is the repository\'s',
        {
          data: { rateLimit: { remaining: 4984 }, repository: { pullRequest: null } },
          errors: [{
            type: 'FORBIDDEN',
            path: ['repository', 'pullRequest'],
            extensions: { saml_failure: false },
            locations: [{ line: 4, column: 5 }],
            message: 'Resource not accessible by personal access token',
          }],
        },
        { read: { kind: 'repo_not_visible' }, rateLimitRemaining: 4984 },
      ],
    ])('%s', async (_what, body, expected) => {
      fetchMock.mockResolvedValueOnce(answer(body));

      await expect(fetchPullRequest('acme/widgets', 12, TOKEN)).resolves.toEqual(expected);
    });
  });

  describe('fails the read of this one pull request', () => {
    const INCOMPLETE = 'GitHub answered with a pull request that is missing its state, head branch, fork flag or close time';
    const MISS = {
      type: 'NOT_FOUND',
      path: ['repository', 'pullRequest'],
      locations: [{ line: 4, column: 5 }],
      message: 'Could not resolve to a PullRequest with the number of 12.',
    };

    test('on another status, which is about one request, naming the status and not the message', async () => {
      fetchMock.mockResolvedValueOnce(answer({ message: 'Not Found', documentation_url: 'https://docs.github.com/graphql' }, 404));

      const error = await read();

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitHubStopError);
      expect(error).not.toBeInstanceOf(GitHubNoAnswerError);
      expect((error as Error).message).toBe('GitHub answered HTTP 404');
    });

    test.each<[string, unknown, string]>([
      [
        'a 200 with another error, naming its type and not its message',
        {
          data: { rateLimit: { remaining: 4983 }, repository: { pullRequest: null } },
          errors: [{
            type: 'INSUFFICIENT_SCOPES',
            path: ['repository', 'pullRequest'],
            locations: [{ line: 4, column: 5 }],
            message: "Your token has not been granted the required scopes to execute this query. The 'pullRequest' field requires one of the following scopes: ['repo'], but your token has only been granted the: ['read:org'] scopes. Please modify your token's scopes at: https://github.com/settings/tokens.",
          }],
        },
        'GitHub answered with errors: INSUFFICIENT_SCOPES',
      ],
      [
        'a 200 with an error that has no type',
        { data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `C0DE:1F2E3D:4C5B6A:7F8E9D:691F0A2B` when reporting this issue.' }] },
        'GitHub answered with errors: untyped',
      ],
      [
        'a 200 with a not-found error about something other than the repository or the pull request',
        {
          data: { rateLimit: { remaining: 4982 }, repository: { pullRequest: pullRequest({ author: null }) } },
          errors: [
            { type: 'NOT_FOUND', path: ['repository', 'pullRequest', 'author'], locations: [{ line: 6, column: 7 }], message: 'Could not resolve to a User.' },
            { type: 'NOT_FOUND', path: ['repository', 'pullRequest', 'reviews', 'nodes', 0, 'author'], locations: [{ line: 7, column: 54 }], message: 'Could not resolve to a User.' },
          ],
        },
        'GitHub answered with errors: NOT_FOUND',
      ],
      ['the error of a miss in an answer without data', { data: null, errors: [MISS] }, 'GitHub answered with errors: NOT_FOUND'],
      [
        'the error of a miss beside a second error',
        {
          data: { rateLimit: { remaining: 4980 }, repository: { pullRequest: null } },
          errors: [MISS, { message: 'Something went wrong while executing your query.' }],
        },
        'GitHub answered with errors: NOT_FOUND, untyped',
      ],
      [
        'the error of a miss in an answer that holds the pull request all the same',
        { data: { rateLimit: { remaining: 4980 }, repository: { pullRequest: pullRequest() } }, errors: [MISS] },
        'GitHub answered with errors: NOT_FOUND',
      ],
      ['a 200 whose repository is null, without an error to say why', { data: { rateLimit: { remaining: 4981 }, repository: null } }, 'GitHub answered without a pull request'],
      [
        'a pull request in a state this read does not know',
        { data: { repository: { pullRequest: pullRequest({ state: 'LOCKED', closedAt: '2026-11-19T17:40:05Z' }) } } },
        INCOMPLETE,
      ],
      ['a pull request without a head branch', { data: { repository: { pullRequest: pullRequest({ headRefName: null }) } } }, INCOMPLETE],
      [
        'a pull request that does not say whether it comes from a fork',
        { data: { repository: { pullRequest: pullRequest({ isCrossRepository: undefined }) } } },
        INCOMPLETE,
      ],
      [
        'a merged pull request without a merge time',
        { data: { repository: { pullRequest: pullRequest({ state: 'MERGED', mergedAt: null, closedAt: '2026-11-19T09:15:43Z' }) } } },
        INCOMPLETE,
      ],
      [
        'a closed pull request whose close time is no time',
        { data: { repository: { pullRequest: pullRequest({ state: 'CLOSED', closedAt: 'yesterday' }) } } },
        INCOMPLETE,
      ],
    ])('on %s', async (_what, body, message) => {
      fetchMock.mockResolvedValueOnce(answer(body));

      const error = await read();

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitHubStopError);
      expect(error).not.toBeInstanceOf(GitHubNoAnswerError);
      expect((error as Error).message).toBe(message);
    });
  });

  describe('reads the state', () => {
    test('of an open pull request, with the branch it was opened from', async () => {
      await expect(snapshotOf({})).resolves.toEqual({
        state: 'open',
        headRef: 'bgagent/task-1/add-a-retry',
        crossRepository: false,
        closedAt: null,
        firstReviewAt: null,
        changesRequested: 0,
      });
    });

    test.each<[PullRequestSnapshot['state'], Record<string, unknown>]>([
      ['open', {}],
      ['merged', { state: 'MERGED', mergedAt: '2026-11-19T09:15:42Z', closedAt: '2026-11-19T09:15:43Z' }],
      ['closed', { state: 'CLOSED', closedAt: '2026-11-19T17:40:05Z' }],
    ])('of a pull request opened from a fork, and says that it is one: %s', async (state, fields) => {
      await expect(snapshotOf({ ...fields, isCrossRepository: true })).resolves.toMatchObject({ state, crossRepository: true });
    });

    test('of a merged pull request: the merge time is the close time, not GitHub\'s closedAt', async () => {
      const snapshot = await snapshotOf({ state: 'MERGED', mergedAt: '2026-11-19T09:15:42Z', closedAt: '2026-11-19T09:15:43Z' });

      expect(snapshot).toMatchObject({ state: 'merged', closedAt: '2026-11-19T09:15:42Z' });
    });

    test('of a pull request closed without a merge', async () => {
      const snapshot = await snapshotOf({ state: 'CLOSED', mergedAt: null, closedAt: '2026-11-19T17:40:05Z' });

      expect(snapshot).toMatchObject({ state: 'closed', closedAt: '2026-11-19T17:40:05Z' });
    });
  });

  describe('counts the reviews', () => {
    test('by a person who can push to the repository, other than the author: the earliest is the first review', async () => {
      const snapshot = await snapshotOf({
        reviews: {
          nodes: [
            review('COMMENTED', '2026-11-18T14:05:00Z', person('hubot-reviewer')),
            review('APPROVED', '2026-11-18T11:30:00Z', person('octocat')),
            review('APPROVED', '2026-11-18T16:00:00Z', person('octocat')),
          ],
        },
      });

      expect(snapshot).toMatchObject({ firstReviewAt: '2026-11-18T11:30:00Z', changesRequested: 0 });
    });

    test.each([
      ['by the author of the pull request, as every reply ABCA posts is', review('CHANGES_REQUESTED', '2026-11-18T11:00:00Z', person('abca-agent'))],
      ['by a bot', review('CHANGES_REQUESTED', '2026-11-18T11:00:00Z', { login: 'copilot-pull-request-reviewer', __typename: 'Bot' })],
      ['without an author, as a review of a deleted account is', review('CHANGES_REQUESTED', '2026-11-18T11:00:00Z', null)],
      ['by a person who cannot push to the repository', review('CHANGES_REQUESTED', '2026-11-18T11:00:00Z', person('octocat'), false)],
      ['that does not say whether its author can push', { state: 'CHANGES_REQUESTED', submittedAt: '2026-11-18T11:00:00Z', author: person('octocat') }],
      ['without a time', review('CHANGES_REQUESTED', null, person('octocat'))],
      ['whose time is no time', review('CHANGES_REQUESTED', 'yesterday', person('octocat'))],
      ['that is no review at all', null],
    ])('not one %s', async (_what, node) => {
      const snapshot = await snapshotOf({ reviews: { nodes: [node] } });

      expect(snapshot).toMatchObject({ firstReviewAt: null, changesRequested: 0 });
    });

    // GitHub reports a reply to a review thread as a COMMENTED review, and a dismissed review as DISMISSED whatever it was.
    test.each([
      ['only comments', 'COMMENTED'],
      ['was dismissed since', 'DISMISSED'],
    ])('a review that %s is a first review, and no change request', async (_what, state) => {
      const snapshot = await snapshotOf({
        reviews: {
          nodes: [
            review(state, '2026-11-18T11:30:00Z', person('octocat')),
            review('APPROVED', '2026-11-18T16:00:00Z', person('monalisa')),
          ],
        },
      });

      expect(snapshot).toMatchObject({ firstReviewAt: '2026-11-18T11:30:00Z', changesRequested: 0 });
    });

    test('a review that is not submitted yet is passed over for the first one that is', async () => {
      const snapshot = await snapshotOf({
        reviews: { nodes: [review('PENDING', null, person('octocat')), review('APPROVED', '2026-11-18T16:00:00Z', person('monalisa'))] },
      });

      expect(snapshot).toMatchObject({ firstReviewAt: '2026-11-18T16:00:00Z', changesRequested: 0 });
    });

    test('every change request by a person counts, also a second one of the same person; one by the author does not', async () => {
      const snapshot = await snapshotOf({
        reviews: {
          nodes: [
            review('CHANGES_REQUESTED', '2026-11-18T12:00:00Z', person('abca-agent')),
            review('CHANGES_REQUESTED', '2026-11-18T13:00:00Z', person('octocat')),
            review('CHANGES_REQUESTED', '2026-11-18T14:00:00Z', person('octocat')),
            review('CHANGES_REQUESTED', '2026-11-18T15:00:00Z', person('monalisa')),
            review('DISMISSED', '2026-11-18T15:30:00Z', person('monalisa')),
            review('APPROVED', '2026-11-18T16:00:00Z', person('octocat')),
          ],
        },
      });

      expect(snapshot).toMatchObject({ firstReviewAt: '2026-11-18T13:00:00Z', changesRequested: 3 });
    });

    test('every person counts when the account that opened the pull request is gone', async () => {
      const snapshot = await snapshotOf({ author: null, reviews: { nodes: [review('APPROVED', '2026-11-18T11:30:00Z', person('octocat'))] } });

      expect(snapshot).toMatchObject({ firstReviewAt: '2026-11-18T11:30:00Z' });
    });

    test.each([
      ['no reviews', { reviews: null }],
      ['reviews without nodes', { reviews: { nodes: null } }],
    ])('none in a pull request with %s', async (_what, fields) => {
      await expect(snapshotOf(fields)).resolves.toMatchObject({ firstReviewAt: null, changesRequested: 0 });
    });
  });

  describe('reports what is left of the token\'s budget', () => {
    test('as the answer gives it', async () => {
      fetchMock.mockResolvedValueOnce(found());

      await expect(fetchPullRequest('acme/widgets', 12, TOKEN)).resolves.toMatchObject({ rateLimitRemaining: 4990 });
    });

    test.each([
      ['no rateLimit', { repository: { pullRequest: pullRequest() } }],
      ['a null rateLimit, as a server without rate limits answers', { rateLimit: null, repository: { pullRequest: pullRequest() } }],
    ])('as null when the answer carries %s', async (_what, data) => {
      fetchMock.mockResolvedValueOnce(answer({ data }));

      await expect(fetchPullRequest('acme/widgets', 12, TOKEN)).resolves.toMatchObject({ read: { kind: 'snapshot' }, rateLimitRemaining: null });
    });
  });
});

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: 'task-1',
    user_id: 'user-1',
    status: TaskStatus.COMPLETED,
    repo: 'Acme/Widgets',
    resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
    workflow_ref: 'coding/new-task-v1',
    branch_name: 'bgagent/task-1/add-a-retry',
    channel_source: 'api',
    status_created_at: 'COMPLETED#2026-11-18T10:24:00Z',
    created_at: '2026-11-18T10:00:00.000Z',
    started_at: '2026-11-18T10:00:41.000Z',
    completed_at: '2026-11-18T10:24:00Z',
    updated_at: '2026-11-18T10:24:00Z',
    pr_url: 'https://github.com/Acme/Widgets/pull/12',
    build_passed: true,
    ...overrides,
  };
}

const inOrchestration = (subIssueId: string): TaskRecord['channel_metadata'] =>
  ({ orchestration_id: 'orch_1', orchestration_sub_issue_id: subIssueId });

const repoOfLength = (length: number): string => `${'o'.repeat(39)}/${'n'.repeat(length - 40)}`;

describe('pullRequestCandidate', () => {
  const FINISHED_AT_MS = Date.parse('2026-11-18T10:24:00Z');

  test('follows the new pull request of a task that ended normally, under the repository and number of its record, with its finish time', () => {
    expect(pullRequestCandidate(task()))
      .toEqual({ taskId: 'task-1', repo: 'Acme/Widgets', number: 12, recordedOpen: false, finishedAtMs: FINISHED_AT_MS });
  });

  test('follows it whether or not its build passed', () => {
    expect(pullRequestCandidate(task({ build_passed: false }))).toMatchObject({ taskId: 'task-1', number: 12 });
    expect(pullRequestCandidate(task({ build_passed: undefined }))).toMatchObject({ taskId: 'task-1', number: 12 });
  });

  test('keeps following a pull request that a read recorded as open', () => {
    expect(pullRequestCandidate(task({ pr_state: 'open' })))
      .toEqual({ taskId: 'task-1', repo: 'Acme/Widgets', number: 12, recordedOpen: true, finishedAtMs: FINISHED_AT_MS });
  });

  test('takes the number from pr_number when the record has one', () => {
    expect(pullRequestCandidate(task({ pr_number: 31 }))).toMatchObject({ number: 31 });
  });

  test('follows a pull request in a repository whose full name is as long as one can be, 140 characters', () => {
    expect(pullRequestCandidate(task({ repo: repoOfLength(140) }))).toMatchObject({ repo: repoOfLength(140), number: 12 });
  });

  test.each<[string, Partial<TaskRecord>]>([
    ['whose pull request is recorded as merged', { pr_state: 'merged', pr_closed_at: '2026-11-19T09:15:42Z' }],
    ['whose pull request is recorded as closed', { pr_state: 'closed', pr_closed_at: '2026-11-19T09:15:42Z' }],
    ['whose pull request is recorded as not found', { pr_state: 'not_found' }],
    ['that failed after it opened its pull request', { status: TaskStatus.FAILED }],
    ['that was cancelled', { status: TaskStatus.CANCELLED }],
    ['that is still running', { status: TaskStatus.RUNNING }],
    ['that opened no pull request', { pr_url: undefined }],
    ['whose pull-request URL names no number', { pr_url: 'https://github.com/Acme/Widgets/pulls' }],
    ['that has no repository', { repo: undefined }],
    ['whose repository is one character longer than a full name can be', { repo: repoOfLength(141) }],
    ['that worked on an existing pull request', { resolved_workflow: { id: 'coding/pr-iteration-v1', version: '1.0.0' }, workflow_ref: undefined, pr_number: 12 }],
    ['that is a sub-task of an orchestration', { channel_metadata: inOrchestration('issue-1') }],
    ['that is a sub-task of an orchestration, and whose build failed', { channel_metadata: inOrchestration('issue-1'), build_passed: false }],
    ['that is the integration node of an orchestration', { channel_metadata: inOrchestration(`issue-1${INTEGRATION_NODE_SUFFIX}`) }],
  ])('does not follow a task %s', (_what, overrides) => {
    expect(pullRequestCandidate(task(overrides))).toBeNull();
  });
});

const candidates = (count: number): PullRequestCandidate[] => Array.from({ length: count }, (_, index) => ({
  taskId: `task-${String(index).padStart(4, '0')}`,
  repo: 'acme/widgets',
  number: index + 1,
  recordedOpen: false,
  finishedAtMs: NOW - 48 * HOUR_MS,
}));
const idsOf = (selected: readonly PullRequestCandidate[]): string[] => selected.map((candidate) => candidate.taskId);
const hour = (hours: number): number => (494_000 + hours) * HOUR_MS;

describe('selectForRun', () => {
  test('orders nothing for a run without candidates', () => {
    expect(selectForRun([], hour(0))).toEqual([]);
  });

  test('with no more candidates than one run reads, starts one further each hour', () => {
    const all = candidates(250);
    const ids = idsOf(all);

    expect(idsOf(selectForRun(all, hour(0)))).toEqual(ids);
    expect(idsOf(selectForRun(all, hour(1)))).toEqual([...ids.slice(1), ids[0]]);
    expect(idsOf(selectForRun(all, hour(249)))).toEqual([ids[249], ...ids.slice(0, 249)]);
  });

  test('a run that stops after one read reads another pull request each hour: 100 of them in 100 hours', () => {
    const all = candidates(100);

    const firsts = Array.from({ length: 100 }, (_, run) => selectForRun(all, hour(run))[0].taskId);

    expect(new Set(firsts).size).toBe(100);
  });

  test('with more, a run starts at its share of the list, and the order still holds every candidate', () => {
    const all = candidates(600);
    const ids = idsOf(all);

    expect(idsOf(selectForRun(all, hour(0)))).toEqual([...ids.slice(400), ...ids.slice(0, 400)]);
    expect(idsOf(selectForRun(all, hour(1)))).toEqual(ids);
    expect(idsOf(selectForRun(all, hour(2)))).toEqual([...ids.slice(200), ...ids.slice(0, 200)]);
  });

  test('one candidate more than a run reads makes two shares', () => {
    const all = candidates(251);
    const ids = idsOf(all);

    expect(idsOf(selectForRun(all, hour(0)))).toEqual(ids);
    expect(idsOf(selectForRun(all, hour(1)))).toEqual([...ids.slice(125), ...ids.slice(0, 125)]);
  });

  test('keeps the order all through an hour', () => {
    const all = candidates(600);

    expect(idsOf(selectForRun(all, hour(1) - 1))).toEqual(idsOf(selectForRun(all, hour(0))));
    expect(idsOf(selectForRun(all, hour(1)))).not.toEqual(idsOf(selectForRun(all, hour(0))));
  });

  test('does not depend on the order the candidates arrive in', () => {
    const all = candidates(600);
    const shuffled = [...all.slice(300).reverse(), ...all.slice(0, 300)];

    expect(idsOf(selectForRun(shuffled, hour(0)))).toEqual(idsOf(selectForRun(all, hour(0))));
  });

  test.each([251, 600, 1000, 1001])('while the same %i wait, runs of 250 requests reach each of them within ceil(n / 250) consecutive hours', (count) => {
    const all = candidates(count);
    const hours = Math.ceil(count / 250);

    for (const first of [0, 1, 7]) {
      const seen = new Set<string>();
      for (let run = 0; run < hours; run += 1) {
        for (const id of idsOf(selectForRun(all, hour(first + run)).slice(0, 250))) seen.add(id);
      }
      expect(seen.size).toBe(count);
    }
  });

  test('one candidate more, short of a further run, moves the start of each run by one place at most', () => {
    for (const count of [1001, 1104, 1249]) {
      const before = candidates(count);
      const after = candidates(count + 1);
      const ids = idsOf(after);
      for (let run = 0; run < 5; run += 1) {
        const moved = ids.indexOf(selectForRun(after, hour(run))[0].taskId) - ids.indexOf(selectForRun(before, hour(run))[0].taskId);
        expect(Math.abs(moved)).toBeLessThanOrEqual(1);
      }
    }
  });
});

const CANDIDATE: PullRequestCandidate = { taskId: 'task-1', repo: 'acme/widgets', number: 12, recordedOpen: false, finishedAtMs: NOW - 48 * HOUR_MS };
const RECORDED_OPEN: PullRequestCandidate = { ...CANDIDATE, recordedOpen: true };

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  state: 'open',
  headRef: 'bgagent/task-1/add-a-retry',
  crossRepository: false,
  closedAt: null,
  firstReviewAt: null,
  changesRequested: 0,
  ...overrides,
});

describe('decideRead', () => {
  test('records an open pull request on the first read, and nothing once it is recorded', () => {
    expect(decideRead(CANDIDATE, snapshot(), NOW)).toBe('record_open');
    expect(decideRead(RECORDED_OPEN, snapshot(), NOW)).toBe('nothing');
  });

  test('records a merge at once, whatever the record says so far and whatever GitHub\'s clock says', () => {
    const merged = snapshot({ state: 'merged', closedAt: ago(1000) });

    expect(decideRead(CANDIDATE, merged, NOW)).toBe('record_final');
    expect(decideRead(RECORDED_OPEN, merged, NOW)).toBe('record_final');
    expect(decideRead(CANDIDATE, snapshot({ state: 'merged', closedAt: ago(-MINUTE_MS) }), NOW)).toBe('record_final');
  });

  test.each([
    ['a second ago', 'nothing', 1000],
    ['a second less than an hour ago', 'nothing', HOUR_MS - 1000],
    ['exactly an hour ago', 'record_final', HOUR_MS],
    ['three days ago', 'record_final', 72 * HOUR_MS],
    ['a minute ahead of the clock', 'nothing', -MINUTE_MS],
  ])('a pull request closed %s: %s', (_when, decision, closedForMs) => {
    const closed = snapshot({ state: 'closed', closedAt: ago(closedForMs) });

    expect(decideRead(CANDIDATE, closed, NOW)).toBe(decision);
    expect(decideRead(RECORDED_OPEN, closed, NOW)).toBe(decision);
  });

  test.each([
    ['names another task', 'bgagent/task-2/add-a-retry'],
    ['is not a branch of ABCA', 'feature/add-a-retry'],
    ['has the task id in another place', 'task-1/bgagent/add-a-retry'],
    ['names the task without a branch name after it', 'bgagent/task-1'],
    ['is empty', ''],
  ])('takes a pull request whose head branch %s as not found, whatever its state', (_what, headRef) => {
    expect(decideRead(CANDIDATE, snapshot({ headRef }), NOW)).toBe('pr_not_found');
    expect(decideRead(CANDIDATE, snapshot({ headRef, state: 'merged', closedAt: ago(HOUR_MS) }), NOW)).toBe('pr_not_found');
    expect(decideRead(RECORDED_OPEN, snapshot({ headRef, state: 'closed', closedAt: ago(2 * HOUR_MS) }), NOW)).toBe('pr_not_found');
  });

  test('takes a pull request opened from a fork as not found, whatever its head branch and its state', () => {
    expect(decideRead(CANDIDATE, snapshot({ crossRepository: true }), NOW)).toBe('pr_not_found');
    expect(decideRead(RECORDED_OPEN, snapshot({ crossRepository: true, state: 'merged', closedAt: ago(HOUR_MS) }), NOW)).toBe('pr_not_found');
  });
});

describe('recordsNotFound', () => {
  test.each([
    ['a second less than an hour ago', false, HOUR_MS - 1000],
    ['exactly an hour ago', true, HOUR_MS],
    ['two days ago', true, 48 * HOUR_MS],
  ])('for a task that finished %s: %s', (_when, recorded, finishedForMs) => {
    expect(recordsNotFound({ ...CANDIDATE, finishedAtMs: NOW - finishedForMs }, NOW)).toBe(recorded);
  });

  test('not on a record that holds the state open, however long ago its task finished', () => {
    expect(recordsNotFound(RECORDED_OPEN, NOW)).toBe(false);
  });

  test('not for a task whose record has no usable finish time: how long ago it finished is not known', () => {
    expect(recordsNotFound({ ...CANDIDATE, finishedAtMs: NaN }, NOW)).toBe(false);
  });
});
