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

import createWrapper from '@cloudscape-design/components/test-utils/dom';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { renderRoute } from '../../helpers/render';
import { mockData, server, TEST_API_BASE } from '../../helpers/server';

const REPO_PAGE = '/repos/acme/web-frontend';

describe('Linear on the repository page', () => {
  it('lists open Linear issues with what the agent is doing', async () => {
    renderRoute(REPO_PAGE);
    const table = await screen.findByRole('table', { name: /From Linear/ });
    expect(within(table).getByRole('link', { name: 'Add a loading skeleton to the dashboard' })).toHaveAttribute('href', 'https://linear.app/acme/issue/WEB-12');
    expect(within(table).getByRole('button', { name: 'Start WEB-12' })).toBeInTheDocument();
    // WEB-8 already has a task: no Start button, a link to the task instead.
    expect(within(table).queryByRole('button', { name: 'Start WEB-8' })).not.toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'View task' })).toHaveAttribute('href', `/tasks/${MOCK_IDS.completed}`);
  });

  it('starts an issue by labeling it, and says what happens next', async () => {
    renderRoute(REPO_PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Start WEB-11' }));
    expect(await screen.findByText('WEB-11 is with the agent')).toBeInTheDocument();
    expect(screen.getByText(/comment on the issue in Linear/)).toBeInTheDocument();
    const issue = mockData.linear['acme/web-frontend'][0].issues.find((i) => i.identifier === 'WEB-11')!;
    expect(issue.labels).toContain('bgagent');
    expect(await screen.findByText('Starting…')).toBeInTheDocument();
  });

  it('shows why a start failed', async () => {
    server.use(http.post(`${TEST_API_BASE}/linear-issues/:id/start`, () => HttpResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Linear has no "bgagent" label yet. Create it in Linear (Settings → Labels), then try again.', request_id: 'r' } },
      { status: 422 },
    )));
    renderRoute(REPO_PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Start WEB-12' }));
    expect(await screen.findByText(/Create it in Linear/)).toBeInTheDocument();
  });

  it('explains a Linear connection that needs re-authorizing', async () => {
    server.use(http.get(`${TEST_API_BASE}/repos/:repo/linear-issues`, () => HttpResponse.json({
      data: { repo: 'acme/web-frontend', projects: [{ project_id: 'p', trigger_label: 'bgagent', problem: 'ABCA cannot reach this Linear workspace. Re-run `bgagent linear setup` to re-authorize it.', issues: [] }] },
    })));
    renderRoute(REPO_PAGE);
    expect(await screen.findByText('Linear issues are unavailable')).toBeInTheDocument();
  });

  it('shows nothing for a repository without a Linear project', async () => {
    renderRoute('/repos/acme/infra');
    await screen.findByRole('link', { name: 'New task' });
    expect(screen.queryByRole('table', { name: /From Linear/ })).not.toBeInTheDocument();
  });
});

describe('Linear on the New task form', () => {
  it('offers "Hand over a Linear issue" only for a repo with a Linear project', async () => {
    renderRoute('/tasks/new?repo=acme%2Finfra');
    await screen.findByRole('radio', { name: 'Fix a GitHub issue' });
    expect(screen.queryByRole('radio', { name: /Hand over a Linear issue/ })).not.toBeInTheDocument();
  });

  it('hands over a picked issue and goes to the repository page', async () => {
    const { router } = renderRoute('/tasks/new?repo=acme%2Fweb-frontend');
    fireEvent.click(await screen.findByRole('radio', { name: /Hand over a Linear issue/ }));
    const picker = createWrapper(document.body).findAutosuggest('[data-testid="linear-picker"]')!;
    picker.focus();
    fireEvent.change(screen.getByRole('combobox', { name: 'Linear issue' }), { target: { value: 'locale' } });
    await waitFor(() => expect(picker.findDropdown().findOptions().length).toBeGreaterThan(0));
    picker.selectSuggestionByValue("WEB-11 Date picker ignores the user's locale");
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/repos/acme/web-frontend'));
    expect(mockData.linear['acme/web-frontend'][0].issues.find((i) => i.identifier === 'WEB-11')!.labels).toContain('bgagent');
  });

  it('asks for an issue before starting', async () => {
    renderRoute('/tasks/new?repo=acme%2Fweb-frontend');
    fireEvent.click(await screen.findByRole('radio', { name: /Hand over a Linear issue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByText('Pick a Linear issue.')).toBeInTheDocument();
  });
});
