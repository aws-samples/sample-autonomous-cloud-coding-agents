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

import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { titleOf } from '../../helpers/fixtures';
import { renderRoute } from '../../helpers/render';
import { mockData, server, TEST_API_BASE } from '../../helpers/server';

describe('ApprovalsPage', () => {
  it('shows what the agent wants to do, why it asked, and how risky it is', async () => {
    renderRoute('/approvals');
    // The tool's input as the agent stores it: JSON.
    expect(await screen.findByText(
      '{"command": "terraform apply -target=module.staging_database", "description": "Apply the staging database change"}',
    )).toBeInTheDocument();
    // The agent's own reason: the rules that held the action.
    expect(screen.getByText('Soft-deny: terraform_apply')).toBeInTheDocument();
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

  it('counts the time of a request on while the page stays open and no request changes', async () => {
    // The interval clock and the date are in the test's hands, and still run on their own for the waits of the test.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
    // The page reads the task list too, for the titles, and each of its answers draws the page again.
    // It gets no answer here, so that only the requests can move the card.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(http.get(`${TEST_API_BASE}/tasks`, async () => {
      await held;
      return undefined;
    }));
    try {
      renderRoute('/approvals');
      expect(await screen.findByText('2m ago')).toBeInTheDocument();
      expect(screen.getByText('in 3m')).toBeInTheDocument();
      // Two minutes on: the request is four minutes old and has one minute left.
      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      expect(await screen.findByText('4m ago')).toBeInTheDocument();
      expect(screen.queryByText('in 3m')).not.toBeInTheDocument();
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});
