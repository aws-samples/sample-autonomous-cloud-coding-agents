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

import { getLinearSecret } from './linear-verify';
import { logger } from './logger';

/**
 * Lambda-side helper for posting comments and reactions onto Linear issues
 * via direct GraphQL. Used by the webhook processor to give users feedback
 * on pre-container failures (guardrail block, concurrency cap, unmapped
 * project, etc.) — paths where the agent never starts and the agent-side
 * Linear MCP / `linear_reactions.py` cannot run.
 *
 * All calls are best-effort. Errors are logged at WARN and swallowed —
 * Linear feedback is advisory and must never gate task-rejection logic.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const REQUEST_TIMEOUT_MS = 5000;

/** Reaction emoji short-code for the failure marker. Matches `EMOJI_FAILURE` in `agent/src/linear_reactions.py`. */
const EMOJI_FAILURE = 'x';

const COMMENT_CREATE_MUTATION = `
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}
`.trim();

const REACTION_CREATE_MUTATION = `
mutation ReactIssue($issueId: String!, $emoji: String!) {
  reactionCreate(input: { issueId: $issueId, emoji: $emoji }) {
    success
  }
}
`.trim();

async function graphqlRequest(
  apiToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': apiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('Linear feedback GraphQL non-2xx', { status: resp.status });
      return false;
    }
    const body = (await resp.json()) as { errors?: unknown };
    if (body.errors) {
      logger.warn('Linear feedback GraphQL errors', { errors: body.errors });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Linear feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveToken(secretArn: string): Promise<string | null> {
  try {
    return await getLinearSecret(secretArn);
  } catch (err) {
    logger.warn('Linear feedback could not resolve API token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Post a comment onto a Linear issue. Returns true on success, false on any failure
 * (network, auth, GraphQL errors). Never throws — callers proceed regardless.
 */
export async function postIssueComment(
  apiTokenSecretArn: string,
  issueId: string,
  body: string,
): Promise<boolean> {
  const token = await resolveToken(apiTokenSecretArn);
  if (!token) return false;
  return graphqlRequest(token, COMMENT_CREATE_MUTATION, { issueId, body });
}

/**
 * Add an emoji reaction onto a Linear issue. Defaults to ❌ — the failure marker
 * the agent uses on the success/failure side. Returns true on success.
 */
export async function addIssueReaction(
  apiTokenSecretArn: string,
  issueId: string,
  emoji: string = EMOJI_FAILURE,
): Promise<boolean> {
  const token = await resolveToken(apiTokenSecretArn);
  if (!token) return false;
  return graphqlRequest(token, REACTION_CREATE_MUTATION, { issueId, emoji });
}

/**
 * Convenience: post a feedback comment **and** drop a ❌ reaction in one call.
 * Both calls run in parallel; both are best-effort. Returns void — callers
 * never branch on the result.
 */
export async function reportIssueFailure(
  apiTokenSecretArn: string,
  issueId: string,
  message: string,
): Promise<void> {
  await Promise.allSettled([
    postIssueComment(apiTokenSecretArn, issueId, message),
    addIssueReaction(apiTokenSecretArn, issueId, EMOJI_FAILURE),
  ]);
}
