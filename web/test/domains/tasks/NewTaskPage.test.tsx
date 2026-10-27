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

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_NOT_ONBOARDED_REPO } from '../../../src/mocks/handlers';
import { renderRoute } from '../../helpers/render';
import { mockData, server, TEST_API_BASE } from '../../helpers/server';

function fillRepo(value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value } });
}

describe('NewTaskPage', () => {
  it('checks the form before sending anything', async () => {
    renderRoute('/tasks/new');
    fireEvent.click(await screen.findByRole('button', { name: 'Start task' }));
    expect(await screen.findByText(/Enter the repository as owner\/name/)).toBeInTheDocument();
    expect(screen.getByText('Describe the change you want.')).toBeInTheDocument();
  });

  it('starts a described task and opens its page', async () => {
    let idempotencyKey: string | null = null;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST') idempotencyKey = request.headers.get('Idempotency-Key');
    });
    const { router } = renderRoute('/tasks/new');
    fillRepo('acme/web-frontend');
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe the change' }), { target: { value: 'Fix the footer link' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tasks\/01MOCK/));
    const created = mockData.tasks.at(-1);
    expect(created).toMatchObject({ repo: 'acme/web-frontend', task_description: 'Fix the footer link', issue_number: null });
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    server.events.removeAllListeners();
  });

  it('starts a task from an issue number', async () => {
    renderRoute('/tasks/new?repo=acme%2Finfra');
    fireEvent.click(await screen.findByRole('radio', { name: 'Fix a GitHub issue' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Issue number' }), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(mockData.tasks.at(-1)).toMatchObject({ repo: 'acme/infra', issue_number: 42, task_description: null }));
  });

  it('pre-fills from the link, e.g. "Try again"', async () => {
    renderRoute('/tasks/new?repo=acme%2Fdocs&description=Rewrite+the+guide');
    expect(await screen.findByRole('combobox', { name: 'Repository' })).toHaveValue('acme/docs');
    expect(screen.getByRole('textbox', { name: 'Describe the change' })).toHaveValue('Rewrite the guide');
  });

  it('explains a repository that is not set up yet', async () => {
    renderRoute('/tasks/new');
    fillRepo(MOCK_NOT_ONBOARDED_REPO);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Describe the change' }), { target: { value: 'Anything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect((await screen.findAllByText(/not set up for agents yet/)).length).toBeGreaterThan(0);
  });

  it('shows other API errors as they are', async () => {
    server.use(http.post(`${TEST_API_BASE}/tasks`, () => HttpResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Slow down.', request_id: 'r' } },
      { status: 429 },
    )));
    renderRoute('/tasks/new');
    fillRepo('acme/docs');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Describe the change' }), { target: { value: 'Anything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByText('Slow down.')).toBeInTheDocument();
  });
});
