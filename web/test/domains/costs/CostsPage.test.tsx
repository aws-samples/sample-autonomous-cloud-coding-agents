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

import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { COST_EXPLANATIONS } from '../../../src/core/util/costs';
import { buildFixtures } from '../../../src/mocks/fixtures';
import { bubbleText } from '../../helpers/explanations';
import { renderRoute } from '../../helpers/render';
import { server, TEST_API_BASE } from '../../helpers/server';

describe('CostsPage', () => {
  it('shows this month\'s spend, tasks and spend on failed work', async () => {
    renderRoute('/costs');
    expect(await screen.findByRole('group', { name: /^Spent this month: \$/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /^Spent on failed or stopped tasks: \$/ })).toBeInTheDocument();
    expect(await screen.findByText(/of your \$100\.00 monthly limit/)).toBeInTheDocument();
  });

  it('names each tile with its number', async () => {
    renderRoute('/costs?range=30d');
    expect(await screen.findByRole('group', { name: 'Spent last 30 days: $10.84' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Tasks: 14' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Average per task: $1.81' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Spent on failed or stopped tasks: $5.11' })).toBeInTheDocument();
  });

  it('names its tiles as loading, with a dash, until the tasks arrive', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(http.get(`${TEST_API_BASE}/tasks`, async ({ request }) => {
      if (!new URL(request.url).searchParams.has('view')) await held;
      return undefined;
    }));
    renderRoute('/costs?range=30d');
    expect(await screen.findByRole('group', { name: 'Tasks: loading' })).toHaveTextContent(/-$/);
    expect(screen.getByRole('group', { name: 'Spent last 30 days: loading' })).toHaveTextContent(/-$/);

    release();
    expect(await screen.findByRole('group', { name: 'Tasks: 14' })).toBeInTheDocument();
  });

  it('groups the digits of a count and of an amount of a thousand and more', async () => {
    const finished = new Date().toISOString();
    const tasks = Array.from({ length: 1204 }, (_, i) => ({
      ...buildFixtures().tasks[0],
      task_id: `01JF3KQZ8X${String(i).padStart(16, '0')}`,
      status: 'COMPLETED',
      cost_usd: 4.5,
      completed_at: finished,
      updated_at: finished,
    }));
    server.use(http.get(`${TEST_API_BASE}/tasks`, ({ request }) => (new URL(request.url).searchParams.has('view')
      ? undefined
      : HttpResponse.json({ data: tasks, pagination: { next_token: null, has_more: false } }))));
    renderRoute('/costs');
    expect(await screen.findByRole('group', { name: 'Tasks: 1,204' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Spent this month: $5,418.00' })).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: /By repository/i })).getByRole('cell', { name: '1,204' })).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll('svg text'), (tick) => tick.textContent)).toContain('$5,000');
  });

  it('explains each tile, and the chart from the "i" beside its title, in a bubble', async () => {
    renderRoute('/costs?range=30d');
    const icon = await screen.findByRole('button', { name: 'About tasks' });
    for (const name of ['About spent last 30 days', 'About average per task', 'About spent on failed or stopped tasks', 'About spend per day']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    fireEvent.focus(icon);
    expect(screen.getByRole('tooltip').textContent).toBe(bubbleText('Tasks', {
      what: 'How many of your tasks fall in the selected time range.',
      why: 'It is the volume behind the spend. Read it with "Average per task": spend can rise because you submitted more tasks, or'
        + ' because each one cost more.',
      how: 'Tasks that finished in the selected range, whatever the result, and tasks not yet finished whose last change falls in it.'
        + ' Tasks that recorded no cost are counted too. It reads your 500 most recent tasks.',
    }));

    fireEvent.focus(screen.getByRole('button', { name: 'About spend per day' }));
    expect(screen.getByRole('tooltip').textContent).toBe(bubbleText('Spend per day', COST_EXPLANATIONS.perDay));
  });

  it('breaks spend down by repository by default, with links', async () => {
    renderRoute('/costs');
    const table = await screen.findByRole('table', { name: /By repository/i });
    const links = await within(table).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toContain('acme/payments-api');
  });

  it('switches the grouping and keeps it in the URL', async () => {
    const { router } = renderRoute('/costs');
    fireEvent.click(await screen.findByRole('button', { name: 'Outcome' }));
    expect(router.state.location.search).toContain('group=outcome');
    expect(await screen.findByRole('table', { name: /By outcome/i })).toBeInTheDocument();
  });

  it('lists the most expensive tasks', async () => {
    renderRoute('/costs');
    const table = await screen.findByRole('table', { name: /Most expensive tasks/ });
    expect(await within(table).findByRole('link', { name: 'Migrate the ledger service to Java 21' })).toBeInTheDocument();
  });

  it('says when no monthly limit is set', async () => {
    server.use(http.get(`${TEST_API_BASE}/tasks`, ({ request }) => (new URL(request.url).searchParams.get('view') === 'budget'
      ? HttpResponse.json({ data: { period: '2026-10', resets_at: '', configured: false, spend_usd: 0, monthly_limit_usd: null, remaining_usd: null, utilization_percent: null, hard_stop: false, hard_stop_active: false } })
      : HttpResponse.json({ data: [], pagination: { next_token: null, has_more: false } }))));
    renderRoute('/costs');
    expect(await screen.findByText('No monthly limit set')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Average per task: no data' })).toHaveTextContent(/-$/);
    expect(screen.getByRole('group', { name: 'Tasks: 0' })).toBeInTheDocument();
  });
});
