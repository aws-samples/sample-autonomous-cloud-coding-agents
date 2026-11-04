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
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../../helpers/render';
import { mockData, server, TEST_API_BASE } from '../../helpers/server';

const REPO_PAGE = '/repos/acme/web-frontend';

const openLinearTab = async () => fireEvent.click(await screen.findByRole('tab', { name: /^Linear/ }));

describe('Not started yet, on the repository page', () => {
  it('lists open GitHub issues without a task, each with Start', async () => {
    renderRoute(REPO_PAGE);
    const table = await screen.findByRole('table', { name: 'GitHub issues not started' });
    expect(within(table).getByRole('link', { name: 'Settings page loses unsaved changes on back navigation' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Start issue #31' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'GitHub issues (2)' })).toBeInTheDocument();
  });

  it('leaves out issues that already have a task', async () => {
    renderRoute('/repos/acme/payments-api');
    const table = await screen.findByRole('table', { name: 'GitHub issues not started' });
    // #214 has a queued task, so only #198 is left to start.
    expect(within(table).queryByRole('button', { name: 'Start issue #214' })).not.toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Start issue #198' })).toBeInTheDocument();
  });

  it('starts a GitHub issue in one click; it moves from the list to the tasks', async () => {
    renderRoute(REPO_PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Start issue #31' }));
    expect(await screen.findByText('Issue #31 is with the agent')).toBeInTheDocument();
    expect(mockData.tasks.at(-1)).toMatchObject({ repo: 'acme/web-frontend', issue_number: 31 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start issue #31' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Follow its progress' })).toHaveAttribute('href', `/tasks/${mockData.tasks.at(-1)!.task_id}`);
  });

  it('waits for every page of tasks before offering Start, and leaves out issues found on a later page', async () => {
    // The API filters by repository after DynamoDB's page limit: page one can be empty.
    const onPageTwo = { ...mockData.tasks.find((t) => t.repo === 'acme/web-frontend')!, task_id: '01JF3KQZ8X0000000000PAGE02', issue_number: 31 };
    server.use(http.get(`${TEST_API_BASE}/tasks`, async ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('repo') !== 'acme/web-frontend') return undefined;
      if (!url.searchParams.get('next_token')) return HttpResponse.json({ data: [], pagination: { next_token: 'cGFnZTI=', has_more: true } });
      await delay(400);
      return HttpResponse.json({ data: [onPageTwo], pagination: { next_token: null, has_more: false } });
    }));
    renderRoute(REPO_PAGE);
    expect(await screen.findByText('Checking which issues already have a task…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start issue #27' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start issue #27' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Start issue #31' })).not.toBeInTheDocument();
  });

  it('retries a start with the same idempotency key, so a lost response cannot create a second task', async () => {
    const keys: Array<string | null> = [];
    let calls = 0;
    server.use(http.post(`${TEST_API_BASE}/tasks`, ({ request }) => {
      keys.push(request.headers.get('Idempotency-Key'));
      calls += 1;
      // The first attempt "succeeds" upstream but its response never arrives.
      if (calls === 1) return HttpResponse.error();
      return undefined;
    }));
    renderRoute(REPO_PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Start issue #31' }));
    expect(await screen.findByText('Could not start the issue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start issue #31' }));
    expect(await screen.findByText('Issue #31 is with the agent')).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('lists Linear issues the agent has not picked up, and leaves out ones it has', async () => {
    renderRoute(REPO_PAGE);
    await openLinearTab();
    const table = await screen.findByRole('table', { name: 'Linear issues not started' });
    expect(within(table).getByRole('link', { name: 'Add a loading skeleton to the dashboard' })).toHaveAttribute('href', 'https://linear.app/acme/issue/WEB-12');
    expect(within(table).getByRole('button', { name: 'Start WEB-12' })).toBeInTheDocument();
    // WEB-8 already has a task: it shows under Tasks, not here.
    expect(within(table).queryByText('Fix dark-mode contrast on the settings page')).not.toBeInTheDocument();
  });

  it('starts a Linear issue by labeling it, and says what happens next', async () => {
    renderRoute(REPO_PAGE);
    await openLinearTab();
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
    await openLinearTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Start WEB-12' }));
    expect(await screen.findByText(/Create it in Linear/)).toBeInTheDocument();
  });

  it('explains a Linear connection that needs re-authorizing', async () => {
    server.use(http.get(`${TEST_API_BASE}/repos/:repo/linear-issues`, () => HttpResponse.json({
      data: { repo: 'acme/web-frontend', projects: [{ project_id: 'p', trigger_label: 'bgagent', problem: 'ABCA cannot reach this Linear workspace. Re-run `bgagent linear setup` to re-authorize it.', issues: [] }] },
    })));
    renderRoute(REPO_PAGE);
    await openLinearTab();
    expect(await screen.findByText('Linear issues are unavailable')).toBeInTheDocument();
  });

  it('says so when Linear issues cannot load, instead of hiding them', async () => {
    server.use(http.get(`${TEST_API_BASE}/repos/:repo/linear-issues`, () => HttpResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: 'r' } },
      { status: 502 },
    )));
    renderRoute(REPO_PAGE);
    await openLinearTab();
    expect(await screen.findByText('Could not load Linear issues')).toBeInTheDocument();
  });

  it('has no Linear tab for a repository without a Linear project', async () => {
    renderRoute('/repos/acme/infra');
    await screen.findByRole('heading', { name: 'Not started yet' });
    expect(screen.queryByRole('tab', { name: /^Linear/ })).not.toBeInTheDocument();
  });

  it('is hidden on a deployment without the console API', async () => {
    renderRoute(REPO_PAGE, { consoleApi: false });
    await screen.findByRole('link', { name: 'New task' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Not started yet' })).not.toBeInTheDocument());
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
