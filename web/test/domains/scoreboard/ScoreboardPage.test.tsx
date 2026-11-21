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

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scoreboard, ScoreboardPeriod, ScoreboardRange } from '../../../src/core/api/types';
import { aboutLabel, formatTimestamp } from '../../../src/core/util/format';
import { SECTIONS } from '../../../src/core/util/scoreboard';
import { MOCK_IDS, mockScoreboard } from '../../../src/mocks/fixtures';
import { bubbleText } from '../../helpers/explanations';
import { renderRoute } from '../../helpers/render';
import { server, TEST_API_BASE } from '../../helpers/server';

const TILE_COUNT = SECTIONS.flatMap((section) => section.tiles).length;

const isScoreboard = (request: Request, range?: ScoreboardRange) => {
  const params = new URL(request.url).searchParams;
  return params.get('view') === 'scoreboard' && (!range || params.get('range') === range);
};

/** Answers the scoreboard request with the mock API's numbers for the range it asks for, changed by `change`. */
function serveChanged(change: (board: Scoreboard) => Scoreboard): void {
  server.use(http.get(`${TEST_API_BASE}/tasks`, ({ request }) => (isScoreboard(request)
    ? HttpResponse.json({ data: change(mockScoreboard(isScoreboard(request, '7d') ? '7d' : '30d', new Date())) })
    : undefined)));
}

/** Holds the scoreboard request (of one range, or of any) until the returned function is called; the mock API then answers it. */
function holdScoreboard(range?: ScoreboardRange): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(http.get(`${TEST_API_BASE}/tasks`, async ({ request }) => {
    if (isScoreboard(request, range)) await held;
    return undefined;
  }));
  return release;
}

/** The period with no task finished in it: every count at zero, every fraction and duration without a value. */
function emptied(period: ScoreboardPeriod): ScoreboardPeriod {
  const none = { count: 0, total: 0 };
  const noTask = { count: 0, task_ids: [] };
  return {
    from: period.from,
    to: period.to,
    finished: 0,
    outcomes: { verified_pr: 0, unverified_pr: 0, no_new_pr: 0, failed: 0, cancelled: 0, timed_out: 0 },
    time_to_verified_pr_s: null,
    wait_p50_s: null,
    queued: none,
    verified: none,
    not_reworked: none,
    untouched: none,
    touchpoints: { approve: 0, clarify: 0, follow_up: 0, cancel: 0 },
    spend_usd: 0,
    uncosted: 0,
    guardrail_stops: noTask,
    blanket_approvals: noTask,
    gated: none,
    pull_requests: { merged: 0, closed: 0, open: 0, unread: 0 },
    merged_clean: none,
    time_to_merge_s: null,
    first_review_s: null,
  };
}

const boom = () => HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Boom.', request_id: 'req-9' } }, { status: 500 });

const PREVIOUS_LINE = /days before$/;

/** Between the two units of a duration. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/** The section headings of the page; the side navigation has a heading of the same level. */
const sectionHeadings = () => screen.queryAllByRole('heading', { level: 2 })
  .filter((heading) => !heading.closest('nav'))
  .map((heading) => heading.textContent);

describe('ScoreboardPage', () => {
  afterEach(() => {
    vi.useRealTimers();
    // The shell keeps the colour mode there; the setup clears sessionStorage only.
    localStorage.clear();
  });

  it('shows the last 30 days by default: the four headings, and each tile under its name with the counts behind it', async () => {
    renderRoute('/scoreboard');
    const verified = await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' });
    expect(within(verified).getByText('26 of 37 tasks that asked for a new pull request')).toBeInTheDocument();
    for (const name of [
      'Time to verified pull request: 24m',
      `Time to merged pull request: 1d${NO_BREAK_SPACE}3h`,
      'Waited in line: 8%',
      'Pull requests open for more than 7 days: 2',
      'Merged, so far: 74%',
      'Merged without being sent back: 85%',
      'Not reworked through ABCA, so far: 79%',
      'Verified pull request with no stop for a person: 62%',
      'Human touchpoints per verified pull request: 1.4',
      'Spend per verified pull request: $4.12',
      'Stopped by a guardrail: 0',
      'Held for approval: 7%',
      'Started with blanket approval: 3',
    ]) {
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
    }
    expect(sectionHeadings()).toEqual(['Speed', 'Quality', 'Leverage', 'Trust', 'Tasks finished']);
    expect(screen.getByText('How long it takes.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^52 tasks finished in the last 30 days: 37 asked for a new pull request, 26 delivered a verified one\./);
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/^Not measured by ABCA: the hours people spent/)).toBeInTheDocument();
    // Under the numbers: whose they are, how a period and its spend differ from the Costs page's, and where every user's are.
    expect(screen.getByText('These numbers cover your own tasks. A period is 7 or 30 times 24 hours back from now and its spend is that of the'
      + ' tasks that write code, while the Costs page adds every task over whole UTC days, so the same range can show a different spend there.'
      + ' Numbers for every user are on the CloudWatch dashboard, in the "Factory scoreboard" row.')).toBeInTheDocument();
    // How far the page sees: said under its title, and where the first section ends.
    expect(screen.getByText(/ Your own tasks, up to the merge\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^Not measured by ABCA: deploy, .* The last thing ABCA sees is the merge\.$/)).toBeInTheDocument();
  });

  it('sets seven tiles against the period before, each in its own form', async () => {
    renderRoute('/scoreboard');
    await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' });
    const lines = [
      ['Time to verified pull request: 24m', '31m in the 30 days before'],
      // A text is matched with its white space normalized, the no-break space too; a name is matched as it is.
      [`Time to merged pull request: 1d${NO_BREAK_SPACE}3h`, '1d 9h in the 30 days before'],
      ['Ended in a verified pull request: 70%', '62% (18 of 29) in the 30 days before'],
      ['Merged, so far: 74%', '71% (15 of 21) in the 30 days before'],
      ['Verified pull request with no stop for a person: 62%', '55% (16 of 29) in the 30 days before'],
      ['Human touchpoints per verified pull request: 1.4', '1.6 in the 30 days before'],
      ['Spend per verified pull request: $4.12', '$4.51 in the 30 days before'],
    ];
    for (const [name, line] of lines) {
      expect(within(screen.getByRole('group', { name })).getByText(line)).toBeInTheDocument();
    }
    expect(screen.getAllByText(PREVIOUS_LINE)).toHaveLength(lines.length);
  });

  it('takes the range from the URL; a week without a verified pull request says why a number is missing', async () => {
    renderRoute('/scoreboard?range=7d');
    const spend = await screen.findByRole('group', { name: 'Spend per verified pull request: no data' });
    expect(within(spend).getByText('-')).toBeInTheDocument();
    expect(within(spend).getByText('No verified pull request in this period. $12.40 spent on 6 tasks that write code and started. 1 has no recorded cost.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Time to verified pull request: no data' })).toBeInTheDocument();
    // ABCA has read neither of the week's two pull requests on GitHub: the three numbers over the merged ones say so, not that none is merged.
    for (const name of ['Time to merged pull request: no data', 'Merged, so far: no data', 'Merged without being sent back: no data']) {
      const unread = screen.getByRole('group', { name });
      expect(within(unread).getByText('-')).toBeInTheDocument();
      expect(within(unread).getByText('ABCA has not read the 2 new pull requests of this period on GitHub.')).toBeInTheDocument();
    }
    // Nor the one of the week before, the only one old enough to wait: the API gives no count, and the tile no task.
    const waiting = screen.getByRole('group', { name: 'Pull requests open for more than 7 days: no data' });
    expect(within(waiting).getByText('-')).toBeInTheDocument();
    expect(within(waiting).getByText('ABCA has not read these pull requests on GitHub.')).toBeInTheDocument();
    expect(within(waiting).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Not reworked through ABCA, so far: 100%' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Stopped by a guardrail: 0' })).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^8 tasks finished in the last 7 days/);
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    // One task of the week before asked for a pull request: only the two shares over such tasks are set against it.
    for (const name of ['Ended in a verified pull request: 0%', 'Verified pull request with no stop for a person: 0%']) {
      expect(within(screen.getByRole('group', { name })).getByText('0% (0 of 1) in the 7 days before')).toBeInTheDocument();
    }
    expect(screen.getAllByText(PREVIOUS_LINE)).toHaveLength(2);
  });

  it('falls back to 30 days for a range it does not know', async () => {
    renderRoute('/scoreboard?range=year');
    expect(await screen.findByText(/^52 tasks finished in the last 30 days/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the numbers on screen, dimmed, while another range loads, says that it loads, and puts the range in the URL', async () => {
    const release = holdScoreboard('7d');
    const { router } = renderRoute('/scoreboard');
    const body = (await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' })).closest('[aria-busy]');
    expect(body).toHaveAttribute('aria-busy', 'false');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^52 tasks finished in the last 30 days/);

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(body).toHaveAttribute('aria-busy', 'true'));
    expect(body).toHaveStyle({ opacity: '0.5' });
    expect(router.state.location.search).toBe('?range=7d');
    expect(router.state.historyAction).toBe('REPLACE');
    // Still the numbers of the month. What says so is outside the dimmed part, where it is announced.
    expect(screen.getByRole('group', { name: 'Ended in a verified pull request: 70%' })).toBeInTheDocument();
    expect(status).toHaveTextContent(/^Loading the scoreboard$/);
    expect(body).not.toContainElement(status);

    release();
    expect(await screen.findByRole('group', { name: 'Ended in a verified pull request: 0%' })).toBeInTheDocument();
    expect(body).toHaveAttribute('aria-busy', 'false');
    expect(body).toHaveStyle({ opacity: '1' });
    expect(status).toHaveTextContent(/^8 tasks finished in the last 7 days/);
  });

  it('shows the error in place of the dimmed numbers when the other range cannot be read', async () => {
    server.use(http.get(`${TEST_API_BASE}/tasks`, ({ request }) => (isScoreboard(request, '7d') ? boom() : undefined)));
    renderRoute('/scoreboard');
    await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' });

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    expect(await screen.findByText('Could not load the scoreboard')).toBeInTheDocument();
    expect(screen.getByText('Boom. (INTERNAL_ERROR, request req-9)')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Ended in a verified pull request/ })).not.toBeInTheDocument();
    expect(sectionHeadings()).toEqual([]);
  });

  it('reads the numbers again after five minutes', async () => {
    // Only the interval clock is in the test's hands; it still runs on its own, for the waits of the test.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'], shouldAdvanceTime: true });
    let reads = 0;
    server.use(http.get(`${TEST_API_BASE}/tasks`, ({ request }) => {
      if (isScoreboard(request)) reads += 1;
      return undefined;
    }));
    renderRoute('/scoreboard');
    await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' });
    expect(reads).toBe(1);

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    await waitFor(() => expect(reads).toBe(2));
  });

  it('names every tile as loading until the numbers arrive', async () => {
    const release = holdScoreboard();
    renderRoute('/scoreboard');
    const tile = await screen.findByRole('group', { name: 'Ended in a verified pull request: loading' });
    expect(within(tile).getByText('-')).toBeInTheDocument();
    expect(screen.getAllByRole('group', { name: /: loading$/ })).toHaveLength(TILE_COUNT);
    expect(screen.queryByRole('group', { name: 'Tasks finished, by how they ended' })).not.toBeInTheDocument();
    // Said where the first sentence of the page will be, and in the table of outcomes.
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading the scoreboard$/);
    expect(screen.getAllByText('Loading the scoreboard')).toHaveLength(2);

    release();
    expect(await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /: loading$/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Loading the scoreboard')).not.toBeInTheDocument();
  });

  it('shows the API error in place of the numbers', async () => {
    server.use(http.get(`${TEST_API_BASE}/tasks`, boom));
    renderRoute('/scoreboard');
    expect(await screen.findByText('Could not load the scoreboard')).toBeInTheDocument();
    expect(screen.getByText('Boom. (INTERNAL_ERROR, request req-9)')).toBeInTheDocument();
    expect(sectionHeadings()).toEqual([]);
  });

  it.each<[string, Partial<Scoreboard>]>([
    ['no pull request waits', { open_over_7d: { count: 0, task_ids: [] } }],
    // Not counted is not waiting: the API gives no count when it did not read the period before.
    ['the pull requests that wait are not counted', { previous: null, open_over_7d: null }],
  ])('says so, and offers a new task, when nothing finished and %s', async (_what, rest) => {
    serveChanged((month) => ({ ...month, current: emptied(month.current), ...rest }));
    renderRoute('/scoreboard');
    expect(await screen.findByText('No tasks finished in the last 30 days. The scoreboard fills in as your tasks finish.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' })).toHaveAttribute('href', '/tasks/new');
    expect(sectionHeadings()).toEqual([]);
    expect(screen.queryByRole('group', { name: /^Ended in a verified pull request/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('draws its sections when nothing finished in the period and pull requests of the period before wait', async () => {
    // The count is of the whole response: three of last week are still open, in a week without a task.
    const waitingIds = [MOCK_IDS.completedOld, MOCK_IDS.completed, MOCK_IDS.noChanges];
    serveChanged((week) => ({ ...week, current: emptied(week.current), open_over_7d: { count: 3, task_ids: waitingIds } }));
    renderRoute('/scoreboard?range=7d');
    const waiting = await screen.findByRole('group', { name: 'Pull requests open for more than 7 days: 3' });
    expect(within(waiting).getAllByRole('link').map((task) => task.textContent)).toEqual(['DONEOLD1', 'DONEPR01', 'NOCHANGE']);
    expect(sectionHeadings()).toEqual(['Speed', 'Quality', 'Leverage', 'Trust', 'Tasks finished']);
    expect(screen.queryByText(/The scoreboard fills in as your tasks finish\.$/)).not.toBeInTheDocument();
    // Every other number says that the period has nothing.
    expect(screen.getByRole('status')).toHaveTextContent(/^0 tasks finished in the last 7 days: 0 asked for a new pull request/);
    expect(within(screen.getByRole('group', { name: 'Merged, so far: no data' })).getByText('No new pull request in this period.')).toBeInTheDocument();
    // The table lists the six outcomes at zero, each with the dash of a number that has nothing to divide by; a bar with no part is not drawn.
    const rows = within(screen.getByRole('table', { name: 'Tasks finished by outcome' })).getAllByRole('row').slice(1);
    expect(rows.map((row) => Array.from(row.querySelectorAll('td'), (cell) => cell.textContent))).toEqual(Array(6).fill(['0', '-']));
    expect(screen.queryByRole('group', { name: 'Tasks finished, by how they ended' })).not.toBeInTheDocument();
  });

  it('warns above the first section when the read did not reach the start of the range, and compares nothing', async () => {
    const from = '2026-11-07T09:42:07.000Z';
    serveChanged((month) => ({ ...month, truncated: true, previous: null, open_over_7d: null, current: { ...month.current, from } }));
    renderRoute('/scoreboard');
    const warning = await screen.findByText('These numbers cover part of the range');
    expect(screen.getByText(
      `Showing tasks finished since ${formatTimestamp(from)}. This range holds more than the scoreboard reads at once; a shorter range may cover all of it.`,
    )).toBeInTheDocument();
    expect(warning.compareDocumentPosition(screen.getByRole('heading', { name: 'Speed' }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText(new RegExp(`^52 tasks finished since ${formatTimestamp(from)}: `))).toBeInTheDocument();
    expect(screen.queryByText(PREVIOUS_LINE)).not.toBeInTheDocument();
  });

  it('does not advise a shorter range than the shortest', async () => {
    const from = '2026-11-17T09:42:07.000Z';
    serveChanged((week) => ({ ...week, truncated: true, previous: null, open_over_7d: null, current: { ...week.current, from } }));
    renderRoute('/scoreboard?range=7d');
    expect(await screen.findByText(
      `Showing tasks finished since ${formatTimestamp(from)}. This range holds more than the scoreboard reads at once.`,
    )).toBeInTheDocument();
  });

  it('compares nothing, and warns of nothing, when only the period before was not read; the pull requests that wait are then not counted', async () => {
    // The API gives no count of them without the period before: its tasks hold the pull requests old enough to wait.
    serveChanged((month) => ({ ...month, previous: null, open_over_7d: null }));
    renderRoute('/scoreboard');
    expect(await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' })).toBeInTheDocument();
    expect(screen.queryByText(PREVIOUS_LINE)).not.toBeInTheDocument();
    expect(screen.queryByText('These numbers cover part of the range')).not.toBeInTheDocument();
    const waiting = screen.getByRole('group', { name: 'Pull requests open for more than 7 days: no data' });
    expect(within(waiting).getByText('The scoreboard did not read far enough back to count these.')).toBeInTheDocument();
    expect(within(waiting).queryByRole('link')).not.toBeInTheDocument();
  });

  it('links a count to its tasks, each by the end of its id, in the order the API names them', async () => {
    const blocked = '01JF3KQZ8X00000000BLOCKED1';
    serveChanged((month) => ({ ...month, current: { ...month.current, guardrail_stops: { count: 1, task_ids: [blocked] } } }));
    const { router } = renderRoute('/scoreboard');
    const stopped = await screen.findByRole('group', { name: 'Stopped by a guardrail: 1' });
    expect(within(stopped).getByRole('link', { name: 'Task BLOCKED1' })).toHaveAttribute('href', `/tasks/${blocked}`);
    const blanket = screen.getByRole('group', { name: 'Started with blanket approval: 3' });
    expect(within(blanket).getAllByRole('link').map((task) => task.textContent)).toEqual(['DONEPR01', 'CANCEL01', 'DONEOLD1']);
    // The pull requests that wait for a person: the one that has waited longest comes first.
    const waiting = screen.getByRole('group', { name: 'Pull requests open for more than 7 days: 2' });
    expect(within(waiting).getAllByRole('link').map((task) => task.textContent)).toEqual(['DONEOLD1', 'DONEPR01']);
    expect(within(waiting).getByRole('link', { name: 'Task DONEOLD1' })).toHaveAttribute('href', `/tasks/${MOCK_IDS.completedOld}`);

    fireEvent.click(within(blanket).getByRole('link', { name: 'Task DONEPR01' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${MOCK_IDS.completed}`));
  });

  it('says under the count of the pull requests that wait what it leaves out, after the links of the ones it counts', async () => {
    // Twenty more verified pull requests than ABCA follows: those of an orchestration.
    serveChanged((month) => ({
      ...month,
      current: { ...month.current, outcomes: { ...month.current.outcomes, verified_pr: month.current.outcomes.verified_pr + 20 } },
    }));
    renderRoute('/scoreboard');
    const waiting = await screen.findByRole('group', { name: 'Pull requests open for more than 7 days: 2' });
    const links = within(waiting).getAllByRole('link');
    expect(links.map((task) => task.textContent)).toEqual(['DONEOLD1', 'DONEPR01']);
    // Between the number and its links, the sentence would make them read as the orchestration's.
    const leftOut = within(waiting).getByText('The 20 of an orchestration are not followed.');
    expect(links[1].compareDocumentPosition(leftOut)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('says how many more tasks a count has than the ten it names', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `01JF3KQZ8X00000000STOPPED${i}`);
    serveChanged((month) => ({ ...month, current: { ...month.current, guardrail_stops: { count: 2150, task_ids: ids } } }));
    renderRoute('/scoreboard');
    const stopped = await screen.findByRole('group', { name: 'Stopped by a guardrail: 2,150' });
    expect(within(stopped).getAllByRole('link')).toHaveLength(10);
    expect(stopped).toHaveTextContent(/STOPPED8, STOPPED9 and 2,140 more$/);
  });

  it('explains each number in a bubble: what it is, why it matters and how it is computed', async () => {
    renderRoute('/scoreboard');
    const icon = await screen.findByRole('button', { name: 'About waited in line' });
    expect(screen.getAllByRole('button', { name: /^About / })).toHaveLength(TILE_COUNT);
    // The icon's name keeps a name inside the label as it is written.
    expect(screen.getByRole('button', { name: 'About not reworked through ABCA, so far' })).toBeInTheDocument();
    // The icon stays on the line of the label's last word, however the label wraps.
    const lastWord = within(screen.getByRole('group', { name: /^Waited in line: / })).getByText('line');
    expect(lastWord).toContainElement(icon);
    expect(lastWord).toHaveStyle({ whiteSpace: 'nowrap' });

    fireEvent.focus(icon);
    // A task that waits too long in line ends as failed; "ran out of time" is another outcome on this page.
    expect(screen.getByRole('tooltip').textContent).toBe(bubbleText('Waited in line', {
      what: 'The share of your tasks that could not start right away because you already had as many running as allowed.',
      why: 'A high share says your limit on tasks running at once, not the agents, holds work back. How long work waits to start is'
        + ' on the line under "Time to verified pull request". Submit fewer tasks at once, or have the limit raised.',
      how: 'Finished tasks that waited in line, divided by finished tasks that waited in line or started. A task cancelled while it'
        + ' waited, or failed because it waited too long, counts as having waited. It says how often tasks waited, not for how long.',
    }));
  });

  it('opens, from the "i" of each tile, the bubble that explains that tile', async () => {
    renderRoute('/scoreboard');
    await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' });
    for (const { label, explanation } of SECTIONS.flatMap((section) => section.tiles)) {
      // A label holds no character that a pattern reads as anything but itself.
      const group = screen.getByRole('group', { name: new RegExp(`^${label}: `) });
      // One bubble at a time: the one that opens closes the one before it.
      fireEvent.focus(within(group).getByRole('button', { name: aboutLabel(label) }));
      expect(screen.getByRole('tooltip').textContent).toBe(bubbleText(label, explanation));
    }
  });

  it('opens the bubble of a tile for a pointer that rests on its number, not only on its label', async () => {
    renderRoute('/scoreboard');
    const tile = await screen.findByRole('group', { name: 'Ended in a verified pull request: 70%' });
    fireEvent.pointerMove(within(tile).getByText('70%'));
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/^Ended in a verified pull requestWhat it isOf the tasks that asked for a new pull request/);
  });

  it('draws the finished tasks as one bar in three parts, over the table of all six outcomes', async () => {
    renderRoute('/scoreboard');
    const bar = await screen.findByRole('group', { name: 'Tasks finished, by how they ended' });
    expect(within(bar).getAllByRole('img').map((part) => [part.getAttribute('aria-label'), part.style.flexGrow])).toEqual([
      ['Verified pull request: 26 of 52 finished tasks, 50%', '26'],
      ['Finished without a verified pull request: 17 of 52 finished tasks, 33%', '17'],
      ['Failed or stopped: 9 of 52 finished tasks, 17%', '9'],
    ]);
    // However small its share, a part stays wide enough for a pointer or a finger to hit.
    expect(within(bar).getAllByRole('img').map((part) => part.style.minWidth)).toEqual(['24px', '24px', '24px']);
    const rows = within(screen.getByRole('table', { name: 'Tasks finished by outcome' })).getAllByRole('row').slice(1);
    expect(rows.map((row) => Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent))).toEqual([
      ['Verified pull request', '26', '50%'],
      ['Pull request without a passed build', '2', '4%'],
      ['Finished, no new pull request', '15', '29%'],
      ['Failed', '5', '10%'],
      ['Cancelled', '2', '4%'],
      ['Ran out of time', '2', '4%'],
    ]);
    // The table is the legend of the bar: the swatch of a row is the colour of its part.
    const parts = within(bar).getAllByRole('img').map((part) => part.querySelector('div')?.style.background);
    const swatches = rows.map((row) => row.querySelector<HTMLElement>('span[aria-hidden="true"]')?.style.background);
    // Slots 0, 2 and 1 of the light palette.
    expect(parts).toEqual(['rgb(42, 120, 214)', 'rgb(27, 175, 122)', 'rgb(235, 104, 52)']);
    expect(swatches).toEqual([parts[0], parts[1], parts[1], parts[2], parts[2], parts[2]]);
  });

  it('draws the bar and its legend in the dark palette in dark mode', async () => {
    // The shell reads the mode it was left in, and applies it to the page.
    localStorage.setItem('abca-console-theme', 'dark');
    renderRoute('/scoreboard');
    const part = await screen.findByRole('img', { name: /^Verified pull request: 26/ });
    const table = screen.getByRole('table', { name: 'Tasks finished by outcome' });
    // Slot 0 of the dark palette, #3987e5 (#2a78d6 in light mode).
    await waitFor(() => expect(part.querySelector('div')?.style.background).toBe('rgb(57, 135, 229)'));
    expect(table.querySelector<HTMLElement>('span[aria-hidden="true"]')?.style.background).toBe('rgb(57, 135, 229)');
  });

  it('explains a part of the bar, with its number, when the part takes the focus', async () => {
    renderRoute('/scoreboard');
    const part = await screen.findByRole('img', { name: 'Failed or stopped: 9 of 52 finished tasks, 17%' });
    expect(part).toHaveAttribute('tabindex', '0');
    // The bubble is the one tooltip of a part: a title would open a second.
    expect(part).not.toHaveAttribute('title');

    fireEvent.focus(part);
    expect(screen.getByRole('tooltip').textContent).toBe(bubbleText('Failed or stopped', {
      what: 'Tasks that failed, were cancelled, or ran out of time.',
      why: 'Each one took time, and usually money, without a result you can use. When the share grows, open the tasks from the Tasks'
        + " page: each task's page says why it ended and, for a failure, what to do next.",
      how: 'The table rows "Failed", "Cancelled" and "Ran out of time", added together. A task whose change broke a build that passed'
        + ' before ends as failed, and its pull request stays open on GitHub.',
    }, '9 of 52 finished tasks, 17%'));
  });

  it('draws no part for outcomes that no task had', async () => {
    renderRoute('/scoreboard?range=7d');
    const bar = await screen.findByRole('group', { name: 'Tasks finished, by how they ended' });
    expect(within(bar).getAllByRole('img').map((part) => part.getAttribute('aria-label'))).toEqual([
      'Finished without a verified pull request: 3 of 8 finished tasks, 38%',
      'Failed or stopped: 5 of 8 finished tasks, 63%',
    ]);
  });
});
