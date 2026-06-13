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
 * Outbound AWS SDK User-Agent solution tracking (#319) — CLI surface.
 *
 * Every AWS API call made by `bgagent` carries:
 *
 *     app/uksb-wt64nei4u6/{STACKNAME}     (only when config has stack_name)
 *     md/uksb-wt64nei4u6#cli[#{PID}]
 *
 * CLI-local mirror of `cdk/src/handlers/shared/ua.ts` (the CLI package
 * cannot import from the CDK package — same mirroring convention as
 * `cli/src/types.ts`). Solution id, wire format, and sanitization rules
 * must stay identical; `agent/src/ua.py` is the Python counterpart.
 *
 * The component label is hardcoded (`cli`); the stack name comes from the
 * optional `stack_name` field in `~/.bgagent/config.json`. The trace handle
 * is the CLI process pid, set once at startup in `bin/bgagent.ts` and
 * appended per-request by the {@link withAbcaTrace} middleware.
 */

import { tryLoadConfig } from './config';

/**
 * AWS solution-tracking id for ABCA. Deploy-time counterpart (#292) lives in
 * the CloudFormation stack description in `cdk/src/main.ts`.
 */
export const SOLUTION_ID = 'uksb-wt64nei4u6';

/** Stable per-component label: this surface IS the bgagent CLI. */
const COMPONENT = 'cli';

/** App-id budget: 50-char value cap minus `uksb-wt64nei4u6/` (16) = 34. */
const STACK_NAME_MAX = 34;

/**
 * RFC 7230 token charset; `/` and `#` deliberately excluded (structural
 * separators of the scheme). Mirrors the CDK and Python implementations.
 */
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

let currentTrace: string | undefined;

/** Replace every non-UA-token char (incl. non-ASCII) with `-`. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

/**
 * Client config fragment carrying the static ABCA UA segments. Spread into
 * every SDK client constructor: `new SecretsManagerClient({ region, ...abcaUserAgent() })`.
 *
 * Pair semantics (mirrors the CDK module): the `app/` segment is a
 * single-element pair so its literal `/` separators survive the SDK's
 * name-position escaping; the `md/` pair lets the SDK's own `name#value`
 * join produce the `#`.
 */
export function abcaUserAgent(): { customUserAgent: ([string] | [string, string])[] } {
  const pairs: ([string] | [string, string])[] = [];
  const stackName = tryLoadConfig()?.stack_name?.trim();
  if (stackName) {
    // Sanitize FIRST, then clip, so a replaced char can't be re-split.
    const clipped = sanitizeUaValue(stackName).slice(0, STACK_NAME_MAX);
    pairs.push([`app/${SOLUTION_ID}/${clipped}`]);
  }
  pairs.push([`md/${SOLUTION_ID}`, COMPONENT]);
  return { customUserAgent: pairs };
}

/** Set (or clear) the ambient trace handle (the CLI pid, set at startup). */
export function setAbcaTrace(handle?: string): void {
  currentTrace = handle || undefined;
}

/** Current trace handle, sanitized to UA-token-safe ASCII, or undefined. */
export function getAbcaTrace(): string | undefined {
  return currentTrace ? sanitizeUaValue(currentTrace) : undefined;
}

/** Structural view of a client middleware stack (avoids @smithy/types dep). */
interface MiddlewareStackLike {
  addRelativeTo(middleware: unknown, options: Record<string, unknown>): void;
}

/**
 * Append `#{TRACE}` to the outgoing User-Agent headers on every request by
 * splicing onto the static `md/` segment, after the SDK's own
 * `getUserAgentMiddleware` has rendered the headers. Mutates only the
 * header strings; the client and its connection pool are untouched.
 * No-ops on clients without a middleware stack (jest constructor mocks).
 */
export function withAbcaTrace<T>(client: T): T {
  const stack = (client as { middlewareStack?: MiddlewareStackLike }).middlewareStack;
  if (!stack || typeof stack.addRelativeTo !== 'function') {
    return client;
  }
  const md = `md/${SOLUTION_ID}#${COMPONENT}`;
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
