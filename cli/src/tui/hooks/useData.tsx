/**
 * TUI data provider + hook.
 *
 * Wraps a `DataSource` and exposes a snapshot of tasks, pending
 * approvals, registered repos, and policies via React context.
 * Polls on a configurable interval (default 2 s) and always
 * refreshes on demand via `refresh()`.
 *
 * Panels call `useData()` to read the snapshot; the
 * synchronous-legacy `getTasks()` / `getPendingApprovals()` / etc.
 * in `data.ts` still work for mock mode but are bypassed when
 * `useData().source.label === 'live'`.
 *
 * The provider is the single place that picks mock vs real based on
 * `BGAGENT_TUI_MOCK`. Setting the env var to anything truthy (the
 * literal string `"1"`, `"true"`, or any non-empty string that isn't
 * `"0"` / `"false"`) forces mock mode; default is live.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  PendingApprovalView,
  PolicyRuleView,
  RegisteredRepoView,
  TaskRowView,
} from '../data.js';
import type { ApprovalScope, TaskEvent } from '../../types.js';
import type { DataSource, SubmitTaskInput } from '../api/source.js';
import { MockDataSource } from '../api/source-mock.js';
import { RealDataSource } from '../api/source-real.js';

export interface DataSnapshot {
  tasks: TaskRowView[];
  approvals: PendingApprovalView[];
  repos: RegisteredRepoView[];
  policiesByRepo: Map<string, { hard: PolicyRuleView[]; soft: PolicyRuleView[] }>;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
}

export interface DataActions {
  refresh: () => Promise<void>;
  getTaskEvents: (taskId: string, opts?: { after?: string }) => Promise<TaskEvent[]>;
  loadPolicies: (repoId: string) => Promise<void>;
  submitTask: (input: SubmitTaskInput) => Promise<TaskRowView>;
  approve: (taskId: string, requestId: string, scope?: ApprovalScope) => Promise<void>;
  deny: (taskId: string, requestId: string, reason?: string) => Promise<void>;
}

interface DataContextShape extends DataActions {
  snapshot: DataSnapshot;
  source: DataSource;
}

const DataContext = createContext<DataContextShape | null>(null);

/** Decide mock-vs-real from env. Honors `BGAGENT_TUI_MOCK=1/true`.
 *  Defaults to MOCK so `npm run tui` keeps working without a
 *  deployed backend; the `bgagent tui` subcommand (Phase 4) flips
 *  the default to LIVE by setting the env before render. */
function pickSourceFromEnv(): DataSource {
  const v = process.env.BGAGENT_TUI_MOCK;
  const useMock = v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return useMock ? new MockDataSource() : new RealDataSource();
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface DataProviderProps {
  children: React.ReactNode;
  /** Inject a specific source (used by tests and by the `bgagent tui`
   *  subcommand when it wants to force a mode). */
  source?: DataSource;
  pollIntervalMs?: number;
}

export const DataProvider: React.FC<DataProviderProps> = ({
  children,
  source: sourceOverride,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) => {
  // `pickSourceFromEnv` reads `process.env` — stable across renders, so a
  // `useMemo` with an empty deps list keeps the same instance (and its
  // `lastTasks` cache) for the lifetime of the provider.
  const source = useMemo(
    () => sourceOverride ?? pickSourceFromEnv(),
    [sourceOverride],
  );

  const [snapshot, setSnapshot] = useState<DataSnapshot>(() => ({
    tasks: [],
    approvals: [],
    repos: [],
    policiesByRepo: new Map(),
    loading: true,
    error: null,
    lastRefreshedAt: null,
  }));

  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [tasks, approvals, repos] = await Promise.all([
        source.listTasks(),
        source.listPending(),
        source.listRegisteredRepos(),
      ]);
      setSnapshot((prev) => ({
        ...prev,
        tasks,
        approvals,
        repos,
        loading: false,
        error: null,
        lastRefreshedAt: Date.now(),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSnapshot((prev) => ({
        ...prev,
        loading: false,
        error: msg,
        lastRefreshedAt: Date.now(),
      }));
    } finally {
      inFlight.current = false;
    }
  }, [source]);

  const loadPolicies = useCallback(async (repoId: string) => {
    if (!repoId) return;
    try {
      const policies = await source.listPolicies(repoId);
      setSnapshot((prev) => {
        const next = new Map(prev.policiesByRepo);
        next.set(repoId, policies);
        return { ...prev, policiesByRepo: next };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSnapshot((prev) => ({ ...prev, error: msg }));
    }
  }, [source]);

  const getTaskEvents = useCallback(
    (taskId: string, opts?: { after?: string }) => source.getTaskEvents(taskId, opts),
    [source],
  );

  const submitTask = useCallback(async (input: SubmitTaskInput): Promise<TaskRowView> => {
    const row = await source.submitTask(input);
    // Fire-and-forget refresh so the new task appears in the list.
    void refresh();
    return row;
  }, [source, refresh]);

  const approve = useCallback(async (taskId: string, requestId: string, scope?: ApprovalScope) => {
    await source.approve(taskId, requestId, scope);
    void refresh();
  }, [source, refresh]);

  const deny = useCallback(async (taskId: string, requestId: string, reason?: string) => {
    await source.deny(taskId, requestId, reason);
    void refresh();
  }, [source, refresh]);

  // Initial hydration + polling.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => clearInterval(id);
  }, [refresh, pollIntervalMs]);

  const value: DataContextShape = useMemo(
    () => ({
      snapshot,
      source,
      refresh,
      getTaskEvents,
      loadPolicies,
      submitTask,
      approve,
      deny,
    }),
    [snapshot, source, refresh, getTaskEvents, loadPolicies, submitTask, approve, deny],
  );

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
};

/** Panels read the snapshot here. Throws if used outside the
 *  provider — the provider wraps `App` in `index.tsx`. */
export function useData(): DataContextShape {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error('useData must be used inside <DataProvider>');
  }
  return ctx;
}
