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

import { logger } from './logger';

/** Slack API errors that should not count as failures for caller-side logging. */
const BENIGN_SLACK_ERRORS = new Set(['already_reacted', 'no_reaction']);

/**
 * POST to a Slack Web API method with a bot token.
 *
 * Logs errors at warn level rather than throwing — Slack reactions, replies, and
 * message cleanup are best-effort side-effects. Callers that need delivery to fail
 * the whole request (e.g. stream dispatchers) should inspect the return value
 * instead of relying on exceptions.
 *
 * @param botToken - xoxb-... bot token for the workspace.
 * @param method - Slack Web API method, e.g. 'chat.postMessage'.
 * @param body - JSON body to send.
 * @returns true if the call succeeded; false if the request failed at any layer.
 */
export async function slackFetch(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      logger.warn('Slack API returned non-2xx', { method, status: response.status });
      return false;
    }
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      if (result.error && BENIGN_SLACK_ERRORS.has(result.error)) {
        return true;
      }
      logger.warn('Slack API returned error', { method, error: result.error });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Slack API fetch threw', {
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
