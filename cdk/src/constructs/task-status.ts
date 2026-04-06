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
 * States progress through the lifecycle: SUBMITTED -> HYDRATING ->
 * RUNNING -> FINALIZING -> terminal (COMPLETED / FAILED / CANCELLED / TIMED_OUT).
 * See ORCHESTRATOR.md for the full state transition table.
 */
export const TaskStatus = {
  SUBMITTED: 'SUBMITTED',
  HYDRATING: 'HYDRATING',
  RUNNING: 'RUNNING',
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
 * Active (non-terminal) states that indicate a task is still in progress.
 */
export const ACTIVE_STATUSES: readonly TaskStatusType[] = [
  TaskStatus.SUBMITTED,
  TaskStatus.HYDRATING,
  TaskStatus.RUNNING,
  TaskStatus.FINALIZING,
];

/**
 * Valid state transitions. Maps each state to the set of states it can transition to.
 * Derived from the transition table in ORCHESTRATOR.md.
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatusType, readonly TaskStatusType[]>> = {
  [TaskStatus.SUBMITTED]: [TaskStatus.HYDRATING, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.HYDRATING]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.RUNNING]: [TaskStatus.FINALIZING, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT, TaskStatus.FAILED],
  [TaskStatus.FINALIZING]: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMED_OUT],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.TIMED_OUT]: [],
};
