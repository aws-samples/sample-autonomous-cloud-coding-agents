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
import sharedConstants from '../../../../contracts/constants.json';

const REQUEST_TIMEOUT_MS = 5000;
const FORGE_WEBTRIGGER_SUFFIX = sharedConstants.jira_app_actor.forge_webtrigger_suffix;
export const JIRA_APP_ACTOR_MIN_SECRET_LENGTH = sharedConstants.jira_app_actor.min_secret_length;
const PROXY_ERROR_CODES = new Set([
  'cloud_id_required',
  'invalid_comment_request',
  'invalid_update_comment_request',
  'invalid_issue_key',
  'invalid_json',
  'invalid_payload',
  'invalid_signature',
  'invalid_transition_request',
  'jira_request_failed',
  'method_not_allowed',
  'payload_too_large',
  'proxy_not_configured',
  'unsupported_operation',
]);

export interface JiraAppActorConfig {
  readonly proxyUrl: string;
  readonly sharedSecret: string;
}

export interface JiraAppActorRequest {
  readonly version: 1;
  readonly operation: 'comment' | 'update_comment' | 'get_transitions' | 'transition' | 'identity';
  readonly cloud_id: string;
  readonly issue_key?: string;
  readonly comment_id?: string;
  readonly body?: Record<string, unknown>;
  readonly transition_id?: string;
}

export type JiraAppActorResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | {
    readonly ok: false;
    readonly status?: number;
    readonly retryable: boolean;
    readonly errorCode?: string;
  };

function proxyErrorCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const error = (value as { error?: unknown }).error;
    return typeof error === 'string' && PROXY_ERROR_CODES.has(error) ? error : undefined;
  } catch {
    return undefined; // nosemgrep: ts-silent-success-masking -- invalid proxy bodies have no code
  }
}

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
      error_id: 'JIRA_APP_ACTOR_CONFIG_INVALID',
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
    const errorCode = proxyErrorCode(responseBody);
    const retryable = errorCode !== 'proxy_not_configured'
      && (result.status === 429 || result.status >= 500);
    const details = {
      error_id: retryable
        ? 'JIRA_APP_ACTOR_PROXY_TRANSIENT'
        : 'JIRA_APP_ACTOR_PROXY_REJECTED',
      status: result.status,
      retryable,
      operation: request.operation,
      jira_cloud_id: request.cloud_id,
      issue_key: request.issue_key,
      proxy_error_code: errorCode,
    };
    if (retryable) {
      logger.warn('Jira app-actor proxy returned retryable non-2xx', details);
    } else {
      logger.error('Jira app-actor proxy rejected request', details);
    }
    return { ok: false, status: result.status, retryable, errorCode };
  } catch (err) {
    logger.warn('Jira app-actor proxy request failed', {
      error_id: 'JIRA_APP_ACTOR_PROXY_NETWORK',
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
