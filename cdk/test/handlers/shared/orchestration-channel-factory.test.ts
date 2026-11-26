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
    expect(channelForSource(undefined, BOTH)?.kind).toBe('linear');
  });

  test('a surface whose registry is not configured yields no adapter', () => {
    expect(channelForSource('jira', { linear: 'LinearRegistry' })).toBeUndefined();
    expect(channelForSource('linear', { jira: 'JiraRegistry' })).toBeUndefined();
    expect(channelForSource(undefined, {})).toBeUndefined();
  });

  test('a trigger channel with no issue-tracking surface yields no adapter', () => {
    for (const source of ['api', 'webhook', 'slack', 'unknown-future-surface']) {
      expect(channelForSource(source, BOTH)).toBeUndefined();
    }
  });

  test('a NEW surface can be added without editing this module or the interface', () => {
    const built: string[] = [];
    const unregister = registerChannelFactory('acme-tracker', (table) => {
      built.push(table);
      return { kind: 'acme-tracker', postComment: jest.fn(), upsertComment: jest.fn(), reportFailure: jest.fn() } as unknown as Channel;
    });
    try {
      const ch = channelForSource('acme-tracker', { 'acme-tracker': 'AcmeRegistry' });
      expect(ch?.kind).toBe('acme-tracker');
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
    const unregister = registerChannelFactory('linear', () => ({ kind: 'stub-linear' } as unknown as Channel));
    expect(channelForSource('linear', BOTH)?.kind).toBe('stub-linear');
    unregister();
    expect(channelForSource('linear', BOTH)?.kind).toBe('linear');
  });

  test('the returned adapter carries the registry it was given', async () => {
    const linear = channelForSource('linear', BOTH);
    expect(linear?.kind).toBe('linear');
    const jira = channelForSource('jira', BOTH);
    expect(jira?.kind).toBe('jira');
    expect(linear).not.toBe(jira);
  });
});
