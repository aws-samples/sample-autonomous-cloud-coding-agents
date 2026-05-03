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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ApiClient } from '../../src/api-client';
import { makeTraceCommand } from '../../src/commands/trace';
import { ApiError } from '../../src/errors';

jest.mock('../../src/api-client');

function mockApiClientWith(getTraceUrl: jest.Mock): void {
  (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(
    () =>
      ({
        createTask: jest.fn(),
        listTasks: jest.fn(),
        getTask: jest.fn(),
        cancelTask: jest.fn(),
        nudgeTask: jest.fn(),
        getTaskEvents: jest.fn(),
        getStatusSnapshot: jest.fn(),
        catchUpEvents: jest.fn(),
        getTraceUrl,
        createWebhook: jest.fn(),
        listWebhooks: jest.fn(),
        revokeWebhook: jest.fn(),
      }) as unknown as ApiClient,
  );
}

/** Build a fetch response whose ``body`` is a WHATWG ReadableStream of *bytes*. */
function makeFetchResponse(ok: boolean, status: number, statusText: string, bytes?: Uint8Array): Response {
  const body = bytes !== undefined
    ? new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    })
    : null;
  return { ok, status, statusText, body } as unknown as Response;
}

describe('trace download command', () => {
  const originalFetch = global.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('writes raw gzipped bytes to -o <file>', async () => {
    const payload = gzipSync(Buffer.from('{"event":"TURN","turn":1}\n', 'utf-8'));
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(true, 200, 'OK', payload)) as typeof global.fetch;

    const outFile = join(tmpDir, 'trace.jsonl.gz');
    const consoleErr = jest.spyOn(console, 'error').mockImplementation();
    try {
      const cmd = makeTraceCommand();
      await cmd.parseAsync(['node', 'test', 'download', 'task-1', '-o', outFile]);

      // File exists and contains the raw gzipped payload exactly.
      const written = readFileSync(outFile);
      expect(Buffer.compare(written, payload)).toBe(0);
      // Status message goes to stderr (not stdout).
      expect(consoleErr).toHaveBeenCalledWith(`Wrote ${outFile}`);
    } finally {
      consoleErr.mockRestore();
    }

    expect(getTraceUrl).toHaveBeenCalledWith('task-1');
    // L3 item 1: fetch is invoked with an AbortSignal for timeout / SIGINT.
    expect(global.fetch).toHaveBeenCalledWith(
      'https://s3.example/trace?sig=abc',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test('streams gunzipped JSONL to stdout by default', async () => {
    const jsonl = '{"event":"TURN","turn":1}\n{"event":"TURN","turn":2}\n';
    const payload = gzipSync(Buffer.from(jsonl, 'utf-8'));
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(true, 200, 'OK', payload)) as typeof global.fetch;

    // Capture writes to process.stdout rather than the inherited FD.
    const written: Buffer[] = [];
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    }) as typeof process.stdout.write);

    try {
      const cmd = makeTraceCommand();
      await cmd.parseAsync(['node', 'test', 'download', 'task-1']);
    } finally {
      writeSpy.mockRestore();
    }

    const actual = Buffer.concat(written).toString('utf-8');
    expect(actual).toBe(jsonl);
  });

  test('friendly 404 message when TRACE_NOT_AVAILABLE', async () => {
    const getTraceUrl = jest.fn().mockRejectedValue(
      new ApiError(404, 'TRACE_NOT_AVAILABLE', 'Task did not run with --trace.', 'req-1'),
    );
    mockApiClientWith(getTraceUrl);
    global.fetch = jest.fn() as typeof global.fetch;

    const cmd = makeTraceCommand();
    await expect(cmd.parseAsync(['node', 'test', 'download', 'task-nope'])).rejects.toThrow(
      /No trace artifact for task task-nope/,
    );
    // Should NOT have attempted to fetch the S3 URL when the API returned 404.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('propagates non-404 API errors without reframing', async () => {
    const getTraceUrl = jest.fn().mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', 'You do not have access to this task.', 'req-2'),
    );
    mockApiClientWith(getTraceUrl);
    global.fetch = jest.fn() as typeof global.fetch;

    const cmd = makeTraceCommand();
    await expect(cmd.parseAsync(['node', 'test', 'download', 'task-x'])).rejects.toThrow(
      /You do not have access/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('surfaces expired-URL 403 from S3 with actionable hint', async () => {
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/expired?sig=stale',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);
    global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(false, 403, 'Forbidden')) as typeof global.fetch;

    const cmd = makeTraceCommand();
    await expect(cmd.parseAsync(['node', 'test', 'download', 'task-1'])).rejects.toThrow(
      /S3 download failed: HTTP 403[^\n]*15-minute TTL/,
    );
  });

  test('rejects with CliError "corrupt or not gzipped" when stdout pipeline hits bad bytes (L3 item 1)', async () => {
    // Bytes are NOT a valid gzip stream (magic number 0x1f 0x8b is missing).
    // The default (no ``-o``) path pipes through ``createGunzip()``; L3
    // wraps the raw zlib ``Z_DATA_ERROR`` in a ``CliError`` that names
    // the real cause (corrupt / not gzipped) rather than surfacing an
    // internal stack that looks like a CLI bug.
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse(true, 200, 'OK', junk),
    ) as typeof global.fetch;

    // Silence the stdout writes the pipeline attempts before rejecting.
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as typeof process.stdout.write);

    try {
      const cmd = makeTraceCommand();
      await expect(cmd.parseAsync(['node', 'test', 'download', 'task-1'])).rejects.toThrow(
        /corrupt or not gzipped/,
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  test('AbortController aborts the fetch when the 2-minute timeout expires (L3 item 1)', async () => {
    // Use fake timers so we can advance past the 2-minute wall clock
    // without the Jest suite sleeping for 2 real minutes. The fetch
    // mock returns a promise that only rejects when the AbortSignal
    // fires — mirroring undici's behavior on a stalled S3 stream.
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    // Fake timers must be installed BEFORE the action runs so the
    // setTimeout in the handler uses the fake clock.
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          // Reject on abort so the action's AbortError handler runs.
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The user aborted a request.');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }) as unknown as Promise<Response>;
      }) as typeof global.fetch;

      const cmd = makeTraceCommand();
      // Attach a catch handler BEFORE advancing timers so the rejection
      // is never observed as unhandled (which Jest would treat as a
      // test failure even if the final assertion also matches).
      const done = cmd.parseAsync(['node', 'test', 'download', 'task-1']);
      const assertion = expect(done).rejects.toThrow(/timed out after 2 minutes/);

      // Fast-forward past the 2-minute timeout. The in-action timer
      // will fire and abort the AbortController.
      await jest.advanceTimersByTimeAsync(121_000);

      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  test('SIGINT during fetch aborts the download and cleans up the listener (L3 item 1)', async () => {
    // Verify both the listener attach/detach contract AND that a SIGINT
    // actually cancels the pending fetch. Fake timers prevent the
    // 2-minute watchdog from racing the SIGINT signal.
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    // Track SIGINT listener count to confirm the action both adds (1)
    // and removes (0) its handler on completion.
    const listenersBefore = process.listenerCount('SIGINT');

    jest.useFakeTimers();
    try {
      let sigintListenerAttached = false;
      global.fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
        sigintListenerAttached = process.listenerCount('SIGINT') > listenersBefore;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The user aborted a request.');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
          // Simulate the user hitting Ctrl+C shortly after fetch starts.
          // ``process.emit('SIGINT')`` triggers the action's handler
          // which calls ac.abort().
          setImmediate(() => process.emit('SIGINT' as never));
        }) as unknown as Promise<Response>;
      }) as typeof global.fetch;

      const cmd = makeTraceCommand();
      const done = cmd.parseAsync(['node', 'test', 'download', 'task-1']);
      // Drain any pending setImmediate / microtasks.
      await Promise.resolve();
      jest.runOnlyPendingTimers();

      await expect(done).rejects.toThrow(/Cancelled by user|aborted/);
      expect(sigintListenerAttached).toBe(true);
      // Listener must be detached on both success and error paths.
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects when S3 response has no body', async () => {
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/weird',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);
    global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(true, 200, 'OK')) as typeof global.fetch;

    const cmd = makeTraceCommand();
    await expect(cmd.parseAsync(['node', 'test', 'download', 'task-1'])).rejects.toThrow(
      /S3 response had no body/,
    );
  });
});
