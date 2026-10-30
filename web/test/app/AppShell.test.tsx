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
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_IDS } from '../../src/mocks/fixtures';
import { renderRoute } from '../helpers/render';
import { server, TEST_API_BASE } from '../helpers/server';

// Cloudscape renders a hidden measuring copy of the top navigation, so utilities appear twice.
const first = (name: string | RegExp) => screen.getAllByRole('button', { name, hidden: true })[0];

describe('AppShell', () => {
  afterEach(() => localStorage.clear());

  it('has no "Needs your OK" page in the menu; a bell lists what is waiting instead', async () => {
    const { router } = renderRoute('/tasks');
    await screen.findByRole('heading', { name: 'Tasks', level: 1 });
    expect(screen.queryByRole('link', { name: /Needs your OK/ })).not.toBeInTheDocument();

    await waitFor(() => expect(first('Approvals: 1 waiting')).toBeInTheDocument());
    fireEvent.click(first('Approvals: 1 waiting'));
    const item = await screen.findByText('Infrastructure changes require approval');
    fireEvent.click(item);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${MOCK_IDS.awaiting}`));
  });

  it('says so when nothing is waiting', async () => {
    server.use(http.get(`${TEST_API_BASE}/pending`, () => HttpResponse.json({ data: { pending: [] } })));
    renderRoute('/');
    await waitFor(() => expect(first('Approvals: none waiting')).toBeInTheDocument());
  });

  it('switches theme with a moon in light mode and a sun in dark mode', async () => {
    renderRoute('/');
    fireEvent.click(await waitFor(() => first('Switch to dark mode')));
    expect(localStorage.getItem('abca-console-theme')).toBe('dark');
    expect(first('Switch to light mode')).toBeInTheDocument();
  });
});
