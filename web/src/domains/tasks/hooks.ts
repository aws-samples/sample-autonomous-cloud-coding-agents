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

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/providers/api/ApiProvider';
import type { ApiClient } from '../../core/api/client';
import { CODING_WORKFLOW_ID, type CreateTaskRequest, type TaskEvent, type TaskStatusType } from '../../core/api/types';
import { isTerminal } from '../../core/util/task-health';

/** Live views poll; the API has no push channel for browsers yet. */
const LIST_REFRESH_MS = 15_000;
const ACTIVE_TASK_REFRESH_MS = 10_000;
/** Quicker, briefly: the last events usually land within seconds of the task finishing. */
const FINAL_EVENTS_REFRESH_MS = 5_000;
const PAGE_SIZE = 100;
const EVENT_PAGE_SIZE = 100;
/** Stop loading a task's history past this many events; a 500-turn task writes about 1,500. */
export const MAX_TASK_EVENTS = 5_000;
/**
 * Each refresh asks again for the last few events it already has, so an event
 * written a moment late (with an id just before the newest) is not skipped.
 */
const EVENT_REFRESH_OVERLAP = 20;

const taskKeys = {
  all: ['tasks'] as const,
  list: (status: readonly TaskStatusType[] | undefined, repo?: string) => ['tasks', 'list', status ?? 'all', repo ?? 'any'] as const,
  detail: (taskId: string) => ['tasks', 'detail', taskId] as const,
  events: (taskId: string) => ['tasks', 'events', taskId] as const,
};

export function useTaskList(status?: readonly TaskStatusType[], repo?: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: taskKeys.list(status, repo),
    queryFn: ({ pageParam }) => api.listTasks({ status, repo, limit: PAGE_SIZE, nextToken: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination.has_more && last.pagination.next_token ? last.pagination.next_token : undefined),
    refetchInterval: LIST_REFRESH_MS,
  });
}

/** Stop loading a repository's task history past this many tasks. */
export const MAX_REPO_TASKS = 1_000;

/**
 * Every task of one repository, loading page after page. The API applies its repository
 * filter after DynamoDB's page limit, so a page can come back short (even empty) while
 * more matches follow: only `complete` means no task is missing.
 */
export function useAllRepoTasks(repo: string) {
  const query = useTaskList(undefined, repo);
  const tasks = query.data?.pages.flatMap((p) => p.data) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const count = tasks.length;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && count < MAX_REPO_TASKS) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, count]);
  return { query, tasks, complete: query.isSuccess && !hasNextPage, capped: Boolean(hasNextPage) && count >= MAX_REPO_TASKS };
}

export function useTask(taskId: string) {
  const api = useApi();
  return useQuery({
    queryKey: taskKeys.detail(taskId),
    queryFn: () => api.getTask(taskId),
    refetchInterval: (query) => (query.state.data && isTerminal(query.state.data.status) ? false : ACTIVE_TASK_REFRESH_MS),
  });
}

/** A task's events, oldest first. `truncated` when the history is longer than {@link MAX_TASK_EVENTS}. */
export interface TaskEventLog {
  readonly events: readonly TaskEvent[];
  readonly truncated: boolean;
}

/**
 * Loads the whole history once, then only what is new: each refresh continues
 * from the newest event already loaded.
 */
export async function loadTaskEvents(api: ApiClient, taskId: string, previous: TaskEventLog | undefined): Promise<TaskEventLog> {
  // Past the cap the page shows what it has; refreshing would only drop the newest events.
  if (previous?.truncated) return previous;
  const known = previous?.events ?? [];
  const byId = new Map(known.map((e) => [e.event_id, e]));
  let after = known.length > 0 ? known[Math.max(0, known.length - EVENT_REFRESH_OVERLAP)].event_id : undefined;
  // The first event itself is only re-read when the overlap reaches back to it.
  if (after !== undefined && known.length <= EVENT_REFRESH_OVERLAP) after = undefined;
  let nextToken: string | undefined;
  for (;;) {
    const page = await api.listTaskEvents(taskId, { limit: EVENT_PAGE_SIZE, ...(after ? { after } : {}), ...(nextToken ? { nextToken } : {}) });
    for (const event of page.data) byId.set(event.event_id, event);
    if (byId.size >= MAX_TASK_EVENTS) break;
    if (page.data.length < EVENT_PAGE_SIZE || !page.pagination.has_more) break;
    // `after` and `next_token` are alternatives; continue with whichever started the walk.
    if (after) after = page.data[page.data.length - 1].event_id;
    else if (page.pagination.next_token) nextToken = page.pagination.next_token;
    else break;
  }
  const events = [...byId.values()].sort((a, b) => a.event_id.localeCompare(b.event_id));
  return { events: events.slice(0, MAX_TASK_EVENTS), truncated: events.length >= MAX_TASK_EVENTS };
}

/** Events that close a task's history; once one is loaded nothing more will arrive. */
const TERMINAL_EVENT_TYPES = new Set(['task_completed', 'task_failed', 'task_cancelled', 'task_timed_out']);
/** After the task reports it finished, keep polling this many times for its final events. */
const FINAL_EVENT_POLLS = 6;

/**
 * A task's events, polled while it runs. The task record and its events arrive
 * separately, so when the task shows as finished its last events may not be loaded
 * yet: polling continues until a terminal event is in, for at most FINAL_EVENT_POLLS.
 */
export function useTaskEvents(taskId: string, live: boolean) {
  const api = useApi();
  const queryClient = useQueryClient();
  const pollsSinceFinished = useRef(0);
  return useQuery({
    queryKey: taskKeys.events(taskId),
    queryFn: () => loadTaskEvents(api, taskId, queryClient.getQueryData<TaskEventLog>(taskKeys.events(taskId))),
    refetchInterval: (query) => {
      if (live) {
        pollsSinceFinished.current = 0;
        return ACTIVE_TASK_REFRESH_MS;
      }
      const closed = query.state.data?.events.some((e) => TERMINAL_EVENT_TYPES.has(e.event_type)) ?? false;
      if (closed || pollsSinceFinished.current >= FINAL_EVENT_POLLS) return false;
      pollsSinceFinished.current += 1;
      return FINAL_EVENTS_REFRESH_MS;
    },
  });
}

/**
 * Submits a new task. One idempotency key per form instance: a double click or a
 * retried request after a network blip creates one task, not two.
 */
export function useCreateTask() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return useMutation({
    mutationFn: (req: CreateTaskRequest) => api.createTask(req, idempotencyKey),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });
}

export function useCancelTask(taskId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelTask(taskId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });
}

export function useSendMessage(taskId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => api.nudgeTask(taskId, message),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.events(taskId) }),
  });
}

/** Open issues for the issue picker. Disabled until the repository name looks valid. */
export function useRepoIssues(repo: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['repos', repo, 'issues'],
    queryFn: () => api.listRepoIssues(repo),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** While the agent is picking issues up, refresh often so "Starting…" turns into a task link. */
const LINEAR_STARTING_REFRESH_MS = 5_000;
const LINEAR_REFRESH_MS = 60_000;

export function useLinearIssues(repo: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['repos', repo, 'linear-issues'],
    queryFn: () => api.listLinearIssues(repo),
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.projects.some((p) => p.issues.some((i) => i.agent.kind === 'starting'))
      ? LINEAR_STARTING_REFRESH_MS
      : LINEAR_REFRESH_MS),
  });
}

/**
 * Starts the agent on one GitHub issue, from a list of issues. Each issue keeps one
 * idempotency key for as long as the page is open: a retry after a lost response, or a
 * second click on a list that has not refreshed yet, returns the same task instead of
 * creating another.
 */
export function useStartGitHubIssue(repo: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(new Map<number, string>());
  const keyFor = (issueNumber: number) => {
    const known = keys.current.get(issueNumber);
    if (known) return known;
    const key = crypto.randomUUID();
    keys.current.set(issueNumber, key);
    return key;
  };
  return useMutation({
    mutationFn: (issueNumber: number) => api.createTask({ repo, workflow_ref: CODING_WORKFLOW_ID, issue_number: issueNumber }, keyFor(issueNumber)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });
}

export function useStartLinearIssue(repo: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, projectId }: { issueId: string; projectId: string }) => api.startLinearIssue(issueId, projectId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['repos', repo, 'linear-issues'] });
      await queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}
