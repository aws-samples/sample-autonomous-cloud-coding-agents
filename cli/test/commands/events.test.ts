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

import { ApiClient } from '../../src/api-client';
import { makeEventsCommand } from '../../src/commands/events';

jest.mock('../../src/api-client');

describe('events command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockGetTaskEvents = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockGetTaskEvents.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      getTaskEvents: mockGetTaskEvents,
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('shows events for a task', async () => {
    mockGetTaskEvents.mockResolvedValue({
      data: [{
        event_id: 'evt-1',
        event_type: 'TASK_SUBMITTED',
        timestamp: '2026-01-01T00:00:00Z',
        metadata: {},
      }],
      pagination: { next_token: null, has_more: false },
    });

    const cmd = makeEventsCommand();
    await cmd.parseAsync(['node', 'test', 'abc']);

    expect(mockGetTaskEvents).toHaveBeenCalledWith('abc', { limit: undefined });
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('TASK_SUBMITTED');
  });

  test('passes limit option', async () => {
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });

    const cmd = makeEventsCommand();
    await cmd.parseAsync(['node', 'test', 'abc', '--limit', '5']);

    expect(mockGetTaskEvents).toHaveBeenCalledWith('abc', { limit: 5 });
  });

  test('outputs JSON when --output json', async () => {
    const response = {
      data: [{ event_id: 'evt-1', event_type: 'TASK_SUBMITTED', timestamp: '2026-01-01T00:00:00Z', metadata: {} }],
      pagination: { next_token: null, has_more: false },
    };
    mockGetTaskEvents.mockResolvedValue(response);

    const cmd = makeEventsCommand();
    await cmd.parseAsync(['node', 'test', 'abc', '--output', 'json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(response, null, 2));
  });
});
