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
 * Hourly sweep of pull-request outcomes (scheduled).
 *
 * A task that opened a new pull request is finished while the pull request is
 * still open: whether the work was accepted is decided later, on GitHub. Once an
 * hour this function asks GitHub about each such pull request that is followed
 * ({@link pullRequestCandidate} says which) and has no final state on its task
 * record, and records what it finds: `open` on the first read, then `merged` or
 * `closed` with GitHub's time, the first review and the change requests. A
 * final state is written once, and the pull request is not read again. The
 * write is followed by one metric line in the `ABCA/Factory` namespace. The
 * line is lost when the function dies between the two, and when the SDK retries
 * a write whose response was lost: the retry is refused, like a write that
 * another run made first.
 *
 * The rules are the pure helpers of `./shared/pr-outcome`. This handler owns the
 * I/O: the candidate query, the token, one read of GitHub per pull request, at
 * most one conditional write per read, and the line.
 *
 * A run reads with the platform GitHub token only, and asks GitHub about a
 * bounded number of pull requests: the ones it does not reach wait for a later
 * hour. It stops reading when little of its time is left (`deadline`), when the
 * token's GraphQL budget is low (`floor`), when GitHub refuses the token
 * (`token`), and when GitHub holds the token back or gives several reads in a
 * row no usable answer (`unavailable`). It reads nothing when the secret holds no
 * usable token (`secret`). The constants below hold the numbers. Once a run
 * reads, it does not throw: the failure of one pull request is logged and
 * counted, and the run goes on to the next.
 *
 * A run ends with one summary line, `PR outcome sweep summary`: the fields of
 * {@link RunCounts}, then `stopped` (one of the words above, or `none`). A stop
 * gives the line its level: an error when the token is the problem (`token`,
 * `secret`), a warning for the others. When nothing stopped the run, the line is
 * an error when every pull request it asked about failed, a warning when some
 * failed, and information otherwise. A run that cannot read its candidates fails
 * without one, and the invocation is retried.
 */

import { QueryCommand, UpdateCommand, type UpdateCommandInput, type UpdateCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { TaskStatus } from '../constructs/task-status';
import { resolveGitHubToken } from './shared/context-hydration';
import { logger } from './shared/logger';
import {
  decideRead,
  fetchPullRequest,
  finalStateUpdate,
  GitHubNoAnswerError,
  GitHubStopError,
  openStateUpdate,
  PR_SWEEP_MAX_PULL_REQUESTS,
  pullRequestCandidate,
  selectForRun,
  type PullRequestCandidate,
  type PullRequestSnapshot,
} from './shared/pr-outcome';
import { prOutcomeMetricLine, SCOREBOARD_PROJECTION, taskFacts, type ScoreboardTask } from './shared/scoreboard';
import type { TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';

const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const STATUS_INDEX = process.env.TASK_STATUS_INDEX_NAME!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN!;
const ddb = makeDocClient();

/**
 * The run stops reading when less of the function's time is left (ms): room for a read that
 * waits for GitHub as long as it may, and for the write that comes after it.
 */
const PR_SWEEP_DEADLINE_MARGIN_MS = 30_000;

/**
 * The run stops reading when the token's GraphQL budget is under this many points. The
 * agents' `gh` commands draw on the same budget: what is left of it is theirs.
 */
const PR_SWEEP_RATE_LIMIT_FLOOR = 1_000;

/**
 * The run stops reading when this many reads in a row get no usable answer from GitHub. One
 * such read can be the fault of its pull request, and ending the run on it would keep the
 * pull requests behind it from ever being read; several in a row are GitHub being away.
 */
const PR_SWEEP_NO_ANSWER_LIMIT = 3;

/**
 * A final state older than this many days is recorded without a metric line. The line is
 * stamped with GitHub's close time, and CloudWatch drops a timestamp older than 14 days
 * without a word. It happens to a pull request that was closed long before its first read:
 * one from before the sweep was deployed, or one that waited behind a backlog.
 */
const PR_OUTCOME_METRIC_MAX_AGE_DAYS = 13;

/** A token as a request header can carry it: printable ASCII, from the space to the tilde. */
const USABLE_TOKEN = /^[ -~]+$/;

/** The numbers of one run, in the order the summary line carries them. */
interface RunCounts {
  /** Task records the candidate query read: every COMPLETED task there is. */
  readonly scanned: number;
  /** Followed pull requests without a final state on record. */
  readonly candidates: number;
  /** Pull requests the run asked GitHub about. */
  read: number;
  /** Final states the run recorded, by state. */
  merged: number;
  closed: number;
  /** Pull requests the run found open. */
  open: number;
  /** Pull requests in a repository that GitHub does not show to the token: the one whose read said so, and those not read for it. */
  repo_not_visible: number;
  /** Pull requests that GitHub does not have under the recorded number, or has from another branch than the task's. */
  pr_not_found: number;
  /** Pull requests whose read or write failed; each is logged. */
  failed: number;
  /** Candidates the run did not reach, whatever ended it. */
  left_out: number;
  /** Final states recorded without a metric line. */
  not_emitted: number;
}

/** Why a run stopped reading; `none` when nothing but its own cap ended it. */
type Stop = 'none' | 'deadline' | 'floor' | 'unavailable' | 'token' | 'secret';

/** The level of a stop: an error when the token is the problem, so that an expired one is seen. */
const STOP_LEVEL: Readonly<Record<Stop, 'info' | 'warn' | 'error'>> = {
  none: 'info',
  deadline: 'warn',
  floor: 'warn',
  unavailable: 'warn',
  token: 'error',
  secret: 'error',
};

/**
 * The level of the summary line. A failure that is none of the stops is counted per pull
 * request and stops nothing, so a run in which all of them fail would end like a good one:
 * the level says it instead, as it does for the scheduled neighbours.
 */
function summaryLevel(stopped: Stop, counts: RunCounts): 'info' | 'warn' | 'error' {
  if (stopped !== 'none' || counts.failed === 0) return STOP_LEVEL[stopped];
  return counts.failed === counts.read ? 'error' : 'warn';
}

/** The pull requests to follow, and how many task records the query read to find them. */
async function loadCandidates(): Promise<{ scanned: number; candidates: PullRequestCandidate[] }> {
  const candidates: PullRequestCandidate[] = [];
  let scanned = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    // Every hour this reads every COMPLETED task there is: the filter runs after the read, and
    // saves bytes, not read units. That is fine while the tasks in retention number in the tens
    // of thousands. Beyond that, the read needs a sparse index on an attribute that a task
    // carries only while its pull request is open, so that it reads those tasks alone.
    const page = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE_NAME,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#status = :completed',
      FilterExpression: 'attribute_exists(pr_url) AND (attribute_not_exists(pr_state) OR pr_state = :open)',
      ExpressionAttributeValues: { ':completed': TaskStatus.COMPLETED, ':open': 'open' },
      ...SCOREBOARD_PROJECTION,
      ...(startKey && { ExclusiveStartKey: startKey }),
    }));
    scanned += page.ScannedCount ?? 0;
    for (const task of (page.Items ?? []) as ScoreboardTask[]) {
      const candidate = pullRequestCandidate(task);
      if (candidate) candidates.push(candidate);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return { scanned, candidates };
}

/**
 * One conditional write. `refused` when its condition failed, which happens in three ways:
 * another run recorded a state first, the SDK retried a write of this run that had landed,
 * or the task is gone. Nothing is left to record then.
 */
async function write(input: UpdateCommandInput): Promise<UpdateCommandOutput | 'refused'> {
  try {
    return await ddb.send(new UpdateCommand(input));
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return 'refused';
    throw err;
  }
}

/** The metric line of a final state, built from the record as the write left it; null when the close is too old for CloudWatch. */
function outcomeLine(task: TaskRecord | undefined, nowMs: number): string | null {
  const facts = task && taskFacts(task);
  if (!task || !facts || facts.prClosedAtMs === null) return null;
  if (nowMs - facts.prClosedAtMs > PR_OUTCOME_METRIC_MAX_AGE_DAYS * 24 * 3600 * 1000) return null;
  // The plain fields of the task's own line: whose task it is, where, and what it ran.
  return prOutcomeMetricLine(facts, { user_id: task.user_id, repo: task.repo, workflow: task.resolved_workflow?.id });
}

/** Record a final state, once, and write its metric line. */
async function recordFinal(candidate: PullRequestCandidate, snapshot: PullRequestSnapshot, nowMs: number, counts: RunCounts): Promise<void> {
  const written = await write(finalStateUpdate(TASK_TABLE_NAME, candidate.taskId, snapshot));
  if (written === 'refused') {
    // Not counted: another run that wrote the state counted it, and a write of this run that
    // landed without its answer cannot be told from that. Said, because the line may be the lost one.
    logger.info('PR outcome sweep: a final write was refused', { task_id: candidate.taskId, state: snapshot.state });
    return;
  }
  counts[snapshot.state] += 1;
  const line = outcomeLine(written.Attributes as TaskRecord | undefined, nowMs);
  if (line === null) counts.not_emitted += 1;
  else process.stdout.write(line + '\n');
}

/**
 * Count a task whose recorded number leads to no pull request of its own, and name it. The
 * line comes again in every run that reads the pull request, until the task record expires:
 * information for a number GitHub does not have, a warning for a pull request of another
 * branch, which a record should never name. The branch is GitHub's text and stays out of it.
 */
function notFound(candidate: PullRequestCandidate, why: 'not_found' | 'other_head_branch', counts: RunCounts): void {
  counts.pr_not_found += 1;
  logger[why === 'not_found' ? 'info' : 'warn']('PR outcome sweep: no pull request of the task under the recorded number', {
    task_id: candidate.taskId,
    repo: candidate.repo,
    pr_number: candidate.number,
    why,
  });
}

/** Do what one read asks of the task record, and count what the read found. */
async function record(candidate: PullRequestCandidate, snapshot: PullRequestSnapshot, nowMs: number, counts: RunCounts): Promise<void> {
  const decision = decideRead(candidate, snapshot, nowMs);
  if (decision === 'pr_not_found') {
    notFound(candidate, 'other_head_branch', counts);
    return;
  }
  if (decision === 'record_open') await write(openStateUpdate(TASK_TABLE_NAME, candidate.taskId));
  if (decision === 'record_final') await recordFinal(candidate, snapshot, nowMs, counts);
  // Open is counted as found, whichever run recorded it.
  if (snapshot.state === 'open') counts.open += 1;
}

/** Say in a line of its own why GitHub ended the run, and on which pull request; the summary line follows it. */
function stoppedByGitHub(reason: 'token' | 'unavailable', detail: { task_id: string; http_status?: number; error: string }): Stop {
  logger[STOP_LEVEL[reason]]('PR outcome sweep: stopped by GitHub', detail);
  return reason;
}

/** What keeps the run from another read, `none` when nothing does. */
function stopBeforeRead(context: Context, remaining: number | null): Stop {
  if (context.getRemainingTimeInMillis() < PR_SWEEP_DEADLINE_MARGIN_MS) return 'deadline';
  return remaining !== null && remaining < PR_SWEEP_RATE_LIMIT_FLOOR ? 'floor' : 'none';
}

/**
 * Walk the candidates in the run's order, read each and record what the read says, until a
 * stop or until the run has asked GitHub as often as it may. Returns the stop, and leaves in
 * `counts.left_out` how many candidates the walk did not reach.
 */
async function readPullRequests(
  selected: readonly PullRequestCandidate[],
  token: string,
  context: Context,
  nowMs: number,
  counts: RunCounts,
): Promise<Stop> {
  const hiddenRepos = new Set<string>();
  let remaining: number | null = null;
  // How many reads in a row, up to the last one, GitHub gave no usable answer to.
  let unanswered = 0;
  let reached = 0;
  let stopped: Stop = 'none';
  for (const candidate of selected) {
    // The cap is on what the run asks GitHub: a candidate it passes over without a request
    // takes no place. A run that has asked as often as it may has ended, not stopped.
    if (counts.read === PR_SWEEP_MAX_PULL_REQUESTS) break;
    // Before a read, never between a read and its write: a stop leaves nothing half done.
    stopped = stopBeforeRead(context, remaining);
    if (stopped !== 'none') break;
    reached += 1;
    const repo = candidate.repo.toLowerCase();
    if (hiddenRepos.has(repo)) {
      counts.repo_not_visible += 1;
      continue;
    }
    try {
      counts.read += 1;
      const { read, rateLimitRemaining } = await fetchPullRequest(candidate.repo, candidate.number, token);
      remaining = rateLimitRemaining;
      unanswered = 0;
      if (read.kind === 'repo_not_visible') {
        hiddenRepos.add(repo);
        counts.repo_not_visible += 1;
        logger.warn('PR outcome sweep: GitHub does not show a repository to the platform token', { repo: candidate.repo });
      } else if (read.kind === 'pr_not_found') {
        notFound(candidate, 'not_found', counts);
      } else {
        await record(candidate, read.snapshot, nowMs, counts);
      }
    } catch (err) {
      if (err instanceof GitHubStopError) {
        stopped = stoppedByGitHub(err.reason, { task_id: candidate.taskId, http_status: err.httpStatus, error: err.message });
        break;
      }
      const noAnswer = err instanceof GitHubNoAnswerError ? err : undefined;
      counts.failed += 1;
      logger.warn('PR outcome sweep: a pull request failed', {
        task_id: candidate.taskId,
        http_status: noAnswer?.httpStatus,
        error: err instanceof Error ? err.message : String(err),
      });
      // An answer that fails one pull request is an answer all the same: GitHub is there.
      unanswered = noAnswer ? unanswered + 1 : 0;
      if (unanswered === PR_SWEEP_NO_ANSWER_LIMIT) {
        stopped = stoppedByGitHub('unavailable', { task_id: candidate.taskId, error: `GitHub gave no usable answer to ${unanswered} reads in a row` });
        break;
      }
    }
  }
  counts.left_out = selected.length - reached;
  return stopped;
}

/** Take the platform token and read with it. Returns why the run stopped, `none` when nothing but its cap ended it. */
async function sweep(selected: readonly PullRequestCandidate[], context: Context, nowMs: number, counts: RunCounts): Promise<Stop> {
  let secret: string;
  try {
    // The platform token only: a repository's own token is in a secret this function may not read.
    secret = await resolveGitHubToken(GITHUB_TOKEN_SECRET_ARN);
  } catch (err) {
    // The resolver's message names the secret and what is wrong with it; the name of its cause is Secrets Manager's own word for it.
    const cause = (err as { cause?: { name?: unknown } | null } | null)?.cause?.name;
    logger.error('PR outcome sweep: the secret of the platform GitHub token cannot be read', {
      error: err instanceof Error ? err.message : String(err),
      cause: typeof cause === 'string' ? cause : undefined,
    });
    return 'secret';
  }
  const token = secret.trim();
  if (!USABLE_TOKEN.test(token)) {
    // Said here, without the value: `fetch` refuses such a header before any request, in a
    // message that quotes it, and every run would read as GitHub being away.
    logger.error('PR outcome sweep: the secret of the platform GitHub token holds no usable token', {
      error: 'the value is empty, or holds a character that a request header cannot carry',
    });
    return 'secret';
  }
  return readPullRequests(selected, token, context, nowMs, counts);
}

/** Scheduled entrypoint: one run of the sweep. */
export async function handler(_event: unknown, context: Context): Promise<void> {
  const nowMs = Date.now();
  const { scanned, candidates } = await loadCandidates();
  const selected = selectForRun(candidates, nowMs);
  const counts: RunCounts = {
    scanned,
    candidates: candidates.length,
    read: 0,
    merged: 0,
    closed: 0,
    open: 0,
    repo_not_visible: 0,
    pr_not_found: 0,
    failed: 0,
    left_out: selected.length,
    not_emitted: 0,
  };
  // The token is fetched only for a run that has something to read.
  const stopped = selected.length > 0 ? await sweep(selected, context, nowMs, counts) : 'none';
  logger[summaryLevel(stopped, counts)]('PR outcome sweep summary', { ...counts, stopped });
}
