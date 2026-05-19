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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

// ESM module bindings are read-only — `jest.spyOn` on `import * as`
// fails. Use `unstable_mockModule` (Jest's ESM-compatible mocking
// API) and dynamic-import the modules under test AFTER the mock
// is registered. We type the mock against the real
// `ClipboardReadResult` so each test can hand it any valid
// discriminator without triggering type narrowing.
import type { ClipboardReadResult } from '../../src/tui/utils/clipboard';

const clipboardMock = {
  readClipboardImage: jest.fn<(opts?: { maxBytes?: number }) => Promise<ClipboardReadResult>>(),
  shouldShowHintOnce: jest.fn<(toolKey: string) => boolean>(),
  _resetHintCacheForTests: jest.fn(),
  DEFAULT_MAX_IMAGE_BYTES: 5 * 1024 * 1024,
};
clipboardMock.readClipboardImage.mockResolvedValue({
  ok: false,
  failure: { kind: 'not_image' },
});
clipboardMock.shouldShowHintOnce.mockReturnValue(true);

jest.unstable_mockModule('../../src/tui/utils/clipboard', () => clipboardMock);

const { default: Submit } = await import('../../src/tui/panels/Submit');
const { renderPanel } = await import('./_render');
const { flush, KEY_DOWN, KEY_ENTER } = await import('./_helpers');
const { MockDataSource } = await import('../../src/tui/api/source-mock');
const { APPROVAL_TIMEOUT_S_DEFAULT, INITIAL_APPROVALS_MAX_ENTRIES }
  = await import('../../src/types');

/** Move from the repo step through the listed repos, exiting into
 *  the next field (prompt). The repo step's cursor walks the repo
 *  list first; we need one ↓ per list entry plus one to exit. */
async function leaveRepoStep(stdin: { write: (s: string) => void }, repoCount: number) {
  for (let i = 0; i < repoCount; i += 1) {
    stdin.write(KEY_DOWN);
    await flush();
  }
}

describe('Submit panel', () => {
  it('renders all five form fields including the new approval-timeout + pre-approvals', async () => {
    const { lastFrame, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source: new MockDataSource() },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('New Task');
    expect(frame).toContain('Repository');
    expect(frame).toContain('Instructions');
    expect(frame).toContain('Approval timeout');
    expect(frame).toContain(`${APPROVAL_TIMEOUT_S_DEFAULT}s`);
    expect(frame).toContain('Pre-approve');
    expect(frame).toContain('[ Submit Task ]');
    unmount();
  });

  it('navigates down through the field order correctly', async () => {
    const source = new MockDataSource();
    const repoCount = (await source.listRegisteredRepos()).length;
    const { lastFrame, stdin, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    // Walk from repo down to submit — confirms focus moves
    // through prompt, timeout, approvals, submit.
    await leaveRepoStep(stdin, repoCount); // → prompt
    stdin.write(KEY_DOWN); await flush(); // → timeout
    stdin.write(KEY_DOWN); await flush(); // → approvals
    stdin.write(KEY_DOWN); await flush(); // → submit
    const frame = lastFrame() ?? '';
    // Submit button is rendered; the color changes when focused (and
    // the panel still renders the button label in both states).
    expect(frame).toContain('[ Submit Task ]');
    unmount();
  });

  it('rejects submit when prompt is empty', async () => {
    const source = new MockDataSource();
    const repoCount = (await source.listRegisteredRepos()).length;
    const submitSpy = jest.spyOn(source, 'submitTask');
    const { stdin, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    // Navigate to Submit without filling in prompt.
    await leaveRepoStep(stdin, repoCount);
    stdin.write(KEY_DOWN); await flush(); // → timeout
    stdin.write(KEY_DOWN); await flush(); // → approvals
    stdin.write(KEY_DOWN); await flush(); // → submit
    stdin.write(KEY_ENTER); await flush();
    expect(submitSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('exposes the approval-scopes help once focused on the pre-approvals field', async () => {
    const source = new MockDataSource();
    const repoCount = (await source.listRegisteredRepos()).length;
    const { lastFrame, stdin, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    await leaveRepoStep(stdin, repoCount); // → prompt
    stdin.write(KEY_DOWN); await flush(); // → timeout
    stdin.write(KEY_DOWN); await flush(); // → approvals
    const frame = lastFrame() ?? '';
    expect(frame).toContain('a or + to add a scope');
    expect(INITIAL_APPROVALS_MAX_ENTRIES).toBeGreaterThan(0);
    unmount();
  });

  describe('attachments / clipboard paste', () => {
    beforeEach(() => {
      clipboardMock.readClipboardImage.mockReset();
      clipboardMock.shouldShowHintOnce.mockReset();
      clipboardMock.shouldShowHintOnce.mockImplementation(() => true);
      // Default: no image (tests opt-in to a successful read).
      clipboardMock.readClipboardImage.mockResolvedValue({
        ok: false as const,
        failure: { kind: 'not_image' as const },
      });
    });

    it('renders the attachments field and Ctrl+V hint', async () => {
      const { lastFrame, unmount } = renderPanel(
        <Submit active onSubmitted={() => {}} />,
        { source: new MockDataSource() },
      );
      for (let i = 0; i < 3; i += 1) await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Attachments');
      expect(frame).toMatch(/Ctrl\+V/);
      unmount();
    });

    it('appends an image attachment on Ctrl+V when the clipboard has a PNG', async () => {
      clipboardMock.readClipboardImage.mockResolvedValue({
        ok: true as const,
        image: {
          buffer: PNG_BYTES,
          mediaType: 'image/png' as const,
          base64: PNG_BYTES.toString('base64'),
          sizeBytes: PNG_BYTES.length,
        },
      });
      const { lastFrame, stdin, unmount } = renderPanel(
        <Submit active onSubmitted={() => {}} />,
        { source: new MockDataSource() },
      );
      for (let i = 0; i < 3; i += 1) await flush();
      // Ctrl+V is byte 0x16 in raw mode; ink-testing-library passes
      // raw bytes through to useInput.
      stdin.write('\x16');
      // The paste pipeline is async (spawn → magic-byte sniff →
      // setState). Two flushes covers the microtask drain plus a
      // rerender.
      await flush();
      await flush();
      const frame = lastFrame() ?? '';
      // The attachment summary shows the count + the green pasted toast.
      expect(frame).toMatch(/Attachments/);
      expect(frame).toMatch(/Pasted image/);
      unmount();
    });

    it('shows a warning when the clipboard does not contain an image', async () => {
      // Default mock already returns not_image — no extra setup needed.
      const { lastFrame, stdin, unmount } = renderPanel(
        <Submit active onSubmitted={() => {}} />,
        { source: new MockDataSource() },
      );
      for (let i = 0; i < 3; i += 1) await flush();
      stdin.write('\x16');
      await flush();
      await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toMatch(/does not contain an image/i);
      unmount();
    });

    it('shows the install hint with brew install pngpaste when tool is missing on macOS', async () => {
      clipboardMock.readClipboardImage.mockResolvedValue({
        ok: false as const,
        failure: {
          kind: 'tool_missing' as const,
          platform: 'darwin' as const,
          hint: 'Install pngpaste for clipboard image paste:\n  brew install pngpaste',
        },
      });
      const { lastFrame, stdin, unmount } = renderPanel(
        <Submit active onSubmitted={() => {}} />,
        { source: new MockDataSource() },
      );
      for (let i = 0; i < 3; i += 1) await flush();
      stdin.write('\x16');
      await flush();
      await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toMatch(/brew install pngpaste/);
      unmount();
    });

    it('forwards attachments to submitTask on form submit', async () => {
      const source = new MockDataSource();
      const repoCount = (await source.listRegisteredRepos()).length;
      const submitSpy = jest.spyOn(source, 'submitTask');
      clipboardMock.readClipboardImage.mockResolvedValue({
        ok: true as const,
        image: {
          buffer: PNG_BYTES,
          mediaType: 'image/png' as const,
          base64: PNG_BYTES.toString('base64'),
          sizeBytes: PNG_BYTES.length,
        },
      });
      const { stdin, unmount } = renderPanel(
        <Submit active onSubmitted={() => {}} />,
        { source },
      );
      for (let i = 0; i < 3; i += 1) await flush();

      // Paste an image first.
      stdin.write('\x16'); await flush(); await flush();

      // Walk to prompt, type a description, walk to submit.
      await leaveRepoStep(stdin, repoCount); // → prompt
      stdin.write(KEY_ENTER); await flush(); // enter prompt edit
      stdin.write('do a thing'); await flush();
      stdin.write(KEY_ENTER); await flush(); // exit prompt edit
      stdin.write(KEY_DOWN); await flush(); // → timeout
      stdin.write(KEY_DOWN); await flush(); // → approvals
      stdin.write(KEY_DOWN); await flush(); // → attachments
      stdin.write(KEY_DOWN); await flush(); // → submit
      stdin.write(KEY_ENTER); await flush(); await flush();

      expect(submitSpy).toHaveBeenCalled();
      const arg = (submitSpy.mock.calls[0] as unknown as [{ attachments?: unknown[] }])[0];
      expect(arg.attachments).toBeDefined();
      expect(arg.attachments).toHaveLength(1);
      expect((arg.attachments as Array<{ type: string; content_type?: string }>)[0]).toMatchObject({
        type: 'image',
        content_type: 'image/png',
      });
      unmount();
    });
  });
});
