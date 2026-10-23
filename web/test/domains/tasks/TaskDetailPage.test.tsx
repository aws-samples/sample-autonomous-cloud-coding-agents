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
import { describe, expect, it } from 'vitest';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { renderRoute } from '../../helpers/render';

describe('TaskDetailPage', () => {
  it('explains a failure with the classified title and remedy', async () => {
    renderRoute(`/tasks/${MOCK_IDS.failed}`);
    expect(await screen.findByText('Budget exceeded')).toBeInTheDocument();
    expect(screen.getByText(/Raise the per-repository or per-task budget/)).toBeInTheDocument();
    expect(screen.getByText('$5.00 of $5.00')).toBeInTheDocument();
  });

  it('shows milestones and blockers but hides tool-call noise until asked', async () => {
    renderRoute(`/tasks/${MOCK_IDS.running}`);
    expect(await screen.findByText('reproduced_failure')).toBeInTheDocument();
    expect(screen.queryByText('Turn 12')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show tool calls and turns/ }));
    expect(await screen.findByText('Turn 12')).toBeInTheDocument();
  });

  it('renders the blocker hint from the event metadata', async () => {
    renderRoute(`/tasks/${MOCK_IDS.failed}`);
    expect(await screen.findByText('build_failure [ledger-core] - Lombok 1.18.20 does not support Java 21')).toBeInTheDocument();
  });

  it('warns when the agent heartbeat is stale', async () => {
    renderRoute(`/tasks/${MOCK_IDS.stale}`);
    expect(await screen.findByText('No recent heartbeat from the agent')).toBeInTheDocument();
  });

  it('points paused tasks at the approvals inbox', async () => {
    renderRoute(`/tasks/${MOCK_IDS.awaiting}`);
    expect(await screen.findByText('This task is paused for approval')).toBeInTheDocument();
  });

  it('treats an unknown task as not found rather than an error', async () => {
    renderRoute('/tasks/does-not-exist');
    expect(await screen.findByText('Task not found')).toBeInTheDocument();
  });
});
