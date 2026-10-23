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

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App, shouldRetry } from '../../src/app/App';
import type { RuntimeConfig } from '../../src/app/config/runtime-config';
import { unavailableAuthAdapter } from '../../src/app/providers/auth/AuthProvider';
import { ApiError } from '../../src/core/api/client';
import { createMockAuthAdapter } from '../../src/mocks/auth';
import { TEST_API_BASE } from '../helpers/server';

const CONFIG: RuntimeConfig = { apiBaseUrl: TEST_API_BASE, region: 'us-east-1', auth: { mode: 'mock' } };

describe('App session gate', () => {
  it('fails closed when no sign-in mechanism is available', async () => {
    render(<App config={CONFIG} authAdapter={unavailableAuthAdapter('Sign-in is not configured.')} />);
    expect(await screen.findByText('Sign-in is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Sign-in is not configured.')).toBeInTheDocument();
    expect(screen.queryByText('Overview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows the console only after sign-in, and returns to sign-in on sign-out', async () => {
    sessionStorage.setItem('abca-mock-signed-out', '1');
    render(<App config={CONFIG} authAdapter={createMockAuthAdapter(sessionStorage)} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();

    // Cloudscape renders a hidden measuring copy of the top navigation, so the menu appears twice.
    fireEvent.click(screen.getAllByRole('button', { name: 'operator@example.com', hidden: true })[0]);
    fireEvent.click(await screen.findByText('Sign out'));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('shouldRetry', () => {
  it('does not retry client errors', () => {
    expect(shouldRetry(0, new ApiError(403, 'FORBIDDEN', 'no', ''))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, 'TASK_NOT_FOUND', 'no', ''))).toBe(false);
  });

  it('retries server and network errors twice', () => {
    expect(shouldRetry(0, new ApiError(503, 'UNAVAILABLE', 'no', ''))).toBe(true);
    expect(shouldRetry(1, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetry(2, new TypeError('fetch failed'))).toBe(false);
  });
});
