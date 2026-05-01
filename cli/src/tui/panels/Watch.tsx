import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import figures from 'figures';
import EventLine from '../components/EventLine.js';
import ApprovalCard from '../components/ApprovalCard.js';
import { useApprovals, useEditing } from '../context.js';
import { getEventsForTask, TERM_WIDTH, type TaskSummary } from '../data.js';
import { fmtDuration, STATUS_COLOR, STATUS_LABEL, trunc } from '../constants.js';

/** Wrap long text to fit within a max width, breaking at word boundaries. */
function wordWrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface WatchProps {
  task: TaskSummary;
  active: boolean;
  onBack: () => void;
}

// Chrome lines consumed by non-event content:
// PeccyMini(4) + title/tabs overlap(0, inline) + separator(1) + task status(1)
// + description(2) + scroll indicator(1) + helpbar(2) + approval card(~6 if shown)
// + spinner(1) + margin(2) = ~20 worst case
const CHROME_LINES = 20;

const Watch: React.FC<WatchProps> = ({ task, active, onBack }) => {
  const { stdout } = useStdout();
  const termRows = process.stdout.rows || stdout?.rows || 30;
  const EVENT_WINDOW = Math.max(5, termRows - CHROME_LINES);

  const { approvals, approve, deny } = useApprovals();
  const { setEditing } = useEditing();
  const [events, setEvents] = useState<typeof taskEvents>([]);
  const [eventIdx, setEventIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [nudging, setNudging] = useState(false);
  const [nudgeText, setNudgeText] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDeny, setConfirmDeny] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(-1); // -1 = auto-follow (show latest)
  const msgTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [, setTick] = useState(0);

  const taskEvents = useMemo(() => getEventsForTask(task.task_id), [task.task_id]);

  const pendingApproval = useMemo(() => {
    const pa = approvals.find(a => a.task_id === task.task_id);
    if (!pa) return null;
    const remaining = Math.max(0, pa.timeout_s - Math.floor((Date.now() - new Date(pa.created_at).getTime()) / 1000));
    return {
      event: {
        event_id: `synth_${pa.request_id}`,
        task_id: pa.task_id,
        event_type: 'approval_requested' as const,
        timestamp: pa.created_at,
        metadata: {
          request_id: pa.request_id,
          tool_name: pa.tool_name,
          input_preview: pa.tool_input_preview,
          reason: pa.reason,
          severity: pa.severity,
        },
      },
      timeoutRemaining: remaining,
      requestId: pa.request_id,
      toolName: pa.tool_name,
    };
  }, [approvals, task.task_id]);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const showMessage = useCallback((msg: string) => {
    setMessage(msg);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = globalThis.setTimeout(() => setMessage(''), 4000);
  }, []);

  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  // Single interval: simulate polling + elapsed
  useEffect(() => {
    const timer = setInterval(() => {
      setEventIdx(prev => {
        if (prev < taskEvents.length) {
          setEvents(taskEvents.slice(0, prev + 1));
          return prev + 1;
        }
        return prev;
      });
      setElapsed(p => p + 1);
    }, 600);
    return () => clearInterval(timer);
  }, [taskEvents]);

  // Editing lock
  useEffect(() => {
    if (confirmDeny) setEditing(true, 'deny-confirm');
    else if (nudging) setEditing(true, 'text');
    else setEditing(false);
    return () => setEditing(false);
  }, [nudging, confirmDeny, setEditing]);

  useInput(useCallback((input, key) => {
    if (!active) return;

    if (confirmDeny) {
      if (input === 'y' || input === 'Y') {
        if (pendingApproval) { deny(pendingApproval.requestId); showMessage(`${figures.cross} Denied ${pendingApproval.toolName}`); }
        setConfirmDeny(false); return;
      }
      if (key.escape || input === 'n' || input === 'N') { setConfirmDeny(false); return; }
      return;
    }

    if (nudging) {
      if (key.escape) { setNudging(false); setNudgeText(''); return; }
      if (key.return && nudgeText.length > 0) { showMessage(`${figures.tick} Nudge sent: "${nudgeText}"`); setNudging(false); setNudgeText(''); return; }
      if (key.backspace || key.delete) { setNudgeText(p => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setNudgeText(p => p + input); }
      return;
    }

    // ↑/↓ scroll through events
    if (key.upArrow && events.length > EVENT_WINDOW) {
      setScrollOffset(prev => {
        const current = prev === -1 ? Math.max(0, events.length - EVENT_WINDOW) : prev;
        return Math.max(0, current - 1);
      });
      return;
    }
    if (key.downArrow && events.length > EVENT_WINDOW) {
      setScrollOffset(prev => {
        if (prev === -1) return -1; // already at bottom
        const maxOffset = Math.max(0, events.length - EVENT_WINDOW);
        const next = prev + 1;
        return next >= maxOffset ? -1 : next; // snap back to auto-follow at bottom
      });
      return;
    }

    if (key.escape) { onBack(); return; }
    if (input === 'n') { setNudging(true); return; }
    if (input === 'a' && pendingApproval) { approve(pendingApproval.requestId); showMessage(`${figures.tick} Approved ${pendingApproval.toolName}`); return; }
    if (input === 'd' && pendingApproval) { setConfirmDeny(true); return; }
    if ((input === 'a' || input === 'd') && !pendingApproval) { showMessage('No pending approval for this task'); return; }
  }, [active, nudging, confirmDeny, nudgeText, pendingApproval, approve, deny, onBack, showMessage, events.length]));

  const isPolling = eventIdx < taskEvents.length;
  const sc = STATUS_COLOR[task.status] ?? 'white';
  const sl = STATUS_LABEL[task.status] ?? task.status;

  const descMaxWidth = TERM_WIDTH - 10;
  const descLines = wordWrap(task.task_description, descMaxWidth);

  // Compute visible event window
  const isAutoFollow = scrollOffset === -1;
  const visibleStart = isAutoFollow
    ? Math.max(0, events.length - EVENT_WINDOW)
    : scrollOffset;
  const visibleEvents = events.slice(visibleStart, visibleStart + EVENT_WINDOW);
  const canScrollUp = visibleStart > 0;
  const canScrollDown = !isAutoFollow;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Compact header — single line status */}
      <Box>
        <Text bold>Task </Text>
        <Text color="blue" underline>..{task.task_id.slice(-4)}</Text>
        <Text>  </Text>
        <Text color={sc} bold>{sl}</Text>
        <Text dimColor>  {task.repo}  Step {task.turn}/~{task.max_turns ?? '?'}  {fmtDuration(elapsed)}</Text>
        {task.cost_usd != null && <Text color="yellow">  ${task.cost_usd.toFixed(4)}</Text>}
      </Box>
      {/* Description — word wrapped */}
      {descLines.map((line, i) => (
        <Text key={i} dimColor>  {line}</Text>
      ))}

      {/* Scroll indicator */}
      {canScrollUp && (
        <Text dimColor>  {figures.arrowUp} {visibleStart} more events above</Text>
      )}

      {/* Event stream — fixed height window */}
      <Box flexDirection="column" marginTop={1}>
        {events.length === 0 ? (
          <Box><Text color="cyan"><Spinner type="dots" /></Text><Text> Waiting for events…</Text></Box>
        ) : (
          visibleEvents.map(e => <EventLine key={e.event_id} event={e} />)
        )}
        {isPolling && isAutoFollow && events.length > 0 && (
          <Box><Text color="cyan"><Spinner type="dots" /></Text><Text dimColor> polling…</Text></Box>
        )}
        {canScrollDown && (
          <Text dimColor>  {figures.arrowDown} more events below (↓ to scroll, or keep waiting)</Text>
        )}
      </Box>

      {/* Approval card */}
      {pendingApproval && !nudging && !confirmDeny && (
        <ApprovalCard
          event={pendingApproval.event}
          taskDescription={task.task_description}
          repo={task.repo}
          timeoutRemaining={pendingApproval.timeoutRemaining}
        />
      )}

      {/* Deny confirmation */}
      {confirmDeny && (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="red" bold>{figures.warning} Confirm deny?</Text>
          <Text>The agent will be blocked and may not be able to continue.</Text>
          <Box><Text color="red" bold>[y]</Text><Text> Deny  </Text><Text bold>[n]</Text><Text> Cancel</Text></Box>
        </Box>
      )}

      {/* Nudge input */}
      {nudging && (
        <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>{figures.arrowRight} Nudge the agent</Text>
          <Box>
            <Text dimColor>{figures.pointer} </Text>
            {nudgeText ? <Text>{nudgeText}</Text> : <Text dimColor>e.g. "focus on the tests first"</Text>}
            <Text color="cyan">|</Text>
          </Box>
          <Text dimColor>Enter: send  Esc: cancel</Text>
        </Box>
      )}

      {/* Status message */}
      {message && !confirmDeny && (
        <Box marginTop={1}><Text color="green">{message}</Text></Box>
      )}
    </Box>
  );
};

export default Watch;
