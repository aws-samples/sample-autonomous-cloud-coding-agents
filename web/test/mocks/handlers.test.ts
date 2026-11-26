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
import type { Scoreboard } from '../../src/core/api/types';
import { buildFixtures, mockScoreboard } from '../../src/mocks/fixtures';
import { TEST_API_BASE } from '../helpers/server';

const DAY_MS = 86_400_000;

describe('mock API handlers', () => {
  it('rejects requests without a token like the Cognito authorizer', async () => {
    const res = await fetch(`${TEST_API_BASE}/tasks`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it.each(['0', '101', 'abc'])('rejects limit=%s', async (limit) => {
    const res = await fetch(`${TEST_API_BASE}/tasks?limit=${limit}`, { headers: { Authorization: 't' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 404 for events of an unknown task', async () => {
    const res = await fetch(`${TEST_API_BASE}/tasks/nope/events`, { headers: { Authorization: 't' } });
    expect(res.status).toBe(404);
  });

  it.each([
    ['?view=scoreboard', '30d', 30],
    ['?view=scoreboard&range=30d', '30d', 30],
    ['?view=scoreboard&range=7d', '7d', 7],
  ])('answers /tasks%s with the scoreboard of that range and the period before it', async (query, range, days) => {
    const res = await fetch(`${TEST_API_BASE}/tasks${query}`, { headers: { Authorization: 't' } });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Scoreboard };
    expect(data.range).toBe(range);
    expect(Date.parse(data.current.to) - Date.parse(data.current.from)).toBe(days * DAY_MS);
    expect(data.previous).toMatchObject({ from: new Date(Date.parse(data.current.from) - days * DAY_MS).toISOString(), to: data.current.from });
  });

  it.each([
    ['?view=scoreboard&range=90d', 'Invalid range value. Expected "7d" or "30d".'],
    ['?view=scoreboard&range=', 'Invalid range value. Expected "7d" or "30d".'],
    ['?view=costs', 'Invalid view value. Expected "budget" or "scoreboard".'],
    ['?view=', 'Invalid view value. Expected "budget" or "scoreboard".'],
  ])('rejects /tasks%s with the message of the API', async (query, message) => {
    const res = await fetch(`${TEST_API_BASE}/tasks${query}`, { headers: { Authorization: 't' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message, request_id: 'mock-request' } });
  });
});

describe('mock tasks', () => {
  it('have a cost only once they have finished, and none when they were cancelled or ran out of time', () => {
    const { tasks } = buildFixtures(new Date(), { history: true });
    expect([...new Set(tasks.filter((task) => task.cost_usd !== null).map((task) => task.status))].sort()).toEqual(['COMPLETED', 'FAILED']);
    expect(tasks.filter((task) => task.status === 'CANCELLED').length).toBeGreaterThan(1);
  });
});

describe('mock scoreboard', () => {
  it.each(['30d', '7d'] as const)('puts every new pull request of the %s sample in one of the four states, in both periods', (range) => {
    const { current, previous } = mockScoreboard(range, new Date());
    const periods = [current, previous].filter((period) => period !== null);
    expect(periods).toHaveLength(2);
    for (const { pull_requests: { merged, closed, open, unread }, outcomes, merged_clean: clean } of periods) {
      expect(merged + closed + open + unread).toBe(outcomes.verified_pr + outcomes.unverified_pr);
      expect(clean.total).toBe(merged);
    }
  });

  it('gives no count of the pull requests that wait only where the API would give none: the week before has some, all unread', () => {
    const { previous, open_over_7d: waiting } = mockScoreboard('7d', new Date());
    expect(waiting).toBeNull();
    expect(previous?.pull_requests).toEqual({ merged: 0, closed: 0, open: 0, unread: 1 });
  });
});
