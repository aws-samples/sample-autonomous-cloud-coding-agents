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

import * as crypto from 'crypto';
import { logger } from './logger';

const REQUEST_TIMEOUT_MS = 5000;
const FORGE_WEBTRIGGER_SUFFIX = '.webtrigger.atlassian.app';
export const JIRA_APP_ACTOR_MIN_SECRET_LENGTH = 32;

export interface JiraAppActorConfig {
  readonly proxyUrl: string;
  readonly sharedSecret: string;
}

export interface JiraAppActorRequest {
  readonly version: 1;
  readonly operation: 'comment' | 'get_transitions' | 'transition' | 'identity';
  readonly cloud_id: string;
  readonly issue_key?: string;
  readonly body?: Record<string, unknown>;
  readonly transition_id?: string;
}

export type JiraAppActorResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly status?: number; readonly retryable: boolean };

export function validateJiraAppActorProxyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !url.hostname.endsWith(FORGE_WEBTRIGGER_SUFFIX)
      || url.username
      || url.password
      || url.search
      || url.hash
      || !url.pathname.startsWith('/public/')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- invalid URL is the validator's null contract
  }
}

export function signJiraAppActorRequest(
  sharedSecret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${crypto
    .createHmac('sha256', sharedSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

export async function requestJiraAppActor(
  config: JiraAppActorConfig,
  request: JiraAppActorRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraAppActorResult> {
  const proxyUrl = validateJiraAppActorProxyUrl(config.proxyUrl);
  if (!proxyUrl || config.sharedSecret.length < JIRA_APP_ACTOR_MIN_SECRET_LENGTH) {
    logger.error('Jira app-actor configuration is invalid; refusing OAuth fallback', {
      proxy_url_valid: Boolean(proxyUrl),
      shared_secret_valid: config.sharedSecret.length >= JIRA_APP_ACTOR_MIN_SECRET_LENGTH,
    });
    return { ok: false, retryable: false };
  }

  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await fetchImpl(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bgagent-Timestamp': timestamp,
        'X-Bgagent-Signature': signJiraAppActorRequest(config.sharedSecret, timestamp, body),
      },
      body,
      signal: controller.signal,
    });
    const responseBody = await result.text();
    if (result.ok) {
      return { ok: true, status: result.status, body: responseBody };
    }
    const retryable = result.status === 429 || result.status >= 500;
    logger.warn('Jira app-actor proxy returned non-2xx', {
      status: result.status,
      retryable,
      operation: request.operation,
      jira_cloud_id: request.cloud_id,
      issue_key: request.issue_key,
    });
    return { ok: false, status: result.status, retryable };
  } catch (err) {
    logger.warn('Jira app-actor proxy request failed', {
      operation: request.operation,
      jira_cloud_id: request.cloud_id,
      issue_key: request.issue_key,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
