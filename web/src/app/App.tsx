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

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ApiError, createApiClient } from '../core/api/client';
import { routes } from '../routes';
import type { RuntimeConfig } from './config/runtime-config';
import { SignInPage } from './pages/SignInPage';
import { ApiProvider } from './providers/api/ApiProvider';
import { AuthProvider, useAuth, type AuthAdapter, type AuthSession } from './providers/auth/AuthProvider';

/** Client errors (4xx) are deterministic; only retry server and network failures. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
}

function SignedInApp({ config, session }: { config: RuntimeConfig; session: AuthSession }) {
  const client = useMemo(
    () => createApiClient({ baseUrl: config.apiBaseUrl, getToken: () => session.getToken() }),
    [config.apiBaseUrl, session],
  );
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <ApiProvider client={client}>
      <RouterProvider router={router} />
    </ApiProvider>
  );
}

function SessionGate({ config }: { config: RuntimeConfig }) {
  const { state } = useAuth();
  const queryClient = useQueryClient();
  const signedIn = state.status === 'signed-in';

  // Never let one user's cached data survive into the next session.
  useEffect(() => {
    if (!signedIn) queryClient.clear();
  }, [signedIn, queryClient]);

  return state.status === 'signed-in' ? <SignedInApp config={config} session={state.session} /> : <SignInPage />;
}

export function App({ config, authAdapter }: { config: RuntimeConfig; authAdapter: AuthAdapter }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider adapter={authAdapter}>
        <SessionGate config={config} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
