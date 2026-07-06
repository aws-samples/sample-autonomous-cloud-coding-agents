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
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ApiError, CliError } from './errors';
import type { CreateTaskRequest, CreateTaskResponse, SuccessResponse } from './types';

export const WEBHOOK_SECRET_PREFIX = 'bgagent/webhook/';

export interface WebhookTestPayload extends CreateTaskRequest {
  readonly task_description: string;
  readonly repo: string;
}

export interface WebhookTestResult {
  readonly http_status: number;
  readonly body: unknown;
  readonly task_id?: string;
}

/** Compute HMAC-SHA256 signature for webhook task creation. */
export function signWebhookBody(secret: string, body: string): string {
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

/** Fetch webhook HMAC secret from Secrets Manager (operator credentials). */
export async function fetchWebhookSecret(region: string, webhookId: string): Promise<string> {
  const sm = new SecretsManagerClient({ region });
  let result;
  try {
    result = await sm.send(new GetSecretValueCommand({
      SecretId: `${WEBHOOK_SECRET_PREFIX}${webhookId}`,
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') {
      throw new CliError(
        `No webhook secret found for '${webhookId}'. Create the webhook first with `
        + '`bgagent webhook create`, or pass --secret explicitly.',
      );
    }
    throw err;
  }
  if (!result.SecretString) {
    throw new CliError(`Webhook secret for '${webhookId}' is empty.`);
  }
  return result.SecretString;
}

/** POST a signed sample payload to ``/webhooks/tasks``. */
export async function sendWebhookTestRequest(
  apiUrl: string,
  webhookId: string,
  secret: string,
  payload: WebhookTestPayload,
): Promise<WebhookTestResult> {
  const base = apiUrl.replace(/\/+$/, '');
  const url = `${base}/webhooks/tasks`;
  const body = JSON.stringify(payload);
  const signature = signWebhookBody(secret, body);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Id': webhookId,
      'X-Webhook-Signature': signature,
    },
    body,
  });

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const errBody = (json && typeof json === 'object'
      ? json
      : {}) as { error?: { code?: string; message?: string; request_id?: string } };
    const code = errBody.error?.code ?? 'WEBHOOK_TEST_FAILED';
    const message = errBody.error?.message ?? `HTTP ${response.status}`;
    const requestId = errBody.error?.request_id ?? '';
    throw new ApiError(response.status, code, message, requestId);
  }

  if (!json || typeof json !== 'object') {
    // A 2xx with a missing/non-JSON body means the gateway did not return the
    // documented envelope — surface it instead of reporting a hollow success.
    throw new ApiError(
      response.status,
      'WEBHOOK_TEST_MALFORMED_RESPONSE',
      `Webhook accepted (HTTP ${response.status}) but returned a non-JSON body.`,
      '',
    );
  }
  const envelope = json as SuccessResponse<CreateTaskResponse>;
  const taskId = envelope.data?.task_id;
  return {
    http_status: response.status,
    body: json,
    task_id: taskId,
  };
}

/** Default dry-run-safe sample payload for connectivity testing. */
export function buildSampleWebhookPayload(repo: string): WebhookTestPayload {
  return {
    repo,
    task_description: 'Webhook connectivity test from bgagent CLI (safe to cancel)',
    workflow_ref: 'coding/new-task-v1',
  };
}
