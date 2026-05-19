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

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { CliError } from './errors';

/**
 * Localhost OAuth callback URL used during `bgagent linear setup`.
 * Must match the URL allowlisted on the CLI workload identity in CDK
 * (cdk/src/constructs/cli-workload-identity.ts).
 */
export const CALLBACK_HOST = 'localhost';
export const CALLBACK_PORT = 8443;
export const CALLBACK_PATH = '/oauth/callback';
export const CALLBACK_URL = `https://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>bgagent setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;text-align:center;color:#222}h1{color:#0a0}p{color:#666}</style></head>
<body><h1>✓ Linear authorized</h1><p>You can close this tab and return to your terminal.</p></body></html>`;

const FAILURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>bgagent setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;text-align:center;color:#222}h1{color:#c00}p{color:#666}</style></head>
<body><h1>✗ Authorization not captured</h1><p>The callback URL did not include a session_id. Re-run <code>bgagent linear setup</code> and try again.</p></body></html>`;

/**
 * Generate a self-signed cert + key pair for localhost using openssl.
 *
 * The cert is created in a temp dir and removed on close; the user's
 * browser will warn ("connection not private") on the redirect because
 * it's self-signed. This is acceptable: the cert is only used between
 * the user's browser and `localhost`, never traverses the network.
 *
 * Why openssl shell-out instead of node-forge or selfsigned: avoids a
 * runtime dependency for a one-off setup-time operation. openssl ships
 * with macOS and most Linux distros; if it's missing, fail loudly with
 * a remediation hint rather than silently falling back.
 */
export function generateSelfSignedCert(): { certPath: string; keyPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-oauth-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');

  try {
    // -batch suppresses the interactive subject prompt; -subj sets a minimal
    // subject. Localhost cert with 1-day validity (we only need it for the
    // setup session — if you don't finish in 24h, regenerate).
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-nodes',
      '-subj', '/CN=localhost',
      '-batch',
    ], { stdio: 'pipe' });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new CliError(
      `Failed to generate localhost cert via openssl: ${err instanceof Error ? err.message : String(err)}. `
      + `Confirm \`openssl\` is installed and on PATH (ships with macOS and most Linux distros).`,
    );
  }

  return {
    certPath,
    keyPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort — leftover certs in /tmp are harmless.
      }
    },
  };
}

export interface CallbackResult {
  /** Value of the `session_id` query param on the OAuth callback URL. */
  readonly sessionId: string;
}

export interface CallbackServerOptions {
  /**
   * How long to keep the server listening before rejecting with a timeout
   * error. The OAuth dance has a 600s server-side ceiling; 700s here
   * covers slow-clicking users without holding the process open forever.
   *
   * @default 700_000 (700 seconds)
   */
  readonly timeoutMs?: number;
}

/**
 * Start a one-shot HTTPS server that listens on `https://localhost:8443/oauth/callback`,
 * resolves with the captured `session_id` from the first GET it receives,
 * then shuts down.
 *
 * The OAuth dance flow:
 *   1. CLI calls `get_resource_oauth2_token(...)` and gets back an
 *      `authorizationUrl` + `sessionUri`.
 *   2. CLI starts THIS server.
 *   3. CLI opens `authorizationUrl` in the browser.
 *   4. User authorizes on Linear's consent screen.
 *   5. Linear redirects to `https://bedrock-agentcore.us-east-1.amazonaws.com/.../callback/<uuid>?code=...`.
 *   6. AWS exchanges the code with Linear, then redirects the browser to
 *      the URL we passed as `resourceOauth2ReturnUrl` — namely THIS server,
 *      with `?session_id=urn:ietf:params:oauth:request_uri:...` appended.
 *   7. We capture session_id, render a success page, and shut down.
 *   8. CLI polls `get_resource_oauth2_token` with `sessionUri` until the
 *      access token shows up.
 *
 * Returns a Promise resolving with the captured session_id, or rejecting
 * on timeout / server error / malformed callback.
 */
export async function awaitOauthCallback(
  options: CallbackServerOptions = {},
): Promise<CallbackResult> {
  const timeoutMs = options.timeoutMs ?? 700_000;
  const cert = generateSelfSignedCert();

  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        fn();
      } finally {
        cert.cleanup();
        clearTimeout(timer);
        // .close() shuts down the listener; in-flight responses still complete.
        try {
          server.close();
        } catch {
          // already closing
        }
      }
    };

    const server = https.createServer(
      {
        key: fs.readFileSync(cert.keyPath),
        cert: fs.readFileSync(cert.certPath),
      },
      (req, res) => {
        // Defensive: if we somehow get a request after settling, just close it.
        if (settled || !req.url) {
          res.statusCode = 410;
          res.end();
          return;
        }
        // We accept any path — AWS's redirect always goes to the configured
        // resourceOauth2ReturnUrl, so the path matches CALLBACK_PATH, but
        // matching loosely makes diagnosis easier (a misconfigured allowlist
        // sends us to /something else and we capture the query anyway).
        const url = new URL(req.url, CALLBACK_URL);
        const sessionId = url.searchParams.get('session_id');
        if (!sessionId) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          // Settle on `finish` so the response body actually flushes before
          // the listener closes — otherwise the client hangs waiting for
          // bytes it never gets, leaving callers / tests deadlocked.
          res.once('finish', () => {
            settle(() => reject(new CliError(
              `OAuth callback received without session_id. Got URL: ${req.url}. `
              + `If you saw an error on Linear's consent screen, that's likely the root cause; `
              + `re-run \`bgagent linear setup\` after fixing the Linear app config.`,
            )));
          });
          res.end(FAILURE_HTML);
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.once('finish', () => {
          settle(() => resolve({ sessionId }));
        });
        res.end(SUCCESS_HTML);
      },
    );

    server.on('error', (err) => {
      if ('code' in err && err.code === 'EADDRINUSE') {
        settle(() => reject(new CliError(
          `Port ${CALLBACK_PORT} is in use. Another bgagent setup may be running, `
          + `or another local service has bound it. Stop it and re-run \`bgagent linear setup\`.`,
        )));
      } else {
        settle(() => reject(err));
      }
    });

    const timer = setTimeout(() => {
      settle(() => reject(new CliError(
        `Timed out waiting ${Math.round(timeoutMs / 1000)}s for OAuth callback. `
        + `Either you closed the browser before authorizing, or Linear's consent flow `
        + `couldn't complete. Re-run \`bgagent linear setup\`.`,
      )));
    }, timeoutMs);
    timer.unref();

    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}
