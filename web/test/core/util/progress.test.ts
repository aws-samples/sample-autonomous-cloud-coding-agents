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
import { outcomeOf, reachedStep, stepStates } from '../../../src/core/util/progress';
import { buildFixtures, MOCK_IDS } from '../../../src/mocks/fixtures';

const NOW = new Date();
const fixtures = buildFixtures(NOW);
const task = (id: string) => fixtures.tasks.find((t) => t.task_id === id)!;
const events = (id: string) => fixtures.events[id] ?? [];
const outcome = (id: string) => outcomeOf(task(id), events(id), NOW);
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
    expect(outcome(MOCK_IDS.running)).toBeNull();
  });

  it('calls out a stuck task', () => {
    expect(outcome(MOCK_IDS.stale)).toMatchObject({ type: 'warning', title: 'No update for 9 min', offer: 'stuck' });
  });

  it('does not call a quiet task on ECS stuck', () => {
    expect(outcome(MOCK_IDS.ecs)).toBeNull();
    expect(outcomeOf({ ...task(MOCK_IDS.ecs), compute_type: 'agentcore' }, events(MOCK_IDS.ecs), NOW)).toMatchObject({ offer: 'stuck' });
  });

  it('asks for approval', () => {
    expect(outcome(MOCK_IDS.awaiting)).toMatchObject({ title: 'Waiting for your approval', offer: 'approval' });
  });

  it('shows the place in line', () => {
    expect(outcome(MOCK_IDS.queued)).toMatchObject({ title: 'Waiting in line (number 1)', text: 'Should start in about 4m 0s.' });
  });

  it('reports a finished pull request', () => {
    expect(outcome(MOCK_IDS.completed)?.title).toBe('Done: pull request #482 is ready for review');
    expect(outcomeOf({ ...task(MOCK_IDS.completed), pr_url: null, pr_number: null }, [], NOW)).toEqual({ type: 'success', title: 'Done' });
  });

  it('says how the pull request ended, once the event of ABCA\'s read of GitHub is among the task\'s events', () => {
    expect(outcome(MOCK_IDS.prMerged)).toEqual({ type: 'success', title: 'Done: pull request #212 was merged' });
    expect(outcome(MOCK_IDS.prClosed)).toEqual({ type: 'info', title: 'Done: pull request #1071 was closed without merging' });
    expect(outcomeOf(task(MOCK_IDS.prMerged), [], NOW)).toEqual({ type: 'success', title: 'Done: pull request #212 is ready for review' });
  });

  it('shows a failed run without a pull request as the failure it is, even when the agent reported success', () => {
    expect(outcome(MOCK_IDS.noChanges)).toMatchObject({ type: 'error', offer: 'retry' });
  });

  it('keeps real failures as errors with a retry', () => {
    expect(outcome(MOCK_IDS.failed)).toMatchObject({ type: 'error', title: 'Budget exceeded', offer: 'retry' });
    expect(outcome(MOCK_IDS.timedOut)).toMatchObject({ title: 'Ran out of time', offer: 'retry' });
    expect(outcome(MOCK_IDS.cancelled)).toMatchObject({ title: 'Cancelled' });
  });
});
