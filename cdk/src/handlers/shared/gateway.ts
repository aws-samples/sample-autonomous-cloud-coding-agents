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

import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Extract the authenticated user_id from the API Gateway event.
 *
 * Two authorizer shapes place the identity in different spots:
 * - The native Cognito authorizer sets `authorizer.claims.sub`.
 * - A custom REQUEST authorizer (webhook / API-key) sets `authorizer.userId`
 *   as a top-level context value.
 *
 * Both resolve to the same IdP-namespaced platform user ID, so a handler behind
 * either authorizer reads identity through this one call.
 * @param event - the API Gateway proxy event.
 * @returns the platform user ID, or null if missing.
 */
export function extractUserId(event: APIGatewayProxyEvent): string | null {
  const authorizer = event.requestContext.authorizer;
  if (!authorizer) return null;
  if (typeof authorizer.claims?.sub === 'string') return authorizer.claims.sub;
  if (typeof authorizer.userId === 'string') return authorizer.userId;
  return null;
}

/**
 * Generate a branch name from task ID and description.
 * Pattern: `bgagent/{taskId}/{slug}`
 * @param taskId - the ULID task identifier.
 * @param description - optional task description or issue title used to generate slug.
 * @returns the branch name string.
 */
export function generateBranchName(taskId: string, description?: string): string {
  const slug = slugify(description);
  if (slug) {
    return `bgagent/${taskId}/${slug}`;
  }
  return `bgagent/${taskId}/task`;
}

/**
 * Build channel metadata from the API Gateway event context.
 * @param event - the API Gateway proxy event.
 * @returns channel metadata record with source IP, user agent, and request ID.
 */
export function buildChannelMetadata(event: APIGatewayProxyEvent): Record<string, string> {
  return {
    source_ip: event.requestContext.identity?.sourceIp ?? 'unknown',
    user_agent: event.requestContext.identity?.userAgent ?? 'unknown',
    api_request_id: event.requestContext.requestId ?? 'unknown',
  };
}

/**
 * Extract user ID and webhook ID from a REQUEST authorizer context.
 * The webhook authorizer injects these as top-level keys in event.requestContext.authorizer.
 * @param event - the API Gateway proxy event.
 * @returns object with userId and webhookId, or null if context is missing.
 */
export function extractWebhookContext(event: APIGatewayProxyEvent): { userId: string; webhookId: string } | null {
  const authCtx = event.requestContext.authorizer;
  if (!authCtx || typeof authCtx.userId !== 'string' || typeof authCtx.webhookId !== 'string') return null;
  return { userId: authCtx.userId, webhookId: authCtx.webhookId };
}

/**
 * Build channel metadata for a webhook-sourced request.
 * @param event - the API Gateway proxy event.
 * @param webhookId - the webhook integration ID.
 * @returns channel metadata record.
 */
export function buildWebhookChannelMetadata(
  event: APIGatewayProxyEvent,
  webhookId: string,
): Record<string, string> {
  return {
    webhook_id: webhookId,
    source_ip: event.requestContext.identity?.sourceIp ?? 'unknown',
    user_agent: event.requestContext.identity?.userAgent ?? 'unknown',
    api_request_id: event.requestContext.requestId ?? 'unknown',
  };
}

/**
 * Convert a description string to a URL-safe slug.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses consecutive hyphens,
 * trims leading/trailing hyphens, and truncates to 50 characters.
 */
/** Maximum slug length for gateway path segments. */
const SLUG_MAX_LENGTH = 50;

function slugify(text?: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
}
