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

import { render } from 'ink-testing-library';
import { flush, KEY_DOWN, KEY_ENTER, KEY_ESC } from './_helpers';
import ScopePicker from '../../src/tui/components/ScopePicker';
import type { ApprovalScope } from '../../src/types';

describe('ScopePicker', () => {
  it('renders all 9 scope options on mount', () => {
    const { lastFrame, unmount } = render(
      <ScopePicker onConfirm={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    // Short forms
    expect(frame).toContain('Just this one call');
    expect(frame).toContain('tool type');
    expect(frame).toContain('tool group');
    expect(frame).toContain('Full autonomy');
    // Prefixed forms
    expect(frame).toContain('tool_type:<Name>');
    expect(frame).toContain('tool_group:<name>');
    expect(frame).toContain('bash_pattern:<glob>');
    expect(frame).toContain('write_path:<glob>');
    expect(frame).toContain('rule:<rule_id>');
    unmount();
  });

  it('confirms the short-form scope on Enter', async () => {
    let confirmed: ApprovalScope | null = null;
    const { stdin, unmount } = render(
      <ScopePicker onConfirm={(s) => { confirmed = s; }} onCancel={() => {}} />,
    );
    // The first option is `this_call` — press Enter.
    stdin.write(KEY_ENTER);
    await flush();
    expect(confirmed).toBe('this_call');
    unmount();
  });

  it('prompts for operand on prefixed scope, then composes scope:<operand>', async () => {
    let confirmed: ApprovalScope | null = null;
    const { lastFrame, stdin, unmount } = render(
      <ScopePicker onConfirm={(s) => { confirmed = s; }} onCancel={() => {}} />,
    );
    // Options (in order): this_call(0), tool_type_session(1),
    // tool_group_session(2), tool_type(3). Down 3 times → focus on
    // tool_type prefix row.
    stdin.write(KEY_DOWN); // ↓
    await flush();
    stdin.write(KEY_DOWN); // ↓
    await flush();
    stdin.write(KEY_DOWN); // ↓ → tool_type prefix
    await flush();
    stdin.write(KEY_ENTER); // Enter → operand step
    await flush();
    // Frame should now show the operand prompt.
    expect(lastFrame() ?? '').toContain('Enter operand for tool_type');
    // Type "Bash" and confirm.
    stdin.write('B');
    await flush();
    stdin.write('a');
    await flush();
    stdin.write('s');
    await flush();
    stdin.write('h');
    await flush();
    stdin.write(KEY_ENTER);
    await flush();
    expect(confirmed).toBe('tool_type:Bash');
    unmount();
  });

  it('gates all_session behind a y/n confirmation', async () => {
    let confirmed: ApprovalScope | null = null;
    const { lastFrame, stdin, unmount } = render(
      <ScopePicker onConfirm={(s) => { confirmed = s; }} onCancel={() => {}} />,
    );
    // all_session is the LAST option (index 8).
    for (let i = 0; i < 8; i += 1) {
      stdin.write(KEY_DOWN);
      await flush();
    }
    stdin.write(KEY_ENTER); // Enter → confirm step
    await flush();
    expect(lastFrame() ?? '').toContain('all_session grants the agent blanket');
    expect(confirmed).toBeNull();
    stdin.write('y');
    await flush();
    expect(confirmed).toBe('all_session');
    unmount();
  });

  it('cancels on Escape from picker step', async () => {
    let cancelled = false;
    const { stdin, unmount } = render(
      <ScopePicker onConfirm={() => {}} onCancel={() => { cancelled = true; }} />,
    );
    // Node's `readline` keypress parser buffers a lone \u001B as
    // the start of a multi-byte sequence. Double-escape tells the
    // parser "no continuation coming" — ink sees a single escape.
    stdin.write(KEY_ESC);
    await flush();
    expect(cancelled).toBe(true);
    unmount();
  });
});
