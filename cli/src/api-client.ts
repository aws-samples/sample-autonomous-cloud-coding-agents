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
  SlackLinkResponse,
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

  private async request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
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
    });

    debug(`Response: ${res.status} ${res.statusText}`);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new CliError(`HTTP ${res.status}: ${res.statusText} (non-JSON response)`);
    }

    debug(`Response body: ${JSON.stringify(json)}`);

    if (!res.ok) {
      const err = json as ErrorResponse;
      if (err.error) {
        let message = `${err.error.message} (${err.error.code})`;
        if (res.status === 401) {
          message += '\nHint: Run `bgagent login` to re-authenticate.';
        }
        throw new ApiError(res.status, err.error.code, message, err.error.request_id);
      }
      throw new CliError(`HTTP ${res.status}: ${res.statusText}`);
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
  async getTask(taskId: string): Promise<TaskDetail> {
    const res = await this.request<SuccessResponse<TaskDetail>>('GET', `/tasks/${encodeURIComponent(taskId)}`);
    return res.data;
  }

  /** DELETE /tasks/{task_id} — cancel a task. */
  async cancelTask(taskId: string): Promise<CancelTaskResponse> {
    const res = await this.request<SuccessResponse<CancelTaskResponse>>('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
    return res.data;
  }

  /** GET /tasks/{task_id}/events — get task events. */
  async getTaskEvents(taskId: string, opts?: {
    limit?: number;
    nextToken?: string;
  }): Promise<PaginatedResponse<TaskEvent>> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.nextToken) params.set('next_token', opts.nextToken);

    const qs = params.toString();
    const path = `/tasks/${encodeURIComponent(taskId)}/events${qs ? `?${qs}` : ''}`;
    return this.request<PaginatedResponse<TaskEvent>>('GET', path);
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

  /** POST /slack/link — link a Slack account using a verification code. */
  async slackLink(code: string): Promise<SlackLinkResponse> {
    const res = await this.request<SuccessResponse<SlackLinkResponse>>('POST', '/slack/link', { code });
    return res.data;
  }
}
