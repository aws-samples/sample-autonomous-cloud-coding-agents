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

import * as http from 'http';
import { URL } from 'url';
import { CliError } from './errors';

/**
 * Localhost OAuth callback URL used during `bgagent linear setup`.
 *
 * HTTP (not HTTPS) is intentional. Per RFC 8252 §7.3 (OAuth 2.0 for
 * Native Apps) and Linear's docs, providers MUST treat http://localhost
 * URLs as a special case and not require TLS — the connection never
 * leaves the host. Using HTTP here removes the self-signed-cert browser
 * warning that scared early testers during the Phase 2.0b smoke.
 *
 * The redirect_uri value sent to Linear MUST byte-match what's configured
 * in Linear's app — keep this constant in sync with the LINEAR_SETUP_GUIDE
 * playbook entry.
 */
export const CALLBACK_HOST = 'localhost';
export const CALLBACK_PORT = 8080;
export const CALLBACK_PATH = '/oauth/callback';
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
 * the localhost callback. Was previously an all-nullable struct
 * `{ sessionId: string | null, code: string | null, state: string | null }`
 * which let callers (and tests) construct nonsense values like
 * "all three null" or "sessionId AND code+state set" — neither is
 * actually reachable in production. Splitting into two cases makes
 * downstream pattern-matching exhaustive and the "impossible state"
 * unrepresentable.
 *
 * - `agentcore`: legacy AgentCore Identity USER_FEDERATION redirect.
 *   AWS handles the code-for-token exchange itself; we receive only
 *   the session_id we use to poll for the resulting token. Parked
 *   path; kept for the eventual 2.0c resume.
 * - `direct-oauth`: Phase 2.0b Option 2. Linear redirects directly to
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

  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        fn();
      } finally {
        clearTimeout(timer);
        // .close() shuts down the listener; in-flight responses still complete.
        try {
          server.close();
        } catch {
          // already closing
        }
      }
    };

    const server = http.createServer(
      (req, res) => {
        // Defensive: if we somehow get a request after settling, just close it.
        if (settled || !req.url) {
          res.statusCode = 410;
          res.end();
          return;
        }
        // We accept any path — Linear's redirect always goes to the configured
        // redirect_uri (which matches CALLBACK_PATH), but matching loosely
        // makes diagnosis easier when something is misconfigured.
        const url = new URL(req.url, CALLBACK_URL);
        const sessionId = url.searchParams.get('session_id');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        // Linear may redirect with `?error=access_denied` if the user clicks
        // Cancel on the consent screen. Surface that explicitly rather than
        // saying "no session_id / code".
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

        // Need either session_id (AgentCore-style — legacy, parked path) or
        // code+state (direct Linear OAuth — Phase 2.0b Option 2).
        if (!sessionId && !(code && state)) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          // Settle on `finish` so the response body actually flushes before
          // the listener closes — otherwise the client hangs waiting for
          // bytes it never gets, leaving callers / tests deadlocked.
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
        // Build the discriminated union value here so callers don't
        // see the all-nullable shape. Direct-OAuth path takes
        // precedence: if Linear sent both session_id AND code+state
        // (shouldn't happen, but defensively…) we treat it as direct.
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
