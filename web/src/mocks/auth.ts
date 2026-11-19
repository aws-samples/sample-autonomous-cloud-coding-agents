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

import type { AuthAdapter, AuthSession, AuthUser } from '../app/providers/auth/AuthProvider';

/**
 * Local-only sign-in for mock mode. It is reachable only through the
 * `__MOCK__`-guarded import in main.tsx, so it never ships in a production bundle,
 * and the mock API it pairs with accepts any token.
 */
const MOCK_USER: AuthUser = { id: 'mock-user-0001', email: 'operator@example.com', groups: ['operators'] };

const SIGNED_OUT_KEY = 'abca-mock-signed-out';

export function createMockAuthAdapter(storage: Storage = sessionStorage, user: AuthUser = MOCK_USER): AuthAdapter {
  const session: AuthSession = {
    user,
    getToken: async () => 'mock-id-token',
    signOut: async () => storage.setItem(SIGNED_OUT_KEY, '1'),
  };
  return {
    restore: async () => (storage.getItem(SIGNED_OUT_KEY) ? null : session),
    signIn: async () => {
      storage.removeItem(SIGNED_OUT_KEY);
      return session;
    },
  };
}
