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
 * Outbound AWS SDK User-Agent solution tracking (#319).
 *
 * Every AWS API call made by the Lambda handlers carries two ABCA
 * solution-tracking segments in the `User-Agent` header:
 *
 *     app/uksb-wt64nei4u6/{STACKNAME}                 (only when ABCA_STACK_NAME set)
 *     md/uksb-wt64nei4u6#{COMPONENT}[#{TRACE}]
 *
 * Both ride the verbatim `customUserAgent` path — NOT the sanitizing
 * `userAgentAppId` config field, whose allowed charset excludes `/` and would
 * mangle the `uksb-wt64nei4u6/` separator into `-`. Because the raw path
 * applies only pass-through escaping to our token-safe characters, this
 * module sanitizes `{STACKNAME}` and `{TRACE}` itself.
 *
 * The static part is baked once at client construction via
 * {@link abcaUserAgent}. The optional `#{TRACE}` suffix (the handler's ulid
 * request id, or a task id) is appended **per request** by the middleware
 * {@link withAbcaTrace} adds — never via client config — so module-level
 * cached clients keep their connection pools across trace changes.
 *
 * Trace state is a module-level variable: a Lambda execution environment
 * processes one invocation at a time, so ambient module state is safe (and
 * survives across the SDK's async internals where per-call threading can't).
 *
 * Counterparts: `agent/src/ua.py` (Python agent runtime) and `cli/src/ua.ts`
 * (bgagent CLI). Solution id, wire format, and sanitization rules must stay
 * identical across all three.
 */

/**
 * AWS solution-tracking id for ABCA. Deploy-time counterpart (#292) lives in
 * the CloudFormation stack description in `cdk/src/main.ts`. Per-surface
 * literal by design — see PR #338.
 */
export const SOLUTION_ID = 'uksb-wt64nei4u6';

/**
 * Env var carrying the stable per-component label (`api`, `webhook`,
 * `orchestr`) — set per-Lambda by the CDK constructs. Shared handler modules
 * are bundled into multiple Lambdas, so identity must come from the
 * environment, not from code.
 */
export const COMPONENT_ENV = 'ABCA_COMPONENT';

/** Env var carrying the deployed CloudFormation stack name (set by CDK). */
export const STACK_NAME_ENV = 'ABCA_STACK_NAME';

/** Default component label when ABCA_COMPONENT is absent (REST API surface). */
const DEFAULT_COMPONENT = 'api';

/**
 * App-id budget: the documented 50-char cap on the value, minus
 * `uksb-wt64nei4u6/` (16 chars), leaves 34 for the stack name.
 */
const STACK_NAME_MAX = 34;

/**
 * RFC 7230 token charset (the UA product-token alphabet). `/` and `#` are
 * deliberately excluded — they are the structural separators of the scheme.
 * Mirrors `_ALLOWED` in `agent/src/ua.py`.
 */
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

let currentTrace: string | undefined;

/** Replace every non-UA-token char (incl. non-ASCII) with `-`. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

/** The component label for this Lambda (from env, sanitized). */
function componentLabel(): string {
  return sanitizeUaValue(process.env[COMPONENT_ENV]?.trim() || DEFAULT_COMPONENT);
}

/** The static `md/` segment as it renders on the wire. */
function mdSegment(): string {
  return `md/${SOLUTION_ID}#${componentLabel()}`;
}

/**
 * Client config fragment carrying the static ABCA UA segments.
 *
 * Spread into any SDK v3 client constructor:
 * `new DynamoDBClient({ ...abcaUserAgent() })`. Each entry is a
 * `[name, value?]` user-agent pair. The SDK's escaper treats the two
 * positions differently: the *name* is split on `/`, each part escaped
 * (where `#` is NOT allowed and becomes `-`), and rejoined with `/`; the
 * *value* allows `#` and is joined to the name with `#`. So:
 *
 *  - the `app/` segment is a single-element pair — its only separators are
 *    slashes, which survive the name path (this is what keeps the literal
 *    `/` that the sanitizing app-id config field would destroy);
 *  - the `md/` segment is a two-element pair `['md/{id}', component]`,
 *    rendering `md/{id}#component` — the `#` comes from the SDK's own
 *    name#value join, not from our string (a `#` inside the name would be
 *    escaped to `-`).
 */
export function abcaUserAgent(): { customUserAgent: ([string] | [string, string])[] } {
  const pairs: ([string] | [string, string])[] = [];
  const stackName = process.env[STACK_NAME_ENV]?.trim();
  if (stackName) {
    // Sanitize FIRST, then clip, so a replaced char can't be re-split.
    const clipped = sanitizeUaValue(stackName).slice(0, STACK_NAME_MAX);
    pairs.push([`app/${SOLUTION_ID}/${clipped}`]);
  }
  pairs.push([`md/${SOLUTION_ID}`, componentLabel()]);
  return { customUserAgent: pairs };
}

/**
 * Set (or clear, by omitting the argument) the ambient trace handle.
 * Handlers call this with their per-invocation request id right after
 * minting it; the orchestrator uses the task id.
 */
export function setAbcaTrace(handle?: string): void {
  currentTrace = handle || undefined;
}

/** Current trace handle, sanitized to UA-token-safe ASCII, or undefined. */
export function getAbcaTrace(): string | undefined {
  return currentTrace ? sanitizeUaValue(currentTrace) : undefined;
}

/**
 * Minimal structural view of an SDK v3 client middleware stack — enough to
 * add the trace middleware without importing @smithy/types (which is not a
 * declared dependency of the handlers).
 */
interface MiddlewareStackLike {
  addRelativeTo(middleware: unknown, options: Record<string, unknown>): void;
}

/**
 * Append `#{TRACE}` to the outgoing User-Agent headers on every request.
 *
 * Adds a middleware right after the SDK's own `getUserAgentMiddleware`
 * (step `build`) that splices the current trace onto the static `md/`
 * segment in both `user-agent` and `x-amz-user-agent`. Only the header
 * strings change — the client, its config, and its connection pool are
 * untouched, so cached/module-level clients are reused freely across traces.
 *
 * No-ops when the client has no middleware stack: ~40 existing test suites
 * mock client constructors as `jest.fn(() => ({}))`, and module-level
 * instrumentation must not crash under those mocks. Real SDK clients always
 * have a stack, so the guard is test-environment-only.
 */
export function withAbcaTrace<T>(client: T): T {
  const stack = (client as { middlewareStack?: MiddlewareStackLike }).middlewareStack;
  if (!stack || typeof stack.addRelativeTo !== 'function') {
    return client;
  }
  const md = mdSegment();
  stack.addRelativeTo(
    (next: (args: unknown) => Promise<unknown>) => async (args: unknown) => {
      const trace = getAbcaTrace();
      const request = (args as { request?: { headers?: Record<string, string> } }).request;
      if (trace && request?.headers) {
        for (const header of ['user-agent', 'x-amz-user-agent']) {
          const value = request.headers[header];
          if (value && value.includes(md)) {
            request.headers[header] = value.replace(md, `${md}#${trace}`);
          }
        }
      }
      return next(args);
    },
    {
      name: 'abcaUaTraceMiddleware',
      relation: 'after',
      toMiddleware: 'getUserAgentMiddleware',
      override: true,
    },
  );
  return client;
}
