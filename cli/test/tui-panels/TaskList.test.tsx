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

import { flush, KEY_DOWN, KEY_ENTER } from './_helpers';
import { renderPanel } from './_render';
import { MockDataSource } from '../../src/tui/api/source-mock';
import TaskList from '../../src/tui/panels/TaskList';

describe('TaskList panel', () => {
  it('renders the column headers including the new GATES + SOURCE columns', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    const { lastFrame, unmount } = renderPanel(
      <TaskList tasks={tasks} onSelectTask={() => {}} active />,
      { source },
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('STATUS');
    expect(frame).toContain('SOURCE');
    expect(frame).toContain('GATES');
    expect(frame).toContain('DESCRIPTION');
    unmount();
  });

  it('renders channel-source labels in the SOURCE column', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    const { lastFrame, unmount } = renderPanel(
      <TaskList tasks={tasks} onSelectTask={() => {}} active />,
      { source },
    );
    await flush();
    const frame = lastFrame() ?? '';
    // The mock fixture varies channel_source across the 4 rows so
    // users see the column doing something; assert each label is
    // actually in the frame.
    expect(frame).toContain('CLI');
    expect(frame).toContain('Slack');
    expect(frame).toContain('Linear');
    expect(frame).toContain('Hook');
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
