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

import { jest } from '@jest/globals';
import { flush, KEY_ENTER, KEY_ESC } from './_helpers';
import { renderPanel } from './_render';
import { MockDataSource } from '../../src/tui/api/source-mock';
import Approvals from '../../src/tui/panels/Approvals';

describe('Approvals panel', () => {
  it('shows pending approvals from the mock source', async () => {
    const { lastFrame, unmount } = renderPanel(
      <Approvals active />,
      { source: new MockDataSource() },
    );
    // Pending list flows through DataProvider → snapshot → context.
    for (let i = 0; i < 4; i += 1) await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pending Approvals');
    // Mock fixture has two pending rows on two different tasks.
    expect(frame).toMatch(/2 pending across 2 tasks/);
    // Both tools are surfaced.
    expect(frame).toContain('EditFile');
    expect(frame).toContain('Bash');
    unmount();
  });

  it('opens the scope picker on [a]', async () => {
    const { lastFrame, stdin, unmount } = renderPanel(
      <Approvals active />,
      { source: new MockDataSource() },
    );
    for (let i = 0; i < 4; i += 1) await flush();
    stdin.write('a');
    await flush();
    const frame = lastFrame() ?? '';
    // ScopePicker heading is "Approve <tool>" per the heading prop.
    expect(frame).toContain('Approve EditFile');
    // Full 9-variant scope list is rendered.
    expect(frame).toContain('Just this one call');
    expect(frame).toContain('Full autonomy');
    unmount();
  });

  it('opens the deny confirm on [d], then the reason input on [y]', async () => {
    const { lastFrame, stdin, unmount } = renderPanel(
      <Approvals active />,
      { source: new MockDataSource() },
    );
    for (let i = 0; i < 4; i += 1) await flush();
    stdin.write('d');
    await flush();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('Confirm deny');
    stdin.write('y');
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('optional reason');
    unmount();
  });

  it('calls source.approve with the chosen scope when the user confirms', async () => {
    const source = new MockDataSource();
    const approveSpy = jest.spyOn(source, 'approve');
    const { stdin, unmount } = renderPanel(<Approvals active />, { source });
    for (let i = 0; i < 4; i += 1) await flush();
    stdin.write('a'); // opens picker
    await flush();
    stdin.write(KEY_ENTER); // picks `this_call`
    await flush();
    // Allow the TuiProvider optimistic path + async source call.
    for (let i = 0; i < 3; i += 1) await flush();
    expect(approveSpy).toHaveBeenCalledTimes(1);
    const call = approveSpy.mock.calls[0];
    // task_id is the first approval in the fixture; scope is 'this_call'.
    expect(call[2]).toBe('this_call');
    unmount();
  });

  it('cancels the scope picker on Escape', async () => {
    const { lastFrame, stdin, unmount } = renderPanel(
      <Approvals active />,
      { source: new MockDataSource() },
    );
    for (let i = 0; i < 4; i += 1) await flush();
    stdin.write('a');
    await flush();
    expect(lastFrame() ?? '').toContain('Approve EditFile');
    stdin.write(KEY_ESC);
    await flush();
    // Picker gone, back to the list header.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pending Approvals');
    expect(frame).not.toContain('Approve EditFile');
    unmount();
  });
});
