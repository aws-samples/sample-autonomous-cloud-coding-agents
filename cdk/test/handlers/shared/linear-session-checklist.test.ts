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

import {
  CHECKLIST_STAGE,
  checklistKind,
  checklistMoveForEvent,
  closingLine,
  renderChecklist,
} from '../../../src/handlers/shared/linear-session-checklist';

const statuses = (steps: ReturnType<typeof renderChecklist>) => steps.map((s) => s.status);

test('coding tasks get a checklist, other workflows do not', () => {
  expect(checklistKind('coding/new-task-v1')).toBe('new');
  expect(checklistKind(undefined)).toBe('new');
  expect(checklistKind('coding/pr-iteration-v1')).toBe('iteration');
  expect(checklistKind('review/pr-review-v1')).toBeNull();
});

test('steps before the stage are done, the stage is in progress with its note', () => {
  const steps = renderChecklist('new', { stage: CHECKLIST_STAGE.code, note: 'round 2' });
  expect(statuses(steps)).toEqual(['completed', 'completed', 'inProgress', 'pending', 'pending']);
  expect(steps[2].content).toBe('Write the code — round 2');
});

test('the pull request number stays on its step once it exists', () => {
  const steps = renderChecklist('iteration', { stage: CHECKLIST_STAGE.review, pr: '#7' });
  expect(steps[3].content).toBe('Push to the pull request — #7');
  expect(steps[4]).toEqual({ content: 'Ready for your review', status: 'inProgress' });
});

test('a finished task completes every step; a stopped one cancels what was left', () => {
  expect(statuses(renderChecklist('new', { stage: CHECKLIST_STAGE.review }, 'done'))).toEqual(Array(5).fill('completed'));
  expect(statuses(renderChecklist('new', { stage: CHECKLIST_STAGE.code }, 'stopped')))
    .toEqual(['completed', 'completed', 'canceled', 'canceled', 'canceled']);
});

test('events move the checklist to their stage; others do not move it', () => {
  expect(checklistMoveForEvent('admission_queued')).toEqual({ stage: CHECKLIST_STAGE.understand, note: 'queued for a free slot' });
  expect(checklistMoveForEvent('hydration_complete')).toEqual({ stage: CHECKLIST_STAGE.setup });
  expect(checklistMoveForEvent('repo_setup_complete')).toEqual({ stage: CHECKLIST_STAGE.code });
  expect(checklistMoveForEvent('agent_execution_complete')).toEqual({ stage: CHECKLIST_STAGE.pr });
  expect(checklistMoveForEvent('pr_created')).toEqual({ stage: CHECKLIST_STAGE.review });
  expect(checklistMoveForEvent('agent_tool_call')).toBeNull();
});

test('the closing line says whether the reader has to act', () => {
  expect(closingLine('question')).toMatch(/^\*\*Waiting on you\.\*\*/);
  expect(closingLine('pr')).toContain('review the pull request');
  for (const o of ['no_change', 'cancelled'] as const) expect(closingLine(o)).toContain('Nothing needed from you');
  expect(closingLine('failed')).toContain('try again');
});
