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

import { classifyError } from '../../../src/handlers/shared/error-classifier';
import { buildAdfDocument } from '../../../src/handlers/shared/jira-feedback';
import {
  jiraIterationFrame,
  renderJiraFinalStatusComment,
  renderJiraFinalStatusText,
  type JiraFinalStatusInput,
} from '../../../src/handlers/shared/jira-status-comment';

// The formatter's other cases are in fanout-task-events.test.ts, which stubs
// the ADF serializer. These go through the real one: they assert the document
// Jira receives.
const COMPLETED: JiraFinalStatusInput = {
  eventType: 'task_completed',
  prUrl: null,
  costUsd: 0.5,
  turns: 3,
  maxTurns: 100,
  durationS: 60,
  taskId: 't',
  errorTitle: null,
};

/** The agent's answer as it writes one: Markdown, with a fenced block. */
const ANSWER = [
  'The retry is in `worker.ts`, **not** in the queue:',
  '',
  '```ts',
  'for (const job of jobs) {',
  '  await queue.retry(job);',
  '}',
  '```',
  'See [the runbook](https://example.com/runbook).',
].join('\n');

describe('renderJiraFinalStatusComment: the answer of the agent', () => {
  test('inline code, bold and a fenced block reach Jira as ADF, not as literal Markdown', () => {
    const doc = buildAdfDocument(renderJiraFinalStatusComment({ ...COMPLETED, answerText: ANSWER }));

    expect(doc.content).toEqual([
      // The header stays first: the webhook processor knows ABCA's own
      // comments by it.
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '✅ ' },
          { type: 'text', text: 'Task completed', marks: [{ type: 'strong' }] },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The retry is in ' },
          { type: 'text', text: 'worker.ts', marks: [{ type: 'code' }] },
          { type: 'text', text: ', ' },
          { type: 'text', text: 'not', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' in the queue:' },
        ],
      },
      { type: 'paragraph', content: [] },
      // One block, line breaks and indentation as written, the fences and the
      // language gone.
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: 'for (const job of jobs) {\n  await queue.retry(job);\n}' }],
      },
      // The link stays as typed: see the next test.
      { type: 'paragraph', content: [{ type: 'text', text: 'See [the runbook](https://example.com/runbook).' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'cost: $0.50 • turns: 3 / 100 • duration: 1m' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'task t', marks: [{ type: 'em' }] }] },
    ]);
  });

  test('a link or an image in the answer stays as typed, with its URL: the text is the agent\'s own', () => {
    const doc = buildAdfDocument(renderJiraFinalStatusComment({
      ...COMPLETED,
      prUrl: 'https://github.com/o/r/pull/7',
      answerText: [
        '[Open live preview](https://example.org/x)',
        '![x](https://example.org/y.png)',
        '[![x](https://example.org/y.png)](https://example.org/x) and **[bold](https://example.org/z)**',
      ].join('\n'),
    }));
    const content = doc.content as Array<{ content: Array<{ marks?: Array<{ type: string }> }> }>;

    // Between the header and the metrics, the pull request and the footer.
    expect(content.slice(1, -3)).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: '[Open live preview](https://example.org/x)' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '![x](https://example.org/y.png)' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '[![x](https://example.org/y.png)](https://example.org/x) and ' },
          { type: 'text', text: '[bold](https://example.org/z)', marks: [{ type: 'strong' }] },
        ],
      },
    ]);
    // The one link of the comment is ABCA's own, to the pull request.
    expect(content.flatMap((node) => node.content).filter((run) => run.marks?.some((mark) => mark.type === 'link')))
      .toEqual([{
        type: 'text',
        text: 'https://github.com/o/r/pull/7',
        marks: [{ type: 'link', attrs: { href: 'https://github.com/o/r/pull/7' } }],
      }]);
  });

  test('the plain-text form keeps the block fenced and the link as Markdown', () => {
    expect(renderJiraFinalStatusText({ ...COMPLETED, answerText: ANSWER })).toBe([
      '✅ Task completed',
      'The retry is in worker.ts, not in the queue:',
      '',
      '```',
      'for (const job of jobs) {',
      '  await queue.retry(job);',
      '}',
      '```',
      'See [the runbook](https://example.com/runbook).',
      'cost: $0.50 • turns: 3 / 100 • duration: 1m',
      'task t',
    ].join('\n'));
  });
});

describe('jiraIterationFrame', () => {
  test('a completed iteration with a red build gets the failure frame and a fixed reason', () => {
    expect(jiraIterationFrame('task_completed', false, null))
      .toEqual({ eventType: 'task_failed', errorTitle: 'Build or tests did not pass' });
  });

  test('the reason is the title the error classifier gives a task that its build gate failed', () => {
    // The message the agent stores for that task (agent/src/pipeline.py). The
    // two outcomes are the same red build, so they read the same.
    const gated = classifyError("Task did not succeed (agent_status='success', build_ok=False)");
    expect(jiraIterationFrame('task_completed', false, null).errorTitle).toBe(gated?.title);
  });

  test.each([
    ['a completed run with a green build', 'task_completed', true, null],
    ['a completed run whose build did not run', 'task_completed', null, null],
    ['a completed run without a build result', 'task_completed', undefined, null],
    ['a failed run, whatever its build', 'task_failed', false, 'Exceeded max turns'],
    ['a cancelled run', 'task_cancelled', false, null],
  ] as const)('leaves %s as it is', (_name, eventType, buildPassed, errorTitle) => {
    expect(jiraIterationFrame(eventType, buildPassed, errorTitle)).toEqual({ eventType, errorTitle });
  });
});
