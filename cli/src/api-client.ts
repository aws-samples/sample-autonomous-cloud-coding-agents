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
import { debug, isVerbose, redactedJson } from './debug';
import { ApiError, CliError } from './errors';
import {
  ApiKeyDetail,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalScope,
  CancelTaskResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  CreateWebhookRequest,
  CreateWebhookResponse,
  DenyRequest,
  DenyResponse,
  ErrorResponse,
  GetPendingResponse,
  GetPoliciesResponse,
  JiraLinkResponse,
  LinearLinkResponse,
  LinearRemoveWorkspaceResponse,
  NudgeRequest,
  NudgeResponse,
  RegistryListEntry,
  RegistryPublishRequest,
  RegistryRecordResponse,
  RegistryResolveResponse,
  RegistryShowResponse,
  SlackLinkResponse,
  PaginatedResponse,
  PersonalBudgetStatus,
  ReplayBundle,
  Scoreboard,
  ScoreboardRange,
  SuccessResponse,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  TraceUrlResponse,
  WebhookDetail,
} from './types';

const STATUS_SNAPSHOT_EVENT_LIMIT = 20;

export interface ApiClientOptions {
  /**
   * Platform API key to authenticate with instead of a Cognito session.
   * When set (or when `BGAGENT_API_KEY` is in the environment), requests carry
   * the `X-API-Key` header and no `bgagent login` is required. Only the
   * endpoints the key is scoped for will succeed.
   */
  readonly apiKey?: string;
}

export class ApiClient {
  private baseUrl: string | undefined;

  private registryBaseUrl: string | undefined;

  private readonly apiKey: string | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.BGAGENT_API_KEY ?? undefined;
  }

  private getBaseUrl(): string {
    if (!this.baseUrl) {
      const config = loadConfig();
      this.baseUrl = config.api_url.replace(/\/+$/, '');
    }
    return this.baseUrl;
  }

  private getRegistryBaseUrl(): string {
    if (!this.registryBaseUrl) {
      const config = loadConfig();
      if (!config.registry_api_url) {
        throw new Error(
          'registry_api_url is not set in your bgagent config. If the stack deploys the Agent Registry, '
          + 'run `bgagent configure --stack-name <stack>` (or add registry_api_url from its RegistryApiUrl output); '
          + 'otherwise run `bgagent setup` and enable AWS Agent Registry (feature \'agentRegistry\').',
        );
      }
      this.registryBaseUrl = config.registry_api_url.replace(/\/+$/, '');
    }
    return this.registryBaseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    baseUrl?: string,
  ): Promise<T> {
    const authHeaders: Record<string, string> = this.apiKey
      ? { 'X-API-Key': this.apiKey }
      : { Authorization: await getAuthToken() };
    const url = `${baseUrl ?? this.getBaseUrl()}${path}`;

    debug(`${method} ${url}`);
    if (body && isVerbose()) {
      debug(`Request body: ${redactedJson(body)}`);
    }

    const res = await fetch(url, {
      method,
      headers: {
        ...authHeaders,
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

    if (jsonParseOk && isVerbose()) {
      debug(`Response body: ${redactedJson(json)}`);
    }

    if (!res.ok) {
      if (jsonParseOk && (json as ErrorResponse).error) {
        const err = json as ErrorResponse;
        let message = `${err.error.message} (${err.error.code})`;
        if (res.status === 401) {
          message += '\nHint: Run `bgagent login` to re-authenticate.';
        }
        throw new ApiError(res.status, err.error.code, message, err.error.request_id);
      }
      throw new ApiError(
        res.status,
        'HTTP_ERROR',
        `HTTP ${res.status}: ${res.statusText}${jsonParseOk ? '' : ' (non-JSON response)'}`,
        '',
      );
    }

    if (!jsonParseOk) {
      throw new CliError(`HTTP ${res.status}: ${res.statusText} (non-JSON response)`);
    }

    return json as T;
  }

  async createTask(req: CreateTaskRequest, idempotencyKey?: string): Promise<CreateTaskResponse> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const res = await this.request<SuccessResponse<CreateTaskResponse>>('POST', '/tasks', req, headers);
    return res.data;
  }

  async confirmUploads(taskId: string): Promise<TaskDetail> {
    const res = await this.request<SuccessResponse<TaskDetail>>('POST', `/tasks/${encodeURIComponent(taskId)}/confirm-uploads`);
    return res.data;
  }

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

  async getPersonalBudget(): Promise<PersonalBudgetStatus> {
    const res = await this.request<SuccessResponse<PersonalBudgetStatus>>(
      'GET',
      '/tasks?view=budget',
    );
    return res.data;
  }

  /**
   * GET /tasks?view=scoreboard — the authenticated caller's factory scoreboard: their finished
   * tasks of the range and of the period before it, or those of one repository when `repo` is given.
   */
  async getScoreboard(opts: { range: ScoreboardRange; repo?: string }): Promise<Scoreboard> {
    const params = new URLSearchParams({ view: 'scoreboard', range: opts.range });
    if (opts.repo !== undefined) params.set('repo', opts.repo);
    const res = await this.request<SuccessResponse<Scoreboard>>('GET', `/tasks?${params.toString()}`);
    return res.data;
  }

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

  async cancelTask(taskId: string): Promise<CancelTaskResponse> {
    const res = await this.request<SuccessResponse<CancelTaskResponse>>('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
    return res.data;
  }

  /**
   * POST /tasks/{task_id}/nudge — send a steering message to a running task.
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
   * POST /tasks/{task_id}/approve — approve a pending Cedar HITL gate.
   *
   * `scope` defaults to `this_call` on the server when omitted;
   * callers pass it explicitly to extend the allowlist
   * (`tool_type_session`, `rule:<id>`, etc.). Returns 202 with the
   * decided timestamp + scope echoed back.
   */
  async approveTask(
    taskId: string,
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<ApprovalResponse> {
    const body: ApprovalRequest = {
      request_id: requestId,
      decision: 'approve',
      ...(scope && { scope }),
    };
    const res = await this.request<SuccessResponse<ApprovalResponse>>(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/approve`,
      body,
    );
    return res.data;
  }

  /**
   * POST /tasks/{task_id}/deny — deny a pending Cedar HITL gate.
   *
   * `reason` is sanitized + truncated server-side before reaching the
   * agent. Returns 202.
   */
  async denyTask(
    taskId: string,
    requestId: string,
    reason?: string,
  ): Promise<DenyResponse> {
    const body: DenyRequest = {
      request_id: requestId,
      decision: 'deny',
      ...(reason && { reason }),
    };
    const res = await this.request<SuccessResponse<DenyResponse>>(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/deny`,
      body,
    );
    return res.data;
  }

  async listPending(): Promise<GetPendingResponse> {
    const res = await this.request<SuccessResponse<GetPendingResponse>>(
      'GET',
      '/pending',
    );
    return res.data;
  }

  /**
   * GET /repos/{repo_id}/policies — list Cedar rules for a repo.
   *
   * This client URL-encodes the path segment so callers can pass
   * `owner/repo` as-is.
   */
  async listPolicies(repoId: string): Promise<GetPoliciesResponse> {
    const res = await this.request<SuccessResponse<GetPoliciesResponse>>(
      'GET',
      `/repos/${encodeURIComponent(repoId)}/policies`,
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
   * id drained across pagination.
   */
  async getTaskEvents(taskId: string, opts?: {
    limit?: number;
    nextToken?: string;
    after?: string;
    /** Request newest-first ordering — mutually exclusive with ``after`` on the server. */
    desc?: boolean;
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
   * deterministic ``bgagent status`` snapshot.
   */
  async getStatusSnapshot(taskId: string): Promise<{ task: TaskDetail; recentEvents: TaskEvent[] }> {
    const [task, eventsPage] = await Promise.all([
      this.getTask(taskId),
      this.getTaskEvents(taskId, { limit: STATUS_SNAPSHOT_EVENT_LIMIT, desc: true }),
    ]);
    return { task, recentEvents: eventsPage.data };
  }

  /**
   * Fetch every event with ``event_id > afterEventId``, paginating through
   * the server's ``next_token`` internally.
   *
   * @param afterEventId - the ULID cursor; events strictly greater than
   *   this id are returned.
   * @returns all events after the cursor, in chronological order.
   */
  async catchUpEvents(
    taskId: string,
    afterEventId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<TaskEvent[]> {
    const collected: TaskEvent[] = [];
    const signal = opts?.signal;
    let page = await this.getTaskEvents(taskId, { after: afterEventId, limit: 100, signal });
    collected.push(...page.data);
    while (page.pagination.has_more && page.pagination.next_token) {
      page = await this.getTaskEvents(taskId, {
        nextToken: page.pagination.next_token,
        limit: 100,
        signal,
      });
      collected.push(...page.data);
    }
    return collected;
  }

  /**
   * GET /tasks/{task_id}/trace — get a presigned S3 URL for the
   * ``--trace`` trajectory dump.
   *
   * Returns a short-lived (15-minute) presigned URL the CLI can
   * stream directly from S3. The endpoint 404s with code
   * ``TRACE_NOT_AVAILABLE`` when the task did not run with
   * ``--trace`` or the upload has not yet completed.
   */
  async getTraceUrl(taskId: string): Promise<TraceUrlResponse> {
    const res = await this.request<SuccessResponse<TraceUrlResponse>>(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}/trace`,
    );
    return res.data;
  }

  async getReplay(taskId: string): Promise<ReplayBundle> {
    const res = await this.request<SuccessResponse<ReplayBundle>>(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}/replay`,
    );
    return res.data;
  }

  async createWebhook(req: CreateWebhookRequest): Promise<CreateWebhookResponse> {
    const res = await this.request<SuccessResponse<CreateWebhookResponse>>('POST', '/webhooks', req);
    return res.data;
  }

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

  async revokeWebhook(webhookId: string): Promise<WebhookDetail> {
    const res = await this.request<SuccessResponse<WebhookDetail>>('DELETE', `/webhooks/${encodeURIComponent(webhookId)}`);
    return res.data;
  }

  /** POST /api-keys — mint a new platform API key (Cognito-authenticated). */
  async createApiKey(req: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    const res = await this.request<SuccessResponse<CreateApiKeyResponse>>('POST', '/api-keys', req);
    return res.data;
  }

  async listApiKeys(opts?: {
    includeRevoked?: boolean;
    limit?: number;
    nextToken?: string;
  }): Promise<PaginatedResponse<ApiKeyDetail>> {
    const params = new URLSearchParams();
    if (opts?.includeRevoked) params.set('include_revoked', 'true');
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.nextToken) params.set('next_token', opts.nextToken);

    const qs = params.toString();
    const path = `/api-keys${qs ? `?${qs}` : ''}`;
    return this.request<PaginatedResponse<ApiKeyDetail>>('GET', path);
  }

  async revokeApiKey(keyId: string): Promise<ApiKeyDetail> {
    const res = await this.request<SuccessResponse<ApiKeyDetail>>('DELETE', `/api-keys/${encodeURIComponent(keyId)}`);
    return res.data;
  }

  async slackLink(code: string): Promise<SlackLinkResponse> {
    const res = await this.request<SuccessResponse<SlackLinkResponse>>('POST', '/slack/link', { code });
    return res.data;
  }

  /** POST /linear/link — link a Linear account using a verification code.
   *
   * `dryRun: true` returns the identity attached to the code without
   * writing the mapping. */
  async linearLink(code: string, opts: { dryRun?: boolean } = {}): Promise<LinearLinkResponse> {
    const body: Record<string, unknown> = { code };
    if (opts.dryRun) body.dry_run = true;
    const res = await this.request<SuccessResponse<LinearLinkResponse>>('POST', '/linear/link', body);
    return res.data;
  }

  /** DELETE /linear/workspaces/{slug} — deregister a Linear workspace.
   *
   * Server-side: revokes the registry row (or deletes it with `purge`) and
   * deletes the per-workspace OAuth secret. Admin-only, enforced by the
   * handler against the recorded installer identity. Project→repo mappings
   * are not touched (they carry no workspace id — remove by project id). */
  async linearRemoveWorkspace(
    slug: string,
    opts: { purge?: boolean } = {},
  ): Promise<LinearRemoveWorkspaceResponse> {
    const params = new URLSearchParams();
    if (opts.purge) params.set('purge', 'true');
    const qs = params.toString();
    const path = `/linear/workspaces/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`;
    const res = await this.request<SuccessResponse<LinearRemoveWorkspaceResponse>>('DELETE', path);
    return res.data;
  }

  /** POST /jira/link — link a Jira account using a verification code.
   *
   * `dryRun: true` returns the identity attached to the code without
   * writing the mapping. */
  async jiraLink(code: string, opts: { dryRun?: boolean } = {}): Promise<JiraLinkResponse> {
    const body: Record<string, unknown> = { code };
    if (opts.dryRun) body.dry_run = true;
    const res = await this.request<SuccessResponse<JiraLinkResponse>>('POST', '/jira/link', body);
    return res.data;
  }

  async registryPublish(req: RegistryPublishRequest): Promise<RegistryRecordResponse> {
    const res = await this.request<SuccessResponse<RegistryRecordResponse>>(
      'POST', '/registry/records', req, undefined, undefined, this.getRegistryBaseUrl(),
    );
    return res.data;
  }

  async registryResolve(ref: string): Promise<RegistryResolveResponse> {
    const res = await this.request<SuccessResponse<RegistryResolveResponse>>(
      'GET',
      `/registry/resolve?ref=${encodeURIComponent(ref)}`,
      undefined, undefined, undefined, this.getRegistryBaseUrl(),
    );
    return res.data;
  }

  async registryList(opts?: { kind?: string; namespace?: string }): Promise<RegistryListEntry[]> {
    const params = new URLSearchParams();
    if (opts?.kind) params.set('kind', opts.kind);
    if (opts?.namespace) params.set('namespace', opts.namespace);
    const qs = params.toString();
    const res = await this.request<SuccessResponse<{ assets: RegistryListEntry[] }>>(
      'GET',
      `/registry/records${qs ? `?${qs}` : ''}`,
      undefined, undefined, undefined, this.getRegistryBaseUrl(),
    );
    return res.data.assets;
  }

  async registryShow(
    kind: string,
    namespace: string,
    name: string,
  ): Promise<RegistryShowResponse> {
    const res = await this.request<SuccessResponse<RegistryShowResponse>>(
      'GET',
      `/registry/records/${encodeURIComponent(kind)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      undefined, undefined, undefined, this.getRegistryBaseUrl(),
    );
    return res.data;
  }
}
