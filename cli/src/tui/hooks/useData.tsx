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
import type { ApprovalScope, TaskEvent } from '../../types.js';
import { MockDataSource } from '../api/source-mock.js';
import { RealDataSource } from '../api/source-real.js';
import type { DataSource, SubmitTaskInput } from '../api/source.js';
import type {
  PendingApprovalView,
  PolicyRuleView,
  RegisteredRepoView,
  TaskRowView,
} from '../data.js';
import {
  INITIAL_PENDING_CADENCE,
  isRateLimitError,
  nextPendingCadence,
  type PendingCadenceState,
} from '../utils/pending-cadence.js';

export interface DataSnapshot {
  tasks: TaskRowView[];
  approvals: PendingApprovalView[];
  repos: RegisteredRepoView[];
  policiesByRepo: Map<string, { hard: PolicyRuleView[]; soft: PolicyRuleView[] }>;
  loading: boolean;
  error: string | null;
  /** Set after a 429 on `/v1/pending`. Cleared on the next successful
   *  poll. Surfaced by panels (banner + Approvals header) so the
   *  user understands why approvals may take a few extra seconds to
   *  appear. */
  rateLimited: boolean;
  /** Current refresh cadence in ms — surfaced for tests + a future
   *  diagnostic toggle. */
  pollIntervalMs: number;
  lastRefreshedAt: number | null;
}

export interface DataActions {
  refresh: () => Promise<void>;
  /** Force the next `/v1/pending` poll to fire immediately and reset
   *  the adaptive cadence to fast (3 s). Called when the user
   *  switches to the Approvals panel — their attention is the signal
   *  that pending freshness matters again, even if the ladder had
   *  backed off during idle time on other panels. */
  resetPendingCadence: () => void;
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

// Tasks + repos poll on a fixed cadence — they're not rate-limited and
// the user expects the Tasks list to update within a couple seconds of
// a CLI submit. Only the `/v1/pending` poll uses the adaptive ladder
// in `utils/pending-cadence.ts` because that endpoint IS rate-limited.
// Splitting the two timers fixed a UX regression where backing off the
// pending poll during idle time also delayed Tasks list updates.
const DEFAULT_TASKS_POLL_INTERVAL_MS = 2_000;

// Note: a hard-coded `pollIntervalMs` is no longer the primary cadence
// driver — see `utils/pending-cadence.ts` for the adaptive ladder. The
// prop below is retained for tests that want a fixed cadence and for
// the `bgagent tui` subcommand to override during diagnostic runs.
// When `pollIntervalMs` is provided, it pins BOTH timers (tasks +
// pending) to that value and disables the adaptive ladder + 429
// backoff entirely.

export interface DataProviderProps {
  children: React.ReactNode;
  /** Inject a specific source (used by tests and by the `bgagent tui`
   *  subcommand when it wants to force a mode). */
  source?: DataSource;
  /** Override the poll cadence to a fixed value. When omitted, the
   *  provider uses the adaptive `pending-cadence` state machine that
   *  starts at 3 s, backs off through 5/10/30 s on consecutive empty
   *  polls, and jumps to 30 s on rate-limit (429) responses. */
  pollIntervalMs?: number;
}

export const DataProvider: React.FC<DataProviderProps> = ({
  children,
  source: sourceOverride,
  pollIntervalMs,
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
    rateLimited: false,
    pollIntervalMs: pollIntervalMs ?? INITIAL_PENDING_CADENCE.intervalMs,
    lastRefreshedAt: null,
  }));

  const tasksInFlight = useRef(false);
  const pendingInFlight = useRef(false);
  const cadenceRef = useRef<PendingCadenceState>(INITIAL_PENDING_CADENCE);
  /** Bumped whenever something wants the pending timer to wake up
   *  early (e.g. user switches to Approvals panel). The polling
   *  effect below watches this ref via a state-bridged counter. */
  const [pendingResetTick, setPendingResetTick] = useState(0);

  /** Refresh the tasks list + registered repos. Always runs at the
   *  fixed cadence — these endpoints aren't rate-limited and the user
   *  expects the Tasks panel to reflect CLI-submitted tasks within a
   *  few seconds. Errors here are surfaced via the snapshot's
   *  `error` field but do NOT touch the pending cadence. */
  const refreshTasks = useCallback(async () => {
    if (tasksInFlight.current) return;
    tasksInFlight.current = true;
    try {
      const [tasks, repos] = await Promise.all([
        source.listTasks(),
        source.listRegisteredRepos(),
      ]);
      setSnapshot((prev) => ({
        ...prev,
        tasks,
        repos,
        loading: false,
        // Don't clobber a /pending error message — only clear the
        // error if the previous one was a tasks/repos failure.
        error: prev.rateLimited ? prev.error : null,
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
      tasksInFlight.current = false;
    }
  }, [source]);

  /** Refresh the pending-approvals list. Adaptive cadence + 429 jump
   *  live here; this is the only endpoint the rate-limit applies to
   *  and the only one that needs to back off during idle time. */
  const refreshPending = useCallback(async () => {
    if (pendingInFlight.current) return;
    pendingInFlight.current = true;
    try {
      const approvals = await source.listPending();
      if (pollIntervalMs === undefined) {
        cadenceRef.current = nextPendingCadence(cadenceRef.current, {
          sawPending: approvals.length > 0,
          rateLimited: false,
        });
      }
      setSnapshot((prev) => ({
        ...prev,
        approvals,
        rateLimited: false,
        // Clear a previous rate-limit error on successful poll.
        error: prev.rateLimited ? null : prev.error,
        pollIntervalMs:
          pollIntervalMs ?? cadenceRef.current.intervalMs,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = isRateLimitError(err);
      if (pollIntervalMs === undefined && rateLimited) {
        cadenceRef.current = nextPendingCadence(cadenceRef.current, {
          sawPending: false,
          rateLimited: true,
        });
      }
      setSnapshot((prev) => ({
        ...prev,
        error: rateLimited
          ? 'Rate limit reached on /v1/pending — slowing down polls'
          : msg,
        rateLimited,
        pollIntervalMs:
          pollIntervalMs ?? cadenceRef.current.intervalMs,
      }));
    } finally {
      pendingInFlight.current = false;
    }
  }, [source, pollIntervalMs]);

  /** Convenience wrapper for callers that want both lists fresh
   *  immediately (submit/approve/deny). Public via the context. */
  const refresh = useCallback(async () => {
    await Promise.all([refreshTasks(), refreshPending()]);
  }, [refreshTasks, refreshPending]);

  /** Public action: reset the /pending cadence to fast and trigger an
   *  immediate refresh. Approvals panel calls this on mount/activate
   *  so the user sees fresh data within a frame even if the ladder
   *  had backed off to 30 s during idle time. */
  const resetPendingCadence = useCallback(() => {
    if (pollIntervalMs !== undefined) return; // pinned mode — no-op
    cadenceRef.current = INITIAL_PENDING_CADENCE;
    setPendingResetTick((n) => n + 1);
  }, [pollIntervalMs]);

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

  // ── Polling effect: tasks + repos ─────────────────────────────
  // Fixed cadence (3 s by default, overridable via `pollIntervalMs`
  // for tests/diagnostics). Endpoints aren't rate-limited so the
  // adaptive ladder doesn't apply.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await refreshTasks();
      if (cancelled) return;
      const ms = pollIntervalMs ?? DEFAULT_TASKS_POLL_INTERVAL_MS;
      timer = globalThis.setTimeout(() => { void tick(); }, ms);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshTasks, pollIntervalMs]);

  // ── Polling effect: pending approvals ─────────────────────────
  // Adaptive cadence (3 → 5 → 10 → 30 s on consecutive empty polls,
  // jumps to 30 s on 429). Re-runs the scheduling effect when
  // `pendingResetTick` increments — the Approvals panel calls
  // `resetPendingCadence()` on mount, which bumps the tick + resets
  // `cadenceRef` so the next poll fires at the fast cadence.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await refreshPending();
      if (cancelled) return;
      const ms = pollIntervalMs ?? cadenceRef.current.intervalMs;
      timer = globalThis.setTimeout(() => { void tick(); }, ms);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshPending, pollIntervalMs, pendingResetTick]);

  const value: DataContextShape = useMemo(
    () => ({
      snapshot,
      source,
      refresh,
      resetPendingCadence,
      getTaskEvents,
      loadPolicies,
      submitTask,
      approve,
      deny,
    }),
    [snapshot, source, refresh, resetPendingCadence, getTaskEvents, loadPolicies, submitTask, approve, deny],
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
