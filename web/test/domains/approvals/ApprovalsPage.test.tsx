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

import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { titleOf } from '../../helpers/fixtures';
import { renderRoute } from '../../helpers/render';
import { mockData, server, TEST_API_BASE } from '../../helpers/server';

describe('ApprovalsPage', () => {
  it('shows what the agent wants to do, why it asked, and how risky it is', async () => {
    renderRoute('/approvals');
    expect(await screen.findByText('terraform apply -target=module.staging_database')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure changes require approval')).toBeInTheDocument();
    expect(screen.getByText('High risk')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.awaiting) })).toHaveAttribute('href', `/tasks/${MOCK_IDS.awaiting}`);
  });

  it('approves with one click', async () => {
    renderRoute('/approvals');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. The agent carries on.')).toBeInTheDocument();
    expect(mockData.tasks.find((t) => t.task_id === MOCK_IDS.awaiting)?.status).toBe('RUNNING');
  });

  it('says no with an optional reason', async () => {
    let body: unknown;
    server.use(http.post(`${TEST_API_BASE}/tasks/:taskId/deny`, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ data: { task_id: MOCK_IDS.awaiting, request_id: 'r', status: 'DENIED', decided_at: '' } }, { status: 202 });
    }));
    renderRoute('/approvals');
    fireEvent.click(await screen.findByRole('button', { name: 'Say no' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Why not? (optional)' }), { target: { value: 'Plan it only, do not apply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Say no' }));
    expect(await screen.findByText(/Declined\. The agent skips this action/)).toBeInTheDocument();
    expect(body).toEqual({ request_id: 'req-01JF3KR0APPROVE00000001', decision: 'deny', reason: 'Plan it only, do not apply' });
  });

  it('says so when nothing is waiting', async () => {
    server.use(http.get(`${TEST_API_BASE}/pending`, () => HttpResponse.json({ data: { pending: [] } })));
    renderRoute('/approvals');
    expect(await screen.findByText('No approval requests right now.')).toBeInTheDocument();
  });
});
