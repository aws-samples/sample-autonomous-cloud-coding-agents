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

import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../../../src/core/api/types';
import { finishedWithoutChanges, outcomeOf, reachedStep, stepStates } from '../../../src/core/util/progress';
import { buildFixtures, MOCK_IDS } from '../../../src/mocks/fixtures';

const NOW = new Date();
const fixtures = buildFixtures(NOW);
const task = (id: string) => fixtures.tasks.find((t) => t.task_id === id)!;
const events = (id: string) => fixtures.events[id] ?? [];
const milestone = (name: string, details = ''): TaskEvent => ({ event_id: name, event_type: 'agent_milestone', timestamp: NOW.toISOString(), metadata: { milestone: name, details } });

describe('stepStates', () => {
  it('marks queued work as the first step', () => {
    expect(stepStates(task(MOCK_IDS.queued), [])).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
  });

  it('follows the step milestones of a running task', () => {
    expect(stepStates(task(MOCK_IDS.running), events(MOCK_IDS.running))).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(reachedStep({ status: 'RUNNING', pr_url: null }, [milestone('step:build:start')])).toBe(3);
    expect(reachedStep({ status: 'RUNNING', pr_url: null }, [milestone('step:open_pr:start')])).toBe(4);
  });

  it('treats tool activity as working for workflows without step milestones', () => {
    const toolCall: TaskEvent = { event_id: 't', event_type: 'agent_tool_call', timestamp: NOW.toISOString(), metadata: { tool_name: 'Read' } };
    expect(reachedStep({ status: 'RUNNING', pr_url: null }, [toolCall])).toBe(2);
  });

  it('completes every step, skipping the pull request when there is none', () => {
    expect(stepStates(task(MOCK_IDS.completed), events(MOCK_IDS.completed))).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(stepStates({ status: 'COMPLETED', pr_url: null }, [])).toEqual(['done', 'done', 'done', 'done', 'skipped']);
  });

  it('marks where a failed task stopped', () => {
    expect(stepStates(task(MOCK_IDS.failed), events(MOCK_IDS.failed))).toEqual(['done', 'done', 'stopped', 'todo', 'todo']);
  });
});

describe('outcomeOf', () => {
  it('says nothing while the task is simply working', () => {
    expect(outcomeOf(task(MOCK_IDS.running), events(MOCK_IDS.running), NOW)).toBeNull();
  });

  it('calls out a stuck task', () => {
    expect(outcomeOf(task(MOCK_IDS.stale), [], NOW)).toMatchObject({ type: 'warning', title: 'No update for 9 min', offer: 'stuck' });
  });

  it('asks for approval', () => {
    expect(outcomeOf(task(MOCK_IDS.awaiting), [], NOW)).toMatchObject({ title: 'Needs your OK', offer: 'approval' });
  });

  it('shows the place in line', () => {
    expect(outcomeOf(task(MOCK_IDS.queued), [], NOW)).toMatchObject({ title: 'Waiting in line (number 1)', text: 'Should start in about 4m 0s.' });
  });

  it('reports a finished pull request', () => {
    expect(outcomeOf(task(MOCK_IDS.completed), [], NOW)?.title).toBe('Done: pull request #482 is ready for review');
  });

  it('turns the platform\'s "not saved" failure into "no changes" when the agent finished cleanly', () => {
    const t = task(MOCK_IDS.noChanges);
    expect(finishedWithoutChanges(t, events(MOCK_IDS.noChanges))).toBe(true);
    expect(outcomeOf(t, events(MOCK_IDS.noChanges), NOW)).toMatchObject({ type: 'info', title: 'Finished with no changes', text: expect.stringContaining('already has a CODEOWNERS file') });
    expect(finishedWithoutChanges(t, [milestone('agent_execution_complete', 'status=error')])).toBe(false);
  });

  it('keeps real failures as errors with a retry', () => {
    expect(outcomeOf(task(MOCK_IDS.failed), events(MOCK_IDS.failed), NOW)).toMatchObject({ type: 'error', title: 'Budget exceeded', offer: 'retry' });
    expect(outcomeOf(task(MOCK_IDS.timedOut), [], NOW)).toMatchObject({ title: 'Ran out of time', offer: 'retry' });
    expect(outcomeOf(task(MOCK_IDS.cancelled), [], NOW)).toMatchObject({ title: 'Cancelled' });
  });
});
