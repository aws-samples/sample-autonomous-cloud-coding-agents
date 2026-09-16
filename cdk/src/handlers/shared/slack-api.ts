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
import { type LookupResult, lookupFailed, lookupFound } from './lookup-result';

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

/**
 * POST to a Slack Web API method and return the message timestamp it produced.
 *
 * Distinct from {@link slackFetch} because a boolean is enough for fire-and-forget
 * reactions but NOT for a message the caller must edit later: Slack addresses a
 * message by its ``ts``, so a status panel that matures in place has to capture
 * the one it created.
 *
 * Returns a {@link LookupResult}: ``found`` with the ts, or ``failed`` on any
 * error layer (non-2xx, Slack ``ok: false``, a missing ``ts``, or a thrown
 * fetch). It never emits the ``absent`` state — a successful post always yields a
 * ts, so "no ts" is a failure, not an empty success. Callers that only need to
 * post-or-skip collapse this with ``lookupValueOr(result, null)``; the failure is
 * already logged at warn level here (best-effort contract), so a caller cannot
 * mistake an outage for "no message posted" (#756 Cat 2).
 */
export async function slackFetchTs(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<LookupResult<string>> {
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
      return lookupFailed(new Error(`Slack API ${method} returned HTTP ${response.status}`));
    }
    const result = await response.json() as { ok: boolean; error?: string; ts?: string };
    if (!result.ok) {
      logger.warn('Slack API returned error', { method, error: result.error });
      return lookupFailed(new Error(`Slack API ${method} error: ${result.error ?? 'unknown'}`));
    }
    // chat.update echoes the ts it edited; chat.postMessage returns the new one.
    if (typeof result.ts === 'string') return lookupFound(result.ts);
    logger.warn('Slack API returned ok without a ts', { method });
    return lookupFailed(new Error(`Slack API ${method} succeeded but returned no ts`));
  } catch (err) {
    logger.warn('Slack API fetch threw', {
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
}
