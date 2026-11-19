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
import { renderRoute } from '../../helpers/render';
import { server, TEST_API_BASE } from '../../helpers/server';

describe('CostsPage', () => {
  it('shows this month\'s spend, tasks and spend on failed work', async () => {
    renderRoute('/costs');
    // Fixture tasks finished this month: completed $2.31 + failed $5.00 + no-change $0.11 (+ others outside the month).
    expect(await screen.findByText('Spent this month')).toBeInTheDocument();
    expect(screen.getByText('Spent on failed or stopped tasks')).toBeInTheDocument();
    expect(await screen.findByText(/of your \$100\.00 monthly limit/)).toBeInTheDocument();
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
  });
});
