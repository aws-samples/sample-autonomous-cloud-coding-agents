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
import { mockData } from '../../helpers/server';
import { titleOf } from '../../helpers/fixtures';
import { renderRoute } from '../../helpers/render';

const ALL_IDS = Object.values(MOCK_IDS);

describe('TaskListPage', () => {
  it('lists every task by title, with its repository', async () => {
    renderRoute('/tasks');
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.running) })).toBeInTheDocument();
    for (const id of ALL_IDS) {
      expect(screen.getByRole('link', { name: titleOf(id) })).toBeInTheDocument();
    }
    expect(screen.getByText(`(${ALL_IDS.length})`)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'acme/infra' })[0]).toHaveAttribute('href', '/repos/acme/infra');
  });

  it('names an issue-only task after the issue', async () => {
    renderRoute('/tasks');
    await screen.findByRole('link', { name: titleOf(MOCK_IDS.running) });
    expect(titleOf(MOCK_IDS.queued)).toBe('Add pagination to GET /invoices');
  });

  it('narrows to tasks that need you from the URL', async () => {
    renderRoute('/tasks?view=attention');
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.stale) })).toBeInTheDocument();
    expect(screen.getByText('(4)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: titleOf(MOCK_IDS.queued) })).not.toBeInTheDocument();
  });

  it('asks the API for the statuses of the selected view', async () => {
    renderRoute('/tasks?view=queued');
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.queued) })).toBeInTheDocument();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });

  it('filters loaded tasks by free text', async () => {
    renderRoute('/tasks');
    await screen.findByRole('link', { name: titleOf(MOCK_IDS.running) });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'web-frontend' } });
    expect(screen.getByText('(3)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: titleOf(MOCK_IDS.completed) })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: titleOf(MOCK_IDS.running) })).not.toBeInTheDocument();
  });

  it('narrows to one repository from the URL, asking the API for it', async () => {
    renderRoute('/tasks?repo=acme%2Fweb-frontend');
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.completed) })).toBeInTheDocument();
    expect(screen.getByText('(3)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: titleOf(MOCK_IDS.running) })).not.toBeInTheDocument();
  });

  it('narrows to where tasks were started, and clears every filter at once', async () => {
    const fromSlack = mockData.tasks.filter((t) => t.channel_source === 'slack');
    renderRoute('/tasks?source=slack');
    expect(await screen.findByRole('link', { name: titleOf(fromSlack[0].task_id) })).toBeInTheDocument();
    expect(screen.getByText(`(${fromSlack.length})`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText(`(${ALL_IDS.length})`)).toBeInTheDocument();
  });

  it('sorts by a column when its header is clicked, with empty values last', async () => {
    renderRoute('/tasks');
    await screen.findByRole('link', { name: titleOf(MOCK_IDS.running) });
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const column = headers.findIndex((h) => h === 'Cost');
    const costs = () => [...document.querySelectorAll('tbody tr')]
      .map((row) => row.querySelectorAll('td, th')[column]?.textContent ?? '');
    fireEvent.click(screen.getByText('Cost', { selector: 'th *' }));
    const ascending = costs();
    const amounts = ascending.filter((c) => c.startsWith('$')).map((c) => Number(c.slice(1)));
    expect(amounts.length).toBeGreaterThan(5);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    expect(ascending.slice(amounts.length).every((c) => !c.startsWith('$'))).toBe(true);
  });

  it('shows a stuck task as "No updates lately"', async () => {
    renderRoute('/tasks?view=attention');
    expect(await screen.findByText('No updates lately')).toBeInTheDocument();
  });

  it('links pull requests to GitHub in a new tab', async () => {
    renderRoute('/tasks?view=completed');
    const link = await screen.findByRole('link', { name: /#482/ });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/web-frontend/pull/482');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
