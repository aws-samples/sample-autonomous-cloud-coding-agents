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

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../../src/api-client';
import { makeReplayCommand } from '../../src/commands/replay';
import type { ReplayBundle } from '../../src/types';

jest.mock('../../src/api-client');

const BUNDLE: ReplayBundle = {
  task_id: 'abc',
  workflow_ref: 'coding/new-task-v1',
  resolved_workflow: { id: 'coding/new-task-v1', version: '1' },
  prompt_version: 'coding/new-task-v1@1',
  events: [
    { event_id: '01A', event_type: 'task_started', timestamp: '2026-01-01T00:00:00Z', metadata: {} },
  ],
  events_truncation: null,
  verification: { build_passed: true, lint_passed: false },
  trace_uri: null,
  otel_trace_id: 'aabbccddeeff00112233445566778899',
  session_id: 'sess-1',
  cost_usd: 0.05,
  collected_at: '2026-01-01T00:05:00Z',
};

describe('replay command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  let errSpy: jest.SpiedFunction<typeof console.error>;
  const mockGetReplay = jest.fn();

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    errSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGetReplay.mockReset();
    mockGetReplay.mockResolvedValue(BUNDLE);
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      getReplay: mockGetReplay,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    process.exitCode = undefined;
    consoleSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('prints a human-readable summary by default', async () => {
    await makeReplayCommand().parseAsync(['node', 'test', 'abc']);
    expect(mockGetReplay).toHaveBeenCalledWith('abc');
    const out = consoleSpy.mock.calls[0][0] as string;
    expect(out).toContain('Task:        abc');
    expect(out).toContain('Build:       PASSED');
    expect(out).toContain('Lint:        FAILED');
    expect(out).toContain('Events (1):');
    expect(out).toContain('task_started');
  });

  test('flags a truncated event list so the operator sees the clip', async () => {
    mockGetReplay.mockResolvedValue({
      ...BUNDLE,
      events_truncation: { reason: 'max_bytes', returned_events: 1 },
    });
    await makeReplayCommand().parseAsync(['node', 'test', 'abc']);
    const out = consoleSpy.mock.calls[0][0] as string;
    expect(out).toContain('Events (1, TRUNCATED):');
    expect(out).toContain('list clipped at the size cap');
    expect(out).toContain('bgagent events abc');
  });

  test('prints raw JSON with --json', async () => {
    await makeReplayCommand().parseAsync(['node', 'test', 'abc', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(BUNDLE, null, 2));
  });

  test('writes JSON to --output file and confirms on stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
    const file = join(dir, 'bundle.json');
    try {
      await makeReplayCommand().parseAsync(['node', 'test', 'abc', '--output', file]);
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(BUNDLE);
      // stdout stays clean; confirmation goes to stderr.
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(`Wrote replay bundle to ${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing --output file without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
    const file = join(dir, 'exists.json');
    try {
      // Pre-create the file.
      await makeReplayCommand().parseAsync(['node', 'test', 'abc', '--output', file]);
      mockGetReplay.mockClear();
      await expect(
        makeReplayCommand().parseAsync(['node', 'test', 'abc', '--output', file]),
      ).rejects.toThrow(/Refusing to overwrite/);
      // The refusal short-circuits before the network call.
      expect(mockGetReplay).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
