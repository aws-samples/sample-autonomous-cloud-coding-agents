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
import { type ActionsBlock, renderSlackBlocks, type SlackBlock } from '../../../src/handlers/shared/slack-blocks';

/** Narrow to a section block and return its text; throws if block isn't a section. */
function sectionText(block: SlackBlock): string {
  if (block.type !== 'section') {
    throw new Error(`expected section block, got ${block.type}`);
  }
  return block.text.text;
}

/** Narrow to an actions block; throws if block isn't one. */
function actionsBlock(block: SlackBlock): ActionsBlock {
  if (block.type !== 'actions') {
    throw new Error(`expected actions block, got ${block.type}`);
  }
  return block;
}

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
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rocket:');
    expect(text).toContain('Fix the login bug');
    expect(text).toContain('01HXYZ123');
  });

  test('renders task_completed message with PR URL', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, pr_url: 'https://github.com/org/repo/pull/42', cost_usd: 0.47, duration_s: 272 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.text).toContain('completed');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain('$0.47');
    expect(text).toContain('4m 32s');
    // PR link is in the button, not inline text (avoids Slack unfurl cards)
    const actions = actionsBlock(msg.blocks[1]);
    const button = actions.elements[0];
    expect(button.text.text).toContain('#42');
    if (!('url' in button)) throw new Error('expected link button with url');
    expect(button.url).toBe('https://github.com/org/repo/pull/42');
  });

  test('renders task_failed message with error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType, error_message: 'Repo not found' };
    const msg = renderSlackBlocks('task_failed', task);
    expect(msg.text).toContain('failed');
    expect(sectionText(msg.blocks[0])).toContain('Repo not found');
  });

  test('renders task_failed message with metadata error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType };
    const msg = renderSlackBlocks('task_failed', task, { error: 'timeout' });
    expect(sectionText(msg.blocks[0])).toContain('timeout');
  });

  test('renders task_cancelled message', () => {
    const msg = renderSlackBlocks('task_cancelled', baseTask);
    expect(sectionText(msg.blocks[0])).toContain(':no_entry_sign:');
  });

  test('renders task_timed_out message with duration', () => {
    const task = { ...baseTask, duration_s: 28800 };
    const msg = renderSlackBlocks('task_timed_out', task);
    expect(sectionText(msg.blocks[0])).toContain('8h');
  });

  test('renders session_started message', () => {
    const msg = renderSlackBlocks('session_started', baseTask);
    expect(sectionText(msg.blocks[0])).toContain(':hourglass_flowing_sand:');
  });

  test('renders unknown event type gracefully', () => {
    const msg = renderSlackBlocks('hydration_complete', baseTask);
    expect(sectionText(msg.blocks[0])).toContain('hydration_complete');
  });

  test('truncates long descriptions', () => {
    const task = { ...baseTask, task_description: 'A'.repeat(300) };
    const msg = renderSlackBlocks('task_created', task);
    const text = sectionText(msg.blocks[0]);
    expect(text.length).toBeLessThan(350);
    expect(text).toContain('...');
  });

  test('formats duration in hours', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 3661 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain('1h 1m');
  });

  test('formats duration in minutes and seconds', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 125 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain('2m 5s');
  });

  // -------------------------------------------------------------------
  // PR #79 test gap #32 — task_stranded + agent_error renderers
  // -------------------------------------------------------------------

  test('renders task_stranded message with prior_status from event metadata', () => {
    // The reconciler stamps ``code: STRANDED_NO_HEARTBEAT`` and
    // ``prior_status`` on the event metadata (see
    // reconcile-stranded-tasks.ts). The renderer must surface
    // prior_status so operators can tell whether the task hung in
    // HYDRATING vs RUNNING at a glance — without it, the reviewer's
    // "generic Event: ..." UX regression would resurface.
    const msg = renderSlackBlocks('task_stranded', baseTask, {
      code: 'STRANDED_NO_HEARTBEAT',
      prior_status: 'RUNNING',
      age_seconds: 1800,
    });
    expect(msg.text).toBe('Task stranded for org/repo');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':warning:');
    expect(text).toContain('Task stranded');
    expect(text).toContain('org/repo');
    expect(text).toContain('last status: RUNNING');
  });

  test('renders task_stranded message gracefully without metadata', () => {
    // Missing prior_status (e.g. legacy event written before the
    // reconciler started stamping it) must not crash; the renderer
    // omits the parenthetical and produces a clean message.
    const msg = renderSlackBlocks('task_stranded', baseTask);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':warning:');
    expect(text).toContain('Task stranded');
    expect(text).not.toContain('last status:');
  });

  test('renders agent_error message with error_type and message_preview', () => {
    // ``agent/src/progress_writer.py::write_agent_error`` carries
    // ``error_type`` and ``message_preview`` on the event metadata.
    // Pre-PR-#79 this fell to the default branch
    // (``Event: agent_error for org/repo``) — a UX regression.
    const msg = renderSlackBlocks('agent_error', baseTask, {
      error_type: 'TimeoutError',
      message_preview: 'Tool call timed out after 30s',
    });
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('Agent error');
    expect(text).toContain('org/repo');
    expect(text).toContain('TimeoutError');
    expect(text).toContain('Tool call timed out after 30s');
  });

  test('renders agent_error message without metadata (legacy event shape)', () => {
    // Defense-in-depth: an agent_error event with no metadata at all
    // must still produce a sensible Slack message. The error_type and
    // preview fields drop out cleanly without leaking ``undefined``.
    const msg = renderSlackBlocks('agent_error', baseTask);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('Agent error');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('_Type:_');
  });

  test('agent_error truncates long message_preview to keep Slack message readable', () => {
    // The preview cap is 200 chars — protects channel UX from a
    // pathological agent that emits a 4 KB error message.
    const msg = renderSlackBlocks('agent_error', baseTask, {
      error_type: 'BigError',
      message_preview: 'X'.repeat(500),
    });
    const text = sectionText(msg.blocks[0]);
    expect(text.length).toBeLessThan(400);
    expect(text).toContain('...');
  });
});
