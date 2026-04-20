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

import { TaskStatus, type TaskStatusType } from '../../../src/constructs/task-status';
import { renderSlackBlocks } from '../../../src/handlers/shared/slack-blocks';

describe('renderSlackBlocks', () => {
  const baseTask = {
    task_id: '01HXYZ123',
    repo: 'org/repo',
    task_description: 'Fix the login bug',
    pr_url: undefined as string | undefined,
    error_message: undefined as string | undefined,
    cost_usd: undefined as number | undefined,
    duration_s: undefined as number | undefined,
    status: TaskStatus.SUBMITTED as TaskStatusType,
  };

  test('renders task_created message', () => {
    const msg = renderSlackBlocks('task_created', baseTask);
    expect(msg.text).toContain('org/repo');
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].type).toBe('section');
    expect(msg.blocks[0].text?.text).toContain(':rocket:');
    expect(msg.blocks[0].text?.text).toContain('Fix the login bug');
    expect(msg.blocks[0].text?.text).toContain('01HXYZ123');
  });

  test('renders task_completed message with PR URL', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, pr_url: 'https://github.com/org/repo/pull/42', cost_usd: 0.47, duration_s: 272 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.text).toContain('completed');
    expect(msg.blocks[0].text?.text).toContain('$0.47');
    expect(msg.blocks[0].text?.text).toContain('4m 32s');
    // PR link is in the button, not inline text (avoids Slack unfurl cards)
    const actionsBlock = msg.blocks[1] as unknown as { type: string; elements: Array<{ url: string; text: { text: string } }> };
    expect(actionsBlock.type).toBe('actions');
    expect(actionsBlock.elements[0].url).toBe('https://github.com/org/repo/pull/42');
    expect(actionsBlock.elements[0].text.text).toContain('#42');
  });

  test('renders task_failed message with error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType, error_message: 'Repo not found' };
    const msg = renderSlackBlocks('task_failed', task);
    expect(msg.text).toContain('failed');
    expect(msg.blocks[0].text?.text).toContain('Repo not found');
  });

  test('renders task_failed message with metadata error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType };
    const msg = renderSlackBlocks('task_failed', task, { error: 'timeout' });
    expect(msg.blocks[0].text?.text).toContain('timeout');
  });

  test('renders task_cancelled message', () => {
    const msg = renderSlackBlocks('task_cancelled', baseTask);
    expect(msg.blocks[0].text?.text).toContain(':no_entry_sign:');
  });

  test('renders task_timed_out message with duration', () => {
    const task = { ...baseTask, duration_s: 28800 };
    const msg = renderSlackBlocks('task_timed_out', task);
    expect(msg.blocks[0].text?.text).toContain('8h');
  });

  test('renders session_started message', () => {
    const msg = renderSlackBlocks('session_started', baseTask);
    expect(msg.blocks[0].text?.text).toContain(':hourglass_flowing_sand:');
  });

  test('renders unknown event type gracefully', () => {
    const msg = renderSlackBlocks('hydration_complete', baseTask);
    expect(msg.blocks[0].text?.text).toContain('hydration_complete');
  });

  test('truncates long descriptions', () => {
    const task = { ...baseTask, task_description: 'A'.repeat(300) };
    const msg = renderSlackBlocks('task_created', task);
    expect(msg.blocks[0].text?.text.length).toBeLessThan(350);
    expect(msg.blocks[0].text?.text).toContain('...');
  });

  test('formats duration in hours', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 3661 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.blocks[0].text?.text).toContain('1h 1m');
  });

  test('formats duration in minutes and seconds', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 125 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.blocks[0].text?.text).toContain('2m 5s');
  });
});
