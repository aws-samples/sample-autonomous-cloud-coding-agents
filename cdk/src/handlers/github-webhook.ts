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

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  type GitHubDeploymentStatusPayload,
  validateDeploymentStatusPayload,
} from './shared/github-deployment-status';
import { verifyGitHubRequest } from './shared/github-webhook-verify';
import { logger } from './shared/logger';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const WEBHOOK_SECRET_ARN = process.env.GITHUB_WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.GITHUB_WEBHOOK_DEDUP_TABLE_NAME!;
const PROCESSOR_FUNCTION_NAME = process.env.GITHUB_WEBHOOK_PROCESSOR_FUNCTION_NAME!;

/**
 * Dedup window. GitHub redelivers a webhook up to 5 times when our
 * receiver returns 5xx (each retry ~ exponential backoff, max ~30s
 * apart). 1h is generous coverage with slack for clock skew.
 */
const DEDUP_TTL_SECONDS = 60 * 60;

/**
 * POST /v1/github/webhook — GitHub webhook receiver.
 *
 * Verifies `X-Hub-Signature-256` (per
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
 * filters to successful `deployment_status` events whose environment
 * matches `SCREENSHOT_TARGET_ENVIRONMENT` (default `Preview`), dedups
 * on `(repo, deployment_id, status_id)`, and async-invokes the
 * processor Lambda so we can ack within GitHub's 10s timeout. Other
 * event types (push, pull_request, ping, …) get an immediate 200 so
 * GitHub doesn't retry them.
 *
 * Why `deployment_status` and not `workflow_run`:
 * Most managed hosting providers (Vercel, Netlify, Amplify) don't run
 * a GitHub Action to deploy — they post directly to the GitHub
 * Deployments API. Self-hosted CI typically calls the same API at the
 * end of its workflow. `deployment_status` carries the deploy URL
 * (`deployment_status.environment_url`) and the SHA the deploy is
 * for, letting us route to the correct ABCA task and screenshot the
 * right URL without provider-specific extra API calls.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    const signature = event.headers['X-Hub-Signature-256'] ?? event.headers['x-hub-signature-256'] ?? '';
    if (!signature) {
      logger.warn('GitHub webhook missing X-Hub-Signature-256 header');
      return jsonResponse(401, { error: 'Missing signature' });
    }

    if (!await verifyGitHubRequest(WEBHOOK_SECRET_ARN, signature, event.body)) {
      logger.warn('Invalid GitHub webhook signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    const eventType = event.headers['X-GitHub-Event'] ?? event.headers['x-github-event'] ?? '';

    // GitHub fires `ping` once when the webhook is first registered. Ack with
    // 200 so the GitHub UI shows the webhook as "delivered successfully" and
    // operators don't think setup failed.
    if (eventType === 'ping') {
      return jsonResponse(200, { ok: true, ping: true });
    }

    // Anything other than deployment_status is silently 200'd. We'd rather
    // drop unrelated events at the door than have them clutter the
    // processor's invoke / log volume.
    if (eventType !== 'deployment_status') {
      logger.info('Ignoring non-deployment_status GitHub webhook', { event_type: eventType });
      return jsonResponse(200, { ok: true });
    }

    let raw: GitHubDeploymentStatusPayload;
    try {
      raw = JSON.parse(event.body) as GitHubDeploymentStatusPayload;
    } catch (err) {
      logger.warn('GitHub webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    // Filter pre-validate so common skip-paths return early without
    // logging a "missing fields" warn for an in-progress event.
    if (raw.deployment_status?.state !== 'success') {
      return jsonResponse(200, { ok: true, skipped_state: raw.deployment_status?.state });
    }

    // Filter to a configured environment name. Defaults to `Preview`
    // because Vercel labels per-PR deploys that way, but every provider
    // uses different conventions:
    //   - Vercel preview:           `Preview`
    //   - AWS Amplify Hosting:      branch name (e.g. `main`, `feat/x`)
    //   - GitHub Actions deploys:   whatever the workflow passes to
    //                               `actions/create-deployment`
    //   - Netlify deploy previews:  `Deploy Preview <PR#>`
    // Operators on non-Vercel backends override via
    // `SCREENSHOT_TARGET_ENVIRONMENT` (Lambda env var, redeploy required).
    const targetEnv = process.env.SCREENSHOT_TARGET_ENVIRONMENT ?? 'Preview';
    if (raw.deployment?.environment !== targetEnv) {
      return jsonResponse(200, {
        ok: true,
        skipped_environment: raw.deployment?.environment,
      });
    }

    // GitHub sometimes fires `success` deployment_status events without
    // an `environment_url` (e.g. when the provider hasn't published the
    // URL yet but the build itself succeeded). 200-skip these so GitHub
    // doesn't retry — the next status update will carry the URL.
    if (!raw.deployment_status?.environment_url) {
      return jsonResponse(200, { ok: true, skipped_no_url: true });
    }

    // Single validate call shared with the processor — guarantees the
    // processor doesn't reject a payload the receiver admitted (closes
    // the "missing deployment.sha" gap where the processor would drop
    // events the receiver had dispatched). Runs after the state /
    // environment / env-url skip-paths so 200s don't log a "missing
    // fields" warn.
    const payload = validateDeploymentStatusPayload(raw);
    if (!payload) {
      logger.warn('GitHub deployment_status webhook missing required fields', {
        repo: raw.repository?.full_name,
        deployment_id: raw.deployment?.id,
        status_id: raw.deployment_status?.id,
        sha_present: Boolean(raw.deployment?.sha),
      });
      return jsonResponse(400, { error: 'Missing required deployment_status fields' });
    }

    // Dedup on (repo, deployment_id, status_id). A single deploy lifecycle
    // can emit multiple statuses; using the status id as the third leg
    // keeps reruns of the same status (GitHub retries on 5xx) collapsed
    // while distinct status transitions stay distinct.
    const dedupKey = `${payload.repoFullName}#${payload.deploymentId}#${payload.statusId}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(new PutCommand({
        TableName: DEDUP_TABLE_NAME,
        Item: {
          dedup_key: dedupKey,
          created_at: new Date().toISOString(),
          ttl: nowSeconds + DEDUP_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(dedup_key)',
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        logger.info('GitHub webhook dedup hit — skipping reprocess', {
          dedup_key: dedupKey,
        });
        return jsonResponse(200, { ok: true, deduped: true });
      }
      throw err;
    }

    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: PROCESSOR_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({ raw_body: event.body })),
      }));
    } catch (invokeErr) {
      logger.error('Failed to invoke GitHub webhook processor', {
        error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
        repo: payload.repoFullName,
        deployment_id: payload.deploymentId,
        status_id: payload.statusId,
      });
      // Roll the dedup row back so GitHub's retry can try dispatch again.
      try {
        await ddb.send(new DeleteCommand({
          TableName: DEDUP_TABLE_NAME,
          Key: { dedup_key: dedupKey },
        }));
      } catch (cleanupErr) {
        logger.warn('Failed to roll back GitHub webhook dedup row after invoke failure', {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          dedup_key: dedupKey,
        });
      }
      return jsonResponse(500, { error: 'Dispatch failed' });
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    logger.error('GitHub webhook handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
