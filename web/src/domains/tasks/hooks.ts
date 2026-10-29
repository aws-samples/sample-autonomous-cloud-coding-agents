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
import { useState } from 'react';
import { useApi } from '../../app/providers/api/ApiProvider';
import type { CreateTaskRequest, TaskStatusType } from '../../core/api/types';
import { isTerminal } from '../../core/util/task-health';

/** Live views poll; the API has no push channel for browsers yet. */
const LIST_REFRESH_MS = 15_000;
const ACTIVE_TASK_REFRESH_MS = 10_000;
const PAGE_SIZE = 100;
const EVENT_PAGE_SIZE = 100;

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

export function useTask(taskId: string) {
  const api = useApi();
  return useQuery({
    queryKey: taskKeys.detail(taskId),
    queryFn: () => api.getTask(taskId),
    refetchInterval: (query) => (query.state.data && isTerminal(query.state.data.status) ? false : ACTIVE_TASK_REFRESH_MS),
  });
}

/** Most recent events first. */
export function useTaskEvents(taskId: string, live: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: taskKeys.events(taskId),
    queryFn: () => api.listTaskEvents(taskId, { desc: true, limit: EVENT_PAGE_SIZE }),
    refetchInterval: live ? ACTIVE_TASK_REFRESH_MS : false,
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
