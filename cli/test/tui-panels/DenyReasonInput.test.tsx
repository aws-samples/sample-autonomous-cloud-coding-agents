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
import { flush, KEY_ENTER, KEY_ESC } from './_helpers';
import DenyReasonInput from '../../src/tui/components/DenyReasonInput';
import { DENY_REASON_MAX_LENGTH } from '../../src/types';

describe('DenyReasonInput', () => {
  it('renders prompt + cap hint', () => {
    const { lastFrame, unmount } = render(
      <DenyReasonInput onConfirm={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Deny — optional reason');
    expect(frame).toContain(`0/${DENY_REASON_MAX_LENGTH}`);
    unmount();
  });

  it('accepts typed characters and updates the counter', async () => {
    const { lastFrame, stdin, unmount } = render(
      <DenyReasonInput onConfirm={() => {}} onCancel={() => {}} />,
    );
    stdin.write('no');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('no');
    expect(frame).toContain(`2/${DENY_REASON_MAX_LENGTH}`);
    unmount();
  });

  it('confirms the trimmed reason on Enter', async () => {
    let reason: string | null = null;
    const { stdin, unmount } = render(
      <DenyReasonInput onConfirm={(r) => { reason = r; }} onCancel={() => {}} />,
    );
    stdin.write('stop');
    await flush();
    stdin.write(KEY_ENTER);
    await flush();
    expect(reason).toBe('stop');
    unmount();
  });

  it('cancels on Escape', async () => {
    let cancelled = false;
    const { stdin, unmount } = render(
      <DenyReasonInput onConfirm={() => {}} onCancel={() => { cancelled = true; }} />,
    );
    stdin.write(KEY_ESC);
    await flush();
    expect(cancelled).toBe(true);
    unmount();
  });

  it('confirms empty reason as empty string (agent gets denial with no note)', async () => {
    let reason: string | null = null;
    const { stdin, unmount } = render(
      <DenyReasonInput onConfirm={(r) => { reason = r; }} onCancel={() => {}} />,
    );
    stdin.write(KEY_ENTER);
    await flush();
    expect(reason).toBe('');
    unmount();
  });
});
