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

import { ApplyGuardrailCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { logger } from './logger';
import { MAX_TASK_DESCRIPTION_LENGTH } from './validation';
import { emitWebhookScreeningFailedMetric } from './webhook-screening-metric';

/**
 * Translate a `createTaskCore` non-201 response into a user-facing comment on the issue.
 *
 * The CDK error envelope is `{ error: { code, message, request_id } }`. We surface
 * the `message` because it's already user-readable (e.g. "Task description was
 * blocked by content policy") and add a per-status prefix so the user can tell
 * a guardrail block from a 503 from a validation error.
 *
 * Falls back to a generic message if the body fails to parse — best-effort, never throws.
 */
export function buildCreateTaskFailureMessage(
  statusCode: number,
  rawBody: string,
  retryHint = 'Please re-apply the trigger label in a few minutes.',
): string {
  let detail = '';
  try {
    if (rawBody) {
      const parsed = JSON.parse(rawBody) as { error?: { code?: string; message?: string } };
      const message = parsed.error?.message;
      if (typeof message === 'string' && message.trim()) {
        detail = message.trim();
      }
    }
  } catch {
    // fall through to the generic message
  }

  if (statusCode === 400 && detail) {
    // Guardrail blocks and validation errors land here; the message is already
    // user-readable so just prefix it.
    return `❌ ABCA couldn't accept this task: ${detail}`;
  }
  if (statusCode === 503) {
    return `❌ ABCA is temporarily unavailable (status ${statusCode}). ${retryHint}`;
  }
  if (detail) {
    return `❌ ABCA couldn't create this task (status ${statusCode}): ${detail}`;
  }
  return `❌ ABCA couldn't create this task (status ${statusCode}). Check the ABCA admin logs for details.`;
}

/** Notice appended when the comment section is truncated to fit the budget. */
export const COMMENT_TRUNCATION_NOTICE = '\n\n_(recent comments truncated)_';

export function renderCommentSection(comments: readonly { author: string; createdAt: string; markdown: string }[]): string {
  const lines: string[] = ['', '## Recent comments'];
  for (const c of comments) {
    lines.push('');
    const attribution = c.createdAt ? `**${c.author}** (${c.createdAt}):` : `**${c.author}**:`;
    lines.push(attribution);
    lines.push(c.markdown);
  }
  return lines.join('\n');
}

/**
 * Append an advisory section to a task description, on a new line. A section that does not
 * fit what is left of MAX_TASK_DESCRIPTION_LENGTH is cut and closed with the notice, or left
 * out when not even the notice fits: an advisory section must never grow the description
 * past the length that createTaskCore rejects.
 */
export function appendAdvisorySection(base: string, section: string, truncationNotice: string): string {
  const budget = MAX_TASK_DESCRIPTION_LENGTH - base.length - 1;
  if (budget <= 0) return base;
  let fitted = section;
  if (section.length > budget) {
    const room = budget - truncationNotice.length;
    fitted = room > 0 ? section.slice(0, room) + truncationNotice : '';
  }
  return fitted ? `${base}\n${fitted}` : base;
}

/**
 * Screen advisory third-party content (comments, project documents) through the Bedrock
 * Guardrail as one rendered block, apart from the reporter's own text, which createTaskCore
 * screens. The items come back when the block passes. In every other case they are dropped
 * and the task still proceeds without them (ADR-026): no guardrail is configured, the
 * guardrail blocks the block, or the screening call fails.
 */
export async function screenAdvisoryOrDrop<T>(
  items: readonly T[],
  render: (items: readonly T[]) => string,
  opts: {
    guardrail: { bedrockClient: BedrockRuntimeClient; guardrailId: string; guardrailVersion: string } | undefined;
    what: string;
    metricSource: Parameters<typeof emitWebhookScreeningFailedMetric>[0];
    logFields: Record<string, unknown>;
  },
): Promise<readonly T[]> {
  if (items.length === 0) return items;
  const { guardrail, what, logFields } = opts;
  if (!guardrail) {
    logger.warn(`Dropping ${what}: guardrail not configured to screen them`, logFields);
    return [];
  }
  const text = render(items);
  try {
    const result = await guardrail.bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: guardrail.guardrailId,
      guardrailVersion: guardrail.guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));
    if (result.action === 'GUARDRAIL_INTERVENED') {
      logger.warn(`Dropping ${what}: blocked by content policy (task still proceeds)`, logFields);
      return [];
    }
    return items;
  } catch (err) {
    emitWebhookScreeningFailedMetric(opts.metricSource);
    logger.warn(`Dropping ${what}: screening unavailable (task still proceeds)`, {
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- advisory enrichment that cannot be screened is dropped and the task proceeds (ADR-026)
  }
}
