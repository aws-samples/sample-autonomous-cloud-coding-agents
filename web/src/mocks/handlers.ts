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
 * MSW request handlers that imitate the REST API contract
 * (docs/design/API_CONTRACT.md): response envelopes, pagination, 401 without
 * a token, 400 on invalid parameters and 404 for unknown tasks.
 */

import { delay, http, HttpResponse } from 'msw';
import type { TaskDetail, TaskStatusType, TaskSummary } from '../core/api/types';
import type { MockData } from './fixtures';

function error(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message, request_id: 'mock-request' } }, { status });
}

function toSummary(task: TaskDetail): TaskSummary {
  return {
    task_id: task.task_id,
    status: task.status,
    repo: task.repo,
    issue_number: task.issue_number,
    resolved_workflow: task.resolved_workflow,
    resolved_assets: task.resolved_assets,
    pr_number: task.pr_number,
    task_description: task.task_description,
    branch_name: task.branch_name,
    pr_url: task.pr_url,
    created_at: task.created_at,
    updated_at: task.updated_at,
    agent_heartbeat_at: task.agent_heartbeat_at,
  };
}

/** Parses `limit` like the API: default 20, integer 1-100. */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return 20;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/** Opaque-looking offset cursor. */
function page<T>(items: readonly T[], limit: number, token: string | null) {
  const offset = token ? Number(atob(token)) : 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? btoa(String(offset + limit)) : null;
  return { data: slice, pagination: { next_token: next, has_more: next !== null } };
}

export interface MockHandlerOptions {
  /** Simulated network latency per request; keeps loading states visible in mock mode. */
  readonly latencyMs?: number;
}

export function createHandlers(baseUrl: string, data: MockData, { latencyMs = 0 }: MockHandlerOptions = {}) {
  const base = baseUrl.replace(/\/+$/, '');

  async function guard(request: Request) {
    if (latencyMs) await delay(latencyMs);
    return request.headers.get('Authorization') ? null : error(401, 'UNAUTHORIZED', 'Missing or invalid authentication token.');
  }

  return [
    http.get(`${base}/tasks`, async ({ request }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const url = new URL(request.url);
      const limit = parseLimit(url.searchParams.get('limit'));
      if (limit === null) return error(400, 'VALIDATION_ERROR', 'limit must be an integer from 1 to 100.');
      const statuses = url.searchParams.get('status')?.split(',').filter(Boolean) as TaskStatusType[] | undefined;
      const repo = url.searchParams.get('repo');
      const matching = data.tasks
        .filter((t) => !statuses?.length || statuses.includes(t.status))
        .filter((t) => !repo || t.repo === repo)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(toSummary);
      return HttpResponse.json(page(matching, limit, url.searchParams.get('next_token')));
    }),

    http.get(`${base}/tasks/:taskId`, async ({ request, params }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const found = data.tasks.find((t) => t.task_id === params.taskId);
      return found ? HttpResponse.json({ data: found }) : error(404, 'TASK_NOT_FOUND', `Task ${String(params.taskId)} not found.`);
    }),

    http.get(`${base}/tasks/:taskId/events`, async ({ request, params }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const taskId = String(params.taskId);
      if (!data.tasks.some((t) => t.task_id === taskId)) return error(404, 'TASK_NOT_FOUND', `Task ${taskId} not found.`);
      const url = new URL(request.url);
      const limit = parseLimit(url.searchParams.get('limit'));
      if (limit === null) return error(400, 'VALIDATION_ERROR', 'limit must be an integer from 1 to 100.');
      const ordered = [...(data.events[taskId] ?? [])].sort((a, b) => a.event_id.localeCompare(b.event_id));
      if (url.searchParams.get('desc') === '1') ordered.reverse();
      return HttpResponse.json(page(ordered, limit, url.searchParams.get('next_token')));
    }),

    http.get(`${base}/pending`, async ({ request }) => {
      const denied = await guard(request);
      if (denied) return denied;
      return HttpResponse.json({ data: { pending: data.pending } });
    }),
  ];
}
