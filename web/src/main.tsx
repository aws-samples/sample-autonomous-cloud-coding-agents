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

import '@cloudscape-design/global-styles/index.css';
import Alert from '@cloudscape-design/components/alert';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { loadRuntimeConfig } from './app/config/runtime-config';
import { createCognitoAuthAdapter } from './app/providers/auth/cognito';

async function bootstrap(root: ReturnType<typeof createRoot>): Promise<void> {
  if (__MOCK__) {
    const mocks = await import('./mocks/browser');
    await mocks.startMockBackend();
    root.render(<StrictMode><App config={mocks.MOCK_RUNTIME_CONFIG} authAdapter={mocks.createMockAuthAdapter()} /></StrictMode>);
    return;
  }

  const config = await loadRuntimeConfig();
  if (config.auth.mode !== 'cognito') throw new Error('this build only supports Cognito sign-in');
  const adapter = createCognitoAuthAdapter({ region: config.region, ...config.auth });
  root.render(<StrictMode><App config={config} authAdapter={adapter} /></StrictMode>);
}

const root = createRoot(document.getElementById('root') as HTMLElement);
bootstrap(root).catch((error: unknown) => {
  root.render(
    <Alert type="error" header="The console could not start">
      {error instanceof Error ? error.message : String(error)}
    </Alert>,
  );
});
