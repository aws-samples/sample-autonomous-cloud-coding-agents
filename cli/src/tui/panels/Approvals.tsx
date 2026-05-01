import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import figures from 'figures';
import { useApprovals, useEditing } from '../context.js';
import { SEPARATOR_WIDTH, TRUNC_TOOL_INPUT, TRUNC_REASON, TRUNC_DESCRIPTION_LONG } from '../data.js';
import { SEVERITY_COLOR, SEVERITY_LABEL, trunc, fmtDuration } from '../constants.js';

interface ApprovalsProps {
  active: boolean;
  onDetailChange?: (inDetail: boolean) => void;
}

const Approvals: React.FC<ApprovalsProps> = ({ active, onDetailChange }) => {
  const { approvals, approve, deny } = useApprovals();
  const { setEditing } = useEditing();
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState('');
  const [confirmDeny, setConfirmDeny] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const msgTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  const showMessage = useCallback((msg: string) => {
    setMessage(msg);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = globalThis.setTimeout(() => setMessage(''), 4000);
  }, []);

  const { byTask, flatList } = useMemo(() => {
    const byTask = new Map<string, typeof approvals>();
    for (const a of approvals) {
      const arr = byTask.get(a.task_id) ?? [];
      arr.push(a);
      byTask.set(a.task_id, arr);
    }
    return { byTask, flatList: Array.from(byTask.values()).flat() };
  }, [approvals]);

  useEffect(() => {
    if (flatList.length === 0) { setCursor(0); setDetailId(null); }
    else if (cursor >= flatList.length) setCursor(flatList.length - 1);
  }, [flatList.length, cursor]);

  // Close detail if the viewed approval got resolved
  useEffect(() => {
    if (detailId && !flatList.find(a => a.request_id === detailId)) {
      setDetailId(null);
    }
  }, [flatList, detailId]);

  // Notify parent of detail mode changes
  useEffect(() => {
    onDetailChange?.(!!detailId);
  }, [detailId, onDetailChange]);

  useEffect(() => {
    setEditing(!!confirmDeny, 'deny-confirm');
    return () => setEditing(false);
  }, [confirmDeny, setEditing]);

  const elapsed = (iso: string): number => Math.floor((Date.now() - new Date(iso).getTime()) / 1000);

  // The approval currently being viewed in detail (or selected in list)
  const activeApproval = detailId
    ? flatList.find(a => a.request_id === detailId)
    : flatList[cursor];

  useInput(useCallback((input, key) => {
    if (!active) return;

    // Deny confirmation
    if (confirmDeny) {
      if (input === 'y' || input === 'Y') {
        const a = flatList.find(x => x.request_id === confirmDeny);
        if (a) { deny(confirmDeny); showMessage(`${figures.cross} Denied ${a.tool_name} for ..${a.task_id.slice(-4)}`); }
        setConfirmDeny(null); setDetailId(null); return;
      }
      if (key.escape || input === 'n' || input === 'N') { setConfirmDeny(null); return; }
      return;
    }

    // Detail view mode
    if (detailId) {
      if (key.escape) { setDetailId(null); return; }
      if (input === 'a' && activeApproval) {
        approve(activeApproval.request_id);
        showMessage(`${figures.tick} Approved ${activeApproval.tool_name} for ..${activeApproval.task_id.slice(-4)}`);
        setDetailId(null); return;
      }
      if (input === 'd' && activeApproval) { setConfirmDeny(activeApproval.request_id); return; }
      return;
    }

    // List view
    if (flatList.length === 0) return;
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(flatList.length - 1, c + 1));

    // Enter → detail view
    if (key.return && flatList[cursor]) {
      setDetailId(flatList[cursor].request_id);
      return;
    }

    // Quick approve/deny from list
    const selected = flatList[cursor];
    if (input === 'a' && selected) { approve(selected.request_id); showMessage(`${figures.tick} Approved ${selected.tool_name} for ..${selected.task_id.slice(-4)}`); }
    if (input === 'd' && selected) { setConfirmDeny(selected.request_id); }
  }, [active, flatList, cursor, confirmDeny, detailId, activeApproval, approve, deny, showMessage]));

  let renderIdx = 0;

  // ── Detail view ─────────────────────────────────────────────────

  if (detailId && activeApproval) {
    const a = activeApproval;
    const sev = a.severity.toUpperCase();
    const remaining = Math.max(0, a.timeout_s - elapsed(a.created_at));
    const timeColor = remaining <= 120 ? 'red' : remaining <= 300 ? 'yellow' : undefined;

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold>{figures.warning} Approval Detail</Text>
          <Text dimColor>  Esc to go back</Text>
        </Box>

        <Box borderStyle="single" borderColor="magenta" paddingX={1} flexDirection="column">
          {/* Severity + timeout header */}
          <Box justifyContent="space-between">
            <Text color={SEVERITY_COLOR[sev]} bold>{figures.warning} {SEVERITY_LABEL[sev] ?? sev}</Text>
            <Box>
              <Text dimColor>Timeout: </Text>
              <Text color={timeColor} bold>{fmtDuration(remaining)}</Text>
              {remaining <= 120 && <Text color="red"> {figures.warning}</Text>}
            </Box>
          </Box>

          <Text> </Text>

          {/* Task context */}
          <Box><Text dimColor>Task:         </Text><Text color="blue" underline>..{a.task_id.slice(-4)}</Text><Text>  {a.repo}</Text></Box>
          <Box flexDirection="column">
            <Text dimColor>Goal:</Text>
            <Box marginLeft={2}><Text>{a.task_description}</Text></Box>
          </Box>

          <Text> </Text>

          {/* What the agent wants to do */}
          <Box flexDirection="column">
            <Text dimColor>Wants to:</Text>
            <Box marginLeft={2}>
              <Text bold>{a.tool_name}</Text>
              <Text> {figures.arrowRight} </Text>
            </Box>
            <Box marginLeft={2}><Text>{a.tool_input_preview}</Text></Box>
          </Box>

          <Text> </Text>

          {/* Why */}
          <Box flexDirection="column">
            <Text dimColor>Why:</Text>
            <Box marginLeft={2}><Text>{a.reason}</Text></Box>
          </Box>

          {/* Matching rules */}
          {a.matching_rule_ids.length > 0 && (
            <>
              <Text> </Text>
              <Box>
                <Text dimColor>Triggered by:  </Text>
                <Text color="yellow">{a.matching_rule_ids.join(', ')}</Text>
              </Box>
            </>
          )}
        </Box>

        <Text> </Text>

        {/* Actions */}
        <Box>
          <Text color="green" bold>[a]</Text><Text> Approve   </Text>
          <Text color="red" bold>[d]</Text><Text> Deny   </Text>
          <Text bold>[Esc]</Text><Text dimColor> Back to list</Text>
        </Box>

        {/* Deny confirmation (overlays in detail view) */}
        {confirmDeny && (
          <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" marginTop={1}>
            <Text color="red" bold>{figures.warning} Confirm deny?</Text>
            <Text>The agent will be blocked and may not be able to continue.</Text>
            <Box><Text color="red" bold>[y]</Text><Text> Deny  </Text><Text bold>[n]</Text><Text> Cancel</Text></Box>
          </Box>
        )}

        {message && !confirmDeny && (
          <Box marginTop={1}><Text color="green">{message}</Text></Box>
        )}
      </Box>
    );
  }

  // ── List view ───────────────────────────────────────────────────

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>{figures.warning} Pending Approvals</Text>
        <Text dimColor>  {flatList.length} pending across {byTask.size} task{byTask.size !== 1 ? 's' : ''}</Text>
      </Box>

      {flatList.length === 0 ? (
        <Box flexDirection="column">
          <Text color="green">{figures.tick} No pending approvals. All clear!</Text>
          <Text dimColor>Approvals appear here when agents need permission to proceed.</Text>
        </Box>
      ) : (
        Array.from(byTask.entries()).map(([taskId, taskApprovals]) => {
          const first = taskApprovals[0];
          return (
            <Box key={taskId} flexDirection="column" marginBottom={1}>
              <Text dimColor>{'─'.repeat(SEPARATOR_WIDTH)}</Text>
              <Box>
                <Text dimColor>Task:  </Text>
                <Text color="blue" underline>..{taskId.slice(-4)}</Text>
                <Text>  </Text><Text>{first.repo}</Text>
              </Box>
              <Box>
                <Text dimColor>Goal:  </Text>
                <Text>{trunc(first.task_description, TRUNC_DESCRIPTION_LONG)}</Text>
              </Box>
              <Text> </Text>
              {taskApprovals.map(a => {
                const idx = renderIdx++;
                const sel = idx === cursor && active;
                const sev = a.severity.toUpperCase();
                const remaining = Math.max(0, a.timeout_s - elapsed(a.created_at));
                const timeColor = remaining <= 120 ? 'red' : remaining <= 300 ? 'yellow' : undefined;

                return (
                  <Box key={a.request_id} flexDirection="column" marginLeft={2}>
                    <Box>
                      <Text color={sel ? 'cyan' : undefined}>{sel ? figures.pointer + ' ' : '  '}</Text>
                      <Text color={SEVERITY_COLOR[sev]} bold>{figures.warning} {SEVERITY_LABEL[sev] ?? sev}</Text>
                    </Box>
                    <Box marginLeft={4}>
                      <Text dimColor>Wants to:  </Text>
                      <Text bold>{a.tool_name}</Text>
                      <Text> {figures.arrowRight} </Text>
                      <Text>{trunc(a.tool_input_preview, TRUNC_TOOL_INPUT)}</Text>
                    </Box>
                    <Box marginLeft={4}>
                      <Text dimColor>Why:       </Text>
                      <Text>{trunc(a.reason, TRUNC_REASON)}</Text>
                    </Box>
                    <Box marginLeft={4}>
                      <Text dimColor>Timeout:   </Text>
                      <Text color={timeColor}>{fmtDuration(remaining)}</Text>
                      {remaining <= 120 && <Text color="red"> {figures.warning}</Text>}
                    </Box>
                    {sel && <Box marginLeft={4}><Text dimColor>Enter for full detail</Text></Box>}
                    <Text> </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })
      )}

      {confirmDeny && (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="red" bold>{figures.warning} Confirm deny?</Text>
          <Text>The agent will be blocked and may not be able to continue.</Text>
          <Box><Text color="red" bold>[y]</Text><Text> Deny  </Text><Text bold>[n]</Text><Text> Cancel</Text></Box>
        </Box>
      )}

      {message && !confirmDeny && (
        <Box marginTop={1}><Text color="green">{message}</Text></Box>
      )}
    </Box>
  );
};

export default Approvals;
