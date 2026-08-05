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

import type { AdfParagraph, AdfTextRun } from './jira-feedback';

export interface JiraFinalStatusInput {
  readonly eventType: string;
  readonly prUrl: string | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly maxTurns: number | null;
  readonly durationS: number | null;
  readonly taskId: string;
  readonly errorTitle: string | null;
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

/** Render a Jira terminal status as ADF paragraphs. */
export function renderJiraFinalStatusComment(
  args: JiraFinalStatusInput,
): ReadonlyArray<AdfParagraph> {
  const isCompleted = args.eventType === 'task_completed';
  const shippedDespiteFailure = !isCompleted && args.prUrl != null;

  let headerRuns: AdfTextRun[];
  if (isCompleted) {
    headerRuns = [{ text: '✅ Task completed', strong: true }];
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

  const paragraphs: AdfParagraph[] = [
    headerRuns,
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
    .map((paragraph) => paragraph.map((run) => run.text).join(''))
    .join('\n');
}
