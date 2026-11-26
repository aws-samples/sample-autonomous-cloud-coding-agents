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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

      const written = readFileSync(outFile);
      expect(Buffer.compare(written, payload)).toBe(0);
      expect(consoleErr).toHaveBeenCalledWith(`Wrote ${outFile}`);
    } finally {
      consoleErr.mockRestore();
    }

    expect(getTraceUrl).toHaveBeenCalledWith('task-1');
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
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    global.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse(true, 200, 'OK', junk),
    ) as typeof global.fetch;

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
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

    jest.useFakeTimers();
    try {
      global.fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The user aborted a request.');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }) as unknown as Promise<Response>;
      }) as typeof global.fetch;

      const cmd = makeTraceCommand();
      const done = cmd.parseAsync(['node', 'test', 'download', 'task-1']);
      // eslint-disable-next-line jest/valid-expect -- handler attached before the timers advance, awaited below
      const assertion = expect(done).rejects.toThrow(/timed out after 2 minutes/);

      await jest.advanceTimersByTimeAsync(121_000);

      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  test('SIGINT during fetch aborts the download and cleans up the listener (L3 item 1)', async () => {
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);

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
          setImmediate(() => process.emit('SIGINT' as never));
        }) as unknown as Promise<Response>;
      }) as typeof global.fetch;

      const cmd = makeTraceCommand();
      const done = cmd.parseAsync(['node', 'test', 'download', 'task-1']);
      await Promise.resolve();
      jest.runOnlyPendingTimers();

      await expect(done).rejects.toThrow(/Cancelled by user|aborted/);
      expect(sigintListenerAttached).toBe(true);
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  test('refuses to overwrite existing -o <file> without --force (L4 item 2)', async () => {
    const outFile = join(tmpDir, 'existing.jsonl.gz');
    writeFileSync(outFile, Buffer.from('keep-me'));

    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);
    global.fetch = jest.fn() as typeof global.fetch;

    const cmd = makeTraceCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'download', 'task-1', '-o', outFile]),
    ).rejects.toThrow(/Refusing to overwrite/);

    expect(readFileSync(outFile).toString()).toBe('keep-me');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getTraceUrl).not.toHaveBeenCalled();
  });

  test('overwrites existing -o <file> with --force (L4 item 2)', async () => {
    const outFile = join(tmpDir, 'existing.jsonl.gz');
    writeFileSync(outFile, Buffer.from('old-content'));

    const payload = gzipSync(Buffer.from('{"event":"TURN","turn":7}\n', 'utf-8'));
    const getTraceUrl = jest.fn().mockResolvedValue({
      url: 'https://s3.example/trace?sig=abc',
      expires_at: '2026-04-30T20:00:00Z',
    });
    mockApiClientWith(getTraceUrl);
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeFetchResponse(true, 200, 'OK', payload)) as typeof global.fetch;

    const consoleErr = jest.spyOn(console, 'error').mockImplementation();
    try {
      const cmd = makeTraceCommand();
      await cmd.parseAsync(['node', 'test', 'download', 'task-1', '-o', outFile, '--force']);

      const written = readFileSync(outFile);
      expect(Buffer.compare(written, payload)).toBe(0);
      expect(consoleErr).toHaveBeenCalledWith(`Wrote ${outFile}`);
    } finally {
      consoleErr.mockRestore();
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
