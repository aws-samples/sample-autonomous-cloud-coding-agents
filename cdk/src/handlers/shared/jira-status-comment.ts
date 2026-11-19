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

import { parseMarkdownBlocks, type AdfBlock, type AdfParagraph, type AdfTextRun } from './jira-feedback';

export interface JiraFinalStatusInput {
  readonly eventType: string;
  readonly prUrl: string | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly maxTurns: number | null;
  readonly durationS: number | null;
  readonly taskId: string;
  readonly errorTitle: string | null;
  /** What the agent said in a run that made no commit; shown on a completed run. */
  readonly answerText?: string | null;
}

/**
 * The frame of an iteration's terminal comment and the reason it names. An
 * iteration that completes with a red build is not a clean success: it gets
 * the failure frame, and a fixed reason, because such a run stores no error
 * message. The words are the error classifier's title for a task that its
 * build gate failed.
 */
export function jiraIterationFrame(
  eventType: string,
  buildPassed: boolean | null | undefined,
  errorTitle: string | null,
): Pick<JiraFinalStatusInput, 'eventType' | 'errorTitle'> {
  return eventType === 'task_completed' && buildPassed === false
    ? { eventType: 'task_failed', errorTitle: 'Build or tests did not pass' }
    : { eventType, errorTitle };
}

export type JiraFinishedPointerKind = 'result' | 'details' | 'answer';

/** Short terminal pointer that replaces the long-running progress comment. */
export function renderJiraFinishedPointer(
  kind: JiraFinishedPointerKind,
): ReadonlyArray<AdfParagraph> {
  if (kind === 'result') {
    return [[{ text: '✅ Finished — result posted below.', strong: true }]];
  }
  if (kind === 'answer') {
    return [[{ text: '💬 Finished — answer posted below.', strong: true }]];
  }
  return [[{ text: '❌ Finished — details posted below.', strong: true }]];
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return remainingSeconds === 0
    ? `${minutes}m`
    : `${minutes}m ${remainingSeconds}s`;
}

/** Render a Jira terminal status as ADF blocks. */
export function renderJiraFinalStatusComment(
  args: JiraFinalStatusInput,
): ReadonlyArray<AdfBlock> {
  const isCompleted = args.eventType === 'task_completed';
  const shippedDespiteFailure = !isCompleted && args.prUrl != null;

  let headerRuns: AdfTextRun[];
  if (isCompleted) {
    // This comment can carry the agent's own text (the answer below), which
    // may spell out the ``@bgagent`` mention, and Jira attributes it to the
    // setup user on a site without the Forge app. The webhook processor tells
    // ABCA's comments by their leading marker (``isKnownAbcaComment``): the
    // emoji stays outside the bold run so the marker survives a wiki-text
    // body, where bold is an asterisk.
    headerRuns = [{ text: '✅ ' }, { text: 'Task completed', strong: true }];
  } else if (shippedDespiteFailure) {
    const reason = args.errorTitle ? ` — ${args.errorTitle}` : '';
    headerRuns = [
      { text: `⚠️ Shipped a PR but stopped early${reason}`, strong: true },
      { text: ' — review and decide if more work is needed' },
    ];
  } else {
    const subtype = args.eventType.replace(/^task_/, '').replace(/_/g, ' ');
    const reason = args.errorTitle ? `: ${args.errorTitle}` : '';
    headerRuns = [{ text: `❌ Task ${subtype}${reason}`, strong: true }];
  }

  const costStr = args.costUsd != null ? `$${args.costUsd.toFixed(2)}` : '—';
  const turnsStr = args.turns != null
    ? `${args.turns}${args.maxTurns != null ? ` / ${args.maxTurns}` : ''}`
    : '—';
  const durationStr = args.durationS != null
    ? formatDuration(args.durationS)
    : '—';

  // A completed run without a commit answered a question (an ``@bgagent``
  // question on an open PR): the answer goes under the header, rendered from
  // the Markdown the agent wrote it in. The agent stores its last message
  // for a failed run too; that is not an answer.
  const answer = isCompleted ? (args.answerText ?? '').trim() : '';
  const paragraphs: AdfBlock[] = [
    headerRuns,
    ...(answer ? parseMarkdownBlocks(answer) : []),
    [{ text: `cost: ${costStr} • turns: ${turnsStr} • duration: ${durationStr}` }],
  ];
  if (args.prUrl) {
    paragraphs.push([
      { text: 'PR: ' },
      { text: args.prUrl, href: args.prUrl },
    ]);
  }
  paragraphs.push([{ text: `task ${args.taskId}`, em: true }]);
  return paragraphs;
}

/** Plain-text equivalent for the channel adapter's string comment contract. */
export function renderJiraFinalStatusText(args: JiraFinalStatusInput): string {
  return renderJiraFinalStatusComment(args)
    .map((block) => ('code' in block
      ? ['```', block.code, '```'].join('\n')
      : block
        .map((run) => run.href ? `[${run.text}](${run.href})` : run.text)
        .join('')))
    .join('\n');
}
