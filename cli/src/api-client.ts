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

import { getAuthToken } from './auth';
import { loadConfig } from './config';
import { debug } from './debug';
import { ApiError, CliError } from './errors';
import {
  CancelTaskResponse,
  CreateTaskRequest,
  CreateWebhookRequest,
  CreateWebhookResponse,
  ErrorResponse,
  NudgeRequest,
  NudgeResponse,
  PaginatedResponse,
  SuccessResponse,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  WebhookDetail,
} from './types';

/** HTTP client for the Background Agent REST API. */
export class ApiClient {
  private baseUrl: string | undefined;

  private getBaseUrl(): string {
    if (!this.baseUrl) {
      const config = loadConfig();
      // ApiUrl from the stack output already includes the stage name (e.g. /v1/)
      this.baseUrl = config.api_url.replace(/\/+$/, '');
    }
    return this.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await getAuthToken();
    const url = `${this.getBaseUrl()}${path}`;

    debug(`${method} ${url}`);
    if (body) {
      debug(`Request body: ${JSON.stringify(body)}`);
    }

    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    debug(`Response: ${res.status} ${res.statusText}`);

    let json: unknown;
    let jsonParseOk = true;
    try {
      json = await res.json();
    } catch {
      jsonParseOk = false;
    }

    if (jsonParseOk) {
      debug(`Response body: ${JSON.stringify(json)}`);
    }

    if (!res.ok) {
      // Keep HTTP-status-carrying errors as ``ApiError`` regardless of
      // body shape so callers (e.g. the watch retry loop) can classify
      // 4xx-vs-5xx reliably. A WAF / CloudFront / API-GW edge page is
      // still a deterministic 4xx from the caller's perspective —
      // retrying it would be futile.
      if (jsonParseOk && (json as ErrorResponse).error) {
        const err = json as ErrorResponse;
        let message = `${err.error.message} (${err.error.code})`;
        if (res.status === 401) {
          message += '\nHint: Run `bgagent login` to re-authenticate.';
        }
        throw new ApiError(res.status, err.error.code, message, err.error.request_id);
      }
      // Non-JSON or envelope-less error body — still an HTTP error, still
      // must carry the status so classification works. Code/request_id
      // are unavailable at this layer; surface ``HTTP_ERROR`` / empty.
      throw new ApiError(
        res.status,
        'HTTP_ERROR',
        `HTTP ${res.status}: ${res.statusText}${jsonParseOk ? '' : ' (non-JSON response)'}`,
        '',
      );
    }

    if (!jsonParseOk) {
      // 2xx with an unparseable body is a server contract violation —
      // neither transient (5xx) nor user-recoverable (4xx). Fail hard
      // with ``CliError`` so the retry loop does NOT treat it as
      // transient.
      throw new CliError(`HTTP ${res.status}: ${res.statusText} (non-JSON response)`);
    }

    return json as T;
  }

  /** POST /tasks — create a new task. */
  async createTask(req: CreateTaskRequest, idempotencyKey?: string): Promise<TaskDetail> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const res = await this.request<SuccessResponse<TaskDetail>>('POST', '/tasks', req, headers);
    return res.data;
  }

  /** GET /tasks — list tasks. */
  async listTasks(opts?: {
    status?: string;
    repo?: string;
    limit?: number;
    nextToken?: string;
  }): Promise<PaginatedResponse<TaskSummary>> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.repo) params.set('repo', opts.repo);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.nextToken) params.set('next_token', opts.nextToken);

    const qs = params.toString();
    const path = `/tasks${qs ? `?${qs}` : ''}`;
    return this.request<PaginatedResponse<TaskSummary>>('GET', path);
  }

  /** GET /tasks/{task_id} — get task detail. */
  async getTask(taskId: string, opts?: { signal?: AbortSignal }): Promise<TaskDetail> {
    const res = await this.request<SuccessResponse<TaskDetail>>(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      undefined,
      opts?.signal,
    );
    return res.data;
  }

  /** DELETE /tasks/{task_id} — cancel a task. */
  async cancelTask(taskId: string): Promise<CancelTaskResponse> {
    const res = await this.request<SuccessResponse<CancelTaskResponse>>('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
    return res.data;
  }

  /**
   * POST /tasks/{task_id}/nudge — send a steering message to a running task (Phase 2).
   *
   * The server guardrail-screens and rate-limits the nudge before enqueuing it
   * for the agent to pick up at the next between-turns seam. Returns HTTP 202
   * with the generated `nudge_id` on success.
   */
  async nudgeTask(taskId: string, message: string): Promise<NudgeResponse> {
    const body: NudgeRequest = { message };
    const res = await this.request<SuccessResponse<NudgeResponse>>(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/nudge`,
      body,
    );
    return res.data;
  }

  /**
   * GET /tasks/{task_id}/events — fetch one page of task events.
   *
   * Supports two alternative pagination cursors:
   *   - ``after`` — a ULID event_id. Server returns events with
   *     ``event_id > after``.
   *   - ``nextToken`` — an opaque DynamoDB pagination token for normal
   *     forward pagination.
   *
   * If both are passed, the server prefers ``after`` and logs a warning.
   * Prefer {@link catchUpEvents} when you want all events after a known
   * id drained across pagination (the watch loop uses this).
   */
  async getTaskEvents(taskId: string, opts?: {
    limit?: number;
    nextToken?: string;
    after?: string;
    /** Request newest-first ordering — mutually exclusive with ``after`` on the server. */
    desc?: boolean;
    /** Abort an in-flight request (SIGINT during ``bgagent watch``, etc.). */
    signal?: AbortSignal;
  }): Promise<PaginatedResponse<TaskEvent>> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.nextToken) params.set('next_token', opts.nextToken);
    if (opts?.after) params.set('after', opts.after);
    if (opts?.desc) params.set('desc', '1');

    const qs = params.toString();
    const path = `/tasks/${encodeURIComponent(taskId)}/events${qs ? `?${qs}` : ''}`;
    return this.request<PaginatedResponse<TaskEvent>>('GET', path, undefined, undefined, opts?.signal);
  }

  /**
   * Fetch the combined task + most-recent-events payload that backs the
   * deterministic ``bgagent status`` snapshot (design §5.2).
   *
   * Runs the ``GET /tasks/{id}`` and ``GET /tasks/{id}/events?desc=1&limit=N``
   * calls in parallel so the snapshot is a single round-trip in wall-clock
   * terms. The event page is intentionally small (default 20) — the
   * formatter only needs the latest tool call, turn, milestone, and cost
   * update, which are always recent in a well-behaved event stream.
   *
   * @param taskId - the task to summarize.
   * @param recentEventLimit - how many recent events to pull (default 20).
   */
  async getStatusSnapshot(
    taskId: string,
    recentEventLimit = 20,
  ): Promise<{ task: TaskDetail; recentEvents: TaskEvent[] }> {
    const [task, eventsPage] = await Promise.all([
      this.getTask(taskId),
      this.getTaskEvents(taskId, { limit: recentEventLimit, desc: true }),
    ]);
    return { task, recentEvents: eventsPage.data };
  }

  /**
   * Fetch every event with ``event_id > afterEventId``, paginating through
   * the server's ``next_token`` internally.
   *
   * Paginates forward from a known event_id cursor. Returns events in
   * ascending order (oldest first), matching the server's
   * ``ScanIndexForward: true``.
   *
   * @param taskId - the task whose events to fetch.
   * @param afterEventId - the ULID cursor; events strictly greater than
   *   this id are returned.
   * @param pageSize - page size passed to the server (default 100, max 100).
   * @returns all events after the cursor, in chronological order.
   */
  async catchUpEvents(
    taskId: string,
    afterEventId: string,
    pageSize = 100,
    opts?: { signal?: AbortSignal },
  ): Promise<TaskEvent[]> {
    const collected: TaskEvent[] = [];
    const signal = opts?.signal;
    // First page uses ``after``; subsequent pages use the opaque ``next_token``.
    let page = await this.getTaskEvents(taskId, { after: afterEventId, limit: pageSize, signal });
    collected.push(...page.data);
    while (page.pagination.has_more && page.pagination.next_token) {
      page = await this.getTaskEvents(taskId, {
        nextToken: page.pagination.next_token,
        limit: pageSize,
        signal,
      });
      collected.push(...page.data);
    }
    return collected;
  }

  /** POST /webhooks — create a new webhook. */
  async createWebhook(req: CreateWebhookRequest): Promise<CreateWebhookResponse> {
    const res = await this.request<SuccessResponse<CreateWebhookResponse>>('POST', '/webhooks', req);
    return res.data;
  }

  /** GET /webhooks — list webhooks. */
  async listWebhooks(opts?: {
    includeRevoked?: boolean;
    limit?: number;
    nextToken?: string;
  }): Promise<PaginatedResponse<WebhookDetail>> {
    const params = new URLSearchParams();
    if (opts?.includeRevoked) params.set('include_revoked', 'true');
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.nextToken) params.set('next_token', opts.nextToken);

    const qs = params.toString();
    const path = `/webhooks${qs ? `?${qs}` : ''}`;
    return this.request<PaginatedResponse<WebhookDetail>>('GET', path);
  }

  /** DELETE /webhooks/{webhook_id} — revoke a webhook. */
  async revokeWebhook(webhookId: string): Promise<WebhookDetail> {
    const res = await this.request<SuccessResponse<WebhookDetail>>('DELETE', `/webhooks/${encodeURIComponent(webhookId)}`);
    return res.data;
  }
}
