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

const COMPONENT = 'cli';

/** Standard AWS SDK env var the JS v3 SDK reads natively for the `app/` segment. */
export const APP_ID_ENV = 'AWS_SDK_UA_APP_ID';

/**
 * RFC 7230 token charset. `#` is the scheme's structural separator and is
 * excluded. The `u` flag matches by code point, so a character outside
 * the Basic Multilingual Plane is one `-`, not two.
 */
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/gu;

/** Replace every non-UA-token char (incl. non-ASCII) with `-`. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

/**
 * Set `AWS_SDK_UA_APP_ID` to the ABCA solution id when the operator has not
 * already set it. Never overrides an existing
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

/**
 * The single attributed way to construct an AWS SDK v3 client. Composes the
 * static `md/` segment ({@link abcaUserAgent}) into the client config.
 * Caller-supplied opts (region, timeouts) are preserved — and a caller who
 * supplies their own `customUserAgent` pairs keeps them, with the ABCA `md/`
 * pair appended rather than overwritten (the SDK renders all pairs).
 */
export function makeClient<C>(
  Ctor: new (cfg: { customUserAgent: [string, string][] }) => C,
  cfg: Record<string, unknown> = {},
): C {
  const callerUa = (cfg.customUserAgent as [string, string][] | undefined) ?? [];
  return new Ctor({ ...cfg, customUserAgent: [...callerUa, ...abcaUserAgent().customUserAgent] });
}

/** Attributed `DynamoDBDocumentClient`: {@link makeClient} applied to the wrapped `DynamoDBClient`. */
export function makeDocClient(cfg: Record<string, unknown> = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(makeClient(DynamoDBClient, cfg));
}
