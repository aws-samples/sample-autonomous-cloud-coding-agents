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

  // ── Regression: silent-failure on rejected approve API call ──────────
  // Phase A live drive (task 01KS18SAV6PPR4XVZPAHF2EJF5) caught a
  // P1 bug: the panel used to render `✓ Approved Bash (tool_type:bash)`
  // unconditionally as soon as the user picked a scope, even when the
  // underlying `source.approve()` call rejected. The user's intent
  // never reached the API, the agent stayed blocked AWAITING_APPROVAL,
  // and the user had no way to know — they thought they unblocked the
  // gate, walked away, and the approval timed out 5 minutes later.
  //
  // The fix awaits the round-trip and renders an explicit
  // `✗ Approve failed for ... — <error>` toast on rejection while
  // un-clearing the optimistic row removal so the user can retry.
  describe('regression: rejected approve does not show success toast', () => {
    it('renders an "Approve failed" toast when source.approve rejects', async () => {
      const source = new MockDataSource();
      jest.spyOn(source, 'approve').mockRejectedValue(
        new Error('500: ApiError: backend exploded'),
      );
      const { lastFrame, stdin, unmount } = renderPanel(
        <Approvals active />,
        { source },
      );
      for (let i = 0; i < 4; i += 1) await flush();
      stdin.write('a');
      await flush();
      stdin.write(KEY_ENTER); // pick `this_call`
      // Two things must propagate: the awaited approve() and the
      // setMessage call inside the .then handler. Several flushes.
      for (let i = 0; i < 5; i += 1) await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Approve failed');
      expect(frame).toContain('backend exploded');
      // The success-side string must NOT appear — the user should
      // never see a misleading green check after a rejected call.
      expect(frame).not.toMatch(/✓ Approved/);
      // The row must reappear in the list so the user can retry.
      // (Optimistic clear is undone on rejection.)
      expect(frame).toContain('Pending Approvals');
      expect(frame).toMatch(/2 pending across 2 tasks/);
      unmount();
    });

    it('renders a "Deny failed" toast when source.deny rejects', async () => {
      const source = new MockDataSource();
      jest.spyOn(source, 'deny').mockRejectedValue(
        new Error('400: invalid request_id'),
      );
      const { lastFrame, stdin, unmount } = renderPanel(
        <Approvals active />,
        { source },
      );
      for (let i = 0; i < 4; i += 1) await flush();
      stdin.write('d');
      await flush();
      stdin.write('y'); // confirm deny → opens reason input
      await flush();
      stdin.write(KEY_ENTER); // submit empty reason
      for (let i = 0; i < 5; i += 1) await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Deny failed');
      expect(frame).toContain('invalid request_id');
      // No misleading red-cross-Denied message on a rejected call.
      expect(frame).not.toMatch(/✗ Denied EditFile/);
      unmount();
    });
  });
});
