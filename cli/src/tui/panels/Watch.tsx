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

import figures from 'figures';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { TERMINAL_STATUSES, type ApprovalScope } from '../../types.js';
import ApprovalCard from '../components/ApprovalCard.js';
import DenyReasonInput from '../components/DenyReasonInput.js';
import EventLine from '../components/EventLine.js';
import ScopePicker from '../components/ScopePicker.js';
import { fmtDuration, STATUS_COLOR, STATUS_LABEL, trunc } from '../constants.js';
import { useApprovals, useEditing } from '../context.js';
import { TERM_WIDTH, type TaskRowView, type TaskEvent } from '../data.js';
import { useData } from '../hooks/useData.js';
import { INITIAL_POLL_CADENCE, nextCadence, type PollCadenceState } from '../utils/polling.js';

/** Broaden `readonly string[]` so callers can test arbitrary strings
 *  without `as`. Mirrors the usage in `commands/watch.ts`. */
function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

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
  task: TaskRowView;
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
  const { getTaskEvents, source } = useData();
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [eventIdx, setEventIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [nudging, setNudging] = useState(false);
  const [nudgeText, setNudgeText] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDeny, setConfirmDeny] = useState(false);
  const [showScopePicker, setShowScopePicker] = useState(false);
  const [showDenyInput, setShowDenyInput] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(-1); // -1 = auto-follow (show latest)
  const msgTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [, setTick] = useState(0);

  const taskIsTerminal = isTerminalStatus(task.status);

  // Hydrate events on task change. In mock mode the full list resolves
  // immediately and the simulated-polling effect below replays it one
  // frame at a time. In real mode we refetch on an adaptive cadence
  // (500ms → 1s/2s/5s backoff on consecutive empty polls, reset to
  // fast on the next non-empty poll) — matches `commands/watch.ts`
  // so the TUI's perceived liveness is the same as the CLI's.
  //
  // When the task is already in a terminal status (COMPLETED / FAILED
  // / CANCELLED / TIMED_OUT), we do ONE event hydration and stop —
  // no further polling. This mirrors `bgagent watch`'s
  // already-terminal short-circuit and avoids burning API calls on
  // a task whose stream is closed. The `task.status` dep makes the
  // effect re-run when a running task transitions to terminal while
  // the Watch panel is mounted.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let cadence: PollCadenceState = INITIAL_POLL_CADENCE;
    // Cursor is the last seen event_id. On first poll it's null →
    // the source drains all pages. On subsequent polls we pass it
    // via `after` so the source's `catchUpEvents` only returns the
    // new tail. This makes `pr_created` / `task_completed` always
    // land even on 300+ event streams, and keeps the user's scroll
    // position stable between polls.
    let lastEventId: string | null = null;

    // Reset event state when the task changes. If we're re-entering
    // the same task, the cursor is fresh (null) → a full reload.
    setTaskEvents([]);

    const scheduleNext = (ms: number) => {
      if (cancelled) return;
      timer = globalThis.setTimeout(() => { void poll(); }, ms);
    };

    const poll = async () => {
      if (cancelled) return;
      try {
        const newEvents = await getTaskEvents(
          task.task_id,
          lastEventId ? { after: lastEventId } : undefined,
        );
        if (cancelled) return;
        const sawNew = newEvents.length > 0;
        if (sawNew) {
          lastEventId = newEvents[newEvents.length - 1].event_id;
          // Filter out `approval_decision_recorded` audit events: they
          // are written by ApproveTaskFn / DenyTaskFn directly to
          // TaskEventsTable and duplicate the agent-side
          // `approval_granted` / `approval_denied` milestones the user
          // already sees in the stream. Surfacing both is just noise
          // from a TUI viewer's perspective; the audit row remains
          // queryable via the API for compliance use cases.
          const filtered = newEvents.filter(
            (e) => e.event_type !== 'approval_decision_recorded',
          );
          // Append to existing — dedup by event_id in case the server
          // echoes a boundary row (ULIDs are monotonic so in practice
          // this is belt-and-suspenders). Stable order is maintained
          // because `catchUpEvents` preserves ascending event_id.
          setTaskEvents((prev) => {
            const seen = new Set(prev.map(e => e.event_id));
            const toAppend = filtered.filter(e => !seen.has(e.event_id));
            return toAppend.length > 0 ? [...prev, ...toAppend] : prev;
          });
        }
        if (source.label === 'live' && !taskIsTerminal) {
          cadence = nextCadence(cadence, sawNew);
          scheduleNext(cadence.intervalMs);
        }
      } catch {
        // Surface errors via the data provider's error channel
        // (future: inline toast); keep the old events and retry on
        // the slowest cadence slot so we don't hammer a degraded
        // upstream. Terminal tasks don't retry — their stream is
        // closed and retrying is pointless.
        if (!cancelled && source.label === 'live' && !taskIsTerminal) {
          scheduleNext(5_000);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [task.task_id, task.status, getTaskEvents, source.label, taskIsTerminal]);

  const pendingApproval = useMemo(() => {
    // Source of truth: the task's `awaiting_approval_request_id`.
    // Fall back to a task-id match on the approvals list if the
    // task detail is still loading (real-mode race) or if this is
    // a pre-Cedar-HITL record missing the field.
    const expectedId = task.awaiting_approval_request_id;
    const pa = expectedId
      ? approvals.find(a => a.request_id === expectedId)
      : approvals.find(a => a.task_id === task.task_id);
    if (!pa) return null;
    // Prefer server `expires_at` for the countdown — authoritative
    // once the approval row lands. Fall back to `timeout_s - elapsed`
    // on records without it.
    const expiresAt = pa.expires_at ? new Date(pa.expires_at).getTime() : null;
    const remaining = expiresAt
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      : Math.max(0, pa.timeout_s - Math.floor((Date.now() - new Date(pa.created_at).getTime()) / 1000));
    return {
      event: {
        event_id: `synth_${pa.request_id}`,
        event_type: 'approval_requested' as const,
        timestamp: pa.created_at,
        metadata: {
          task_id: pa.task_id,
          request_id: pa.request_id,
          tool_name: pa.tool_name,
          input_preview: pa.tool_input_preview,
          reason: pa.reason,
          severity: pa.severity,
          // matching_rule_ids surfaces in ApprovalCard's "Triggered"
          // line — closes the asymmetry where Approvals.tsx detail view
          // showed the firing rule but the Watch overlay didn't.
          matching_rule_ids: [...pa.matching_rule_ids],
        },
      } as TaskEvent,
      timeoutRemaining: remaining,
      requestId: pa.request_id,
      toolName: pa.tool_name,
    };
  }, [approvals, task.task_id, task.awaiting_approval_request_id]);

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

  // In mock mode replay events one-at-a-time so the stream looks
  // alive. In live mode we already see real events as they land, so
  // just flush the whole list and only animate the elapsed counter.
  useEffect(() => {
    if (source.label === 'live') {
      setEvents(taskEvents);
      const timer = setInterval(() => setElapsed(p => p + 1), 1000);
      return () => clearInterval(timer);
    }
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
  }, [taskEvents, source.label]);

  // Editing lock — pick the most specific lock mode for the help bar
  useEffect(() => {
    if (showScopePicker) setEditing(true, 'scope-picker');
    else if (showDenyInput) setEditing(true, 'text');
    else if (confirmDeny) setEditing(true, 'deny-confirm');
    else if (nudging) setEditing(true, 'text');
    else setEditing(false);
    return () => setEditing(false);
  }, [nudging, confirmDeny, showScopePicker, showDenyInput, setEditing]);

  useInput(useCallback((input, key) => {
    if (!active) return;

    // Scope picker + deny-input own their own input while mounted.
    if (showScopePicker || showDenyInput) return;

    if (confirmDeny) {
      if (input === 'y' || input === 'Y') {
        if (pendingApproval) { setShowDenyInput(true); }
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
    if (input === 'a' && pendingApproval) { setShowScopePicker(true); return; }
    if (input === 'd' && pendingApproval) { setConfirmDeny(true); return; }
    if ((input === 'a' || input === 'd') && !pendingApproval) { showMessage('No pending approval for this task'); return; }
  }, [active, nudging, confirmDeny, showScopePicker, showDenyInput, nudgeText, pendingApproval, approve, deny, onBack, showMessage, events.length]));

  const handleApproveWithScope = useCallback((scope: ApprovalScope) => {
    if (pendingApproval) {
      approve(pendingApproval.requestId, scope);
      showMessage(`${figures.tick} Approved ${pendingApproval.toolName} (${scope})`);
    }
    setShowScopePicker(false);
  }, [pendingApproval, approve, showMessage]);

  const handleDenyWithReason = useCallback((reason: string) => {
    if (pendingApproval) {
      deny(pendingApproval.requestId, reason || undefined);
      showMessage(`${figures.cross} Denied ${pendingApproval.toolName}${reason ? ` — "${trunc(reason, 30)}"` : ''}`);
    }
    setShowDenyInput(false);
  }, [pendingApproval, deny, showMessage]);

  // Mock-mode "replay animation still in flight" indicator. Irrelevant
  // in live mode (the stream is either polling or closed — tracked via
  // `taskIsTerminal`). Suppressed once the task reaches terminal status
  // so a COMPLETED/FAILED task doesn't keep showing a spinner.
  const isPolling = !taskIsTerminal && eventIdx < taskEvents.length;
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
        <Text dimColor>  {task.repo}  Step {task.turn ?? 0}/~{task.max_turns ?? '?'}  {fmtDuration(elapsed)}</Text>
        {task.cost_usd != null && <Text color="yellow">  ${task.cost_usd.toFixed(4)}</Text>}
      </Box>
      {/* Cedar HITL gate budget — only rendered when we have the
          counters (null on pre-Cedar-HITL tasks). */}
      {task.approval_gate_count != null && task.approval_gate_cap != null && (
        <Box>
          <Text dimColor>  Approval gates: </Text>
          <Text color={
            task.approval_gate_count >= task.approval_gate_cap * 0.8 ? 'red'
              : task.approval_gate_count >= task.approval_gate_cap * 0.5 ? 'yellow'
                : undefined
          }>
            {task.approval_gate_count}/{task.approval_gate_cap}
          </Text>
          <Text dimColor> used</Text>
        </Box>
      )}
      {/* PR banner — pinned to the header area so once a PR lands it
          stays visible regardless of event-stream scroll position.
          `pr_url` is populated by the agent's `pr_created` milestone
          and carried on TaskDetail; we just echo it. */}
      {task.pr_url && (
        <Box>
          <Text color="green" bold>  {figures.tick} PR:</Text>
          <Text>  </Text>
          <Text color="blue" underline>{task.pr_url}</Text>
        </Box>
      )}
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
        {taskIsTerminal && events.length > 0 && (
          <Box>
            <Text color={sc}>{figures.tick} </Text>
            <Text dimColor>Stream closed — task </Text>
            <Text color={sc}>{sl}</Text>
          </Box>
        )}
        {canScrollDown && (
          <Text dimColor>  {figures.arrowDown} more events below (↓ to scroll, or keep waiting)</Text>
        )}
      </Box>

      {/* Approval card */}
      {pendingApproval && !nudging && !confirmDeny && !showScopePicker && !showDenyInput && (
        <ApprovalCard
          event={pendingApproval.event}
          taskDescription={task.task_description}
          repo={task.repo}
          timeoutRemaining={pendingApproval.timeoutRemaining}
        />
      )}

      {/* Scope picker (approve) */}
      {showScopePicker && pendingApproval && (
        <ScopePicker
          heading={`Approve ${pendingApproval.toolName}`}
          onConfirm={handleApproveWithScope}
          onCancel={() => setShowScopePicker(false)}
        />
      )}

      {/* Deny confirmation → deny reason input */}
      {confirmDeny && (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="red" bold>{figures.warning} Confirm deny?</Text>
          <Text>The agent will be blocked and may not be able to continue.</Text>
          <Box><Text color="red" bold>[y]</Text><Text> Add reason  </Text><Text bold>[n]</Text><Text> Cancel</Text></Box>
        </Box>
      )}
      {showDenyInput && (
        <DenyReasonInput
          onConfirm={handleDenyWithReason}
          onCancel={() => setShowDenyInput(false)}
        />
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
