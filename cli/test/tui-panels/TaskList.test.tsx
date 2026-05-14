/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import TaskList from '../../src/tui/panels/TaskList';
import { renderPanel } from './_render';
import { flush, KEY_DOWN, KEY_ENTER } from './_helpers';
import { MockDataSource } from '../../src/tui/api/source-mock';

describe('TaskList panel', () => {
  it('renders the column headers including the new GATES column', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    const { lastFrame, unmount } = renderPanel(
      <TaskList tasks={tasks} onSelectTask={() => {}} active />,
      { source },
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('STATUS');
    expect(frame).toContain('GATES');
    expect(frame).toContain('DESCRIPTION');
    unmount();
  });

  it('renders gate counters in the GATES column', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    const { lastFrame, unmount } = renderPanel(
      <TaskList tasks={tasks} onSelectTask={() => {}} active />,
      { source },
    );
    await flush();
    const frame = lastFrame() ?? '';
    // Fixture tasks have approval_gate_count/cap, so we expect at
    // least one X/50-format entry.
    expect(frame).toMatch(/\d+\/50/);
    unmount();
  });

  it('fires onSelectTask with the focused task_id on Enter', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    let selected: string | null = null;
    const { stdin, unmount } = renderPanel(
      <TaskList tasks={tasks} onSelectTask={(id) => { selected = id; }} active />,
      { source },
    );
    await flush();
    stdin.write(KEY_ENTER);
    await flush();
    expect(selected).toBe(tasks[0].task_id);
    unmount();
  });

  it('moves the cursor on down-arrow', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    let selected: string | null = null;
    const { stdin, unmount } = renderPanel(
      <TaskList tasks={tasks} onSelectTask={(id) => { selected = id; }} active />,
      { source },
    );
    await flush();
    stdin.write(KEY_DOWN);
    await flush();
    stdin.write(KEY_ENTER);
    await flush();
    expect(selected).toBe(tasks[1].task_id);
    unmount();
  });

  it('shows empty-state hint when there are no tasks', async () => {
    const { lastFrame, unmount } = renderPanel(
      <TaskList tasks={[]} onSelectTask={() => {}} active />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No tasks yet');
    unmount();
  });
});
