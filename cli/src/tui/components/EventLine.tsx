import React from 'react';
import { Box, Text } from 'ink';
import type { TaskEvent } from '../data.js';
import { EVENT_COLOR, EVENT_ICON, trunc } from '../constants.js';
import { TRUNC_TOOL_INPUT } from '../data.js';

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
      // so approval-related events stand out in the stream.
      const sub = mstr(m, 'milestone');
      const details = mstr(m, 'details');
      if (sub) {
        return details ? `${sub}: ${details}` : sub;
      }
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
    case 'approval_requested':
      return `APPROVAL NEEDED: ${mstr(m, 'tool_name')} — ${trunc(mstr(m, 'input_preview') || mstr(m, 'tool_input_preview'), TRUNC_TOOL_INPUT)}`;
    case 'approval_granted':
      return `Approved (..${mstr(m, 'request_id').slice(-4)})`;
    case 'approval_denied':
      return `Denied (..${mstr(m, 'request_id').slice(-4)})`;
    case 'approval_timed_out':
      return `Timed out (..${mstr(m, 'request_id').slice(-4)})`;
    case 'approval_stranded':
      return `Stranded (..${mstr(m, 'request_id').slice(-4)})`;

    default:
      return e.event_type;
  }
}

const EventLine: React.FC<{ event: TaskEvent }> = ({ event }) => {
  const ts = new Date(event.timestamp);
  const time = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
  const c = EVENT_COLOR[event.event_type] ?? 'white';
  const icon = EVENT_ICON[event.event_type] ?? '.';
  const isBold =
    event.event_type === 'tool_call'
    || event.event_type === 'agent_tool_call'
    || event.event_type === 'approval_requested';

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
