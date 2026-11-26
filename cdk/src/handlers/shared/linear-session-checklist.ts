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
 * The session checklist (Linear's ``AgentSession.plan``) and the closing line of the
 * session's final message (#1066). Pure: the fan-out consumer does the writes.
 *
 * The checklist lists the stages a person cares about, from understanding the ticket
 * to "ready for your review". Its position is kept on the task record
 * (``linear_checklist_stage``), so it only moves forward whichever Lambda instance
 * sees an event.
 *
 * The ``plan`` shape follows the Linear developer docs ("Agent Plans", technology
 * preview): the whole list, replaced on every update, each step
 * ``{ content, status: 'pending' | 'inProgress' | 'completed' | 'canceled' }``.
 */

export type ChecklistStepStatus = 'pending' | 'inProgress' | 'completed' | 'canceled';

export interface ChecklistStep {
  readonly content: string;
  readonly status: ChecklistStepStatus;
}

/** A new change, or an update to an existing pull request. */
export type ChecklistKind = 'new' | 'iteration';

const PR_ITERATION_WORKFLOW = 'coding/pr-iteration-v1';
const NEW_TASK_WORKFLOW = 'coding/new-task-v1';

/** Stage positions (the index of the step in progress). */
export const CHECKLIST_STAGE = { understand: 0, setup: 1, code: 2, pr: 3, review: 4 } as const;

const LABELS: Readonly<Record<ChecklistKind, readonly string[]>> = {
  new: ['Understand the ticket', 'Set up the repository', 'Write the code', 'Open the pull request', 'Ready for your review'],
  iteration: ['Read the request', 'Set up the repository', 'Update the code', 'Push to the pull request', 'Ready for your review'],
};

/**
 * The checklist a task's session gets, or null for a workflow that has no such stages
 * (a repo-less workflow, a review). Records that predate ``resolved_workflow`` are coding tasks.
 * @param workflowId - the task's resolved workflow id.
 */
export function checklistKind(workflowId: string | undefined): ChecklistKind | null {
  if (workflowId === PR_ITERATION_WORKFLOW) return 'iteration';
  if (workflowId === undefined || workflowId === NEW_TASK_WORKFLOW) return 'new';
  return null;
}

/** Where the checklist stands. */
export interface ChecklistState {
  readonly stage: number;
  /** A few words on the step in progress ("queued for a free slot"). */
  readonly note?: string;
  /** ``#12`` once the pull request exists. */
  readonly pr?: string;
}

/** How the task ended: every step done, or the step in progress and the rest cancelled. */
export type ChecklistEnding = 'done' | 'stopped';

/**
 * The steps for ``state``: steps before the stage are completed, the stage is in
 * progress (with its note), the rest are pending.
 * @param kind - which wording.
 * @param state - the stage, note and pull request.
 * @param ending - set on the task's last write.
 */
export function renderChecklist(kind: ChecklistKind, state: ChecklistState, ending?: ChecklistEnding): ChecklistStep[] {
  const labels = LABELS[kind];
  const stage = ending === 'done' ? labels.length : Math.max(0, Math.min(state.stage, labels.length - 1));
  return labels.map((label, i) => {
    let status: ChecklistStepStatus = 'pending';
    if (i < stage) status = 'completed';
    else if (ending === 'stopped') status = 'canceled';
    else if (i === stage) status = 'inProgress';
    const extra = [i === CHECKLIST_STAGE.pr ? state.pr : undefined, i === stage ? state.note : undefined]
      .filter((s): s is string => Boolean(s)).join(' · ');
    return { content: extra ? `${label} — ${extra}` : label, status };
  });
}

/**
 * The stage an event moves the checklist to, or null when it does not.
 * @param effectiveType - the event type, or a milestone's name.
 */
export function checklistMoveForEvent(effectiveType: string): Omit<ChecklistState, 'pr'> | null {
  switch (effectiveType) {
    case 'admission_queued': return { stage: CHECKLIST_STAGE.understand, note: 'queued for a free slot' };
    case 'hydration_complete': return { stage: CHECKLIST_STAGE.setup };
    case 'repo_setup_complete': return { stage: CHECKLIST_STAGE.code };
    case 'agent_execution_complete': return { stage: CHECKLIST_STAGE.pr };
    case 'pr_created': return { stage: CHECKLIST_STAGE.review };
    default: return null;
  }
}

/** How a finished task reads to the person who asked for it. */
export type SessionOutcome = 'pr' | 'question' | 'no_change' | 'cancelled' | 'failed';

/**
 * The last line of the session's final message: whether the reader has to act.
 * @param outcome - how the task ended.
 */
export function closingLine(outcome: SessionOutcome): string {
  switch (outcome) {
    case 'pr': return '_Your turn: review the pull request. Reply here if it needs changes._';
    case 'question': return '**Waiting on you.** Nothing continues until you reply here.';
    case 'no_change': return '_Nothing needed from you. Reply here if you want a change after all._';
    case 'cancelled': return '_Nothing needed from you. Reply here to start again._';
    case 'failed': return '_Reply here to try again._';
  }
}
