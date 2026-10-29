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

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { renderRoute } from '../../helpers/render';
import { mockData } from '../../helpers/server';

describe('TaskDetailPage', () => {
  it('shows the five steps with the current one marked', async () => {
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    const progress = await screen.findByRole('list', { name: 'Progress' });
    expect(within(progress).getByLabelText('Setting up: done')).toBeInTheDocument();
    expect(within(progress).getByLabelText('Working: in progress')).toHaveAttribute('aria-current', 'step');
    expect(within(progress).getByLabelText('Pull request: not started')).toBeInTheDocument();
  });

  it('tells you what it is doing in plain words, without bookkeeping', async () => {
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    const feed = await screen.findByRole('list', { name: 'Activity' });
    expect(within(feed).getByText('Run the PaymentClient tests to see the failure')).toBeInTheDocument();
    expect(within(feed).getByText('Edited src/client/payment-client.test.ts')).toBeInTheDocument();
    expect(within(feed).getByText(/The retry test waits on a real timer/)).toBeInTheDocument();
    expect(within(feed).queryByText(/Turn|\$0\.84|session/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Right now: Run the test five times/)).toBeInTheDocument();
  });

  it('keeps the raw events in the full log', async () => {
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    fireEvent.click(await screen.findByRole('button', { name: /Full log/ }));
    expect(await screen.findByText('Session started')).toBeInTheDocument();
  });

  it('explains a failure in plain words and offers to try again', async () => {
    renderRoute(`/tasks/${MOCK_IDS.failed}`);
    expect(await screen.findByText('Budget exceeded')).toBeInTheDocument();
    expect(screen.getByText(/What to do: Raise the per-repository or per-task budget/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/tasks/new?repo=acme%2Fpayments-api&description=Migrate+the+ledger+service+to+Java+21&max_turns=60&max_budget_usd=5',
    );
    expect(screen.getByLabelText('Working: stopped here')).toBeInTheDocument();
  });

  it('shows what the task was started with, including its limits', async () => {
    renderRoute(`/tasks/${MOCK_IDS.queued}`);
    await screen.findByRole('heading', { name: 'Request' });
    const request = screen;
    expect(request.getByText('#214 Add pagination to GET /invoices')).toBeInTheDocument();
    expect(request.getByText('60')).toBeInTheDocument();
    expect(request.getByText('$5.00')).toBeInTheDocument();
    expect(request.getByText('Extra guidance')).toBeInTheDocument();
    expect(request.getByText('Use cursor pagination, 50 per page')).toBeInTheDocument();
    expect(request.getByText('Console or CLI')).toBeInTheDocument();
  });

  it('says when a limit is left to the repository', async () => {
    const task = mockData.tasks.find((t) => t.task_id === MOCK_IDS.running)!;
    Object.assign(task, { max_turns: null, max_budget_usd: null });
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    await screen.findByRole('heading', { name: 'Request' });
    expect(screen.getAllByText('Repository default')).toHaveLength(2);
  });

  it('reports "nothing to change" as that, not as a failure', async () => {
    renderRoute(`/tasks/${MOCK_IDS.noChanges}`);
    expect(await screen.findByText('Finished with no changes')).toBeInTheDocument();
    expect(screen.getAllByText(/already has a CODEOWNERS file/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('says so when it has gone quiet, and offers a message or cancel', async () => {
    renderRoute(`/tasks/${MOCK_IDS.stale}`);
    expect(await screen.findByText('No update for 9 min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a message' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Cancel task' }).length).toBeGreaterThan(0);
  });

  it('lets you approve a paused task right on the page', async () => {
    renderRoute(`/tasks/${MOCK_IDS.awaiting}`);
    expect(await screen.findByText(/paused before an action that needs a person to approve it/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Got your OK and carried on')).toBeInTheDocument();
    expect(mockData.pending).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument());
  });

  it('sends a message and shows it until the agent reads it', async () => {
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Also cover the timeout path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Also cover the timeout path')).toBeInTheDocument();
    expect(screen.getByText('Sent, not read yet')).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('marks a message as seen once the agent acknowledges it', async () => {
    const nudgeId = 'nudge-abcdef0123456789';
    sessionStorage.setItem(`abca-console-messages:${MOCK_IDS.running}`, JSON.stringify([{ nudgeId, text: 'Use fake timers', at: new Date().toISOString() }]));
    mockData.events[MOCK_IDS.running].push({
      event_id: `${MOCK_IDS.running}-9999`,
      event_type: 'agent_milestone',
      timestamp: new Date().toISOString(),
      metadata: { milestone: 'nudge_acknowledged', details: '1 nudge(s) acknowledged (ids=…23456789): Use fake timers' },
    });
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    expect(await screen.findByText('Seen')).toBeInTheDocument();
    expect(screen.getByText('Read your message: "Use fake timers"')).toBeInTheDocument();
  });

  it('does not take messages once the task has finished', async () => {
    renderRoute(`/tasks/${MOCK_IDS.completed}`);
    expect(await screen.findByText(/This task has finished, so it can't read messages/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByText('Done: pull request #482 is ready for review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View pull request' })).toHaveAttribute('href', 'https://github.com/acme/web-frontend/pull/482');
  });

  it('cancels after you confirm', async () => {
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Cancel task' }))[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Work it has not pushed yet is lost/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    expect((await screen.findAllByText('Cancelled')).length).toBeGreaterThan(0);
    expect(mockData.tasks.find((t) => t.task_id === MOCK_IDS.running)?.status).toBe('CANCELLED');
  });

  it('treats an unknown task as not found rather than an error', async () => {
    renderRoute('/tasks/does-not-exist');
    expect(await screen.findByText('Task not found')).toBeInTheDocument();
  });
});
