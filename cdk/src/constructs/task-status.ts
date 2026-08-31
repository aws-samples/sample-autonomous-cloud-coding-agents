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
 * Valid task states in the task lifecycle state machine.
 *
 * States progress through the lifecycle:
 *   [PENDING_UPLOADS ->] SUBMITTED [<-> QUEUED] -> HYDRATING ->
 *   RUNNING -> FINALIZING -> terminal (COMPLETED / FAILED / CANCELLED / TIMED_OUT).
 * See ORCHESTRATOR.md for the full state transition table.
 *
 * PENDING_UPLOADS is a pre-active state for tasks with presigned-upload
 * attachments: no compute allocated, no concurrency slot consumed. The
 * task transitions to SUBMITTED once uploads are confirmed and screened.
 *
 * QUEUED (#441) is a pre-active state for tasks that hit the per-user
 * admission cap: the admission slot was NOT acquired, so no compute is
 * allocated and no concurrency slot is consumed. The admission-queue
 * pickup Lambda re-attempts admission in FIFO order (by ``created_at``)
 * as slots free up, transitioning QUEUED -> SUBMITTED and re-invoking
 * the orchestrator. A pickup that loses the admission race simply
 * re-queues (SUBMITTED -> QUEUED); FIFO position is preserved because
 * ``created_at`` never changes.
 *
 * AWAITING_APPROVAL is the Cedar-HITL soft-deny gate surface: the
 * task is alive but paused on a human decision. See
 * `docs/design/CEDAR_HITL_GATES.md` §10.3 for the joint
 * `status` + `awaiting_approval_request_id` invariant that callers
 * must preserve when transitioning in or out of this state.
 */
export const TaskStatus = {
  PENDING_UPLOADS: 'PENDING_UPLOADS',
  QUEUED: 'QUEUED',
  SUBMITTED: 'SUBMITTED',
  HYDRATING: 'HYDRATING',
  RUNNING: 'RUNNING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
} as const;

/**
 * Union type of all valid task status values.
 */
export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

/**
 * Terminal states that indicate a task has finished processing.
 */
export const TERMINAL_STATUSES: readonly TaskStatusType[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.TIMED_OUT,
];

/**
 * Pre-active states where the task exists but has not entered the
 * orchestration pipeline. No compute resources are allocated and no
 * concurrency slot is consumed. QUEUED belongs here (#441): admission
 * explicitly did NOT acquire a slot, so counting it as active would
 * deadlock the queue (queued tasks would hold the very slots they
 * are waiting for).
 */
export const PRE_ACTIVE_STATUSES: readonly TaskStatusType[] = [
  TaskStatus.PENDING_UPLOADS,
  TaskStatus.QUEUED,
];

/**
 * Active (non-terminal) states that indicate a task is still in progress.
 * AWAITING_APPROVAL counts as active — the task is alive, just paused
 * waiting on a human decision. PENDING_UPLOADS is NOT here — it is
 * pre-active and does not consume a concurrency slot.
 */
export const ACTIVE_STATUSES: readonly TaskStatusType[] = [
  TaskStatus.SUBMITTED,
  TaskStatus.HYDRATING,
  TaskStatus.RUNNING,
  TaskStatus.AWAITING_APPROVAL,
  TaskStatus.FINALIZING,
];

/**
 * Valid state transitions. Maps each state to the set of states it can transition to.
 * Derived from the transition table in ORCHESTRATOR.md + §10.3 of the
 * Cedar HITL gates design (AWAITING_APPROVAL entries) + ATTACHMENTS.md
 * (PENDING_UPLOADS entries).
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatusType, readonly TaskStatusType[]>> = {
  // PENDING_UPLOADS: presigned-upload task awaiting client file uploads.
  // Transitions to SUBMITTED on confirm-uploads success, FAILED on
  // screening failure, CANCELLED on user cancel or 30-min auto-cancel.
  [TaskStatus.PENDING_UPLOADS]: [TaskStatus.SUBMITTED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  // QUEUED (#441): admission-capped task awaiting a free concurrency
  // slot. SUBMITTED on pickup (slot acquired), CANCELLED on user
  // cancel, FAILED only via the queue-stranded backstop.
  [TaskStatus.QUEUED]: [TaskStatus.SUBMITTED, TaskStatus.CANCELLED, TaskStatus.FAILED],
  [TaskStatus.SUBMITTED]: [TaskStatus.QUEUED, TaskStatus.HYDRATING, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.HYDRATING]: [
    TaskStatus.RUNNING,
    TaskStatus.AWAITING_APPROVAL,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.RUNNING]: [
    TaskStatus.AWAITING_APPROVAL,
    TaskStatus.FINALIZING,
    TaskStatus.CANCELLED,
    TaskStatus.TIMED_OUT,
    TaskStatus.FAILED,
  ],
  // AWAITING_APPROVAL transitions back to RUNNING on approve or denial
  // resume; CANCELLED on user cancel mid-approval; FAILED only via the
  // stranded-approval reconciler.
  [TaskStatus.AWAITING_APPROVAL]: [
    TaskStatus.RUNNING,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.FINALIZING]: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMED_OUT],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.TIMED_OUT]: [],
};
