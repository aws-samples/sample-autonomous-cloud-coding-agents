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

import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { shortId } from '../../../src/core/util/format';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { renderRoute } from '../../helpers/render';
import { server, TEST_API_BASE } from '../../helpers/server';

describe('OverviewPage', () => {
  it('counts work by state from the fixture set', async () => {
    renderRoute('/');
    // RUNNING x2, AWAITING_APPROVAL and HYDRATING are active; one task is queued.
    expect(await screen.findByRole('link', { name: 'Active: 4' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Queued: 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'No agent heartbeat: 1' })).toBeInTheDocument();
    // The timed-out task is older than 24 hours and the old completion is 3 days old.
    expect(screen.getByRole('link', { name: 'Failed or timed out (24h): 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Completed (24h): 1' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Waiting for approval: 1' })).toBeInTheDocument());
  });

  it('lists exactly the tasks that need attention', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: shortId(MOCK_IDS.stale) })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shortId(MOCK_IDS.awaiting) })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shortId(MOCK_IDS.failed) })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: shortId(MOCK_IDS.running) })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: shortId(MOCK_IDS.timedOut) })).not.toBeInTheDocument();
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
