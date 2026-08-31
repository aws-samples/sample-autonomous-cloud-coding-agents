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

import { logger } from '../../../src/handlers/shared/logger';

/** Capture the first JSON line written to a stream during `fn`. */
function captureLine(stream: 'stdout' | 'stderr', fn: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const spy = jest.spyOn(process[stream], 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe('logger', () => {
  test('info/warn write to stdout, error to stderr', () => {
    expect(captureLine('stdout', () => logger.info('hi')).level).toBe('INFO');
    expect(captureLine('stdout', () => logger.warn('hi')).level).toBe('WARN');
    expect(captureLine('stderr', () => logger.error('hi')).level).toBe('ERROR');
  });

  test('child merges persistent context into every line (correlation envelope)', () => {
    const log = logger.child({ task_id: 't-1', user_id: 'u-1', repo: 'o/r' });
    const line = captureLine('stdout', () => log.info('Session started', { session_id: 's-1' }));
    expect(line).toMatchObject({
      level: 'INFO',
      message: 'Session started',
      task_id: 't-1',
      user_id: 'u-1',
      repo: 'o/r',
      session_id: 's-1',
    });
  });

  test('per-call data wins over child context on key collision', () => {
    const log = logger.child({ task_id: 't-1', repo: 'o/r' });
    const line = captureLine('stdout', () => log.warn('override', { repo: 'other/repo' }));
    expect(line.repo).toBe('other/repo');
  });

  test('child is composable and does not mutate the base logger', () => {
    const withTask = logger.child({ task_id: 't-1' });
    const withUser = withTask.child({ user_id: 'u-1' });
    expect(captureLine('stdout', () => withUser.info('x'))).toMatchObject({ task_id: 't-1', user_id: 'u-1' });
    // Base logger stays context-free.
    expect(captureLine('stdout', () => logger.info('x')).task_id).toBeUndefined();
  });
});
