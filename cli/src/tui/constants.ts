/**
 * Shared TUI constants — single source of truth for colors, icons, labels.
 * Panels import from here instead of redefining their own maps.
 */
import figures from 'figures';

// ── Status ──────────────────────────────────────────────────────────

export const STATUS_COLOR: Record<string, string> = {
  RUNNING: 'cyan',
  AWAITING_APPROVAL: 'magenta',
  COMPLETED: 'green',
  FAILED: 'red',
  CANCELLED: 'gray',
  SUBMITTED: 'gray',
  HYDRATING: 'blue',
  FINALIZING: 'yellow',
  TIMED_OUT: 'redBright',  // distinct from FAILED
};

export const STATUS_ICON: Record<string, string> = {
  RUNNING: figures.bullet,
  AWAITING_APPROVAL: figures.warning,
  COMPLETED: figures.tick,
  FAILED: figures.cross,
  CANCELLED: figures.line,
  SUBMITTED: figures.circle,
  HYDRATING: figures.ellipsis,
  FINALIZING: figures.arrowRight,
  TIMED_OUT: figures.warning,  // distinct from FAILED (cross)
};

export const STATUS_LABEL: Record<string, string> = {
  RUNNING: 'Running',
  AWAITING_APPROVAL: 'Needs approval',
  COMPLETED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  SUBMITTED: 'Queued',
  HYDRATING: 'Starting up',
  FINALIZING: 'Wrapping up',
  TIMED_OUT: 'Timed out',
};

// ── Event types ─────────────────────────────────────────────────────

// Keys include both the mock fixture event names and the real
// agent-side names (`agent_turn`, `agent_tool_call`, ...). Keeping
// both in one map lets EventLine handle mixed streams and the mock
// demo without branching. See agent/src/progress_writer.py for the
// authoritative producer-side vocabulary.
export const EVENT_COLOR: Record<string, string> = {
  // Lifecycle
  task_started: 'green',
  task_complete: 'green',
  task_completed: 'green',
  task_failed: 'red',
  // Agent runtime (real)
  agent_turn: 'gray',
  agent_tool_call: 'yellow',
  agent_tool_result: 'gray',
  agent_milestone: 'cyan',
  agent_cost_update: 'yellow',
  agent_error: 'red',
  // Mock fixture aliases
  turn_start: 'gray',
  tool_call: 'yellow',
  tool_result: 'gray',
  milestone: 'cyan',
  cost_update: 'yellow',
  error: 'red',
  // Cedar HITL milestones
  approval_requested: 'magenta',
  approval_granted: 'green',
  approval_denied: 'red',
  approval_timed_out: 'redBright',
  approval_stranded: 'redBright',
  nudge_acknowledged: 'cyan',
};

export const EVENT_ICON: Record<string, string> = {
  // Lifecycle
  task_started: figures.star,
  task_complete: figures.tick,
  task_completed: figures.tick,
  task_failed: figures.cross,
  // Agent runtime (real)
  agent_turn: figures.line,
  agent_tool_call: figures.play,
  agent_tool_result: figures.pointer,
  agent_milestone: figures.star,
  agent_cost_update: '$',
  agent_error: figures.cross,
  // Mock fixture aliases
  turn_start: figures.line,
  tool_call: figures.play,
  tool_result: figures.pointer,
  milestone: figures.star,
  cost_update: '$',
  error: figures.cross,
  // Cedar HITL milestones
  approval_requested: figures.warning,
  approval_granted: figures.tick,
  approval_denied: figures.cross,
  approval_timed_out: figures.cross,
  approval_stranded: figures.cross,
};

// ── Severity ────────────────────────────────────────────────────────
// Consistent casing: keys are always UPPERCASE (matching the data model).

export const SEVERITY_COLOR: Record<string, string> = {
  HIGH: 'red',
  MEDIUM: 'yellow',
  LOW: 'green',
};

export const SEVERITY_LABEL: Record<string, string> = {
  HIGH: 'High risk',
  MEDIUM: 'Medium risk',
  LOW: 'Low risk',
};

// ── Channel source (submission provenance) ─────────────────────────
// Short labels fit under an 8-char column width without truncation.
// Colors let the user scan "which tasks came from where" at a glance:
//   CLI / webhook — neutral (gray / white)
//   Slack / Linear — integration-branded hues

export const CHANNEL_LABEL: Record<string, string> = {
  api: 'CLI',
  webhook: 'Hook',
  slack: 'Slack',
  linear: 'Linear',
};

export const CHANNEL_COLOR: Record<string, string | undefined> = {
  api: undefined,
  webhook: 'gray',
  slack: 'magenta',
  linear: 'blue',
};

// ── Policy tiers (plain-English labels) ─────────────────────────────
// API buckets from GET /repos/{id}/policies are `hard` and `soft`.
// Legacy TUI tiers `hard-deny` / `hard-gate` are kept as aliases so the
// mock fixture and any in-flight callers stay rendering-clean through
// the Phase 1 → Phase 3 transition.

export const TIER_LABEL: Record<string, string> = {
  hard: 'Blocked',
  soft: 'Requires approval',
  'hard-deny': 'Blocked',
  'hard-gate': 'Requires approval',
};

export const TIER_COLOR: Record<string, string> = {
  hard: 'red',
  soft: 'magenta',
  'hard-deny': 'red',
  'hard-gate': 'magenta',
};

// ── Pre-approve scopes (plain-English) ──────────────────────────────

export const SCOPE_LABELS: Record<string, string> = {
  'tool_type:Read': 'Read-only operations (file reads, searches)',
  'tool_type:Edit': 'File editing (writes and modifications)',
  'tool_type:Bash': 'Shell commands (bash/sh execution)',
  'tool_group:file_write': 'All file write operations',
  'all_session': `${figures.warning} Full autonomy — approves everything`,
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Human-friendly time ago from ISO timestamp. */
export function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Format seconds as "Xm Ys" or "Ys". */
export function fmtDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Safe truncation. */
export function trunc(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
