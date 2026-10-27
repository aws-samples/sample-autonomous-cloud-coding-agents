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

import type {
  CancelTaskResponse,
  CreateTaskRequest,
  DecisionResponse,
  ErrorResponse,
  GetPendingResponse,
  NudgeResponse,
  PaginatedResponse,
  SuccessResponse,
  TaskDetail,
  TaskEvent,
  TaskStatusType,
  TaskSummary,
} from './types';

/** HTTP error from the REST API, carrying the envelope's code and request id when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ListTasksParams {
  readonly status?: readonly TaskStatusType[];
  readonly repo?: string;
  readonly limit?: number;
  readonly nextToken?: string;
}

interface ListTaskEventsParams {
  readonly limit?: number;
  readonly nextToken?: string;
  /** Newest first. */
  readonly desc?: boolean;
}

export interface ApiClient {
  listTasks(params?: ListTasksParams): Promise<PaginatedResponse<TaskSummary>>;
  getTask(taskId: string): Promise<TaskDetail>;
  listTaskEvents(taskId: string, params?: ListTaskEventsParams): Promise<PaginatedResponse<TaskEvent>>;
  listPending(): Promise<GetPendingResponse>;
  /** `idempotencyKey` makes a retried submit (double click, flaky network) create one task, not two. */
  createTask(req: CreateTaskRequest, idempotencyKey: string): Promise<TaskDetail>;
  cancelTask(taskId: string): Promise<CancelTaskResponse>;
  nudgeTask(taskId: string, message: string): Promise<NudgeResponse>;
  approve(taskId: string, requestId: string): Promise<DecisionResponse>;
  deny(taskId: string, requestId: string, reason?: string): Promise<DecisionResponse>;
}

export interface ApiClientOptions {
  /** Base URL including the stage, e.g. `https://abc.execute-api.us-east-1.amazonaws.com/v1`. */
  readonly baseUrl: string;
  /** Returns a current Cognito ID token. Sent raw in `Authorization`, matching the CLI. */
  readonly getToken: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
}

export function createApiClient({ baseUrl, getToken, fetchImpl }: ApiClientOptions): ApiClient {
  const root = baseUrl.replace(/\/+$/, '');

  interface RequestOptions {
    readonly query?: URLSearchParams;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  }

  async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const { query, body: payload, headers = {} } = options;
    const qs = query && query.toString() ? `?${query.toString()}` : '';
    // Resolve fetch per request so instrumentation installed later (tests, mock mode) applies.
    const doFetch = fetchImpl ?? globalThis.fetch;
    const res = await doFetch(`${root}${path}${qs}`, {
      method,
      headers: {
        Authorization: await getToken(),
        Accept: 'application/json',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    let body: unknown;
    let parsed = true;
    try {
      body = await res.json();
    } catch {
      parsed = false;
    }

    if (!res.ok) {
      const envelope = parsed ? (body as Partial<ErrorResponse>).error : undefined;
      if (envelope) {
        throw new ApiError(res.status, envelope.code, envelope.message, envelope.request_id);
      }
      throw new ApiError(res.status, 'HTTP_ERROR', `HTTP ${res.status}${parsed ? '' : ' (non-JSON response)'}`, '');
    }
    if (!parsed) {
      throw new ApiError(res.status, 'INVALID_RESPONSE', `HTTP ${res.status} returned a non-JSON body`, '');
    }
    return body as T;
  }

  const get = <T>(path: string, query?: URLSearchParams) => request<T>('GET', path, { query });
  const taskPath = (taskId: string, suffix = '') => `/tasks/${encodeURIComponent(taskId)}${suffix}`;
  const data = async <T>(promise: Promise<SuccessResponse<T>>) => (await promise).data;

  return {
    listTasks(params = {}) {
      const query = new URLSearchParams();
      if (params.status?.length) query.set('status', params.status.join(','));
      if (params.repo) query.set('repo', params.repo);
      if (params.limit) query.set('limit', String(params.limit));
      if (params.nextToken) query.set('next_token', params.nextToken);
      return get<PaginatedResponse<TaskSummary>>('/tasks', query);
    },
    async getTask(taskId) {
      const res = await get<SuccessResponse<TaskDetail>>(`/tasks/${encodeURIComponent(taskId)}`);
      return res.data;
    },
    listTaskEvents(taskId, params = {}) {
      const query = new URLSearchParams();
      if (params.limit) query.set('limit', String(params.limit));
      if (params.nextToken) query.set('next_token', params.nextToken);
      if (params.desc) query.set('desc', '1');
      return get<PaginatedResponse<TaskEvent>>(`/tasks/${encodeURIComponent(taskId)}/events`, query);
    },
    async listPending() {
      const res = await get<SuccessResponse<GetPendingResponse>>('/pending');
      return res.data;
    },
    createTask(req, idempotencyKey) {
      return data(request<SuccessResponse<TaskDetail>>('POST', '/tasks', { body: req, headers: { 'Idempotency-Key': idempotencyKey } }));
    },
    cancelTask(taskId) {
      return data(request<SuccessResponse<CancelTaskResponse>>('DELETE', taskPath(taskId)));
    },
    nudgeTask(taskId, message) {
      return data(request<SuccessResponse<NudgeResponse>>('POST', taskPath(taskId, '/nudge'), { body: { message } }));
    },
    approve(taskId, requestId) {
      return data(request<SuccessResponse<DecisionResponse>>('POST', taskPath(taskId, '/approve'), {
        body: { request_id: requestId, decision: 'approve' },
      }));
    },
    deny(taskId, requestId, reason) {
      return data(request<SuccessResponse<DecisionResponse>>('POST', taskPath(taskId, '/deny'), {
        body: { request_id: requestId, decision: 'deny', ...(reason ? { reason } : {}) },
      }));
    },
  };
}
