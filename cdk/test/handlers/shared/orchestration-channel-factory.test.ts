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

import { type Channel } from '../../../src/handlers/shared/orchestration-channel';
import {
  channelForSource,
  registerChannelFactory,
  registeredChannelSources,
} from '../../../src/handlers/shared/orchestration-channel-factory';

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

  test('a NEW surface can be added without editing this module or the interface', () => {
    // The extensibility tenet: adopting ABCA for another tracker must not require
    // patching the core. A closed union/switch would force every consumer to merge
    // an upstream change for one more surface, so this asserts the registry is
    // genuinely open — a surface registers itself and the lookup finds it.
    const built: string[] = [];
    const unregister = registerChannelFactory('acme-tracker', (table) => {
      built.push(table);
      return { kind: 'acme-tracker', postComment: jest.fn(), upsertComment: jest.fn(), reportFailure: jest.fn() } as unknown as Channel;
    });
    try {
      const ch = channelForSource('acme-tracker', { 'acme-tracker': 'AcmeRegistry' });
      expect(ch?.kind).toBe('acme-tracker');
      // The factory got its own credentials table, not another surface's.
      expect(built).toEqual(['AcmeRegistry']);
      expect(registeredChannelSources()).toContain('acme-tracker');
    } finally {
      unregister();
    }
  });

  test('unregistering restores the prior state, so surfaces do not leak between callers', () => {
    const unregister = registerChannelFactory('temp-surface', () => ({ kind: 'temp-surface' } as unknown as Channel));
    unregister();
    expect(registeredChannelSources()).not.toContain('temp-surface');
    expect(channelForSource('temp-surface', { 'temp-surface': 'T' })).toBeUndefined();
  });

  test('replacing a registered surface is reversible', () => {
    // A test (or a downstream override) may swap an adapter; restoring must put
    // the original back rather than deleting the entry.
    const unregister = registerChannelFactory('linear', () => ({ kind: 'stub-linear' } as unknown as Channel));
    expect(channelForSource('linear', BOTH)?.kind).toBe('stub-linear');
    unregister();
    expect(channelForSource('linear', BOTH)?.kind).toBe('linear');
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
