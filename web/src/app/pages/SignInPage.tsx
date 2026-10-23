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

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import type { ReactNode } from 'react';
import { useAuth } from '../providers/auth/AuthProvider';

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 480, margin: '15vh auto', padding: '0 16px' }}>
      {children}
    </div>
  );
}

/** Shown whenever there is no signed-in session: loading, signed out, or sign-in unavailable. */
export function SignInPage() {
  const { state, signIn } = useAuth();

  if (state.status === 'loading') {
    return (
      <Centered>
        <Box textAlign="center"><Spinner size="large" /></Box>
      </Centered>
    );
  }

  return (
    <Centered>
      <Container header={<Header variant="h1">ABCA Operator Console</Header>}>
        <SpaceBetween size="m">
          {state.status === 'error' ? (
            <Alert type="error" header="Sign-in is unavailable">{state.message}</Alert>
          ) : (
            <Box>Sign in with the same account you use for the <code>bgagent</code> CLI.</Box>
          )}
          {state.status === 'signed-out' && (
            <Button variant="primary" onClick={signIn}>Sign in</Button>
          )}
        </SpaceBetween>
      </Container>
    </Centered>
  );
}
