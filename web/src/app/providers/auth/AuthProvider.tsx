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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface AuthUser {
  /** Cognito `sub`; the API uses it as the task owner id. */
  readonly id: string;
  readonly email: string;
  readonly groups: readonly string[];
}

export interface AuthSession {
  readonly user: AuthUser;
  /** A current ID token for the API's Cognito authorizer. */
  getToken(): Promise<string>;
  signOut(): Promise<void>;
}

/**
 * Pluggable sign-in mechanism. The production adapter uses Cognito managed
 * login; the mock adapter exists only in mock-mode dev builds.
 */
export interface AuthAdapter {
  /** Resumes an existing session (for example after the sign-in redirect); null when signed out. */
  restore(): Promise<AuthSession | null>;
  /** Starts sign-in. Redirecting adapters never resolve; others resolve with the new session. */
  signIn(): Promise<AuthSession | null>;
}

/** Fails closed: no session can be established. Used until a real adapter is configured. */
export function unavailableAuthAdapter(reason: string): AuthAdapter {
  return {
    restore: () => Promise.reject(new Error(reason)),
    signIn: () => Promise.reject(new Error(reason)),
  };
}

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly session: AuthSession }
  | { readonly status: 'error'; readonly message: string };

interface AuthContextValue {
  readonly state: AuthState;
  signIn(): void;
  signOut(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AuthProvider({ adapter, children }: { adapter: AuthAdapter; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    adapter.restore().then(
      (session) => !cancelled && setState(session ? { status: 'signed-in', session } : { status: 'signed-out' }),
      (error: unknown) => !cancelled && setState({ status: 'error', message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  const signIn = useCallback(() => {
    setState({ status: 'loading' });
    adapter.signIn().then(
      (session) => setState(session ? { status: 'signed-in', session } : { status: 'signed-out' }),
      (error: unknown) => setState({ status: 'error', message: errorMessage(error) }),
    );
  }, [adapter]);

  const signOut = useCallback(() => {
    if (state.status !== 'signed-in') return;
    state.session.signOut().finally(() => setState({ status: 'signed-out' }));
  }, [state]);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
