import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
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
/**
 * Production builds only: the dev server injects inline scripts (React Refresh) that this policy would block.
 * The API and login domain are per-deployment, so connect-src allows their AWS-owned parent domains.
 * Cloudscape sets inline style attributes, hence style-src 'unsafe-inline'. frame-ancestors cannot be set from
 * a meta tag; CloudFront's managed SECURITY_HEADERS policy sends X-Frame-Options instead.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'abca-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' },
    ],
  };
}

/**
 * `mise //web:dev:live` only: serves `.config.local.json` (your deployment's public
 * config, fetched by scripts/fetch-live-config.mjs) as /config.json, so the dev server
 * talks to the real API and Cognito. Never part of a build.
 */
function localRuntimeConfig(): Plugin {
  return {
    name: 'abca-local-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        try {
          const body = readFileSync(new URL('./.config.local.json', import.meta.url), 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end('No .config.local.json. Run `mise //web:dev:live`, or `mise //web:dev:mock` for mock data.');
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const mock = mode === 'mock';
  if (command === 'build' && mock) {
    throw new Error('Refusing to build in mock mode: mock data and mock sign-in are for local development only.');
  }

  return {
    plugins: [react(), contentSecurityPolicy(), ...(mock ? [msw({ mode: 'worker-only' })] : [localRuntimeConfig()])],
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
      // CI runners are several times slower than a laptop; page tests render the whole app.
      testTimeout: 20_000,
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
