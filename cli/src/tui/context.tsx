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

interface ApprovalActions {
  approvals: PendingApprovalView[];
  approve: (requestId: string, scope?: ApprovalScope) => void;
  deny: (requestId: string, reason?: string) => void;
}

const ApprovalCtx = createContext<ApprovalActions>({
  approvals: [],
  approve: () => {},
  deny: () => {},
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

  const approve = useCallback((requestId: string, scope?: ApprovalScope) => {
    const pending = snapshot.approvals.find(a => a.request_id === requestId);
    setOptimisticallyCleared(prev => {
      const n = new Set(prev);
      n.add(requestId);
      return n;
    });
    if (pending) {
      // Fire-and-forget — errors surface via the provider's `error`
      // field on the next poll or on the next refresh().
      void sourceApprove(pending.task_id, requestId, scope);
    }
  }, [snapshot.approvals, sourceApprove]);

  const deny = useCallback((requestId: string, reason?: string) => {
    const pending = snapshot.approvals.find(a => a.request_id === requestId);
    setOptimisticallyCleared(prev => {
      const n = new Set(prev);
      n.add(requestId);
      return n;
    });
    if (pending) {
      void sourceDeny(pending.task_id, requestId, reason);
    }
  }, [snapshot.approvals, sourceDeny]);

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
