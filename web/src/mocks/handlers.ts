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
import type { CreateTaskRequest, TaskDetail, TaskStatusType, TaskSummary } from '../core/api/types';
import { TERMINAL_STATUSES } from '../core/api/types';
import type { MockData, ScheduledChange } from './fixtures';

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


const REPO_PATTERN = /^(?!\.+\/)[a-zA-Z0-9._-]+\/(?!\.+$)[a-zA-Z0-9._-]+$/;
/** Submitting to this repository returns 422, to exercise the "not set up" message. */
export const MOCK_NOT_ONBOARDED_REPO = 'acme/not-onboarded';

let sequence = 0;
function newTaskId(): string {
  sequence += 1;
  return `01MOCK${Date.now().toString(36).toUpperCase()}${String(sequence).padStart(4, '0')}`.slice(0, 26).padEnd(26, '0');
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}

function addEvent(data: MockData, taskId: string, eventType: string, metadata: Record<string, unknown>, at: Date) {
  const list = data.events[taskId] ?? (data.events[taskId] = []);
  list.push({ event_id: `${taskId}-${String(list.length).padStart(4, '0')}`, event_type: eventType, timestamp: at.toISOString(), metadata });
}

function patchTask(data: MockData, taskId: string, patch: Partial<TaskDetail>, at: Date) {
  const i = data.tasks.findIndex((t) => t.task_id === taskId);
  if (i >= 0) data.tasks[i] = { ...data.tasks[i], ...patch, updated_at: at.toISOString() };
}

/** Applies every scheduled change that is due, so mock tasks move forward as you watch. */
function advance(data: MockData, nowMs: number) {
  const due = data.scheduled.filter((c) => c.dueMs <= nowMs).sort((a, b) => a.dueMs - b.dueMs);
  if (due.length === 0) return;
  data.scheduled = data.scheduled.filter((c) => c.dueMs > nowMs);
  for (const change of due) {
    const at = new Date(change.dueMs);
    const task = data.tasks.find((t) => t.task_id === change.taskId);
    if (!task || TERMINAL_STATUSES.includes(task.status)) continue;
    if (change.eventType) addEvent(data, change.taskId, change.eventType, change.metadata ?? {}, at);
    patchTask(data, change.taskId, { ...(task.status === 'RUNNING' ? { agent_heartbeat_at: at.toISOString() } : {}), ...change.patch }, at);
  }
}

/** A short, believable run: set up, look around, edit, test, open a pull request. */
function simulatedRun(task: TaskDetail, startMs: number): ScheduledChange[] {
  const repo = task.repo ?? 'acme/app';
  const file = `/workspace/${repo}/src/game/world.ts`;
  const prNumber = 100 + Math.floor((startMs / 1000) % 900);
  const at = (s: number) => startMs + s * 1000;
  const step = (s: number, eventType: string, metadata: Record<string, unknown> = {}, patch?: Partial<TaskDetail>): ScheduledChange =>
    ({ taskId: task.task_id, dueMs: at(s), eventType, metadata, ...(patch ? { patch } : {}) });
  return [
    step(2, 'hydration_started', {}, { status: 'HYDRATING' }),
    step(4, 'session_started', {}, { status: 'RUNNING', started_at: new Date(at(4)).toISOString(), agent_heartbeat_at: new Date(at(4)).toISOString() }),
    step(6, 'agent_milestone', { milestone: 'repo_setup_complete', details: `branch=${task.branch_name} build_before=True` }),
    step(7, 'agent_milestone', { milestone: 'step:implement:start' }),
    step(10, 'agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'ls -a && cat package.json', 'description': 'Look at how the project is laid out'}" }),
    step(14, 'agent_tool_call', { tool_name: 'Read', tool_input_preview: `{'file_path': '${file}'}` }),
    step(18, 'agent_turn', { turn: 3, text_preview: 'Found it: the bounds check lets x reach the map width, one past the last column. Fixing the comparison.' }),
    step(22, 'agent_tool_call', { tool_name: 'Edit', tool_input_preview: `{'file_path': '${file}', 'old_string': 'x <= width'}` }, { cost_usd: 0.18 }),
    step(26, 'agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'npm test', 'description': 'Run the tests'}" }),
    step(30, 'agent_milestone', { milestone: 'step:build:start' }),
    step(36, 'agent_milestone', { milestone: 'step:build:succeeded' }, { build_passed: true, lint_passed: true }),
    step(38, 'agent_milestone', { milestone: 'step:open_pr:start' }, { status: 'FINALIZING' }),
    step(42, 'agent_milestone', { milestone: 'pr_created' }, {
      pr_number: prNumber,
      pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    }),
    step(43, 'task_completed', {}, {
      status: 'COMPLETED',
      completed_at: new Date(at(43)).toISOString(),
      duration_s: 39,
      cost_usd: 0.31,
    }),
  ];
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface MockHandlerOptions {
  /** Simulated network latency per request; keeps loading states visible in mock mode. */
  readonly latencyMs?: number;
}

export function createHandlers(baseUrl: string, data: MockData, { latencyMs = 0 }: MockHandlerOptions = {}) {
  const base = baseUrl.replace(/\/+$/, '');

  async function guard(request: Request) {
    if (latencyMs) await delay(latencyMs);
    advance(data, Date.now());
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

    http.post(`${base}/tasks`, async ({ request }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const key = request.headers.get('Idempotency-Key');
      const existing = key ? data.tasks.find((t) => t.task_id === data.idempotency[key]) : undefined;
      if (existing) return HttpResponse.json({ data: existing }, { status: 201 });
      const body = (await jsonBody(request)) as Partial<CreateTaskRequest> | null;
      if (!body || typeof body.repo !== 'string' || !REPO_PATTERN.test(body.repo)) {
        return error(400, 'VALIDATION_ERROR', "Field 'repo' must be in owner/repo format.");
      }
      // Like the server: without a ref the repo-less default workflow runs, which needs a description.
      if (body.workflow_ref === undefined && !body.task_description?.trim()) {
        return error(400, 'VALIDATION_ERROR', 'The "default/agent-v1" workflow requires task_description.');
      }
      if (body.issue_number === undefined && !body.task_description?.trim()) {
        return error(400, 'VALIDATION_ERROR', 'Provide issue_number or task_description.');
      }
      if (body.repo === MOCK_NOT_ONBOARDED_REPO) {
        return error(422, 'REPO_NOT_ONBOARDED', `Repository '${body.repo}' is not onboarded. Register it with a Blueprint before submitting tasks.`);
      }
      const now = new Date();
      const taskId = newTaskId();
      const created: TaskDetail = {
        ...data.tasks[0],
        task_id: taskId,
        status: 'SUBMITTED',
        repo: body.repo,
        issue_number: body.issue_number ?? null,
        task_description: body.task_description ?? null,
        branch_name: `bgagent/${taskId}/${slug(body.task_description ?? `issue-${body.issue_number}`)}`,
        pr_number: null,
        pr_url: null,
        error_message: null,
        error_classification: null,
        channel_source: 'api',
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        started_at: null,
        completed_at: null,
        agent_heartbeat_at: null,
        duration_s: null,
        cost_usd: null,
        build_passed: null,
        lint_passed: null,
        awaiting_approval_request_id: null,
        queue_position: null,
        estimated_wait_s: null,
      };
      data.tasks.push(created);
      if (key) data.idempotency[key] = taskId;
      addEvent(data, taskId, 'task_created', { channel_source: 'api', repo: body.repo }, now);
      data.scheduled.push(...simulatedRun(created, now.getTime()));
      return HttpResponse.json({ data: created }, { status: 201 });
    }),

    http.get(`${base}/repos/:repoId/issues`, async ({ request, params }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const repo = decodeURIComponent(String(params.repoId));
      if (!REPO_PATTERN.test(repo)) return error(400, 'VALIDATION_ERROR', 'repo_id must be in owner/repo format.');
      if (repo === MOCK_NOT_ONBOARDED_REPO) return error(422, 'REPO_NOT_ONBOARDED', `Repository '${repo}' is not onboarded.`);
      return HttpResponse.json({ data: { repo, issues: data.issues[repo] ?? [] } });
    }),

    http.delete(`${base}/tasks/:taskId`, async ({ request, params }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const taskId = String(params.taskId);
      const found = data.tasks.find((t) => t.task_id === taskId);
      if (!found) return error(404, 'TASK_NOT_FOUND', `Task ${taskId} not found.`);
      if (TERMINAL_STATUSES.includes(found.status)) return error(409, 'TASK_ALREADY_TERMINAL', `Task ${taskId} is already ${found.status}.`);
      const now = new Date();
      data.scheduled = data.scheduled.filter((c) => c.taskId !== taskId);
      data.pending = data.pending.filter((p) => p.task_id !== taskId);
      patchTask(data, taskId, { status: 'CANCELLED', completed_at: now.toISOString() }, now);
      addEvent(data, taskId, 'task_cancelled', {}, now);
      return HttpResponse.json({ data: { task_id: taskId, status: 'CANCELLED', cancelled_at: now.toISOString() } });
    }),

    http.post(`${base}/tasks/:taskId/nudge`, async ({ request, params }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const taskId = String(params.taskId);
      const found = data.tasks.find((t) => t.task_id === taskId);
      if (!found) return error(404, 'TASK_NOT_FOUND', `Task ${taskId} not found.`);
      if (TERMINAL_STATUSES.includes(found.status)) {
        return error(409, 'TASK_NOT_ACTIVE', `Task ${taskId} is in terminal state ${found.status}; cannot accept nudges.`);
      }
      const message = (await jsonBody(request))?.message;
      if (typeof message !== 'string' || !message.trim()) return error(400, 'VALIDATION_ERROR', 'Missing required field: message (string).');
      const now = Date.now();
      const nudgeId = `nudge-${now.toString(36)}${String(++sequence).padStart(4, '0')}`;
      data.scheduled.push(
        {
          taskId,
          dueMs: now + 5000,
          eventType: 'agent_milestone',
          metadata: { milestone: 'nudge_acknowledged', details: `1 nudge(s) acknowledged (ids=…${nudgeId.slice(-8)}): ${message.trim().slice(0, 80)}` },
        },
        { taskId, dueMs: now + 8000, eventType: 'agent_turn', metadata: { turn: 99, text_preview: 'Got your message. Adjusting the plan to include that.' } },
      );
      return HttpResponse.json({ data: { task_id: taskId, nudge_id: nudgeId, submitted_at: new Date(now).toISOString() } }, { status: 202 });
    }),

    ...(['approve', 'deny'] as const).map((decision) => http.post(`${base}/tasks/:taskId/${decision}`, async ({ request, params }) => {
      const denied = await guard(request);
      if (denied) return denied;
      const taskId = String(params.taskId);
      const requestId = (await jsonBody(request))?.request_id;
      const pending = data.pending.find((p) => p.task_id === taskId && p.request_id === requestId);
      if (!pending) return error(404, 'REQUEST_NOT_FOUND', 'No pending approval with that request id.');
      const now = new Date();
      data.pending = data.pending.filter((p) => p !== pending);
      patchTask(data, taskId, { status: 'RUNNING', awaiting_approval_request_id: null, agent_heartbeat_at: now.toISOString() }, now);
      addEvent(data, taskId, 'agent_milestone', { milestone: decision === 'approve' ? 'approval_granted' : 'approval_denied' }, now);
      return HttpResponse.json(
        { data: { task_id: taskId, request_id: pending.request_id, status: decision === 'approve' ? 'APPROVED' : 'DENIED', decided_at: now.toISOString() } },
        { status: 202 },
      );
    })),
  ];
}
