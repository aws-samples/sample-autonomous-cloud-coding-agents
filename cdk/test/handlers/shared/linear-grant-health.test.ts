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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GRANT_HEALTH_PROBE_EVENT,
  isGrantHealthProbe,
  isProbeTick,
  probeLinearGrants,
} from '../../../src/handlers/shared/linear-grant-health';

function fakeDdb(pages: Array<{ Items: unknown[]; LastEvaluatedKey?: Record<string, unknown> }>) {
  const send = jest.fn();
  for (const page of pages) send.mockResolvedValueOnce(page);
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

describe('isGrantHealthProbe', () => {
  test('recognises only the scheduled probe input', () => {
    expect(isGrantHealthProbe(GRANT_HEALTH_PROBE_EVENT)).toBe(true);
    expect(isGrantHealthProbe({ raw_body: '{}' })).toBe(false);
    expect(isGrantHealthProbe({ grant_health_probe: 'true' })).toBe(false);
    expect(isGrantHealthProbe(null)).toBe(false);
  });
});

describe('isProbeTick', () => {
  const HOUR = 3_600_000;
  test('fires on exactly one 15-minute tick per 12-hour window, wherever the ticks start', () => {
    for (const offsetMs of [0, 7 * 60_000, 14 * 60_000 + 59_999]) {
      const fired: number[] = [];
      for (let t = offsetMs; t < 48 * HOUR; t += 15 * 60_000) if (isProbeTick(t, 15)) fired.push(t);
      expect(fired).toHaveLength(4);
      expect(fired.map(t => Math.floor(t / (12 * HOUR)))).toEqual([0, 1, 2, 3]);
    }
  });

  test('a nonsensical cadence probes every tick instead of never', () => {
    expect(isProbeTick(5 * HOUR, Number.NaN)).toBe(true);
    expect(isProbeTick(5 * HOUR, 0)).toBe(true);
    expect(isProbeTick(5 * HOUR, 15, Number.NaN)).toBe(true);
  });
});

describe('probeLinearGrants', () => {
  test('pages the registry and resolves every active workspace, skipping latched ones', async () => {
    const { client, send } = fakeDdb([
      {
        Items: [
          { linear_workspace_id: 'ws-1', workspace_slug: 'alpha', status: 'active' },
          { linear_workspace_id: 'ws-2', workspace_slug: 'beta', status: 'revoked' },
        ],
        LastEvaluatedKey: { linear_workspace_id: 'ws-2' },
      },
      { Items: [{ linear_workspace_id: 'ws-3', workspace_slug: 'gamma', status: 'active' }] },
    ]);
    const resolve = jest.fn(async (id: string) => (id === 'ws-1' ? { access_token: 't' } : null));

    const report = await probeLinearGrants(client, 'Registry', resolve);

    expect(resolve.mock.calls.map(([id]) => id)).toEqual(['ws-1', 'ws-3']);
    expect(report).toEqual({ checked: 2, healthy: 1, unhealthy: ['gamma'], revoked: ['beta'] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ linear_workspace_id: 'ws-2' });
  });

  test('one workspace throwing does not hide the others', async () => {
    const { client } = fakeDdb([{
      Items: [
        { linear_workspace_id: 'ws-1', workspace_slug: 'alpha', status: 'active' },
        { linear_workspace_id: 'ws-2', status: 'active' },
      ],
    }]);
    const resolve = jest.fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ access_token: 't' });

    expect(await probeLinearGrants(client, 'Registry', resolve)).toEqual({
      checked: 2, healthy: 1, unhealthy: ['alpha'], revoked: [],
    });
  });
});
