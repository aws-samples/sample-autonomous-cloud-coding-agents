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
import { shortId } from '../../../src/core/util/format';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { renderRoute } from '../../helpers/render';

const ALL_IDS = Object.values(MOCK_IDS);

describe('TaskListPage', () => {
  it('lists every task visible to the caller', async () => {
    renderRoute('/tasks');
    expect(await screen.findByRole('link', { name: shortId(MOCK_IDS.running) })).toBeInTheDocument();
    for (const id of ALL_IDS) {
      expect(screen.getByRole('link', { name: shortId(id) })).toBeInTheDocument();
    }
    expect(screen.getByText(`(${ALL_IDS.length})`)).toBeInTheDocument();
  });

  it('narrows to tasks needing attention from the URL', async () => {
    renderRoute('/tasks?view=attention');
    expect(await screen.findByRole('link', { name: shortId(MOCK_IDS.stale) })).toBeInTheDocument();
    expect(screen.getByText('(3)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: shortId(MOCK_IDS.queued) })).not.toBeInTheDocument();
  });

  it('asks the API for the statuses of the selected view', async () => {
    renderRoute('/tasks?view=queued');
    expect(await screen.findByRole('link', { name: shortId(MOCK_IDS.queued) })).toBeInTheDocument();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });

  it('filters loaded tasks by free text', async () => {
    renderRoute('/tasks');
    await screen.findByRole('link', { name: shortId(MOCK_IDS.running) });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'web-frontend' } });
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shortId(MOCK_IDS.completed) })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: shortId(MOCK_IDS.running) })).not.toBeInTheDocument();
  });

  it('links pull requests to GitHub in a new tab', async () => {
    renderRoute('/tasks?view=completed');
    const link = await screen.findByRole('link', { name: /#482/ });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/web-frontend/pull/482');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
