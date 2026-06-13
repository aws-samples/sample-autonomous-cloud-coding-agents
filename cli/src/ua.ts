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

/**
 * Outbound AWS SDK User-Agent solution attribution (#319) — CLI surface.
 *
 * Every AWS API call made by the `bgagent` CLI carries two ABCA
 * solution-attribution segments in the `User-Agent` header:
 *
 *     app/uksb-wt64nei4u6        <- native AWS_SDK_UA_APP_ID env (defaulted below)
 *     md/uksb-wt64nei4u6#cli     <- static, baked once at construction
 *
 * **The `app/` segment is emitted by the SDK itself** from the
 * `AWS_SDK_UA_APP_ID` environment variable (read natively by JS v3). The CLI
 * has no deploy-time env wiring, so {@link applyDefaultAppId} sets a default
 * value at process startup — but only when the env var is unset, so an
 * operator who exports `AWS_SDK_UA_APP_ID=''` (or any other value) keeps full
 * control and can opt out.
 *
 * This module otherwise owns only the **static `md/` segment** — a stable
 * `cli` label baked once via `customUserAgent` at client construction. No
 * per-request trace, no middleware.
 *
 * Counterparts: `agent/src/ua.py` and `cdk/src/handlers/shared/ua.ts`.
 * Solution id, wire format, and sanitization rules must stay identical.
 */

/** AWS solution-attribution id for ABCA. Per-surface literal by design. */
export const SOLUTION_ID = 'uksb-wt64nei4u6';

/** Stable per-component label: this surface IS the bgagent CLI. */
export const COMPONENT = 'cli';

/** Standard AWS SDK env var the JS v3 SDK reads natively for the `app/` segment. */
export const APP_ID_ENV = 'AWS_SDK_UA_APP_ID';

/**
 * RFC 7230 token charset. `#` is the scheme's structural separator and is
 * deliberately excluded. Mirrors `_ALLOWED` in `agent/src/ua.py`.
 */
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

/** Replace every non-UA-token char (incl. non-ASCII) with `-`. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

/**
 * Set `AWS_SDK_UA_APP_ID` to the ABCA solution id when the operator has not
 * already set it. Called once at CLI startup. Never overrides an existing
 * value — including an explicit empty string, which is a deliberate opt-out.
 */
export function applyDefaultAppId(): void {
  if (process.env[APP_ID_ENV] === undefined) {
    process.env[APP_ID_ENV] = SOLUTION_ID;
  }
}

/**
 * Client config fragment carrying the static ABCA `md/` segment. Spread into
 * any SDK v3 client constructor: `new CognitoIdentityProviderClient({ region,
 * ...abcaUserAgent() })`. Renders `md/uksb-wt64nei4u6#cli`.
 */
export function abcaUserAgent(): { customUserAgent: [string, string][] } {
  return { customUserAgent: [[`md/${SOLUTION_ID}`, sanitizeUaValue(COMPONENT)]] };
}
