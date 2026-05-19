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
 * TUI viewmodel types + layout constants.
 *
 * Panels bind to the view shapes in this module. Runtime data comes
 * off `useData()` from `./hooks/useData.tsx`, which picks between
 * mock and real sources based on `BGAGENT_TUI_MOCK`. This module
 * deliberately has no runtime queries — all I/O lives behind the
 * `DataSource` interface in `./api/source.ts`.
 */

import type { ChannelSource, TaskEvent, TaskStatusType } from '../types.js';

// Re-export so components can import from './data.js' exclusively.
export type { ChannelSource, TaskEvent, TaskStatusType };

// ─── View shapes panels bind to ─────────────────────────────────────

/** Row the TaskList + Watch panels render. Pre-joins the fields
 *  panels need from `TaskDetail` (wire) with display-friendly
 *  derived fields (`turn` = `turns_completed ?? turns_attempted`). */
export interface TaskRowView {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly task_type: string;
  readonly pr_number: number | null;
  readonly task_description: string;
  readonly branch_name: string;
  readonly pr_url: string | null;
  /** Submission provenance (api / webhook / slack / linear). Surfaced
   *  in the TaskList SOURCE column so users can see which channel
   *  produced the task. Optional so pre-ChannelSource records and
   *  already-loaded mock rows don't require a migration. */
  readonly channel_source?: ChannelSource;
  readonly created_at: string;
  readonly updated_at: string;
  readonly cost_usd: number | null;
  readonly duration_s: number | null;
  readonly max_turns: number | null;
  readonly turns_attempted: number | null;
  readonly turns_completed: number | null;
  /** Current step for the Watch header. Null on pre-DATA-1 records. */
  readonly turn: number | null;
  readonly approval_gate_count: number | null;
  readonly approval_gate_cap: number | null;
  readonly awaiting_approval_request_id: string | null;
}

/** Approval row rendered by the Approvals + Watch panels. Merges
 *  `PendingApprovalSummary` (wire) with the parent task's `repo` +
 *  `task_description`. Severity normalized to UPPERCASE. */
export interface PendingApprovalView {
  readonly task_id: string;
  readonly request_id: string;
  readonly tool_name: string;
  readonly tool_input_preview: string;
  readonly severity: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly reason: string;
  readonly created_at: string;
  readonly timeout_s: number;
  readonly expires_at: string;
  readonly matching_rule_ids: readonly string[];
  readonly repo: string;
  readonly task_description: string;
}

/** Cedar policy row for the Policies panel. `tier` uses the API
 *  vocabulary (`hard`/`soft`). `cedar_source` is mock-only — real
 *  mode leaves it undefined and the panel hides the section. */
export interface PolicyRuleView {
  readonly rule_id: string;
  readonly tier: 'hard' | 'soft';
  readonly summary: string;
  readonly severity?: string;
  readonly category?: string;
  readonly approval_timeout_s?: number;
  readonly action?: string;
  readonly condition_summary?: string;
  readonly cedar_source?: string;
}

/** Registered repo for the Submit panel's repo picker. */
export interface RegisteredRepoView {
  readonly repo: string;
  readonly default_branch: string;
}

// `TaskStatusType` is re-exported above — it now serves as the
// single source of truth for the rendering union too. The previous
// local `TaskStatus` alias was a leftover from before upstream
// extracted the literal union into the shared types contract.

// ─── Layout constants ───────────────────────────────────────────────

export const TERM_WIDTH = 80;
export const SEPARATOR_WIDTH = TERM_WIDTH - 8;
export const TRUNC_DESCRIPTION = 35;
export const TRUNC_DESCRIPTION_LONG = 55;
export const TRUNC_REPO = 24;
export const TRUNC_TOOL_INPUT = 40;
export const TRUNC_REASON = 50;
