import React from 'react';
import { Box, Text } from 'ink';
import type { TaskEvent } from '../data.js';
import { EVENT_COLOR, EVENT_ICON, trunc } from '../constants.js';
import { TRUNC_TOOL_INPUT } from '../data.js';

function fmt(e: TaskEvent): string {
  const m = e.metadata;
  switch (e.event_type) {
    case 'task_started': return 'Task started';
    case 'turn_start': return `Step ${m.turn} ${'─'.repeat(30)}`;
    case 'tool_call': return `${m.tool_name}  ${trunc(m.args_preview ?? '', TRUNC_TOOL_INPUT)}`;
    case 'tool_result': return `${m.tool_name} → ${m.status} ${m.preview ? `(${trunc(m.preview, 30)})` : ''}`;
    case 'milestone': return m.message ?? 'Milestone';
    case 'cost_update': return `Cost: $${Number(m.total_usd).toFixed(4)}`;
    case 'approval_requested': return `APPROVAL NEEDED: ${m.tool_name} — ${trunc(m.input_preview ?? '', TRUNC_TOOL_INPUT)}`;
    case 'approval_granted': return `Approved (..${(m.request_id ?? '').slice(-4)})`;
    case 'approval_denied': return `Denied (..${(m.request_id ?? '').slice(-4)})`;
    case 'approval_timed_out': return `Timed out (..${(m.request_id ?? '').slice(-4)})`;
    case 'task_complete': return 'Task completed';
    case 'task_failed': return 'Task failed';
    default: return e.event_type;
  }
}

const EventLine: React.FC<{ event: TaskEvent }> = ({ event }) => {
  const ts = new Date(event.timestamp);
  const time = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
  const c = EVENT_COLOR[event.event_type] ?? 'white';
  const icon = EVENT_ICON[event.event_type] ?? '.';
  const isBold = event.event_type === 'tool_call' || event.event_type === 'approval_requested';

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
