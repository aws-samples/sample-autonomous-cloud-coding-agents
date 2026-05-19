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
 * Shared TUI context — approval state + editing lock.
 *
 * Approvals are owned by the DataProvider (`hooks/useData.tsx`): it
 * polls the source and exposes a `snapshot.approvals` array. The
 * approval context here wraps that snapshot with local optimistic
 * clearing on approve/deny so the panel redraws instantly rather
 * than waiting on the next poll. The mutation itself is forwarded
 * to the source via `useData().approve/.deny` (which also triggers
 * a refresh).
 */
import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { ApprovalScope } from '../types.js';
import type { PendingApprovalView } from './data.js';
import { useData } from './hooks/useData.js';

// ── Approval state ──────────────────────────────────────────────────

/**
 * Result of an approve/deny round-trip. Callers MUST distinguish the
 * two cases: an `ok: false` result on a human-in-the-loop safety
 * control means the API rejected the decision (auth, validation,
 * stale request_id, etc.) — the agent is still blocked, the user's
 * intent did NOT take effect, and the optimistic-clear has been
 * undone so the row reappears in the list.
 */
export type ApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

interface ApprovalActions {
  approvals: PendingApprovalView[];
  approve: (requestId: string, scope?: ApprovalScope) => Promise<ApprovalResult>;
  deny: (requestId: string, reason?: string) => Promise<ApprovalResult>;
}

const ApprovalCtx = createContext<ApprovalActions>({
  approvals: [],
  approve: async () => ({ ok: false, error: 'no provider' }),
  deny: async () => ({ ok: false, error: 'no provider' }),
});

export const useApprovals = () => useContext(ApprovalCtx);

// ── Editing lock ────────────────────────────────────────────────────

export type EditMode = 'text' | 'deny-confirm' | 'scope-picker' | null;

interface EditingState {
  isEditing: boolean;
  editMode: EditMode;
  setEditing: (v: boolean, mode?: EditMode) => void;
}

const EditingCtx = createContext<EditingState>({
  isEditing: false,
  editMode: null,
  setEditing: () => {},
});

export const useEditing = () => useContext(EditingCtx);

// ── Provider ────────────────────────────────────────────────────────

export const TuiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { snapshot, approve: sourceApprove, deny: sourceDeny } = useData();

  // Optimistic suppression list: request_ids that the user just
  // approved/denied — filtered out of the view until the next poll
  // echoes their absence.
  const [optimisticallyCleared, setOptimisticallyCleared] = useState<Set<string>>(new Set());
  const [isEditing, setIsEditing] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>(null);

  // Once the server snapshot no longer includes a cleared id, drop it
  // from the suppression set so we don't leak memory.
  useEffect(() => {
    setOptimisticallyCleared(prev => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(snapshot.approvals.map(a => a.request_id));
      const next = new Set<string>();
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [snapshot.approvals]);

  const approvals = useMemo(
    () => snapshot.approvals.filter(a => !optimisticallyCleared.has(a.request_id)),
    [snapshot.approvals, optimisticallyCleared],
  );

  /**
   * Optimistically clear the row from the visible list, then call
   * the source. If the call rejects, undo the clear so the row
   * reappears and the user can retry — this is the safety property
   * that the original fire-and-forget version got wrong: the user
   * saw `✓ Approved` even when the API call failed, and the agent
   * stayed blocked until timeout. Phase A live drive
   * (01KS18SAV6PPR4XVZPAHF2EJF5) caught this on the deployed env;
   * the user's tool_type:Bash approval never landed, the row stayed
   * PENDING server-side, and the agent timed out waiting.
   */
  const undoOptimisticClear = useCallback((requestId: string) => {
    setOptimisticallyCleared(prev => {
      if (!prev.has(requestId)) return prev;
      const n = new Set(prev);
      n.delete(requestId);
      return n;
    });
  }, []);

  const approve = useCallback(async (
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<ApprovalResult> => {
    const pending = snapshot.approvals.find(a => a.request_id === requestId);
    if (!pending) return { ok: false, error: 'approval row not found locally' };
    setOptimisticallyCleared(prev => {
      const n = new Set(prev);
      n.add(requestId);
      return n;
    });
    try {
      await sourceApprove(pending.task_id, requestId, scope);
      return { ok: true };
    } catch (err) {
      undoOptimisticClear(requestId);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }, [snapshot.approvals, sourceApprove, undoOptimisticClear]);

  const deny = useCallback(async (
    requestId: string,
    reason?: string,
  ): Promise<ApprovalResult> => {
    const pending = snapshot.approvals.find(a => a.request_id === requestId);
    if (!pending) return { ok: false, error: 'approval row not found locally' };
    setOptimisticallyCleared(prev => {
      const n = new Set(prev);
      n.add(requestId);
      return n;
    });
    try {
      await sourceDeny(pending.task_id, requestId, reason);
      return { ok: true };
    } catch (err) {
      undoOptimisticClear(requestId);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }, [snapshot.approvals, sourceDeny, undoOptimisticClear]);

  const setEditing = useCallback((v: boolean, mode?: EditMode) => {
    setIsEditing(v);
    setEditMode(v ? (mode ?? 'text') : null);
  }, []);

  const approvalValue = useMemo(
    () => ({ approvals, approve, deny }),
    [approvals, approve, deny],
  );

  const editingValue = useMemo(
    () => ({ isEditing, editMode, setEditing }),
    [isEditing, editMode, setEditing],
  );

  return (
    <ApprovalCtx.Provider value={approvalValue}>
      <EditingCtx.Provider value={editingValue}>
        {children}
      </EditingCtx.Provider>
    </ApprovalCtx.Provider>
  );
};
