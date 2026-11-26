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

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as http from 'http';
import { URL } from 'url';
import { CliError } from './errors';

/**
 * Localhost OAuth callback URL used during `bgagent linear setup`.
 *
 * Plain HTTP: RFC 8252 §7.3 has providers accept loopback redirect URIs without TLS.
 * Linear requires the `redirect_uri` to byte-match the one configured on its app.
 */
const CALLBACK_HOST = 'localhost';
export const CALLBACK_PORT = 8080;
const CALLBACK_PATH = '/oauth/callback';
export const CALLBACK_URL = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>bgagent setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;text-align:center;color:#222}h1{color:#0a0}p{color:#666}</style></head>
<body><h1>✓ Linear authorized</h1><p>You can close this tab and return to your terminal.</p></body></html>`;

const FAILURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>bgagent setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;text-align:center;color:#222}h1{color:#c00}p{color:#666}</style></head>
<body><h1>✗ Authorization not captured</h1><p>The callback URL did not include a session_id. Re-run <code>bgagent linear setup</code> and try again.</p></body></html>`;

/**
 * Discriminated union over the two redirect shapes Linear may send to
 * the localhost callback.
 *
 * - `agentcore`: AgentCore Identity USER_FEDERATION redirect.
 *   AWS handles the code-for-token exchange itself; we receive only
 *   the session_id.
 * - `direct-oauth`: Linear redirects directly to
 *   localhost with `code` + `state`. Caller MUST verify `state` against
 *   the value passed into `buildAuthorizationUrl` to prevent CSRF.
 */
export type CallbackResult =
  | {
    readonly kind: 'agentcore';
    readonly sessionId: string;
  }
  | {
    readonly kind: 'direct-oauth';
    readonly code: string;
    readonly state: string;
  };

export interface CallbackServerOptions {
  /**
   * How long to keep the server listening before rejecting with a timeout
   * error.
   *
   * @default 700_000 (700 seconds)
   */
  readonly timeoutMs?: number;
}

/**
 * Start a one-shot HTTP server on {@link CALLBACK_URL}, resolve with the first callback
 * it receives, then shut down.
 *
 * Rejects with CliError on timeout, on a port already in use, on an `error` parameter
 * from Linear, and on a callback with neither `session_id` nor `code` + `state`. Any
 * other server error rejects as raised.
 */
export async function awaitOauthCallback(
  options: CallbackServerOptions = {},
): Promise<CallbackResult> {
  const DEFAULT_CALLBACK_TIMEOUT_MS = 700_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        fn();
      } finally {
        clearTimeout(timer);
        try {
          server.close();
        } catch {
          // already closing
        }
      }
    };

    const server = http.createServer(
      (req, res) => {
        if (settled || !req.url) {
          res.statusCode = 410;
          res.end();
          return;
        }
        const url = new URL(req.url, CALLBACK_URL);
        const sessionId = url.searchParams.get('session_id');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          const errorDescription = url.searchParams.get('error_description') ?? '(no description)';
          res.once('finish', () => {
            settle(() => reject(new CliError(
              `OAuth callback received error from Linear: ${error} — ${errorDescription}.`,
            )));
          });
          res.end(FAILURE_HTML);
          return;
        }

        if (!sessionId && !(code && state)) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.once('finish', () => {
            settle(() => reject(new CliError(
              `OAuth callback received without session_id or code/state. Got URL: ${req.url}. `
              + 'If you saw an error on Linear\'s consent screen, that\'s likely the root cause; '
              + 're-run `bgagent linear setup` after fixing the Linear app config.',
            )));
          });
          res.end(FAILURE_HTML);
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const result: CallbackResult = code && state
          ? { kind: 'direct-oauth', code, state }
          : { kind: 'agentcore', sessionId: sessionId! };
        res.once('finish', () => {
          settle(() => resolve(result));
        });
        res.end(SUCCESS_HTML);
      },
    );

    server.on('error', (err) => {
      if ('code' in err && err.code === 'EADDRINUSE') {
        settle(() => reject(new CliError(
          `Port ${CALLBACK_PORT} is in use. Another bgagent setup may be running, `
          + 'or another local service has bound it. Stop it and re-run `bgagent linear setup`.',
        )));
      } else {
        settle(() => reject(err));
      }
    });

    const timer = setTimeout(() => {
      settle(() => reject(new CliError(
        `Timed out waiting ${Math.round(timeoutMs / 1000)}s for OAuth callback. `
        + 'Either you closed the browser before authorizing, or Linear\'s consent flow '
        + 'couldn\'t complete. Re-run `bgagent linear setup`.',
      )));
    }, timeoutMs);
    timer.unref();

    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

/**
 * Open `url` in the user's default browser. Returns true on best-effort
 * success, false if no opener is available (e.g. headless SSH session) so
 * callers can fall back to printing the URL.
 */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let opener: { cmd: string; args: string[] };
    if (process.platform === 'darwin') {
      opener = { cmd: 'open', args: [url] };
    } else if (process.platform === 'win32') {
      // `start` is a cmd.exe builtin; URLs need empty title arg + escaping.
      opener = { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    } else {
      opener = { cmd: 'xdg-open', args: [url] };
    }
    execFile(opener.cmd, opener.args, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Generate an opaque, URL-safe `state` value for OAuth CSRF protection.
 */
export function randomState(): string {
  const STATE_BYTES = 32;
  return randomBytes(STATE_BYTES).toString('base64url');
}
