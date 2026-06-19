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
 * Outbound AWS SDK User-Agent solution attribution (#319).
 *
 * Every AWS API call made by the Lambda handlers carries two ABCA
 * solution-attribution segments in the `User-Agent` header:
 *
 *     app/uksb-wt64nei4u6#{STACKNAME}   <- native AWS_SDK_UA_APP_ID env (no code here)
 *     md/uksb-wt64nei4u6#{COMPONENT}    <- static, baked once at construction
 *
 * **The `app/` segment is emitted by the SDK itself.** The JS v3 SDK reads
 * the `AWS_SDK_UA_APP_ID` environment variable natively (`util-user-agent-node`
 * `NODE_APP_ID_CONFIG_OPTIONS.environmentVariableSelector`) and renders it as
 * `app/{value}`. The app-id value charset *includes* `#` (`UA_VALUE_ESCAPE_REGEX`
 * permits it), so the `uksb-wt64nei4u6#{stack}` form survives verbatim. CDK
 * sets that env var on every Lambda, so this module contributes **nothing** to
 * `app/` — and a customer can suppress it by setting the env var to `''`.
 * (This is the key simplification over the original `/`-separated design,
 * which had to bypass the native field because `/` is not a legal app-id
 * character. Using `#` keeps it native.)
 *
 * This module owns only the **static `md/` segment** — a stable per-component
 * label baked once via `customUserAgent` at client construction. There is
 * intentionally no per-request trace handle and no middleware machinery:
 * module-level cached clients are never re-pinned, and request correlation is
 * owned by X-Ray / structured-log request ids (#245), not the User-Agent.
 *
 * Counterparts: `agent/src/ua.py` (Python agent runtime) and `cli/src/ua.ts`
 * (bgagent CLI). Solution id, wire format, and sanitization rules must stay
 * identical across all three.
 */

/**
 * AWS solution-attribution id for ABCA. Deploy-time counterpart (#292) lives
 * in the CloudFormation stack description in `cdk/src/main.ts`. Per-surface
 * literal by design.
 */
export const SOLUTION_ID = 'uksb-wt64nei4u6';

/**
 * Env var carrying the stable per-component label (`api`, `webhook`,
 * `orchestr`) — set per-Lambda by the CDK constructs. Shared handler modules
 * are bundled into multiple Lambdas, so identity must come from the
 * environment, not from code.
 */
export const COMPONENT_ENV = 'ABCA_COMPONENT';

/** Default component label when ABCA_COMPONENT is absent (REST API surface). */
const DEFAULT_COMPONENT = 'api';

/**
 * RFC 7230 token charset (the UA product-token alphabet). `#` is the scheme's
 * structural separator and is deliberately excluded so a hostile label cannot
 * inject extra segments. Mirrors `_ALLOWED` in `agent/src/ua.py`.
 */
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

/** Replace every non-UA-token char (incl. non-ASCII) with `-`. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

/** The component label for this Lambda (from env, sanitized). */
function componentLabel(): string {
  return sanitizeUaValue(process.env[COMPONENT_ENV]?.trim() || DEFAULT_COMPONENT);
}

/**
 * Client config fragment carrying the static ABCA `md/` segment.
 *
 * Spread into any SDK v3 client constructor:
 * `new DynamoDBClient({ ...abcaUserAgent() })`. The entry is a `[name, value]`
 * user-agent pair `['md/uksb-wt64nei4u6', component]`, which the SDK renders
 * as `md/uksb-wt64nei4u6#component` (the `#` comes from the SDK's own
 * name#value join). The `app/` segment is contributed separately by the SDK
 * from `AWS_SDK_UA_APP_ID` and is not produced here.
 */
export function abcaUserAgent(): { customUserAgent: [string, string][] } {
  return { customUserAgent: [[`md/${SOLUTION_ID}`, componentLabel()]] };
}
