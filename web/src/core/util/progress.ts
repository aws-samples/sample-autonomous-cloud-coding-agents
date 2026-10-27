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

import type { TaskDetail, TaskEvent } from '../api/types';
import { stepArea, type StepArea } from './activity';
import { formatDuration } from './format';
import { hasStaleHeartbeat } from './task-health';

/**
 * The same five steps for every task, whatever the workflow underneath:
 * Queued → Setting up → Working → Checking → Pull request.
 */
export const PROGRESS_STEPS = ['Queued', 'Setting up', 'Working', 'Checking', 'Pull request'] as const;

export type StepState = 'done' | 'current' | 'todo' | 'stopped' | 'skipped';

const AREA_INDEX: Readonly<Record<StepArea, number>> = { 'setting-up': 1, 'working': 2, 'checking': 3, 'pull-request': 4 };

function milestones(events: readonly TaskEvent[]): string[] {
  return events
    .filter((e) => e.event_type === 'agent_milestone')
    .map((e) => (typeof e.metadata?.milestone === 'string' ? e.metadata.milestone : ''));
}

/** Index of the furthest step the task has reached (0-4). */
export function reachedStep(task: Pick<TaskDetail, 'status' | 'pr_url'>, events: readonly TaskEvent[]): number {
  let reached = 0;
  if (!['PENDING_UPLOADS', 'QUEUED', 'SUBMITTED'].includes(task.status)) reached = 1;
  for (const name of milestones(events)) {
    const step = /^step:([^:]+):start$/.exec(name);
    if (step) reached = Math.max(reached, AREA_INDEX[stepArea(step[1])]);
    if (name === 'pr_created') reached = 4;
  }
  // Workflows without step milestones: tool activity alone means the work has started.
  if (reached === 1 && events.some((e) => e.event_type === 'agent_tool_call')) reached = 2;
  if (task.pr_url) reached = 4;
  return reached;
}

export function stepStates(task: Pick<TaskDetail, 'status' | 'pr_url'>, events: readonly TaskEvent[]): StepState[] {
  const reached = reachedStep(task, events);
  return PROGRESS_STEPS.map((_, i) => {
    if (task.status === 'COMPLETED') return i <= reached || i < 4 ? 'done' : 'skipped';
    if (task.status === 'FAILED' || task.status === 'TIMED_OUT' || task.status === 'CANCELLED') {
      if (i < reached) return 'done';
      return i === reached ? 'stopped' : 'todo';
    }
    if (i < reached) return 'done';
    return i === reached ? 'current' : 'todo';
  });
}

type OutcomeType = 'success' | 'info' | 'warning' | 'error';

export interface Outcome {
  readonly type: OutcomeType;
  readonly title: string;
  readonly text?: string;
  /** Which buttons the banner offers. */
  readonly offer?: 'approval' | 'stuck' | 'retry';
}

/** The agent's own last words, used when it explains why it changed nothing. */
function lastSaid(events: readonly TaskEvent[]): string | null {
  const said = [...events]
    .filter((e) => e.event_type === 'agent_turn' && typeof e.metadata?.text_preview === 'string' && e.metadata.text_preview.trim())
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return said ? String(said.metadata.text_preview).trim() : null;
}

/**
 * The agent finished its work cleanly but there was nothing to commit. The platform
 * currently reports that as FAILED ("change was not saved"); to a person it is
 * "no changes needed".
 */
export function finishedWithoutChanges(task: Pick<TaskDetail, 'status' | 'pr_url'>, events: readonly TaskEvent[]): boolean {
  if (task.status !== 'FAILED' || task.pr_url) return false;
  return events.some((e) => e.event_type === 'agent_milestone'
    && e.metadata?.milestone === 'agent_execution_complete'
    && typeof e.metadata.details === 'string'
    && e.metadata.details.includes('status=success'));
}

function minutesSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(1, Math.round((now.getTime() - t) / 60_000));
}

/** One plain sentence about where the task stands, or null while it is simply working. */
export function outcomeOf(task: TaskDetail, events: readonly TaskEvent[], now: Date = new Date()): Outcome | null {
  switch (task.status) {
    case 'AWAITING_APPROVAL':
      return { type: 'warning', title: 'Needs your OK', text: 'The agent paused before an action that needs a person to approve it.', offer: 'approval' };
    case 'QUEUED':
    case 'PENDING_UPLOADS':
      return {
        type: 'info',
        title: task.queue_position ? `Waiting in line (number ${task.queue_position})` : 'Waiting to start',
        ...(task.estimated_wait_s ? { text: `Should start in about ${formatDuration(task.estimated_wait_s)}.` } : {}),
      };
    case 'COMPLETED':
      return task.pr_url
        ? { type: 'success', title: `Done: pull request${task.pr_number ? ` #${task.pr_number}` : ''} is ready for review` }
        : { type: 'success', title: 'Done' };
    case 'CANCELLED':
      return { type: 'info', title: 'Cancelled', offer: 'retry' };
    case 'TIMED_OUT':
      return { type: 'error', title: 'Ran out of time', text: 'It hit the time limit before finishing. Try again with a smaller change.', offer: 'retry' };
    case 'FAILED': {
      if (finishedWithoutChanges(task, events)) {
        return { type: 'info', title: 'Finished with no changes', text: lastSaid(events) ?? 'The agent decided nothing needed to change.' };
      }
      const why = task.error_classification;
      return {
        type: 'error',
        title: why?.title ?? 'Stopped with an error',
        text: why ? `${why.description} What to do: ${why.remedy}` : (task.error_message ?? undefined),
        offer: 'retry',
      };
    }
    default: {
      if (hasStaleHeartbeat(task, now)) {
        const mins = minutesSince(task.agent_heartbeat_at ?? task.updated_at, now);
        return {
          type: 'warning',
          title: mins ? `No update for ${mins} min` : 'No updates lately',
          text: 'It may be stuck. Send it a message, or cancel it.',
          offer: 'stuck',
        };
      }
      return null;
    }
  }
}
