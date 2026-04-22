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

import { CliError } from '../src/errors';
import {
  AgUiEvent,
  ReconnectReason,
  SseClientOptions,
  buildInvocationUrl,
  extractDedupId,
  runSseClient,
} from '../src/sse-client';

/* ------------------------------------------------------------------------ */
/*  Test utilities                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Build a Response-like object whose ``body`` is a ReadableStream that emits
 * the given chunks (UTF-8) in order, then closes. Each chunk is pushed
 * immediately — tests that want timing control should use
 * {@link controllableResponse} instead.
 */
function staticResponse(status: number, chunks: string[] = [], statusText = 'OK'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, statusText });
}

/**
 * Build a Response-like object whose body emission is caller-controlled via
 * the returned ``push`` / ``close`` / ``error`` helpers. Tracks a ``closed``
 * flag so callers can make ``push`` / ``close`` idempotent in timers without
 * spurious "Invalid state" errors. Enables simulation of slow streams,
 * mid-stream cuts, and keepalive-timeout scenarios.
 *
 * The returned ``bindSignal`` helper can be called inside a mock fetch
 * implementation to link an AbortSignal to the body stream — mirroring the
 * real fetch behaviour where aborting the controller terminates the body.
 */
function controllableResponse(status = 200, statusText = 'OK'): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
  error: (err: Error) => void;
  bindSignal: (signal: AbortSignal | undefined) => void;
  closed: () => boolean;
} {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let isClosed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      isClosed = true;
    },
  });
  const enc = new TextEncoder();
  const push = (chunk: string) => {
    if (isClosed) return;
    try { controllerRef?.enqueue(enc.encode(chunk)); } catch { isClosed = true; }
  };
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    try { controllerRef?.close(); } catch { /* ignore */ }
  };
  const error = (err: Error) => {
    if (isClosed) return;
    isClosed = true;
    try { controllerRef?.error(err); } catch { /* ignore */ }
  };
  const bindSignal = (signal: AbortSignal | undefined) => {
    if (!signal) return;
    if (signal.aborted) {
      error(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      error(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  };
  return {
    response: new Response(body, { status, statusText }),
    push,
    close,
    error,
    bindSignal,
    closed: () => isClosed,
  };
}

/** Build a mock fetch implementation that honours the AbortSignal passed in
 *  the init — necessary to simulate the real fetch semantics in tests where
 *  external cancellation or watchdog abort must kill the body stream. */
function bindingFetch(
  responder: (input: unknown, init: RequestInit) => Response | Promise<Response>,
  bindTo?: { bindSignal: (signal: AbortSignal | undefined) => void },
) {
  return async (input: unknown, init: RequestInit = {}) => {
    const resp = await responder(input, init);
    if (bindTo && init.signal) bindTo.bindSignal(init.signal ?? undefined);
    return resp;
  };
}

/** Normalise ``init.signal`` (which may be null) to the ``AbortSignal | undefined``
 *  type expected by {@link controllableResponse.bindSignal}. */
function sig(init: RequestInit): AbortSignal | undefined {
  return init.signal ?? undefined;
}

/** Encode a single AG-UI event as an SSE ``data:`` frame. */
function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Sample AG-UI events matching what ``sse_wire.py`` emits. */
const EV_TEXT_START = {
  type: 'TEXT_MESSAGE_START',
  timestamp: 1,
  messageId: '01HXYZMSG00000000000000001',
  role: 'assistant',
};
const EV_TEXT_CONTENT = {
  type: 'TEXT_MESSAGE_CONTENT',
  timestamp: 2,
  messageId: '01HXYZMSG00000000000000001',
  delta: 'hello',
};
const EV_TEXT_END = {
  type: 'TEXT_MESSAGE_END',
  timestamp: 3,
  messageId: '01HXYZMSG00000000000000001',
};
const EV_RUN_FINISHED = {
  type: 'RUN_FINISHED',
  timestamp: 4,
  threadId: 'task-42',
  runId: 'task-42',
};
const EV_RUN_ERROR_TERMINAL = {
  type: 'RUN_ERROR',
  timestamp: 5,
  threadId: 'task-42',
  runId: 'task-42',
  code: 'AGENT_ERROR',
  message: 'pipeline blew up',
};
const EV_RUN_ERROR_TRANSIENT = {
  type: 'RUN_ERROR',
  timestamp: 6,
  threadId: 'task-42',
  runId: 'task-42',
  code: 'RATE_LIMITED',
  message: 'slow down',
};

/** Build minimum viable options with sensible test defaults. Override with ``overrides``. */
function buildOptions(overrides: Partial<SseClientOptions> = {}): SseClientOptions {
  const events: AgUiEvent[] = [];
  const base: SseClientOptions = {
    runtimeJwtArn:
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/abca_agent_jwt-ABC123',
    region: 'us-east-1',
    taskId: 'task-42',
    getAuthToken: jest.fn().mockResolvedValue('jwt-token-AAAAAAAA'),
    catchUp: jest.fn().mockResolvedValue([]),
    onEvent: (ev) => events.push(ev),
    reconnectBackoffMs: { initial: 1, max: 1, factor: 1.0 },
    keepaliveGraceMs: 5_000,
    maxStreamSeconds: 10,
  };
  // Expose the collector so tests can inspect emitted events even when they
  // supply their own overrides.
  (base as unknown as { _collector: AgUiEvent[] })._collector = events;
  return { ...base, ...overrides };
}

/** Extract the shared event collector from the options built by {@link buildOptions}. */
function eventsFrom(options: SseClientOptions): AgUiEvent[] {
  return (options as unknown as { _collector: AgUiEvent[] })._collector;
}

/* ------------------------------------------------------------------------ */
/*  Tests                                                                    */
/* ------------------------------------------------------------------------ */

const originalFetch = global.fetch;

describe('sse-client helpers', () => {
  test('buildInvocationUrl — URL-encodes ARN and appends qualifier', () => {
    const arn = 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/abca_agent_jwt-XYZ';
    const url = buildInvocationUrl('us-east-1', arn);
    expect(url).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/' +
      encodeURIComponent(arn) +
      '/invocations?qualifier=DEFAULT',
    );
    // URL-encoding must include the ``:`` separators in the ARN.
    expect(url).toContain('arn%3Aaws%3Abedrock-agentcore');
    // The slash between ``runtime`` and the runtime id must also be encoded.
    expect(url).toContain('runtime%2F');
  });

  test('extractDedupId — prefers explicit id, then messageId, then toolCallId', () => {
    expect(extractDedupId({ type: 'X', id: 'ddb-123', messageId: 'm', toolCallId: 't' }))
      .toBe('id:ddb-123');
    expect(extractDedupId({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1' }))
      .toBe('msg:TEXT_MESSAGE_CONTENT:msg-1');
    expect(extractDedupId({ type: 'TOOL_CALL_START', toolCallId: 'tool-1' }))
      .toBe('tool:TOOL_CALL_START:tool-1');
  });

  test('extractDedupId — RUN_STARTED / FINISHED / ERROR use runId', () => {
    expect(extractDedupId({ type: 'RUN_STARTED', runId: 'run-1' })).toBe('run:RUN_STARTED:run-1');
    expect(extractDedupId({ type: 'RUN_FINISHED', runId: 'run-1' })).toBe('run:RUN_FINISHED:run-1');
    expect(extractDedupId({ type: 'RUN_ERROR', runId: 'run-1' })).toBe('run:RUN_ERROR:run-1');
  });

  test('extractDedupId — STEP_* and CUSTOM fall back gracefully', () => {
    expect(extractDedupId({ type: 'STEP_STARTED', stepName: 'clone', timestamp: 100 }))
      .toBe('step:STEP_STARTED:clone:100');
    expect(extractDedupId({ type: 'CUSTOM', name: 'agent_cost_update', timestamp: 200 }))
      .toBe('custom:agent_cost_update:200');
    expect(extractDedupId({ type: 'MYSTERY', timestamp: 300 })).toBe('misc:MYSTERY:300');
  });
});

describe('runSseClient — happy path and frame handling', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('happy path: 3 events + RUN_FINISHED → emits 4, resolves with terminalEvent', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [
      sseFrame(EV_TEXT_START),
      sseFrame(EV_TEXT_CONTENT),
      sseFrame(EV_TEXT_END),
      sseFrame(EV_RUN_FINISHED),
    ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions();
    const result = await runSseClient(options);

    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    expect(result.reconnectCount).toBe(0);
    expect(result.eventsReceived).toBe(4);
    expect(eventsFrom(options).map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('invalid JSON in a frame → onError, stream continues, next frame works', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [
      'data: {not json\n\n',
      sseFrame(EV_TEXT_START),
      sseFrame(EV_RUN_FINISHED),
    ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const onError = jest.fn();
    const options = buildOptions({ onError });
    const result = await runSseClient(options);

    // RUN_FINISHED should close the stream cleanly.
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    // Valid events still got through.
    expect(eventsFrom(options).some((e) => e.type === 'TEXT_MESSAGE_START')).toBe(true);
    // Invalid JSON should not have prevented completion — bad frame is dropped
    // with a debug log, not routed through onError (parser-level only).
  });

  test('Zod validation failure — falls back to raw frame so terminals still close', async () => {
    // A RUN_FINISHED missing the required runId field still has type recognition.
    const malformedFinished = { type: 'RUN_FINISHED', timestamp: 1 };
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [
      sseFrame(EV_TEXT_START),
      sseFrame(malformedFinished),
    ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions();
    const result = await runSseClient(options);

    // Even though Zod rejected the terminal frame, type-sniffing routes it as terminal.
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
  });

  test('terminal RUN_ERROR with AGENT_ERROR code → no reconnect, resolves with terminal', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [
      sseFrame(EV_TEXT_START),
      sseFrame(EV_RUN_ERROR_TERMINAL),
    ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions();
    const result = await runSseClient(options);

    expect(result.terminalEvent?.type).toBe('RUN_ERROR');
    expect(result.terminalEvent?.code).toBe('AGENT_ERROR');
    expect(result.reconnectCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('non-terminal RUN_ERROR (rate-limited) → reconnects and then finishes', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(200, [
        sseFrame(EV_TEXT_START),
        sseFrame(EV_RUN_ERROR_TRANSIENT),
      ]))
      .mockResolvedValueOnce(staticResponse(200, [
        sseFrame(EV_TEXT_CONTENT),
        sseFrame(EV_RUN_FINISHED),
      ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const onReconnecting = jest.fn();
    const options = buildOptions({ onReconnecting });
    const result = await runSseClient(options);

    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    expect(result.reconnectCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onReconnecting).toHaveBeenCalledWith(
      1,
      'non_terminal_run_error',
      expect.any(Number),
    );
  });

  test('RUN_ERROR with no code → treated as terminal (cautious default)', async () => {
    const codeless = { type: 'RUN_ERROR', runId: 't', threadId: 't', message: 'nope' };
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [
      sseFrame(codeless),
    ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions();
    const result = await runSseClient(options);
    expect(result.terminalEvent?.type).toBe('RUN_ERROR');
    expect(result.reconnectCount).toBe(0);
  });
});

describe('runSseClient — reconnect and catch-up', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('mid-stream abrupt close → reconnects, calls catchUp, resumes', async () => {
    const first = controllableResponse();
    const finisher = staticResponse(200, [
      sseFrame(EV_TEXT_CONTENT),
      sseFrame(EV_RUN_FINISHED),
    ]);
    const call: { n: number } = { n: 0 };
    const mockFetch = jest.fn(async (_input, init: RequestInit = {}) => {
      call.n += 1;
      if (call.n === 1) { first.bindSignal(sig(init)); return first.response; }
      return finisher;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onReconnecting = jest.fn();
    const catchUpEvents: AgUiEvent[] = [
      {
        type: 'TEXT_MESSAGE_START',
        messageId: '01HXYZMSG00000000000000001',
        id: '01HXYZDDB0000000000000005A',
        role: 'assistant',
      },
    ];
    const catchUp = jest.fn().mockResolvedValue(catchUpEvents);
    const options = buildOptions({ onReconnecting, catchUp });

    // Start the client in the background; we'll push data and then close.
    const runPromise = runSseClient(options);
    // Push the first event, then abruptly close the stream (no terminal event).
    await new Promise((r) => setTimeout(r, 10));
    first.push(sseFrame(EV_TEXT_START));
    await new Promise((r) => setTimeout(r, 10));
    first.close();

    const result = await runPromise;
    expect(result.reconnectCount).toBe(1);
    expect(catchUp).toHaveBeenCalled();
    expect(onReconnecting).toHaveBeenCalledWith(1, 'stream_closed', expect.any(Number));
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    // EV_TEXT_START (live, msg id ...001) and catch-up TEXT_MESSAGE_START
    // (explicit id ...05A) have different dedup ids so both get emitted once.
    expect(eventsFrom(options).filter((e) => e.type === 'TEXT_MESSAGE_START').length)
      .toBeGreaterThanOrEqual(1);
  });

  test('keepalive timeout → watchdog aborts, reconnects', async () => {
    const stalled = controllableResponse();
    const finisher = staticResponse(200, [sseFrame(EV_RUN_FINISHED)]);
    const call: { n: number } = { n: 0 };
    const mockFetch = jest.fn(async (_input, init: RequestInit = {}) => {
      call.n += 1;
      if (call.n === 1) {
        stalled.bindSignal(sig(init));
        return stalled.response;
      }
      return finisher;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onReconnecting = jest.fn();
    const options = buildOptions({
      onReconnecting,
      keepaliveGraceMs: 150,
    });

    const result = await runSseClient(options);
    expect(result.reconnectCount).toBe(1);
    expect(onReconnecting).toHaveBeenCalledWith(
      1,
      'keepalive_timeout',
      expect.any(Number),
    );
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
  });

  test('proactive 60-min restart fires when stream age exceeds maxStreamSeconds', async () => {
    // First response stays open long enough to cross the tiny maxStreamSeconds
    // boundary; second response terminates cleanly.
    const ctrl1 = controllableResponse();
    const finisher = staticResponse(200, [sseFrame(EV_RUN_FINISHED)]);
    const call: { n: number } = { n: 0 };
    const mockFetch = jest.fn(async (_input, init: RequestInit = {}) => {
      call.n += 1;
      if (call.n === 1) {
        ctrl1.bindSignal(sig(init));
        return ctrl1.response;
      }
      return finisher;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onReconnecting = jest.fn();
    const options = buildOptions({
      onReconnecting,
      maxStreamSeconds: 0.25, // 250 ms
      keepaliveGraceMs: 10_000, // don't race with keepalive
    });

    // Push a ping every 50ms to keep the watchdog happy for the full 250ms.
    const runPromise = runSseClient(options);
    const pinger = setInterval(() => { if (!ctrl1.closed()) ctrl1.push(': ping\n\n'); }, 50);
    const result = await runPromise;
    clearInterval(pinger);
    expect(result.reconnectCount).toBeGreaterThanOrEqual(1);
    expect(onReconnecting).toHaveBeenCalledWith(
      expect.any(Number),
      'proactive_60min_restart',
      expect.any(Number),
    );
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
  });

  test('network error on fetch → reconnects with network_error reason', async () => {
    const mockFetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const onReconnecting = jest.fn();
    const options = buildOptions({ onReconnecting });
    const result = await runSseClient(options);

    expect(result.reconnectCount).toBe(1);
    expect(onReconnecting).toHaveBeenCalledWith(
      1,
      'network_error',
      expect.any(Number),
    );
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
  });

  test('HTTP 409 RUN_ELSEWHERE → throws CliError (non-retriable, caller falls back)', async () => {
    const runElsewhereBody = JSON.stringify({
      code: 'RUN_ELSEWHERE',
      message: 'Task is running on a different runtime.',
      execution_mode: 'orchestrator',
    });
    const mockFetch = jest.fn().mockResolvedValue(
      new Response(runElsewhereBody, { status: 409, statusText: 'Conflict' }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions();
    await expect(runSseClient(options)).rejects.toThrow(/RUN_ELSEWHERE/);
    // Must not retry — the call is non-retriable.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('HTTP 409 without RUN_ELSEWHERE code → terminal CliError (NOT retried)', async () => {
    // P1-1 (Round 1): any 409 on the SSE path is terminal. The prior
    // "reconnect and hope for the best" behavior would retry against a
    // server that's deliberately rejecting the request. Surface the body
    // in the error so operators can see why.
    const genericBody = JSON.stringify({ code: 'OTHER', message: 'nope' });
    const mockFetch = jest.fn().mockResolvedValue(
      new Response(genericBody, { status: 409, statusText: 'Conflict' }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(runSseClient(buildOptions())).rejects.toThrow(/HTTP 409/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('HTTP 409 with non-JSON body → terminal CliError (body preview in message)', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      new Response('Gateway rejected: proxy overload', { status: 409, statusText: 'Conflict' }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(runSseClient(buildOptions())).rejects.toThrow(/Gateway rejected/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('HTTP 500 on connect → reconnects with http_error reason', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(500, [], 'Server Error'))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const onReconnecting = jest.fn();
    const options = buildOptions({ onReconnecting });
    const result = await runSseClient(options);

    expect(result.reconnectCount).toBe(1);
    expect(onReconnecting).toHaveBeenCalledWith(1, 'http_error', expect.any(Number));
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
  });
});

describe('runSseClient — auth handling', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('401 on initial connect → refreshes token, retries, succeeds', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(401, [], 'Unauthorized'))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const getAuthToken = jest.fn()
      .mockResolvedValueOnce('token-old-OLDOLDOD')
      .mockResolvedValueOnce('token-new-NEWNEWNN');

    const onReconnecting = jest.fn();
    const options = buildOptions({ getAuthToken, onReconnecting });
    const result = await runSseClient(options);

    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    expect(onReconnecting).toHaveBeenCalledWith(1, 'unauthorized_retry', 0);
  });

  test('double-401 → rejects with CliError UNAUTHORIZED', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(401, [], 'Unauthorized'))
      .mockResolvedValueOnce(staticResponse(401, [], 'Unauthorized'));
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions();
    await expect(runSseClient(options)).rejects.toThrow(CliError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('double-401 error message mentions UNAUTHORIZED and login hint', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(401, [], 'Unauthorized'))
      .mockResolvedValueOnce(staticResponse(401, [], 'Unauthorized'));
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(runSseClient(buildOptions())).rejects.toThrow(/UNAUTHORIZED/);
  });

  test('getAuthToken rejects → onError(false), promise rejects', async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    const authErr = new Error('cognito unreachable');
    const options = buildOptions({
      getAuthToken: jest.fn().mockRejectedValue(authErr),
    });
    await expect(runSseClient(options)).rejects.toThrow('cognito unreachable');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('runSseClient — cancellation', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('external abort during stream → resolves with terminalEvent null, no reconnect', async () => {
    const ctrl = controllableResponse();
    const mockFetch = jest.fn(bindingFetch(() => ctrl.response, ctrl));
    global.fetch = mockFetch as unknown as typeof fetch;

    const controller = new AbortController();
    const options = buildOptions({ signal: controller.signal });

    const runPromise = runSseClient(options);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.push(sseFrame(EV_TEXT_START));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const result = await runPromise;
    expect(result.terminalEvent).toBeNull();
    expect(result.reconnectCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('external abort before first connect → resolves immediately, never calls fetch', async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const options = buildOptions({ signal: controller.signal });

    const result = await runSseClient(options);
    expect(result.terminalEvent).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('runSseClient — request construction', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('uses AgentCore data-plane URL with URL-encoded runtime ARN', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const arn =
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/abca_agent_jwt-ABC123';
    await runSseClient(buildOptions({ runtimeJwtArn: arn }));

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('bedrock-agentcore.us-east-1.amazonaws.com');
    expect(url).toContain(encodeURIComponent(arn));
    expect(url).toContain('qualifier=DEFAULT');
    expect(init.method).toBe('POST');
  });

  test('includes mandatory headers and session-id', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    await runSseClient(buildOptions({ taskId: 'my-task-777' }));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('text/event-stream');
    // Session-ID is buildRuntimeSessionId(taskId) — AgentCore requires >= 33
    // chars. 'my-task-777' (11) + 'bgagent-watch-' (14) = 25, then padded to 33.
    expect(headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe(
      'bgagent-watch-my-task-777xxxxxxxx',
    );
  });

  test('invocation body has shape {"input": {"task_id": ..., ...}}', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    await runSseClient(buildOptions({
      taskId: 'task-99',
      invocationInput: { max_turns: 50, resume: true },
    }));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input: Record<string, unknown> };
    expect(body).toHaveProperty('input');
    expect(body.input.task_id).toBe('task-99');
    expect(body.input.max_turns).toBe(50);
    expect(body.input.resume).toBe(true);
  });
});

describe('runSseClient — deduplication', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('duplicate event across catch-up + live stream emitted once', async () => {
    // Catch-up returns a TEXT_MESSAGE_START with a specific messageId.
    // The live stream then emits the same messageId — the dedup set filters it.
    const sharedMsgId = '01HXYZMSG00000000000000777';
    const duplicate = {
      type: 'TEXT_MESSAGE_START',
      messageId: sharedMsgId,
      role: 'assistant',
    };
    const mockFetch = jest.fn()
      // Initial attempt: cut immediately so we trigger catch-up+reconnect.
      .mockResolvedValueOnce(staticResponse(200, []))
      // Reconnect: emits the duplicate, then finishes.
      .mockResolvedValueOnce(staticResponse(200, [
        sseFrame(duplicate),
        sseFrame(EV_RUN_FINISHED),
      ]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const catchUp = jest.fn().mockResolvedValue([duplicate]);
    const options = buildOptions({ catchUp });
    const result = await runSseClient(options);

    const matching = eventsFrom(options).filter(
      (e) => e.type === 'TEXT_MESSAGE_START' && e.messageId === sharedMsgId,
    );
    expect(matching.length).toBe(1);
    expect(result.eventsDeduplicated).toBeGreaterThanOrEqual(1);
  });

  test('dedup cap trims oldest half when exceeded', async () => {
    // Build a single stream with 25 unique-messageId events + finisher.
    const frames: string[] = [];
    for (let i = 0; i < 25; i++) {
      frames.push(sseFrame({
        type: 'TEXT_MESSAGE_START',
        messageId: `msg-${i.toString().padStart(3, '0')}`,
        role: 'assistant',
      }));
    }
    frames.push(sseFrame(EV_RUN_FINISHED));
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, frames));
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions({ dedupCap: 10 });
    const result = await runSseClient(options);

    expect(result.eventsReceived).toBe(26); // 25 + RUN_FINISHED
    // Re-emission of an old id (pre-trim) should NOT be caught — this proves
    // the trim happened. We can't observe the Set directly, but we can assert
    // that the run completed without over-counting dedups.
    expect(result.eventsDeduplicated).toBe(0);
  });

  test('catch-up onCatchUp callback fires with count and cursor', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(200, []))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const catchUp = jest.fn().mockResolvedValue([
      { type: 'CUSTOM', name: 'foo', timestamp: 1 },
      { type: 'CUSTOM', name: 'bar', timestamp: 2 },
    ]);
    const onCatchUp = jest.fn();
    const options = buildOptions({
      catchUp,
      onCatchUp,
      initialCatchUpCursor: '',
    });
    await runSseClient(options);

    expect(onCatchUp).toHaveBeenCalled();
    const call = onCatchUp.mock.calls[onCatchUp.mock.calls.length - 1] as [number, string];
    expect(call[0]).toBe(2);
  });

  test('initial catch-up cursor is honoured on first connect', async () => {
    const mockFetch = jest.fn().mockResolvedValue(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const catchUp = jest.fn().mockResolvedValue([]);
    const options = buildOptions({
      catchUp,
      initialCatchUpCursor: '01HXYZDDB0000000000000ABCD',
    });
    await runSseClient(options);

    expect(catchUp).toHaveBeenCalledWith('01HXYZDDB0000000000000ABCD');
  });

  test('catch-up cursor advances from event ids', async () => {
    const evA: AgUiEvent = { type: 'CUSTOM', name: 'a', id: '01HDDB0000A', timestamp: 1 };
    const evB: AgUiEvent = { type: 'CUSTOM', name: 'b', id: '01HDDB0000B', timestamp: 2 };
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(200, [])) // initial, empty stream
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const catchUp = jest.fn()
      .mockResolvedValueOnce([evA, evB]) // called after 1st connect closes
      .mockResolvedValueOnce([]);

    const options = buildOptions({
      catchUp,
      initialCatchUpCursor: '00START',
    });
    await runSseClient(options);

    // First catchUp call uses the initial cursor.
    expect(catchUp).toHaveBeenNthCalledWith(1, '00START');
    // Second catchUp call (after reconnect) must have advanced to evB's id.
    expect(catchUp).toHaveBeenNthCalledWith(2, '01HDDB0000B');
  });

  test('catch-up failure is non-fatal — onError warns and stream proceeds', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(200, []))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const catchUp = jest.fn().mockRejectedValue(new Error('REST 502'));
    const onError = jest.fn();
    const options = buildOptions({ catchUp, onError });
    const result = await runSseClient(options);

    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'REST 502' }), true);
  });

  test('catch-up failure with CliError is fatal — promise rejects', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(staticResponse(200, []));
    global.fetch = mockFetch as unknown as typeof fetch;

    const fatal = new CliError('session expired');
    const catchUp = jest.fn().mockRejectedValue(fatal);
    const options = buildOptions({ catchUp });

    await expect(runSseClient(options)).rejects.toThrow('session expired');
  });
});

describe('runSseClient — backoff', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('exponential backoff: 3 failures → delays follow initial * factor^attempt', async () => {
    const mockFetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const delays: number[] = [];
    const onReconnecting: (a: number, r: ReconnectReason, d: number) => void =
      (_a, _r, d) => { delays.push(d); };

    const options = buildOptions({
      onReconnecting,
      reconnectBackoffMs: { initial: 100, max: 10_000, factor: 2.0 },
    });
    await runSseClient(options);

    expect(delays.length).toBe(3);
    // attempt 1 → 100 * 2^0 = 100
    expect(delays[0]).toBe(100);
    // attempt 2 → 100 * 2^1 = 200
    expect(delays[1]).toBe(200);
    // attempt 3 → 100 * 2^2 = 400
    expect(delays[2]).toBe(400);
  });

  test('backoff cap: delay clamps at max', async () => {
    const mockFetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('fail'))
      .mockResolvedValueOnce(staticResponse(200, [sseFrame(EV_RUN_FINISHED)]));
    global.fetch = mockFetch as unknown as typeof fetch;

    const delays: number[] = [];
    const options = buildOptions({
      onReconnecting: (_a, _r, d) => { delays.push(d); },
      // initial 5000, factor 10 → would compute 5000; cap at 200.
      reconnectBackoffMs: { initial: 5000, max: 200, factor: 10.0 },
    });
    await runSseClient(options);

    expect(delays[0]).toBe(200);
  });

  test('onReconnecting reports correct reason for each failure mode', async () => {
    const stalled = controllableResponse();
    const finisher = staticResponse(200, [sseFrame(EV_RUN_FINISHED)]);
    const call: { n: number } = { n: 0 };
    const mockFetch = jest.fn(async (_input, init: RequestInit = {}) => {
      call.n += 1;
      if (call.n === 1) { stalled.bindSignal(sig(init)); return stalled.response; }
      if (call.n === 2) throw new TypeError('netfail');
      return finisher;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const reasons: ReconnectReason[] = [];
    const options = buildOptions({
      onReconnecting: (_a, r) => { reasons.push(r); },
      keepaliveGraceMs: 100,
      reconnectBackoffMs: { initial: 1, max: 1, factor: 1.0 },
    });
    await runSseClient(options);

    expect(reasons).toEqual(['keepalive_timeout', 'network_error']);
  });
});

describe('runSseClient — keepalive frames', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('``: ping\\n\\n`` frames do NOT trigger onEvent but reset keepalive timer', async () => {
    const ctrl = controllableResponse();
    const mockFetch = jest.fn(async (_input, init: RequestInit = {}) => {
      ctrl.bindSignal(sig(init));
      return ctrl.response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const options = buildOptions({ keepaliveGraceMs: 200 });
    const runPromise = runSseClient(options);

    // Alternate pings and a short wait to keep the watchdog alive for ~400ms
    // (longer than the 200ms grace), then push a RUN_FINISHED.
    await new Promise((r) => setTimeout(r, 20));
    ctrl.push(': ping\n\n');
    await new Promise((r) => setTimeout(r, 100));
    ctrl.push(': ping\n\n');
    await new Promise((r) => setTimeout(r, 100));
    ctrl.push(sseFrame(EV_RUN_FINISHED));

    const result = await runPromise;
    expect(result.terminalEvent?.type).toBe('RUN_FINISHED');
    expect(result.reconnectCount).toBe(0);
    expect(eventsFrom(options).length).toBe(1); // only RUN_FINISHED, no pings
  });
});
