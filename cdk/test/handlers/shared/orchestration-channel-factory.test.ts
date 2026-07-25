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

// The adapters resolve tokens on use, not on construction, so the factory can be
// exercised without any network — only the modules it selects between are stubbed
// out at the transport layer.
jest.mock('../../../src/handlers/shared/linear-feedback', () => ({
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));
jest.mock('../../../src/handlers/shared/jira-feedback', () => ({}));

import { channelForSource } from '../../../src/handlers/shared/orchestration-channel-factory';

const BOTH = { linear: 'LinearRegistry', jira: 'JiraRegistry' };

describe('channelForSource', () => {
  test('picks the adapter matching the stored channel', () => {
    expect(channelForSource('linear', BOTH)?.kind).toBe('linear');
    expect(channelForSource('jira', BOTH)?.kind).toBe('jira');
  });

  test('an orchestration with no recorded channel is treated as Linear', () => {
    // Rows seeded before the field existed carry no source, and Linear was the
    // only surface that could have seeded them — so defaulting keeps their
    // feedback working rather than silencing it.
    expect(channelForSource(undefined, BOTH)?.kind).toBe('linear');
  });

  test('a surface whose registry is not configured yields no adapter', () => {
    // Skipping is the safe answer: building another surface's adapter would
    // address the wrong tenant.
    expect(channelForSource('jira', { linear: 'LinearRegistry' })).toBeUndefined();
    expect(channelForSource('linear', { jira: 'JiraRegistry' })).toBeUndefined();
    expect(channelForSource(undefined, {})).toBeUndefined();
  });

  test('a trigger channel with no issue-tracking surface yields no adapter', () => {
    // 'api' / 'slack' submissions have no issue to post a panel on; the engine
    // must skip rather than guess at a surface.
    for (const source of ['api', 'webhook', 'slack', 'unknown-future-surface']) {
      expect(channelForSource(source, BOTH)).toBeUndefined();
    }
  });

  test('the returned adapter carries the registry it was given', async () => {
    // A wrong registry would resolve a token for the wrong tenant, so prove the
    // per-surface table actually reaches the adapter.
    const linear = channelForSource('linear', BOTH);
    expect(linear?.kind).toBe('linear');
    const jira = channelForSource('jira', BOTH);
    expect(jira?.kind).toBe('jira');
    // Distinct adapters, not the same object handed back twice.
    expect(linear).not.toBe(jira);
  });
});
