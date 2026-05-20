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
import { Box, Text, useInput } from 'ink';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { ApprovalScope } from '../../types.js';
import DenyReasonInput from '../components/DenyReasonInput.js';
import ScopePicker from '../components/ScopePicker.js';
import { SEVERITY_COLOR, SEVERITY_LABEL, trunc, fmtDuration } from '../constants.js';
import { useApprovals, useEditing } from '../context.js';
import { SEPARATOR_WIDTH, TRUNC_TOOL_INPUT, TRUNC_REASON, TRUNC_DESCRIPTION_LONG } from '../data.js';
import { useData } from '../hooks/useData.js';

interface ApprovalsProps {
  active: boolean;
  onDetailChange?: (inDetail: boolean) => void;
}

const Approvals: React.FC<ApprovalsProps> = ({ active, onDetailChange }) => {
  const { approvals, approve, deny } = useApprovals();
  const { resetPendingCadence } = useData();
  const { setEditing } = useEditing();

  // When the panel becomes active, reset the /v1/pending cadence to
  // fast (3 s) and trigger an immediate refresh. Without this, after
  // sitting idle on Tasks for a while the pending ladder will have
  // backed off to 30 s, and the user would see stale approvals on
  // entry. This is the targeted-Option-4 piece of the cadence fix.
  useEffect(() => {
    if (active) resetPendingCadence();
  }, [active, resetPendingCadence]);
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState('');
  const [confirmDeny, setConfirmDeny] = useState<string | null>(null);
  const [denyReasonFor, setDenyReasonFor] = useState<string | null>(null);
  const [scopePickerFor, setScopePickerFor] = useState<string | null>(null);
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
    if (flatList.length === 0) { setCursor(0); setDetailId(null); } else if (cursor >= flatList.length) {setCursor(flatList.length - 1);}
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
    if (scopePickerFor) setEditing(true, 'scope-picker');
    else if (denyReasonFor) setEditing(true, 'text');
    else if (confirmDeny) setEditing(true, 'deny-confirm');
    else setEditing(false);
    return () => setEditing(false);
  }, [confirmDeny, denyReasonFor, scopePickerFor, setEditing]);

  const elapsed = (iso: string): number => Math.floor((Date.now() - new Date(iso).getTime()) / 1000);

  /** Seconds remaining before the approval auto-denies. Prefer the
   *  server's `expires_at` (authoritative — the server already
   *  accounts for cap clipping etc.); fall back to derived
   *  `timeout_s - elapsed(created_at)` only if expires_at is
   *  missing. */
  const computeRemaining = (expiresAt: string, createdAt: string, timeoutS: number): number => {
    if (expiresAt) {
      const ms = new Date(expiresAt).getTime() - Date.now();
      return Math.max(0, Math.floor(ms / 1000));
    }
    return Math.max(0, timeoutS - elapsed(createdAt));
  };

  // The approval currently being viewed in detail (or selected in list)
  const activeApproval = detailId
    ? flatList.find(a => a.request_id === detailId)
    : flatList[cursor];

  useInput(useCallback((input, key) => {
    if (!active) return;

    // Child overlays own input while mounted.
    if (scopePickerFor || denyReasonFor) return;

    // Deny confirmation — pressing y now opens the reason input.
    if (confirmDeny) {
      if (input === 'y' || input === 'Y') {
        setDenyReasonFor(confirmDeny);
        setConfirmDeny(null); return;
      }
      if (key.escape || input === 'n' || input === 'N') { setConfirmDeny(null); return; }
      return;
    }

    // Detail view mode
    if (detailId) {
      if (key.escape) { setDetailId(null); return; }
      if (input === 'a' && activeApproval) {
        setScopePickerFor(activeApproval.request_id);
        return;
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

    // Quick approve/deny from list → open picker / reason input
    const selected = flatList[cursor];
    if (input === 'a' && selected) { setScopePickerFor(selected.request_id); }
    if (input === 'd' && selected) { setConfirmDeny(selected.request_id); }
  }, [active, flatList, cursor, confirmDeny, detailId, activeApproval, scopePickerFor, denyReasonFor]));

  const handleApproveWithScope = useCallback((scope: ApprovalScope) => {
    const a = flatList.find(x => x.request_id === scopePickerFor);
    const requestId = scopePickerFor;
    setScopePickerFor(null);
    setDetailId(null);
    if (!a || !requestId) return;
    // Await the round-trip so the success message reflects the API's
    // actual decision rather than the user's optimistic intent. Phase A
    // live drive caught the silent-failure case where the toast lied
    // and the agent stayed blocked until timeout.
    void (async () => {
      const result = await approve(requestId, scope);
      if (result.ok) {
        showMessage(`${figures.tick} Approved ${a.tool_name} for ..${a.task_id.slice(-4)} (${scope})`);
      } else {
        showMessage(`${figures.cross} Approve failed for ..${a.task_id.slice(-4)} — ${trunc(result.error, 60)}`);
      }
    })();
  }, [flatList, scopePickerFor, approve, showMessage]);

  const handleDenyWithReason = useCallback((reason: string) => {
    const a = flatList.find(x => x.request_id === denyReasonFor);
    const requestId = denyReasonFor;
    setDenyReasonFor(null);
    setDetailId(null);
    if (!a || !requestId) return;
    void (async () => {
      const result = await deny(requestId, reason || undefined);
      if (result.ok) {
        showMessage(`${figures.cross} Denied ${a.tool_name} for ..${a.task_id.slice(-4)}${reason ? ` — "${trunc(reason, 30)}"` : ''}`);
      } else {
        showMessage(`${figures.cross} Deny failed for ..${a.task_id.slice(-4)} — ${trunc(result.error, 60)}`);
      }
    })();
  }, [flatList, denyReasonFor, deny, showMessage]);

  let renderIdx = 0;

  // ── Detail view ─────────────────────────────────────────────────

  if (detailId && activeApproval) {
    const a = activeApproval;
    const sev = a.severity; // already UPPERCASE per view-model contract
    const remaining = computeRemaining(a.expires_at, a.created_at, a.timeout_s);
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
            <Box><Text color="red" bold>[y]</Text><Text> Add reason  </Text><Text bold>[n]</Text><Text> Cancel</Text></Box>
          </Box>
        )}

        {scopePickerFor && (
          <ScopePicker
            heading={`Approve ${a.tool_name}`}
            onConfirm={handleApproveWithScope}
            onCancel={() => setScopePickerFor(null)}
          />
        )}

        {denyReasonFor && (
          <DenyReasonInput
            onConfirm={handleDenyWithReason}
            onCancel={() => setDenyReasonFor(null)}
          />
        )}

        {message && !confirmDeny && !scopePickerFor && !denyReasonFor && (
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
                const sev = a.severity; // already UPPERCASE
                const remaining = computeRemaining(a.expires_at, a.created_at, a.timeout_s);
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
          <Box><Text color="red" bold>[y]</Text><Text> Add reason  </Text><Text bold>[n]</Text><Text> Cancel</Text></Box>
        </Box>
      )}

      {scopePickerFor && (() => {
        const sel = flatList.find(x => x.request_id === scopePickerFor);
        return sel ? (
          <ScopePicker
            heading={`Approve ${sel.tool_name}`}
            onConfirm={handleApproveWithScope}
            onCancel={() => setScopePickerFor(null)}
          />
        ) : null;
      })()}

      {denyReasonFor && (
        <DenyReasonInput
          onConfirm={handleDenyWithReason}
          onCancel={() => setDenyReasonFor(null)}
        />
      )}

      {message && !confirmDeny && !scopePickerFor && !denyReasonFor && (
        <Box marginTop={1}><Text color="green">{message}</Text></Box>
      )}
    </Box>
  );
};

export default Approvals;
