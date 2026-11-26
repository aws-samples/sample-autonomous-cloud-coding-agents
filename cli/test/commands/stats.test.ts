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
import { makeStatsCommand } from '../../src/commands/stats';
import { ApiError } from '../../src/errors';
import { formatScoreboard } from '../../src/scoreboard';
import type { Scoreboard, ScoreboardPeriod } from '../../src/types';

jest.mock('../../src/api-client');

const PERIOD: ScoreboardPeriod = {
  from: '2026-11-13T12:00:00.000Z',
  to: '2026-11-20T12:00:00.000Z',
  finished: 1,
  outcomes: { verified_pr: 1, unverified_pr: 0, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 },
  time_to_verified_pr_s: { p50: 1440, p90: 1440, count: 1 },
  wait_p50_s: 41,
  queued: { count: 0, total: 1 },
  verified: { count: 1, total: 1 },
  not_reworked: { count: 1, total: 1 },
  untouched: { count: 1, total: 1 },
  touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 },
  spend_usd: 3.5,
  uncosted: 0,
  guardrail_stops: { count: 0, task_ids: [] },
  blanket_approvals: { count: 0, task_ids: [] },
  gated: { count: 0, total: 1 },
  pull_requests: { merged: 0, closed: 0, open: 0, unread: 1 },
  merged_clean: { count: 0, total: 0 },
  time_to_merge_s: null,
  first_review_s: null,
};

const BOARD: Scoreboard = { range: '7d', truncated: false, current: PERIOD, previous: null, open_over_7d: null };

describe('stats command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockGetScoreboard = jest.fn();

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockGetScoreboard.mockReset().mockResolvedValue(BOARD);
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      getScoreboard: mockGetScoreboard,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  test('asks for the last 30 days of every repository, and prints the scoreboard as text', async () => {
    await makeStatsCommand().parseAsync(['node', 'test']);

    expect(mockGetScoreboard).toHaveBeenCalledWith({ range: '30d', repo: undefined });
    expect(consoleSpy.mock.calls).toEqual([[formatScoreboard(BOARD)]]);
  });

  test('passes --range and --repo to the API, and names the repository in the text', async () => {
    await makeStatsCommand().parseAsync(['node', 'test', '--range', '7d', '--repo', 'acme/shop']);

    expect(mockGetScoreboard).toHaveBeenCalledWith({ range: '7d', repo: 'acme/shop' });
    expect(consoleSpy.mock.calls).toEqual([[formatScoreboard(BOARD, 'acme/shop')]]);
  });

  test('prints the response as the API gives it with --output json', async () => {
    await makeStatsCommand().parseAsync(['node', 'test', '--repo', 'acme/shop', '--output', 'json']);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual(BOARD);
  });

  test('refuses a range the API does not serve, before any request', async () => {
    await expect(makeStatsCommand().parseAsync(['node', 'test', '--range', '14d'])).rejects.toMatchObject({
      name: 'CliError',
      message: '--range must be 7d or 30d.',
    });
    expect(mockGetScoreboard).not.toHaveBeenCalled();
  });

  test('leaves a refusal by the API to the entry point, and prints nothing', async () => {
    const refusal = new ApiError(400, 'VALIDATION_ERROR', 'Invalid repo value. Expected "owner/name". (VALIDATION_ERROR)', 'req-1');
    mockGetScoreboard.mockRejectedValue(refusal);

    await expect(makeStatsCommand().parseAsync(['node', 'test', '--repo', 'shop'])).rejects.toBe(refusal);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  describe('against a stack that was deployed before the scoreboard', () => {
    const olderStack = {
      name: 'CliError',
      message: 'This stack does not serve the scoreboard: it was deployed before `bgagent stats` existed. Redeploy the stack, then run the command again.',
    };

    test('says so when the stack refuses the view, in words about a parameter nobody typed', async () => {
      mockGetScoreboard.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Invalid view value. Expected "budget". (VALIDATION_ERROR)', 'req-1'));

      await expect(makeStatsCommand().parseAsync(['node', 'test'])).rejects.toMatchObject(olderStack);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    test.each([
      ['a page of tasks', [{ task_id: '01KA4AGC0000000000000000B2', status: 'RUNNING' }]],
      ['nothing', undefined],
    ])('says so, and prints nothing, when the answer is %s', async (_case, answer) => {
      mockGetScoreboard.mockResolvedValue(answer);

      await expect(makeStatsCommand().parseAsync(['node', 'test', '--output', 'json'])).rejects.toMatchObject(olderStack);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });
});
