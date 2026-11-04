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

import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../src/core/api/client';
import type { TaskEvent } from '../../../src/core/api/types';
import { loadTaskEvents, MAX_TASK_EVENTS } from '../../../src/domains/tasks/hooks';

const event = (n: number): TaskEvent => ({ event_id: `e${String(n).padStart(5, '0')}`, event_type: 'agent_turn', timestamp: `t${n}`, metadata: {} });

/** An events API over `stored`, paging like the real one; records each call's parameters. */
function fakeApi(stored: TaskEvent[]) {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    async listTaskEvents(_taskId: string, params: { limit?: number; nextToken?: string; after?: string } = {}) {
      calls.push({ ...params });
      const limit = params.limit ?? 50;
      const from = params.after ? stored.findIndex((e) => e.event_id > params.after!) : Number(params.nextToken ?? 0);
      const start = from < 0 ? stored.length : from;
      const data = stored.slice(start, start + limit);
      const more = start + limit < stored.length;
      return { data, pagination: { has_more: more, next_token: more ? String(start + limit) : null } };
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('loadTaskEvents', () => {
  it('walks every page on the first load', async () => {
    const stored = Array.from({ length: 283 }, (_, i) => event(i));
    const { api, calls } = fakeApi(stored);
    const log = await loadTaskEvents(api, 't', undefined);
    expect(log.events).toHaveLength(283);
    expect(log.truncated).toBe(false);
    expect(calls.map((c) => c.nextToken ?? null)).toEqual([null, '100', '200']);
  });

  it('then fetches only what is new, re-reading a small overlap', async () => {
    const stored = Array.from({ length: 150 }, (_, i) => event(i));
    const { api, calls } = fakeApi(stored);
    const first = await loadTaskEvents(api, 't', undefined);
    stored.push(event(150), event(151));
    calls.length = 0;
    const next = await loadTaskEvents(api, 't', first);
    expect(calls).toEqual([{ limit: 100, after: 'e00130' }]);
    expect(next.events.map((e) => e.event_id).slice(-3)).toEqual(['e00149', 'e00150', 'e00151']);
    expect(next.events).toHaveLength(152);
  });

  it('starts over while the history is shorter than the overlap', async () => {
    const stored = [event(0), event(1)];
    const { api, calls } = fakeApi(stored);
    const first = await loadTaskEvents(api, 't', undefined);
    await loadTaskEvents(api, 't', first);
    expect(calls.at(-1)).toEqual({ limit: 100 });
  });

  it('stops at the cap and keeps the capped history from then on', async () => {
    const stored = Array.from({ length: MAX_TASK_EVENTS + 150 }, (_, i) => event(i));
    const { api, calls } = fakeApi(stored);
    const log = await loadTaskEvents(api, 't', undefined);
    expect(log.truncated).toBe(true);
    expect(log.events).toHaveLength(MAX_TASK_EVENTS);
    calls.length = 0;
    expect(await loadTaskEvents(api, 't', log)).toBe(log);
    expect(calls).toHaveLength(0);
  });
});
