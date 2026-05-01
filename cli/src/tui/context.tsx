/**
 * Shared TUI context — approval state + editing lock.
 * Uses useMemo for stable provider values to prevent unnecessary re-renders.
 */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { getPendingApprovals, type PendingApproval } from './data.js';

// ── Approval state ──────────────────────────────────────────────────

interface ApprovalActions {
  approvals: PendingApproval[];
  approve: (requestId: string) => void;
  deny: (requestId: string) => void;
}

const ApprovalCtx = createContext<ApprovalActions>({
  approvals: [],
  approve: () => {},
  deny: () => {},
});

export const useApprovals = () => useContext(ApprovalCtx);

// ── Editing lock ────────────────────────────────────────────────────

export type EditMode = 'text' | 'deny-confirm' | null;

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
  const [approvals, setApprovals] = useState<PendingApproval[]>(() => [...getPendingApprovals()]);
  const [isEditing, setIsEditing] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>(null);

  const approve = useCallback((requestId: string) => {
    setApprovals(prev => prev.filter(a => a.request_id !== requestId));
  }, []);

  const deny = useCallback((requestId: string) => {
    setApprovals(prev => prev.filter(a => a.request_id !== requestId));
  }, []);

  const setEditing = useCallback((v: boolean, mode?: EditMode) => {
    setIsEditing(v);
    setEditMode(v ? (mode ?? 'text') : null);
  }, []);

  // Stable provider values — only change when underlying state changes
  const approvalValue = useMemo(
    () => ({ approvals, approve, deny }),
    [approvals, approve, deny]
  );

  const editingValue = useMemo(
    () => ({ isEditing, editMode, setEditing }),
    [isEditing, editMode, setEditing]
  );

  return (
    <ApprovalCtx.Provider value={approvalValue}>
      <EditingCtx.Provider value={editingValue}>
        {children}
      </EditingCtx.Provider>
    </ApprovalCtx.Provider>
  );
};
