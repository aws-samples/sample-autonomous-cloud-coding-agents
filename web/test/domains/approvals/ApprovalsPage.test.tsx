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

import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { shortId } from '../../../src/core/util/format';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { renderRoute } from '../../helpers/render';
import { server, TEST_API_BASE } from '../../helpers/server';

describe('ApprovalsPage', () => {
  it('shows what the agent wants to run and why it was stopped', async () => {
    renderRoute('/approvals');
    expect(await screen.findByText('terraform apply -target=module.staging_database')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure changes require approval')).toBeInTheDocument();
    expect(screen.getByText('soft:terraform-apply')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shortId(MOCK_IDS.awaiting) })).toHaveAttribute('href', `/tasks/${MOCK_IDS.awaiting}`);
  });

  it('says so when nothing is waiting', async () => {
    server.use(http.get(`${TEST_API_BASE}/pending`, () => HttpResponse.json({ data: { pending: [] } })));
    renderRoute('/approvals');
    expect(await screen.findByText('Nothing is waiting for approval.')).toBeInTheDocument();
  });
});
