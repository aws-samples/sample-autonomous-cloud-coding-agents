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
import { describe, expect, it } from 'vitest';
import { summarizeRepos } from '../../../src/domains/repos/repo-summary';
import { buildFixtures, MOCK_IDS } from '../../../src/mocks/fixtures';
import { titleOf } from '../../helpers/fixtures';
import { renderRoute } from '../../helpers/render';

describe('summarizeRepos', () => {
  it('counts each repository\'s tasks by state, most recently active first', () => {
    const rows = summarizeRepos(buildFixtures().tasks);
    expect(rows.map((r) => r.repo)).toEqual(['acme/docs', 'acme/payments-api', 'acme/infra', 'acme/web-frontend']);
    expect(rows.find((r) => r.repo === 'acme/web-frontend')).toMatchObject({ working: 1, needsYou: 2, done: 1, failed: 1, total: 3 });
  });
});

describe('ReposPage', () => {
  it('lists every repository with tasks, and opens one on click', async () => {
    const { router } = renderRoute('/repos');
    const link = await screen.findByRole('link', { name: 'acme/infra' });
    expect(screen.getByRole('link', { name: 'acme/web-frontend' })).toBeInTheDocument();
    fireEvent.click(link);
    expect(router.state.location.pathname).toBe('/repos/acme/infra');
  });
});

describe('RepoDetailPage', () => {
  it('shows only that repository\'s tasks, and starts new ones there', async () => {
    renderRoute('/repos/acme/infra');
    expect(await screen.findByRole('link', { name: titleOf(MOCK_IDS.awaiting) })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: titleOf(MOCK_IDS.timedOut) })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: titleOf(MOCK_IDS.running) })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' })).toHaveAttribute('href', '/tasks/new?repo=acme%2Finfra');
    expect(within(screen.getByRole('table', { name: /^Tasks/ })).queryByText('Repository')).not.toBeInTheDocument();
  });
});
