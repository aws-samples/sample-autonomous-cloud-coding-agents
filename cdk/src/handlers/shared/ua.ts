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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** AWS solution-attribution id for ABCA. */
export const SOLUTION_ID = 'uksb-wt64nei4u6';

const COMPONENT_ENV = 'ABCA_COMPONENT';

const DEFAULT_COMPONENT = 'api';

/**
 * RFC 7230 token charset (the UA product-token alphabet), without `#`: the SDK
 * joins a user-agent pair as name#value. The `u` flag matches by code point, so
 * a character outside the Basic Multilingual Plane is one `-`, not two.
 */
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/gu;

/** Replace every non-UA-token char (incl. non-ASCII) with `-`. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

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

/**
 * The single attributed way to construct an AWS SDK v3 client. Composes the
 * static `md/` segment ({@link abcaUserAgent}) into the client config.
 * Caller-supplied opts (region, timeouts) are preserved, and a caller who
 * supplies their own `customUserAgent` pairs keeps them, with the ABCA `md/`
 * pair appended (the SDK renders all pairs).
 */
export function makeClient<C>(
  Ctor: new (cfg: any) => C,
  cfg: Record<string, unknown> = {},
): C {
  const callerUa = (cfg.customUserAgent as [string, string][] | undefined) ?? [];
  return new Ctor({ ...cfg, customUserAgent: [...callerUa, ...abcaUserAgent().customUserAgent] });
}

/** Attributed `DynamoDBDocumentClient` — the wrapper form, in one call. */
export function makeDocClient(cfg: Record<string, unknown> = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(makeClient(DynamoDBClient, cfg));
}
