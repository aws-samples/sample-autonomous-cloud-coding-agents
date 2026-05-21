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
 * Subset of GitHub's `deployment_status` payload we route on. Vercel
 * (and any GitHub-Deployments-API-aware deploy backend) posts this when
 * a preview / production deploy finishes. The interesting fields:
 *  - `deployment_status.state`: `success` | `failure` | `error` | `pending` | `in_progress`
 *  - `deployment_status.environment_url`: the deployed URL — lives on the
 *    *status* object, not the deployment itself. (The deployment object
 *    only has the immutable SHA + environment name; URL changes per
 *    status update — first `pending` has no URL, then `success` fills
 *    it in.)
 *  - `deployment.environment`: `Preview` | `Production`
 *  - `deployment.sha`: the commit SHA the deploy is for (used to map
 *    back to a PR via the GitHub commit-pulls API)
 *
 * Full payload is forwarded to the processor without re-serialization
 * risk — the processor parses its own copy from the raw body.
 */
interface GitHubDeploymentStatusEnvelope {
  readonly action?: string;
  readonly deployment_status?: {
    readonly id?: number;
    readonly state?: string;
    readonly environment_url?: string;
  };
  readonly deployment?: {
    readonly id?: number;
    readonly sha?: string;
    readonly environment?: string;
  };
  readonly repository?: {
    readonly full_name?: string;
  };
}

/**
 * POST /v1/github/webhook — GitHub webhook receiver.
 *
 * Verifies `X-Hub-Signature-256` (per
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
 * filters to `deployment_status` events from Vercel-style preview deploys,
 * dedups on `(repo, deployment_id, status_id)`, and async-invokes the
 * processor Lambda so we can ack within GitHub's 10s timeout. Other event
 * types (push, pull_request, ping, …) get an immediate 200 so GitHub
 * doesn't retry them.
 *
 * Why `deployment_status` and not `workflow_run`:
 * Vercel doesn't run a GitHub Action to deploy — it posts directly to
 * the GitHub Deployments API. `deployment_status` carries the deploy
 * URL (`deployment.environment_url`) and the SHA the deploy is for,
 * letting us route to the correct ABCA task and screenshot the right
 * URL without extra API calls.
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

    let payload: GitHubDeploymentStatusEnvelope;
    try {
      payload = JSON.parse(event.body) as GitHubDeploymentStatusEnvelope;
    } catch (err) {
      logger.warn('GitHub webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    // Vercel posts intermediate states (`pending`, `in_progress`) before
    // the terminal `success` / `failure` / `error`. Only `success` deploys
    // are worth screenshotting; everything else gets a clean 200 so GitHub
    // doesn't retry.
    if (payload.deployment_status?.state !== 'success') {
      return jsonResponse(200, { ok: true, skipped_state: payload.deployment_status?.state });
    }

    // v1 scope: preview deploys only. Production deploys are skipped here
    // (followup #87 in the plan covers post-merge screenshots if useful).
    // Vercel labels its preview environment `Preview`; configurable via
    // `SCREENSHOT_TARGET_ENVIRONMENT` env so non-Vercel backends with
    // different naming can flip it without a code change.
    const targetEnv = process.env.SCREENSHOT_TARGET_ENVIRONMENT ?? 'Preview';
    if (payload.deployment?.environment !== targetEnv) {
      return jsonResponse(200, {
        ok: true,
        skipped_environment: payload.deployment?.environment,
      });
    }

    const repo = payload.repository?.full_name;
    const deploymentId = payload.deployment?.id;
    const statusId = payload.deployment_status?.id;
    if (!repo || !deploymentId || !statusId) {
      logger.warn('GitHub deployment_status webhook missing repo, deployment id, or status id', {
        repo,
        deployment_id: deploymentId,
        status_id: statusId,
      });
      return jsonResponse(400, { error: 'Missing repo, deployment id, or status id' });
    }

    if (!payload.deployment_status?.environment_url) {
      logger.warn('GitHub deployment_status webhook missing environment_url; cannot screenshot', {
        repo,
        deployment_id: deploymentId,
      });
      return jsonResponse(200, { ok: true, skipped_no_url: true });
    }

    // Dedup on (repo, deployment_id, status_id). A single deploy lifecycle
    // can emit multiple statuses; using the status id as the third leg
    // keeps reruns of the same status (GitHub retries on 5xx) collapsed
    // while distinct status transitions stay distinct.
    const dedupKey = `${repo}#${deploymentId}#${statusId}`;
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
        repo,
        deployment_id: deploymentId,
        status_id: statusId,
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
