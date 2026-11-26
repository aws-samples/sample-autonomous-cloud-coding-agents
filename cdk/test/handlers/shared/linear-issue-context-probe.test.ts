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

import {
  probeLinearIssueContext,
  renderIssueContextHint,
} from '../../../src/handlers/shared/linear-issue-context-probe';

const UPLOADED = { id: 'att-1', title: 'spec.pdf', url: 'https://uploads.linear.app/u/a/spec' };
const LINKED = { id: 'att-2', title: 'Figma board', url: 'https://www.figma.com/file/x' };

describe('probeLinearIssueContext — the hint names only what the task does not carry', () => {
  let originalFetch: typeof fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function answerWithAttachments(nodes: Array<{ id: string; title?: string; url?: string }>): void {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issue: { attachments: { nodes }, project: null } } }),
    });
  }

  test('lists a linked paperclip and leaves out one that was uploaded to Linear', async () => {
    answerWithAttachments([UPLOADED, LINKED]);

    const probe = await probeLinearIssueContext('tok', 'issue-1');

    expect(probe.attachmentTitles).toEqual(['Figma board']);
    expect(probe.attachments).toEqual([
      { title: 'spec.pdf', url: UPLOADED.url },
      { title: 'Figma board', url: LINKED.url },
    ]);
    const hint = renderIssueContextHint(probe);
    expect(hint).toContain('paperclip attachments — "Figma board"');
    expect(hint).not.toContain('spec.pdf');
  });

  test('gives no hint when every paperclip was uploaded to Linear', async () => {
    answerWithAttachments([UPLOADED, { id: 'att-3', title: 'trace.txt', url: 'https://eu.uploads.linear.app/u/b/trace' }]);

    const probe = await probeLinearIssueContext('tok', 'issue-1');

    expect(probe.attachments).toHaveLength(2);
    expect(renderIssueContextHint(probe)).toBe('');
  });

  test('still lists a paperclip that has a title and no URL: nothing can fetch it', async () => {
    answerWithAttachments([{ id: 'att-4', title: 'Runbook' }]);

    const probe = await probeLinearIssueContext('tok', 'issue-1');

    expect(probe.attachments).toEqual([]);
    expect(renderIssueContextHint(probe)).toContain('"Runbook"');
  });
});
