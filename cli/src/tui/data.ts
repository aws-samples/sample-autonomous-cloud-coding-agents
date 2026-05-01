/**
 * Data access layer — single abstraction over mock data.
 * All panels import from here, NOT from mock/data.ts directly.
 * To wire to a real backend, replace the implementations here
 * and change return types to Promise<T>.
 */
import {
  MOCK_TASKS,
  MOCK_EVENTS,
  MOCK_PENDING_APPROVALS,
  MOCK_POLICIES,
  MOCK_REPOS,
  submitTask as mockSubmitTask,
  type TaskSummary,
  type TaskEvent,
  type PendingApproval,
  type CedarPolicy,
  type RegisteredRepo,
} from './mock/data.js';

// Re-export types so consumers only depend on this module
export type { TaskSummary, TaskEvent, PendingApproval, CedarPolicy, RegisteredRepo };

// ── Status union ────────────────────────────────────────────────────

export type TaskStatus =
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'SUBMITTED'
  | 'HYDRATING'
  | 'FINALIZING'
  | 'TIMED_OUT';

// ── Queries ─────────────────────────────────────────────────────────

export function getTasks(): TaskSummary[] {
  return MOCK_TASKS;
}

export function getTask(taskId: string): TaskSummary | undefined {
  return MOCK_TASKS.find(t => t.task_id === taskId);
}

/** Get active registered repos from the RepoTable. */
export function getRegisteredRepos(): RegisteredRepo[] {
  return MOCK_REPOS.filter(r => r.status === 'active');
}

export function getEventsForTask(taskId: string): TaskEvent[] {
  return MOCK_EVENTS.filter(e => e.task_id === taskId);
}

export function getPendingApprovals(): PendingApproval[] {
  return MOCK_PENDING_APPROVALS;
}

export function getPolicies(): CedarPolicy[] {
  return MOCK_POLICIES;
}

// ── Mutations ───────────────────────────────────────────────────────

export function submitNewTask(repo: string, description: string): TaskSummary {
  return mockSubmitTask(repo, description);
}

// ── Layout constants ────────────────────────────────────────────────
// Terminal-aware widths. Swap with process.stdout.columns for responsive.

export const TERM_WIDTH = 80;
export const SEPARATOR_WIDTH = TERM_WIDTH - 8;
export const TRUNC_DESCRIPTION = 35;
export const TRUNC_DESCRIPTION_LONG = 55; // Watch header, Approvals goal
export const TRUNC_REPO = 24;
export const TRUNC_TOOL_INPUT = 40;
export const TRUNC_REASON = 50;
