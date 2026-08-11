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

/** Environment variable carrying the stable per-Lambda component label. */
export const COMPONENT_ENV = 'ABCA_COMPONENT';

const DEFAULT_COMPONENT = 'api';
const UA_TOKEN_SAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

/** Replace every non-UA-token character with a hyphen. */
export function sanitizeUaValue(raw: string): string {
  return raw.replace(UA_TOKEN_SAFE, '-');
}

function componentLabel(): string {
  return sanitizeUaValue(process.env[COMPONENT_ENV]?.trim() || DEFAULT_COMPONENT);
}

/** Static ABCA solution-attribution segment for AWS SDK v3 clients. */
export function abcaUserAgent(): { customUserAgent: [string, string][] } {
  return { customUserAgent: [[`md/${SOLUTION_ID}`, componentLabel()]] };
}

/** Construct an attributed AWS SDK v3 client while preserving caller options. */
export function makeClient<C>(
  Ctor: new (cfg: any) => C,
  cfg: Record<string, unknown> = {},
): C {
  const callerUa = (cfg.customUserAgent as [string, string][] | undefined) ?? [];
  return new Ctor({
    ...cfg,
    customUserAgent: [...callerUa, ...abcaUserAgent().customUserAgent],
  });
}

/** Attributed DynamoDB document client. */
export function makeDocClient(cfg: Record<string, unknown> = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(makeClient(DynamoDBClient, cfg));
}
