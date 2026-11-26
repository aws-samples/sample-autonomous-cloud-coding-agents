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

import { PutCommand, QueryCommand, UpdateCommand, type UpdateCommandInput, type UpdateCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { ulid } from 'ulid';
import { TaskStatus } from '../constructs/task-status';
import { resolveGitHubToken } from './shared/context-hydration';
import { logger } from './shared/logger';
import {
  decideRead,
  fetchPullRequest,
  finalStateUpdate,
  firstStateUpdate,
  GitHubNoAnswerError,
  GitHubStopError,
  PR_SWEEP_MAX_PULL_REQUESTS,
  pullRequestCandidate,
  recordsNotFound,
  selectForRun,
  type PullRequestCandidate,
  type PullRequestSnapshot,
} from './shared/pr-outcome';
import { prOutcomeMetricLine, SCOREBOARD_PROJECTION, taskFacts, type ScoreboardTask } from './shared/scoreboard';
import type { TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';
import { computeTtlEpoch, isValidRepo } from './shared/validation';

const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const STATUS_INDEX = process.env.TASK_STATUS_INDEX_NAME!;
const TASK_EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN!;
const ddb = makeDocClient();

const PR_SWEEP_DEADLINE_MARGIN_MS = 30_000;

const PR_SWEEP_RATE_LIMIT_FLOOR = 1_000;

const PR_SWEEP_NO_ANSWER_LIMIT = 3;

/** CloudWatch drops a metric timestamp older than 14 days without a word. */
const PR_OUTCOME_METRIC_MAX_AGE_DAYS = 13;

const PR_OUTCOME_EVENT_TYPE = 'pr_outcome_recorded';

const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

const USABLE_TOKEN = /^[ -~]+$/;

/** Classic, fine-grained and installation GitHub tokens hold no other character. */
const GITHUB_TOKEN = /^[A-Za-z0-9_.-]+$/;

const HOLDS_GITHUB_TOKEN = /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/;

interface RunCounts {
  readonly scanned: number;
  readonly candidates: number;
  read: number;
  merged: number;
  closed: number;
  open: number;
  repo_not_visible: number;
  pr_not_found: number;
  failed: number;
  left_out: number;
  not_emitted: number;
}

type Stop = 'none' | 'deadline' | 'floor' | 'unavailable' | 'token' | 'secret' | 'no_token';

const STOP_LEVEL: Readonly<Record<Stop, 'info' | 'warn' | 'error'>> = {
  none: 'info',
  deadline: 'warn',
  floor: 'warn',
  unavailable: 'warn',
  token: 'error',
  secret: 'error',
  no_token: 'info',
};

function summaryLevel(stopped: Stop, counts: RunCounts): 'info' | 'warn' | 'error' {
  if (stopped !== 'none' || counts.failed === 0) return STOP_LEVEL[stopped];
  return counts.failed === counts.read ? 'error' : 'warn';
}

async function loadCandidates(): Promise<{ scanned: number; candidates: PullRequestCandidate[] }> {
  const candidates: PullRequestCandidate[] = [];
  let scanned = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
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

async function write(input: UpdateCommandInput): Promise<UpdateCommandOutput | 'refused'> {
  try {
    return await ddb.send(new UpdateCommand(input));
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return 'refused';
    throw err;
  }
}

function outcomeLine(task: TaskRecord | undefined, nowMs: number): string | null {
  const facts = task && taskFacts(task);
  if (!task || !facts || facts.prClosedAtMs === null) return null;
  if (nowMs - facts.prClosedAtMs > PR_OUTCOME_METRIC_MAX_AGE_DAYS * 24 * 3600 * 1000) return null;
  return prOutcomeMetricLine(facts, { user_id: task.user_id, repo: task.repo, workflow: task.resolved_workflow?.id });
}

async function writeOutcomeEvent(candidate: PullRequestCandidate, snapshot: PullRequestSnapshot, task: TaskRecord | undefined): Promise<void> {
  try {
    await ddb.send(new PutCommand({
      TableName: TASK_EVENTS_TABLE_NAME,
      Item: {
        task_id: candidate.taskId,
        event_id: ulid(),
        event_type: PR_OUTCOME_EVENT_TYPE,
        timestamp: new Date(Date.now()).toISOString(),
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        ...(task?.user_id && { user_id: task.user_id }),
        ...(task?.repo && { repo: task.repo }),
        metadata: {
          pr_state: snapshot.state,
          pr_closed_at: snapshot.closedAt,
          pr_changes_requested: snapshot.changesRequested,
          // The document client rejects `undefined` inside a map: no review, no entry.
          ...(snapshot.firstReviewAt !== null && { pr_first_review_at: snapshot.firstReviewAt }),
        },
      },
    }));
  } catch (err) {
    logger.warn('PR outcome sweep: the event of a recorded state was not written', {
      task_id: candidate.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function recordFinal(candidate: PullRequestCandidate, snapshot: PullRequestSnapshot, nowMs: number, counts: RunCounts): Promise<void> {
  const written = await write(finalStateUpdate(TASK_TABLE_NAME, candidate.taskId, snapshot));
  if (written === 'refused') {
    logger.info('PR outcome sweep: a final write was refused', { task_id: candidate.taskId, state: snapshot.state });
    return;
  }
  counts[snapshot.state] += 1;
  const task = written.Attributes as TaskRecord | undefined;
  const line = outcomeLine(task, nowMs);
  if (line === null) counts.not_emitted += 1;
  else process.stdout.write(line + '\n');
  await writeOutcomeEvent(candidate, snapshot, task);
}

async function notFound(
  candidate: PullRequestCandidate,
  why: 'not_found' | 'other_head_branch',
  nowMs: number,
  counts: RunCounts,
): Promise<void> {
  if (recordsNotFound(candidate, nowMs)) await write(firstStateUpdate(TASK_TABLE_NAME, candidate.taskId, 'not_found'));
  counts.pr_not_found += 1;
  logger[why === 'not_found' ? 'info' : 'warn']('PR outcome sweep: no pull request of the task under the recorded number', {
    task_id: candidate.taskId,
    repo: candidate.repo,
    pr_number: candidate.number,
    why,
  });
}

async function record(candidate: PullRequestCandidate, snapshot: PullRequestSnapshot, nowMs: number, counts: RunCounts): Promise<void> {
  const decision = decideRead(candidate, snapshot, nowMs);
  if (decision === 'pr_not_found') {
    await notFound(candidate, 'other_head_branch', nowMs, counts);
    return;
  }
  if (decision === 'record_open') await write(firstStateUpdate(TASK_TABLE_NAME, candidate.taskId, 'open'));
  if (decision === 'record_final') await recordFinal(candidate, snapshot, nowMs, counts);
  if (snapshot.state === 'open') counts.open += 1;
}

function stoppedByGitHub(reason: 'token' | 'unavailable', detail: { task_id: string; http_status?: number; error: string }): Stop {
  logger[STOP_LEVEL[reason]]('PR outcome sweep: stopped by GitHub', detail);
  return reason;
}

function stopBeforeRead(context: Context, remaining: number | null): Stop {
  if (context.getRemainingTimeInMillis() < PR_SWEEP_DEADLINE_MARGIN_MS) return 'deadline';
  return remaining !== null && remaining < PR_SWEEP_RATE_LIMIT_FLOOR ? 'floor' : 'none';
}

async function readPullRequests(
  selected: readonly PullRequestCandidate[],
  token: string,
  context: Context,
  nowMs: number,
  counts: RunCounts,
): Promise<Stop> {
  const hiddenRepos = new Set<string>();
  let remaining: number | null = null;
  let unanswered = 0;
  let reached = 0;
  let stopped: Stop = 'none';
  for (const candidate of selected) {
    if (counts.read === PR_SWEEP_MAX_PULL_REQUESTS) break;
    stopped = stopBeforeRead(context, remaining);
    if (stopped !== 'none') break;
    reached += 1;
    const repo = candidate.repo.toLowerCase();
    if (hiddenRepos.has(repo)) {
      counts.repo_not_visible += 1;
      continue;
    }
    if (!isValidRepo(candidate.repo)) {
      hiddenRepos.add(repo);
      counts.repo_not_visible += 1;
      logger.warn('PR outcome sweep: GitHub does not show a repository to the platform token', { repo: candidate.repo });
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
        await notFound(candidate, 'not_found', nowMs, counts);
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

async function sweep(selected: readonly PullRequestCandidate[], context: Context, nowMs: number, counts: RunCounts): Promise<Stop> {
  let secret: string;
  try {
    secret = await resolveGitHubToken(GITHUB_TOKEN_SECRET_ARN);
  } catch (err) {
    const cause = (err as { cause?: { name?: unknown } | null } | null)?.cause?.name;
    logger.error('PR outcome sweep: the secret of the platform GitHub token cannot be read', {
      error: err instanceof Error ? err.message : String(err),
      cause: typeof cause === 'string' ? cause : undefined,
    });
    return 'secret';
  }
  const token = secret.trim();
  if (!USABLE_TOKEN.test(token)) {
    // `fetch` refuses such a header before any request, in a message that quotes it.
    logger.error('PR outcome sweep: the secret of the platform GitHub token holds no usable token', {
      error: 'the value is empty, or holds a character that a request header cannot carry',
    });
    return 'secret';
  }
  if (!GITHUB_TOKEN.test(token)) {
    if (!HOLDS_GITHUB_TOKEN.test(token)) return 'no_token';
    logger.error('PR outcome sweep: the secret of the platform GitHub token holds no usable token', {
      error: 'the value holds a GitHub token with other characters around it',
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
  const stopped = selected.length > 0 ? await sweep(selected, context, nowMs, counts) : 'none';
  logger[summaryLevel(stopped, counts)]('PR outcome sweep summary', { ...counts, stopped });
}
