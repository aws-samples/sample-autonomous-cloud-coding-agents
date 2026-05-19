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

import { Box, Text } from 'ink';
import React from 'react';
import { EVENT_COLOR, EVENT_ICON, MILESTONE_COLOR, MILESTONE_ICON, trunc } from '../constants.js';
import { TRUNC_TOOL_INPUT, type TaskEvent } from '../data.js';

/** Narrow a `Record<string, unknown>` metadata field to string for
 *  display. See `ApprovalCard.tsx` for rationale. */
function mstr(m: Record<string, unknown>, key: string, fallback = ''): string {
  const v = m[key];
  return typeof v === 'string' ? v : fallback;
}

function mnum(m: Record<string, unknown>, key: string): number | null {
  const v = m[key];
  return typeof v === 'number' ? v : null;
}

function mbool(m: Record<string, unknown>, key: string): boolean {
  return m[key] === true;
}

function mstrlist(m: Record<string, unknown>, key: string): readonly string[] {
  const v = m[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Format an `agent_milestone` event by its `metadata.milestone` sub-name.
 * The agent runtime emits every approval-* event as event_type
 * `agent_milestone` (see `agent/src/progress_writer.py::_put_approval_milestone`),
 * so the live-mode rendering MUST demux on the sub-name — the outer
 * switch in `fmt()` handles the unwrapped names emitted by mock
 * fixtures and the Watch-synthesized pending-approval event.
 *
 * Returning `null` means "let the caller fall back to its default
 * milestone rendering" (sub-name + optional details), which is what
 * older TUI builds did before IMPL-26 surface promotion.
 */
function fmtMilestone(m: Record<string, unknown>): string | null {
  const sub = mstr(m, 'milestone');
  switch (sub) {
    case 'pre_approvals_loaded': {
      const count = mnum(m, 'count') ?? 0;
      const scopes = mstrlist(m, 'scopes');
      if (count === 0) return 'No pre-approvals loaded';
      const head = scopes.slice(0, 3).join(', ');
      const tail = scopes.length > 3 ? `, +${scopes.length - 3} more` : '';
      return `Pre-approvals loaded: ${count} scope${count === 1 ? '' : 's'}${head ? ` — ${head}${tail}` : ''}`;
    }
    case 'approval_requested':
      return `APPROVAL NEEDED: ${mstr(m, 'tool_name')} — ${trunc(mstr(m, 'input_preview') || mstr(m, 'tool_input_preview'), TRUNC_TOOL_INPUT)}`;
    case 'approval_granted':
      return `Approved (..${mstr(m, 'request_id').slice(-4)})${mstr(m, 'scope') ? ` scope=${mstr(m, 'scope')}` : ''}`;
    case 'approval_denied': {
      const reason = mstr(m, 'reason');
      return `Denied (..${mstr(m, 'request_id').slice(-4)})${reason ? ` — ${trunc(reason, 40)}` : ''}`;
    }
    case 'approval_timed_out': {
      const eff = mnum(m, 'effective_timeout_s') ?? mnum(m, 'timeout_s');
      return `Timed out (..${mstr(m, 'request_id').slice(-4)})${eff != null ? ` after ${eff}s` : ''}`;
    }
    case 'approval_stranded':
      return `Stranded (..${mstr(m, 'request_id').slice(-4)}) — reconciler: ${mstr(m, 'reason') || 'task evicted'}`;
    case 'approval_timeout_capped': {
      const req = mnum(m, 'requested_timeout_s');
      const eff = mnum(m, 'effective_timeout_s');
      const reason = mstr(m, 'reason');
      const rules = mstrlist(m, 'matching_rule_ids');
      const ruleSuffix = rules.length > 0 ? ` (${rules.join(', ')})` : '';
      return `Timeout capped: ${req ?? '?'}s → ${eff ?? '?'}s${reason ? ` (${reason}${ruleSuffix})` : ''}`;
    }
    case 'approval_ceiling_shrinking': {
      const remaining = mnum(m, 'maxLifetime_remaining_s');
      const margin = mnum(m, 'cleanup_margin_s');
      const usable = remaining != null && margin != null ? remaining - margin : null;
      return `Approval window shrinking — ~${usable ?? remaining ?? '?'}s of task lifetime left`;
    }
    case 'approval_cap_exceeded': {
      const count = mnum(m, 'count') ?? 0;
      const cap = mnum(m, 'cap') ?? 0;
      return `Approval cap reached: ${count}/${cap} — task halted`;
    }
    case 'approval_rate_limit_exceeded': {
      const rate = mnum(m, 'rate') ?? 0;
      const limit = mnum(m, 'limit') ?? 0;
      return `Approval rate limit: ${rate}/min > ${limit}/min`;
    }
    case 'approval_write_failed':
      return `Approval write failed: ${trunc(mstr(m, 'error'), 60)}`;
    case 'approval_resume_failed':
      return `Approval resume failed (..${mstr(m, 'request_id').slice(-4)}): ${trunc(mstr(m, 'error'), 60)}`;
    case 'approval_poll_degraded': {
      const fails = mnum(m, 'consecutive_failures') ?? 0;
      return `Approval polling degraded — ${fails} consecutive failures`;
    }
    case 'approval_late_win':
      return `Late decision won: ${mstr(m, 'outcome')} (..${mstr(m, 'request_id').slice(-4)}) — ${mstr(m, 'reason')}`;
    case 'policy_decision': {
      // Recent-decision-cache hit (IMPL-23) — surface as a low-key
      // info line so operators can correlate retry patterns.
      const tool = mstr(m, 'tool_name');
      const decision = mstr(m, 'cached_decision');
      return `Policy cache hit: ${tool} → ${decision}`;
    }
    default:
      return null;
  }
}

/**
 * Format a task event for the Watch stream.
 *
 * Handles both the real agent-side vocabulary emitted by
 * `agent/src/progress_writer.py` (``agent_turn``, ``agent_tool_call``,
 * ``agent_tool_result``, ``agent_milestone``, ``agent_cost_update``,
 * ``agent_error``) and the simpler fixture names used by the TUI
 * mock (``turn_start`` / ``tool_call`` / ``tool_result`` / ``milestone``
 * / ``cost_update``). Keeping both in one switch lets the mock demo
 * stay pretty while the real stream renders correctly.
 *
 * Mirrors the formatting logic in ``cli/src/commands/watch.ts::renderEvent``
 * so the TUI and the non-TUI ``bgagent watch`` command surface the
 * same information.
 */
function fmt(e: TaskEvent): string {
  const m = e.metadata;
  switch (e.event_type) {
    // ── Lifecycle ─────────────────────────────────────────────
    case 'task_started':
      return 'Task started';
    case 'task_complete':
    case 'task_completed':
      return 'Task completed';
    case 'task_failed':
      return 'Task failed';

    // ── Agent runtime (real) ──────────────────────────────────
    case 'agent_turn': {
      const turn = mnum(m, 'turn') ?? '?';
      const model = mstr(m, 'model');
      const tools = mnum(m, 'tool_calls_count') ?? 0;
      const parts = [`Step ${turn}`];
      if (model) parts.push(model);
      parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
      return `${parts.join('  ')} ${'─'.repeat(20)}`;
    }
    case 'agent_tool_call':
      return `${mstr(m, 'tool_name')}  ${trunc(mstr(m, 'tool_input_preview'), TRUNC_TOOL_INPUT)}`;
    case 'agent_tool_result': {
      const tool = mstr(m, 'tool_name');
      const status = mbool(m, 'is_error') ? 'error' : 'success';
      const preview = mstr(m, 'content_preview');
      return `${tool} → ${status} ${preview ? `(${trunc(preview, 30)})` : ''}`;
    }
    case 'agent_milestone': {
      // Approval milestones arrive as `agent_milestone` with a
      // `milestone` sub-type (§11.1). Surface that subtype explicitly
      // so approval-related events stand out in the stream — the
      // dedicated formatter below handles every name in §11.1; falling
      // back to the generic sub:details rendering if it returns null
      // (covers any future milestone the formatter hasn't been
      // taught about yet).
      const formatted = fmtMilestone(m);
      if (formatted !== null) return formatted;
      const sub = mstr(m, 'milestone');
      const details = mstr(m, 'details');
      if (sub) return details ? `${sub}: ${details}` : sub;
      return details || 'Milestone';
    }
    case 'agent_cost_update': {
      const cost = mnum(m, 'cost_usd');
      const input = mnum(m, 'input_tokens') ?? 0;
      const output = mnum(m, 'output_tokens') ?? 0;
      const dollars = cost != null ? `$${cost.toFixed(4)}` : '$?';
      return `Cost: ${dollars} (${input} in / ${output} out)`;
    }
    case 'agent_error': {
      const errType = mstr(m, 'error_type', 'Error');
      const msg = mstr(m, 'message_preview');
      return msg ? `${errType}: ${msg}` : errType;
    }

    // ── Mock fixture aliases ──────────────────────────────────
    case 'turn_start':
      return `Step ${mnum(m, 'turn') ?? '?'} ${'─'.repeat(30)}`;
    case 'tool_call':
      return `${mstr(m, 'tool_name')}  ${trunc(mstr(m, 'args_preview'), TRUNC_TOOL_INPUT)}`;
    case 'tool_result': {
      const preview = mstr(m, 'preview');
      return `${mstr(m, 'tool_name')} → ${mstr(m, 'status')} ${preview ? `(${trunc(preview, 30)})` : ''}`;
    }
    case 'milestone':
      return mstr(m, 'message', 'Milestone');
    case 'cost_update':
      return `Cost: $${(mnum(m, 'total_usd') ?? 0).toFixed(4)}`;

    // ── Cedar HITL milestones ─────────────────────────────────
    // These cases fire for either (a) mock-fixture event names that
    // bypass the agent_milestone wrapper, or (b) Watch.tsx's
    // synthesized pending-approval event. For the live agent-emitted
    // path the wrapping is `agent_milestone` + `metadata.milestone =
    // <name>` and rendering goes through `fmtMilestone()` above.
    case 'approval_requested':
    case 'approval_granted':
    case 'approval_denied':
    case 'approval_timed_out':
    case 'approval_stranded':
    case 'approval_timeout_capped':
    case 'approval_ceiling_shrinking':
    case 'approval_cap_exceeded':
    case 'approval_rate_limit_exceeded':
    case 'approval_write_failed':
    case 'approval_resume_failed':
    case 'approval_poll_degraded':
    case 'approval_late_win':
    case 'pre_approvals_loaded': {
      // Reuse the milestone formatter by synthesizing a metadata view
      // that already includes the sub-name. Keeps the unwrapped path
      // and the wrapped path identical in output.
      const synth: Record<string, unknown> = { ...m, milestone: e.event_type };
      const formatted = fmtMilestone(synth);
      return formatted ?? e.event_type;
    }

    default:
      return e.event_type;
  }
}

/** Effective milestone sub-name for color/icon lookup when the event
 *  is wrapped in `agent_milestone`. Falls back to `event_type` for
 *  unwrapped mock fixtures so the existing EVENT_COLOR / EVENT_ICON
 *  maps still apply. */
function effectiveMilestoneKey(event: TaskEvent): string | null {
  if (event.event_type !== 'agent_milestone') return null;
  const sub = event.metadata.milestone;
  return typeof sub === 'string' ? sub : null;
}

const EventLine: React.FC<{ event: TaskEvent }> = ({ event }) => {
  const ts = new Date(event.timestamp);
  const time = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
  // Live mode: every approval-* milestone arrives as event_type
  // `agent_milestone` with the sub-name in metadata. Resolve color +
  // icon via the milestone-keyed maps so safety-critical events
  // (timeout_capped, cap_exceeded, ceiling_shrinking, ...) get their
  // intended yellow/red treatment instead of the generic cyan-star
  // fallback that hid the IMPL-26 surface promotion.
  const milestoneKey = effectiveMilestoneKey(event);
  const c = (milestoneKey && MILESTONE_COLOR[milestoneKey])
    ?? EVENT_COLOR[event.event_type]
    ?? 'white';
  const icon = (milestoneKey && MILESTONE_ICON[milestoneKey])
    ?? EVENT_ICON[event.event_type]
    ?? '.';
  const isBold =
    event.event_type === 'tool_call'
    || event.event_type === 'agent_tool_call'
    || event.event_type === 'approval_requested'
    || milestoneKey === 'approval_requested'
    || milestoneKey === 'approval_cap_exceeded';

  return (
    <Box>
      <Text dimColor>{time}  </Text>
      <Text color={c}>{icon} </Text>
      <Text color={c === 'gray' ? undefined : c} dimColor={c === 'gray'} bold={isBold}>
        {fmt(event)}
      </Text>
    </Box>
  );
};

export default React.memo(EventLine);
