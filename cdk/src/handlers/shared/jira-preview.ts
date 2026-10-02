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

import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  buildAdfDocument, updateIssueCommentAdf,
  type JiraFeedbackContext, type JiraUpdateResult,
} from './jira-feedback';
import type { JiraPreviewBudget } from './jira-preview-budget';
import { renderJiraFinalStatusComment } from './jira-status-comment';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';
import { isAllowedScreenshotUrl } from './screenshot-url';
import type { TaskRecord } from './types';
import { TERMINAL_STATUSES } from '../../constructs/task-status';

const MAX_CONVERGENCE_ATTEMPTS = 4;

/** Jira supports explicit ADF links without requiring Atlassian media storage. */
export function jiraPreviewDocument(screenshotUrl: unknown, previewUrl: unknown): Record<string, unknown> | null {
  if (typeof screenshotUrl !== 'string' || !isAllowedScreenshotUrl(screenshotUrl)) {
    return null;
  }
  return buildAdfDocument([
    [{ text: '🖼️ Preview screenshot', strong: true }],
    [{ text: 'Open screenshot', href: screenshotUrl }],
    ...(typeof previewUrl === 'string' && isAllowedScreenshotUrl(previewUrl)
      ? [[{ text: 'Open live preview', href: previewUrl }]] : []),
  ]);
}

function render(task: TaskRecord): Record<string, unknown> {
  const terminal = TERMINAL_STATUSES.includes(task.status);
  const saved = task.jira_iteration_status;
  // Only build a fallback when no usable status was persisted. Runtime result
  // metrics may be numeric strings, just as in the fan-out notification path.
  const metric = (field: 'cost_usd' | 'turns_attempted' | 'max_turns' | 'duration_s') =>
    coerceNumericOrNull(task[field], { field, task_id: task.task_id }, logger);
  const body = saved && (!terminal || saved.terminal) ? saved.body : terminal
    ? buildAdfDocument(renderJiraFinalStatusComment({
      eventType: task.status === 'COMPLETED' && task.build_passed === false
        ? 'task_failed' : `task_${String(task.status).toLowerCase()}`,
      prUrl: task.pr_url ?? null,
      costUsd: metric('cost_usd'),
      turns: metric('turns_attempted'),
      maxTurns: metric('max_turns'),
      durationS: metric('duration_s'),
      taskId: task.task_id,
      errorTitle: null,
    }))
    : buildAdfDocument([[{ text: '🔄 Working…' }]]);
  // Old tasks may have settled before this writer was deployed. A late preview
  // must still show their outcome, never reset their status to working.
  const preview = jiraPreviewDocument(task.screenshot_url, task.screenshot_preview_url);
  return { ...body, content: [...((body.content ?? []) as unknown[]), ...((preview?.content ?? []) as unknown[])] };
}

/**
 * All iteration comment writers converge from durable task state. Progress cannot
 * replace a terminal body. After each Jira PUT, a strongly consistent re-read
 * detects an overlapping preview/status write and attempts to repair our stale
 * PUT, bounded by four attempts and any supplied delivery deadline.
 * No Jira read/modify/write or external-image embedding is required.
 */
export async function updateJiraIterationComment(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  taskId: string,
  ctx: JiraFeedbackContext,
  issueId: string,
  commentId: string,
  status?: { body: Record<string, unknown>; terminal: boolean },
  budget?: JiraPreviewBudget,
): Promise<JiraUpdateResult> {
  const run = <T>(operation: () => Promise<T>): Promise<T> => budget ? budget.run(operation) : operation();
  let wrote = false;
  try {
    if (status) {
      try {
        await run(() => ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { task_id: taskId },
          UpdateExpression: 'SET jira_iteration_status = :value',
          ConditionExpression: 'attribute_exists(task_id)'
            + (status.terminal ? '' : ' AND (attribute_not_exists(jira_iteration_status) OR jira_iteration_status.terminal = :false)'),
          ExpressionAttributeValues: {
            ':value': status,
            ...(!status.terminal && { ':false': false }),
          },
        }), { abortSignal: budget?.signal }));
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
    }
    const load = async (): Promise<TaskRecord | undefined> => (await run(() => ddb.send(new GetCommand({
      TableName: tableName, Key: { task_id: taskId }, ConsistentRead: true,
    }), { abortSignal: budget?.signal }))).Item as TaskRecord | undefined;
    let task = await load();
    if (!task) {
      logger.warn('Jira iteration task no longer exists', { event: 'jira.preview.task_missing', task_id: taskId });
      return { ok: false, retryable: false };
    }
    for (let attempt = 0; task && attempt < MAX_CONVERGENCE_ATTEMPTS; attempt += 1) {
      const body = render(task);
      const result = await run(() => updateIssueCommentAdf(ctx, issueId, commentId, body));
      if (!result.ok) return result;
      wrote = true;
      task = await load();
      if (!task || JSON.stringify(render(task)) === JSON.stringify(body)) return { ok: true };
    }
    logger.warn('Jira iteration comment did not converge', { event: 'jira.preview.convergence_failed', task_id: taskId });
    return { ok: true };
  } catch (error) {
    logger.warn('Jira iteration comment update failed', {
      event: 'jira.preview.status_failed',
      task_id: taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return wrote ? { ok: true } : { ok: false, retryable: true };
  }
}
