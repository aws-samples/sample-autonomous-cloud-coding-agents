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

import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { taskFacts, type ScoreboardTask } from './scoreboard';
import { extractTaskIdFromBranch } from './screenshot-url';
import { prNumberFromTask } from './task-pr-number';
import { isValidRepo } from './validation';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state mergedAt closedAt headRefName isCrossRepository
      author { login }
      reviews(first: 100) { nodes { state submittedAt authorCanPushToRepository author { login __typename } } }
    }
  }
}`;

const PULL_REQUEST_READ_TIMEOUT_MS = 5_000;

const MS_PER_HOUR = 3600 * 1000;

/**
 * The most pull requests one run asks GitHub about. A read spends one point of the token's
 * GraphQL budget, 5,000 an hour.
 */
export const PR_SWEEP_MAX_PULL_REQUESTS = 250;

/** On GitHub a closed pull request can be reopened. */
const MIN_CLOSED_AGE_MS = MS_PER_HOUR;

/** A pull request that was just opened can be missing from GitHub's answer. */
const MIN_FINISHED_AGE_MS = MS_PER_HOUR;

/** The longest full name a repository has on GitHub: 39 characters of owner, a slash, 100 of name. */
const REPO_FULL_NAME_MAX_LENGTH = 140;

/** What GitHub says about one pull request. */
export interface PullRequestSnapshot {
  readonly state: 'open' | 'merged' | 'closed';
  /** The branch it was opened from. GitHub keeps the name after the branch is deleted. */
  readonly headRef: string;
  /** The head branch is in another repository than the pull request's own: a fork. */
  readonly crossRepository: boolean;
  /** GitHub's merge time when merged, its close time when closed, null while open. */
  readonly closedAt: string | null;
  /** The earliest review that counts; null without one. */
  readonly firstReviewAt: string | null;
  /** How many of the reviews that count requested changes. */
  readonly changesRequested: number;
}

/** What one read says. A read that fails throws. */
export type PullRequestRead =
  | { readonly kind: 'snapshot'; readonly snapshot: PullRequestSnapshot }
  | { readonly kind: 'repo_not_visible' }
  | { readonly kind: 'pr_not_found' };

/**
 * The run must end: GitHub turns the token away, and the next request would get the same.
 * `token`: GitHub refused it (HTTP 401). `unavailable`: GitHub is holding it back (HTTP 403 or
 * 429, an answer of any status but 401 that carries a `retry-after` header, whatever its body
 * holds, or a 200 whose error is `RATE_LIMITED`).
 */
export class GitHubStopError extends Error {
  public readonly reason: 'token' | 'unavailable';
  public readonly httpStatus: number;

  constructor(reason: 'token' | 'unavailable', message: string, httpStatus: number) {
    super(message);
    this.name = 'GitHubStopError';
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

/**
 * GitHub gave no usable answer to one read: HTTP 5xx, no answer at all (a network error, a
 * timeout, a redirect), or a 200 whose body is cut short, is not JSON, or holds neither data
 * nor errors.
 */
export class GitHubNoAnswerError extends Error {
  /** The HTTP status of the answer; undefined when GitHub gave none. */
  public readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'GitHubNoAnswerError';
    this.httpStatus = httpStatus;
  }
}

interface Answer {
  readonly data?: {
    readonly rateLimit?: { readonly remaining?: unknown } | null;
    readonly repository?: { readonly pullRequest?: PullRequestNode | null } | null;
  } | null;
  readonly errors?: unknown;
}

interface PullRequestNode {
  readonly state?: unknown;
  readonly mergedAt?: unknown;
  readonly closedAt?: unknown;
  readonly headRefName?: unknown;
  readonly isCrossRepository?: unknown;
  readonly author?: { readonly login?: unknown } | null;
  readonly reviews?: { readonly nodes?: unknown } | null;
}

interface ReviewNode {
  readonly state?: unknown;
  readonly submittedAt?: unknown;
  readonly authorCanPushToRepository?: unknown;
  readonly author?: { readonly login?: unknown; readonly __typename?: unknown } | null;
}

interface GraphQlError {
  readonly type?: unknown;
  readonly path?: unknown;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function stateOf(state: unknown): PullRequestSnapshot['state'] | null {
  if (state === 'OPEN') return 'open';
  if (state === 'MERGED') return 'merged';
  return state === 'CLOSED' ? 'closed' : null;
}

/**
 * On GitHub each reply to a review thread is a review of its own. GitHub reports a
 * dismissed review as `DISMISSED` whatever it was, and a change request that an approval
 * replaced as `CHANGES_REQUESTED` still.
 */
function reviewsOf(pullRequest: PullRequestNode): Pick<PullRequestSnapshot, 'firstReviewAt' | 'changesRequested'> {
  const author = pullRequest.author?.login;
  const nodes = pullRequest.reviews?.nodes;
  const reviews: readonly (ReviewNode | null)[] = Array.isArray(nodes) ? nodes : [];
  let firstReviewAt: string | null = null;
  let changesRequested = 0;
  for (const review of reviews) {
    if (review?.author?.__typename !== 'User' || review.author.login === author) continue;
    const { submittedAt } = review;
    if (review.authorCanPushToRepository !== true || !isTime(submittedAt)) continue;
    if (firstReviewAt === null || Date.parse(submittedAt) < Date.parse(firstReviewAt)) firstReviewAt = submittedAt;
    if (review.state === 'CHANGES_REQUESTED') changesRequested += 1;
  }
  return { firstReviewAt, changesRequested };
}

function snapshotOf(pullRequest: PullRequestNode): PullRequestSnapshot {
  const state = stateOf(pullRequest.state);
  const { headRefName: headRef, isCrossRepository: crossRepository } = pullRequest;
  const closedAt = state === 'merged' ? pullRequest.mergedAt : pullRequest.closedAt;
  if (state !== null && typeof headRef === 'string' && typeof crossRepository === 'boolean') {
    if (state === 'open') return { state, headRef, crossRepository, closedAt: null, ...reviewsOf(pullRequest) };
    if (isTime(closedAt)) return { state, headRef, crossRepository, closedAt, ...reviewsOf(pullRequest) };
  }
  throw new Error('GitHub answered with a pull request that is missing its state, head branch, fork flag or close time');
}

function errorsOf(answer: Answer | null): { type: string; path: string }[] {
  const listed = answer?.errors;
  const errors: readonly (GraphQlError | null)[] = Array.isArray(listed) ? listed : [];
  return errors.map((error) => {
    const type = error?.type;
    const path = error?.path;
    return { type: typeof type === 'string' ? type : 'untyped', path: Array.isArray(path) ? path.join('.') : '' };
  });
}

function readAnswer(body: unknown): { read: PullRequestRead; rateLimitRemaining: number | null } {
  const answer = body as Answer | null;
  const errors = errorsOf(answer);
  const has = (type: string, path?: string): boolean => errors.some((error) => error.type === type && (path === undefined || error.path === path));
  if (has('RATE_LIMITED')) throw new GitHubStopError('unavailable', 'GitHub answered RATE_LIMITED', 200);

  const data = answer?.data;
  const remaining = data?.rateLimit?.remaining;
  const rateLimitRemaining = typeof remaining === 'number' ? remaining : null;
  // GitHub answers alike for a repository that does not exist and for one the token may not see.
  // The permission to read a pull request is the repository's: it holds for every pull request there.
  if (has('NOT_FOUND', 'repository') || has('FORBIDDEN', 'repository') || has('FORBIDDEN', 'repository.pullRequest')) {
    return { read: { kind: 'repo_not_visible' }, rateLimitRemaining };
  }
  if (errors.length === 1 && has('NOT_FOUND', 'repository.pullRequest') && data?.repository?.pullRequest === null) {
    return { read: { kind: 'pr_not_found' }, rateLimitRemaining };
  }

  if (errors.length > 0) {
    throw new Error(`GitHub answered with errors: ${[...new Set(errors.map((error) => error.type))].join(', ')}`);
  }
  if (typeof data !== 'object' || data === null) throw new GitHubNoAnswerError('GitHub answered HTTP 200 with neither data nor errors', 200);
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new Error('GitHub answered without a pull request');
  return { read: { kind: 'snapshot', snapshot: snapshotOf(pullRequest) }, rateLimitRemaining };
}

/**
 * Never the error's message: the one about a body that is not JSON quotes the body, and the
 * one about a header that cannot be sent quotes the header.
 */
function failureOf(err: unknown): string {
  const { name, cause } = (err ?? {}) as { name?: unknown; cause?: { code?: unknown } | null };
  return [name, cause?.code].filter((part) => typeof part === 'string').join(', ') || 'error';
}

/**
 * Read one pull request from GitHub: one request, one point of the token's GraphQL budget.
 * `rateLimitRemaining` is what the answer says is left of that budget, null when it does not
 * say. Three ways to fail: {@link GitHubStopError} for an answer that ends the run,
 * {@link GitHubNoAnswerError} when GitHub gave this read no usable answer, and a plain `Error`
 * when GitHub answered and the read of this one pull request failed all the same: another
 * HTTP status, a 200 with another GraphQL error, or a 200 without a pull request this read
 * can use. None of them carries the error it was made from.
 */
export async function fetchPullRequest(
  repo: string,
  number: number,
  token: string,
): Promise<{ read: PullRequestRead; rateLimitRemaining: number | null }> {
  if (!isValidRepo(repo)) return { read: { kind: 'repo_not_visible' }, rateLimitRemaining: null };
  const [owner, name] = repo.split('/');
  let status: number | undefined;
  let answered: { readonly waits: boolean; readonly body: unknown } | undefined;
  let failure: string | undefined;
  try {
    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query: PULL_REQUEST_QUERY, variables: { owner, name, number } }),
      redirect: 'error',
      signal: AbortSignal.timeout(PULL_REQUEST_READ_TIMEOUT_MS),
    });
    status = response.status;
    const waits = response.headers.has('retry-after');
    answered = { waits, body: status === 200 && !waits ? await response.json() : undefined };
  } catch (err) {
    failure = failureOf(err);
  }
  if (status === undefined || answered === undefined) throw new GitHubNoAnswerError(`GitHub gave no usable answer (${failure})`, status);
  if (status === 401) throw new GitHubStopError('token', 'GitHub refused the token (HTTP 401)', status);
  // GitHub sends `retry-after` when it wants the caller to wait, and it can do so with a 200.
  if (answered.waits) throw new GitHubStopError('unavailable', `GitHub answered HTTP ${status} and asked to wait`, status);
  // GitHub answers 403 or 429 to a token it is holding back.
  if (status === 403 || status === 429) throw new GitHubStopError('unavailable', `GitHub answered HTTP ${status}`, status);
  if (status >= 500) throw new GitHubNoAnswerError(`GitHub answered HTTP ${status}`, status);
  if (status !== 200) throw new Error(`GitHub answered HTTP ${status}`);
  return readAnswer(answered.body);
}

/** A followed pull request whose record holds no state, or `open`: one that the sweep reads. */
export interface PullRequestCandidate {
  readonly taskId: string;
  /** `owner/name`, as the task record has it. */
  readonly repo: string;
  readonly number: number;
  /** An earlier read recorded the pull request as open. */
  readonly recordedOpen: boolean;
  /** Epoch milliseconds of the task's finish; NaN when the record has no usable time. */
  readonly finishedAtMs: number;
}

/**
 * The pull request to follow for a task; null for a task that has none. Followed: the new
 * pull request of a task that ended normally, until a read records what became of it: a
 * final state, or that GitHub has no such pull request of the task. Not followed: a pull
 * request opened by a task that failed, the pull requests of an orchestration, and a pull
 * request a task only worked on. A record without a repository GitHub can have, or without
 * the number, gives no candidate either.
 */
export function pullRequestCandidate(task: ScoreboardTask): PullRequestCandidate | null {
  const facts = taskFacts(task);
  const number = prNumberFromTask(task);
  if (!facts?.prFollowed || typeof task.repo !== 'string' || task.repo.length > REPO_FULL_NAME_MAX_LENGTH || number === null) return null;
  if (facts.prState !== null && facts.prState !== 'open') return null;
  return { taskId: task.task_id, repo: task.repo, number, recordedOpen: facts.prState === 'open', finishedAtMs: facts.finishedAtMs };
}

/**
 * The candidates in the order one run reads them. A run asks GitHub about at most
 * `PR_SWEEP_MAX_PULL_REQUESTS` of them, so with more candidates than that it takes several
 * runs to pass over them all: run k of such a pass starts at the k-th share of the list,
 * which moves by a few places when a few candidates join or leave. With no more candidates
 * than one run reads, the start moves by one an hour instead, so that a run that stops early
 * every time does not stop before the same ones every time.
 *
 * None is left out by rule: every run has them all in its order. The order is by task id,
 * so that it does not depend on the order in which the table returned them.
 */
export function selectForRun(candidates: readonly PullRequestCandidate[], nowMs: number): PullRequestCandidate[] {
  const ordered = [...candidates].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const hour = Math.floor(nowMs / MS_PER_HOUR);
  const runs = Math.ceil(ordered.length / PR_SWEEP_MAX_PULL_REQUESTS);
  const start = runs > 1 ? Math.floor(((hour % runs) * ordered.length) / runs) : hour % ordered.length;
  return ordered.map((_, offset) => ordered[(start + offset) % ordered.length]);
}

/**
 * What one read asks of the task record:
 *  - `pr_not_found`: the pull request under that number is not this task's;
 *  - `nothing`: no change: open and recorded as open, or closed too recently to be final;
 *  - `record_open`: the first read, and it is open;
 *  - `record_final`: merged, or closed for at least an hour.
 */
export type ReadDecision = 'pr_not_found' | 'nothing' | 'record_open' | 'record_final';

export function decideRead(candidate: PullRequestCandidate, snapshot: PullRequestSnapshot, nowMs: number): ReadDecision {
  if (snapshot.crossRepository || extractTaskIdFromBranch(snapshot.headRef) !== candidate.taskId) return 'pr_not_found';
  if (snapshot.state === 'open') return candidate.recordedOpen ? 'nothing' : 'record_open';
  if (snapshot.state === 'merged') return 'record_final';
  return nowMs - Date.parse(snapshot.closedAt ?? '') >= MIN_CLOSED_AGE_MS ? 'record_final' : 'nothing';
}

/**
 * Whether a read that found no pull request of the task is recorded. Only on a record
 * without a state: a pull request that an earlier read recorded as open keeps that state,
 * and its task stays a candidate.
 */
export function recordsNotFound(candidate: PullRequestCandidate, nowMs: number): boolean {
  return !candidate.recordedOpen && nowMs - candidate.finishedAtMs >= MIN_FINISHED_AGE_MS;
}

/**
 * The write on a record without a state: `open` for a pull request found open, `not_found`
 * when GitHub has no pull request of the task under the recorded number. Like the final
 * write, it sets nothing else: `updated_at` is the finish time of a record without
 * `completed_at`, and `ttl` is the record's retention.
 */
export function firstStateUpdate(tableName: string, taskId: string, state: 'open' | 'not_found'): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { task_id: taskId },
    UpdateExpression: `SET pr_state = :${state}`,
    // Without the test on the key, the update of a task that is gone creates an item.
    ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(pr_state)',
    ExpressionAttributeValues: { [`:${state}`]: state },
  };
}

/**
 * The write of a final state, for a snapshot that {@link decideRead} found final. It lands
 * once: the condition lets it through on a record without a state or with `open`, and
 * refuses every other. It returns the record as the write left it, which is what the
 * metric line is built from.
 */
export function finalStateUpdate(tableName: string, taskId: string, snapshot: PullRequestSnapshot): UpdateCommandInput {
  // The document client rejects `undefined`.
  const reviewed = snapshot.firstReviewAt !== null;
  return {
    TableName: tableName,
    Key: { task_id: taskId },
    UpdateExpression: 'SET pr_state = :state, pr_closed_at = :closed_at, pr_changes_requested = :changes_requested'
      + (reviewed ? ', pr_first_review_at = :first_review_at' : ''),
    ConditionExpression: 'attribute_exists(task_id) AND (attribute_not_exists(pr_state) OR pr_state = :open)',
    ExpressionAttributeValues: {
      ':state': snapshot.state,
      ':closed_at': snapshot.closedAt,
      ':changes_requested': snapshot.changesRequested,
      ':open': 'open',
      ...(reviewed && { ':first_review_at': snapshot.firstReviewAt }),
    },
    ReturnValues: 'ALL_NEW',
  };
}
