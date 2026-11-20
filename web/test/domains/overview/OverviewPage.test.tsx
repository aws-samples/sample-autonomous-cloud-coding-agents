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

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { COUNTERS } from '../../../src/domains/overview/OverviewPage';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { bubbleText } from '../../helpers/explanations';
import { titleOf } from '../../helpers/fixtures';
import { renderRoute } from '../../helpers/render';
import { server, TEST_API_BASE } from '../../helpers/server';

describe('OverviewPage', () => {
  it('counts work by state in plain words', async () => {
    renderRoute('/');
    // RUNNING x2, AWAITING_APPROVAL and HYDRATING are working; one task is queued.
    expect(await screen.findByRole('link', { name: 'Working now: 4' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Waiting in line: 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'No updates lately: 1' })).toBeInTheDocument();
    // The budget failure and the no-changes run are recent; the timeout is older than 24 hours.
    expect(screen.getByRole('link', { name: 'Failed (24h): 2' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Done (24h): 1' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Approval requests: 1' })).toBeInTheDocument());
  });

  it('explains each counter in a bubble, from an "i" that stands beside the counter\'s link and not inside it', async () => {
    const { router } = renderRoute('/');
    const link = await screen.findByRole('link', { name: 'Failed (24h): 2' });
    const icon = screen.getByRole('button', { name: 'About failed (24h)' });
    expect(screen.getAllByRole('button', { name: /^About / })).toHaveLength(COUNTERS.length);
    expect(link).not.toContainElement(icon);

    fireEvent.focus(icon);
    expect(screen.getByRole('tooltip').textContent).toBe(bubbleText('Failed (24h)', {
      what: 'Tasks that failed or ran out of time in the last 24 hours.',
      why: 'Each one left its work undone: read why it ended on its page, then try again, split it up or do it by hand.'
        + ' They stay listed under "Needs you" until a day has passed.',
      how: 'Your tasks that failed or ran out of time, and whose last change is less than 24 hours old, among your 100 most recent tasks.'
        + ' Cancelled tasks are not counted, though the list the number opens shows them, and older tasks too.',
    }));

    // The counter still leads to its tasks.
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.search).toBe('?view=unsuccessful'));
    expect(router.state.location.pathname).toBe('/tasks');
  });

  it('opens the bubble of a counter for a pointer that rests on its number, not only on its label', async () => {
    renderRoute('/');
    fireEvent.pointerMove(await screen.findByRole('link', { name: 'Working now: 4' }));
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/^Working nowWhat it isTasks under way, from starting up to wrapping up/);
  });

  it('lists the tasks that need you, by title', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.stale) })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: titleOf(MOCK_IDS.awaiting) })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: titleOf(MOCK_IDS.failed) })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: titleOf(MOCK_IDS.running) })).not.toBeInTheDocument();
  });

  it('offers a New task button', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: 'New task' })).toHaveAttribute('href', '/tasks/new');
  });

  it('shows the API error instead of zero counts when tasks fail to load', async () => {
    server.use(http.get(`${TEST_API_BASE}/tasks`, () => HttpResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Boom.', request_id: 'req-9' } },
      { status: 500 },
    )));
    renderRoute('/');
    expect(await screen.findByText(/Boom\. \(INTERNAL_ERROR, request req-9\)/)).toBeInTheDocument();
  });
});
