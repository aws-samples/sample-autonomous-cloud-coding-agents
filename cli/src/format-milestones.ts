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
 * Shared formatter for Cedar HITL `agent_milestone` sub-events
 * (§11.1 of `docs/design/CEDAR_HITL_GATES.md`). Used by:
 *
 *   - `tui/components/EventLine.tsx` — Watch panel event stream
 *   - `commands/watch.ts` — `bgagent watch` plain CLI render
 *
 * The agent runtime emits every approval-related event as event_type
 * `agent_milestone` with the sub-name in `metadata.milestone` (see
 * `agent/src/progress_writer.py::_put_approval_milestone`). Both
 * surfaces MUST produce identical text so an operator using the CLI
 * sees the same severity signal — clip vs cap vs ceiling — that the
 * TUI shows; otherwise IMPL-26's surface-promotion goal is half-met.
 *
 * Returning `null` means "let the caller fall back to its default
 * `<sub>: <details>` rendering" — covers any future milestone the
 * formatter hasn't been taught about yet without breaking output.
 */

/** Truncate a long string for inline preview, suffixed with `…`. */
function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function mstr(m: Record<string, unknown>, key: string, fallback = ''): string {
  const v = m[key];
  return typeof v === 'string' ? v : fallback;
}

function mnum(m: Record<string, unknown>, key: string): number | null {
  const v = m[key];
  return typeof v === 'number' ? v : null;
}

function mstrlist(m: Record<string, unknown>, key: string): readonly string[] {
  const v = m[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Per-milestone preview width for tool input — wider terminals still
 *  wrap, but the formatter trims aggressively to keep one line per
 *  event in the CLI watch case. The TUI passes its own truncation
 *  width via the surrounding render, so this only matters for the
 *  `approval_requested` sub-event where the input preview is the most
 *  user-relevant payload. */
const TOOL_INPUT_PREVIEW_WIDTH = 60;

export function formatMilestone(metadata: Record<string, unknown>): string | null {
  const sub = mstr(metadata, 'milestone');
  switch (sub) {
    case 'pre_approvals_loaded': {
      const count = mnum(metadata, 'count') ?? 0;
      const scopes = mstrlist(metadata, 'scopes');
      if (count === 0) return 'No pre-approvals loaded';
      const head = scopes.slice(0, 3).join(', ');
      const tail = scopes.length > 3 ? `, +${scopes.length - 3} more` : '';
      return `Pre-approvals loaded: ${count} scope${count === 1 ? '' : 's'}${head ? ` — ${head}${tail}` : ''}`;
    }
    case 'approval_requested': {
      const tool = mstr(metadata, 'tool_name');
      const preview = mstr(metadata, 'input_preview') || mstr(metadata, 'tool_input_preview');
      return `APPROVAL NEEDED: ${tool} — ${trunc(preview, TOOL_INPUT_PREVIEW_WIDTH)}`;
    }
    case 'approval_granted':
      return `Approved (..${mstr(metadata, 'request_id').slice(-4)})${mstr(metadata, 'scope') ? ` scope=${mstr(metadata, 'scope')}` : ''}`;
    case 'approval_denied': {
      const reason = mstr(metadata, 'reason');
      return `Denied (..${mstr(metadata, 'request_id').slice(-4)})${reason ? ` — ${trunc(reason, 40)}` : ''}`;
    }
    case 'approval_timed_out': {
      const eff = mnum(metadata, 'effective_timeout_s') ?? mnum(metadata, 'timeout_s');
      return `Timed out (..${mstr(metadata, 'request_id').slice(-4)})${eff != null ? ` after ${eff}s` : ''}`;
    }
    case 'approval_stranded':
      return `Stranded (..${mstr(metadata, 'request_id').slice(-4)}) — reconciler: ${mstr(metadata, 'reason') || 'task evicted'}`;
    case 'approval_timeout_capped': {
      const req = mnum(metadata, 'requested_timeout_s');
      const eff = mnum(metadata, 'effective_timeout_s');
      const reason = mstr(metadata, 'reason');
      const rules = mstrlist(metadata, 'matching_rule_ids');
      const ruleSuffix = rules.length > 0 ? ` (${rules.join(', ')})` : '';
      return `Timeout capped: ${req ?? '?'}s → ${eff ?? '?'}s${reason ? ` (${reason}${ruleSuffix})` : ''}`;
    }
    case 'approval_ceiling_shrinking': {
      const remaining = mnum(metadata, 'maxLifetime_remaining_s');
      const margin = mnum(metadata, 'cleanup_margin_s');
      const usable = remaining != null && margin != null ? remaining - margin : null;
      return `Approval window shrinking — ~${usable ?? remaining ?? '?'}s of task lifetime left`;
    }
    case 'approval_cap_exceeded': {
      const count = mnum(metadata, 'count') ?? 0;
      const cap = mnum(metadata, 'cap') ?? 0;
      return `Approval cap reached: ${count}/${cap} — task halted`;
    }
    case 'approval_rate_limit_exceeded': {
      const rate = mnum(metadata, 'rate') ?? 0;
      const limit = mnum(metadata, 'limit') ?? 0;
      return `Approval rate limit: ${rate}/min > ${limit}/min`;
    }
    case 'approval_write_failed':
      return `Approval write failed: ${trunc(mstr(metadata, 'error'), 60)}`;
    case 'approval_resume_failed':
      return `Approval resume failed (..${mstr(metadata, 'request_id').slice(-4)}): ${trunc(mstr(metadata, 'error'), 60)}`;
    case 'approval_poll_degraded': {
      const fails = mnum(metadata, 'consecutive_failures') ?? 0;
      return `Approval polling degraded — ${fails} consecutive failures`;
    }
    case 'approval_late_win':
      return `Late decision won: ${mstr(metadata, 'outcome')} (..${mstr(metadata, 'request_id').slice(-4)}) — ${mstr(metadata, 'reason')}`;
    case 'policy_decision': {
      const tool = mstr(metadata, 'tool_name');
      const decision = mstr(metadata, 'cached_decision');
      return `Policy cache hit: ${tool} → ${decision}`;
    }
    default:
      return null;
  }
}
