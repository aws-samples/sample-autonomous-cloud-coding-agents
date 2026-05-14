/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import Watch from '../../src/tui/panels/Watch';
import { renderPanel } from './_render';
import { flush, KEY_ESC } from './_helpers';
import { MockDataSource } from '../../src/tui/api/source-mock';

describe('Watch panel', () => {
  async function pickFirstTask() {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    return { source, task: tasks[0] };
  }

  it('renders the task header with status + gate budget', async () => {
    const { source, task } = await pickFirstTask();
    const { lastFrame, unmount } = renderPanel(
      <Watch task={task} active onBack={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    const frame = lastFrame() ?? '';
    // Task id suffix + status label from STATUS_LABEL['RUNNING'].
    expect(frame).toContain(`..${task.task_id.slice(-4)}`);
    expect(frame).toContain('Running');
    // Gate budget surfaces gate counters when they are non-null.
    expect(frame).toContain('Approval gates:');
    expect(frame).toContain(`${task.approval_gate_count}/${task.approval_gate_cap}`);
    unmount();
  });

  it('fires onBack when Escape is pressed outside any overlay', async () => {
    const { source, task } = await pickFirstTask();
    let backCalls = 0;
    const { stdin, unmount } = renderPanel(
      <Watch task={task} active onBack={() => { backCalls += 1; }} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    stdin.write(KEY_ESC);
    await flush();
    expect(backCalls).toBe(1);
    unmount();
  });

  it('shows event-stream content from the mock source', async () => {
    const { source, task } = await pickFirstTask();
    const { lastFrame, unmount } = renderPanel(
      <Watch task={task} active onBack={() => {}} />,
      { source },
    );
    // Mock replays events one-at-a-time at 600ms cadence. Wait long
    // enough for a few to land.
    for (let i = 0; i < 3; i += 1) await flush();
    await new Promise((r) => setTimeout(r, 800));
    await flush();
    const frame = lastFrame() ?? '';
    // A known mock event from the fixture stream.
    expect(frame).toMatch(/Task started|ReadFile|Step \d/);
    unmount();
  });

  it('shows the PR banner once task.pr_url is set', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    // The mock fixture has one COMPLETED task with a pr_url — pick it.
    const completed = tasks.find(t => t.pr_url !== null)!;
    expect(completed).toBeDefined();
    const { lastFrame, unmount } = renderPanel(
      <Watch task={completed} active onBack={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    const frame = lastFrame() ?? '';
    // Banner renders the full URL so it's clickable via terminal OSC 8
    // in compatible emulators; the test just asserts substring.
    expect(frame).toContain('PR:');
    expect(frame).toContain(completed.pr_url ?? '');
    unmount();
  });

  it('does NOT show the PR banner for tasks without a pr_url', async () => {
    const { source, task } = await pickFirstTask(); // RUNNING task, pr_url=null
    const { lastFrame, unmount } = renderPanel(
      <Watch task={task} active onBack={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    const frame = lastFrame() ?? '';
    // "PR:" string must be absent — the banner is gated on pr_url.
    expect(frame).not.toContain('PR:');
    unmount();
  });

  it('opens the scope picker on [a] when an approval is pending', async () => {
    const source = new MockDataSource();
    const tasks = await source.listTasks();
    // Use the AWAITING_APPROVAL task (task_id ends in Y4M2 — second
    // fixture). The awaiting_approval_request_id is the source of
    // truth that the approval card links to.
    const awaitingTask = tasks.find(t => t.status === 'AWAITING_APPROVAL')!;
    expect(awaitingTask).toBeDefined();
    const { lastFrame, stdin, unmount } = renderPanel(
      <Watch task={awaitingTask} active onBack={() => {}} />,
      { source },
    );
    // Extra flushes — the pendingApproval lookup requires the context
    // to have loaded the approvals list, which is one more DataProvider
    // round-trip past the tasks/repos fan-out.
    for (let i = 0; i < 5; i += 1) await flush();
    stdin.write('a');
    await flush();
    const frame = lastFrame() ?? '';
    // Scope picker heading uses the approval's tool name (`Bash`).
    expect(frame).toContain('Approve Bash');
    unmount();
  });
});
