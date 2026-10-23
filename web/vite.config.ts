import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { defineConfig } from 'vitest/config';

/**
 * Modes:
 *  - `vite --mode mock`  local development against the in-browser mock API (MSW) and mock sign-in.
 *  - `vite build`        production bundle; reads `/config.json` at runtime (written by the CDK stack).
 *  - `vitest`            unit/component tests against an MSW node server.
 *
 * Mock data and mock sign-in exist only behind the compile-time `__MOCK__` flag, so they are
 * tree-shaken out of every production bundle. Building in mock mode is refused outright.
 */
export default defineConfig(({ command, mode }) => {
  const mock = mode === 'mock';
  if (command === 'build' && mock) {
    throw new Error('Refusing to build in mock mode: mock data and mock sign-in are for local development only.');
  }

  return {
    plugins: [react(), ...(mock ? [msw({ mode: 'worker-only' })] : [])],
    define: { __MOCK__: JSON.stringify(mock) },
    // Loopback only; never expose the dev server to the network.
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      // Cloudscape dominates the bundle and changes rarely; a separate chunk keeps it cached across console releases.
      chunkSizeWarningLimit: 1200,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'cloudscape', test: /node_modules[\\/]@cloudscape-design/ },
              { name: 'vendor', test: /node_modules/ },
            ],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      css: false,
      coverage: {
        provider: 'v8',
        include: ['src/**'],
        exclude: ['src/main.tsx', 'src/env.d.ts', 'src/mocks/browser.ts'],
        reporter: ['text', 'html'],
      },
    },
  };
});
