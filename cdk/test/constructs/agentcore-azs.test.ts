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

import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import {
  AGENTCORE_AZS_CONTEXT_KEY,
  AGENTCORE_SUPPORTED_AZ_IDS,
  AvailabilityZoneInfo,
  resolveAgentCoreAzOverride,
  resolveAgentCoreAzs,
  selectSupportedAzNames,
} from '../../src/constructs/agentcore-azs';

function nodeWithContext(context?: Record<string, unknown>) {
  const app = new App({ context });
  return new Stack(app, 'TestStack').node;
}

function scopeWithContext(context?: Record<string, unknown>): Stack {
  const app = new App({ context });
  return new Stack(app, 'TestStack');
}

// Realistic us-east-1 mapping: supported IDs are use1-az1/az2/az4.
const US_EAST_1_ZONES: AvailabilityZoneInfo[] = [
  { zoneName: 'us-east-1a', zoneId: 'use1-az2' }, // supported
  { zoneName: 'us-east-1b', zoneId: 'use1-az4' }, // supported
  { zoneName: 'us-east-1c', zoneId: 'use1-az6' }, // unsupported
  { zoneName: 'us-east-1d', zoneId: 'use1-az1' }, // supported
  { zoneName: 'us-east-1e', zoneId: 'use1-az3' }, // unsupported
  { zoneName: 'us-east-1f', zoneId: 'use1-az5' }, // unsupported
];

describe('AGENTCORE_SUPPORTED_AZ_IDS', () => {
  it('covers the documented AgentCore VPC regions', () => {
    for (const region of [
      'us-east-1', 'us-east-2', 'us-west-2',
      'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-northeast-1',
      'eu-west-1', 'eu-central-1',
    ]) {
      expect(AGENTCORE_SUPPORTED_AZ_IDS[region]).toBeDefined();
    }
  });

  it('lists at least two unique physical zone IDs per region', () => {
    for (const [region, ids] of Object.entries(AGENTCORE_SUPPORTED_AZ_IDS)) {
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        // Physical zone-ID shape, e.g. use1-az1 (NOT a zone name like us-east-1a).
        expect(id).toMatch(/^[a-z]+[0-9]+-az[0-9]+$/);
      }
      expect(region).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
    }
  });
});

describe('resolveAgentCoreAzOverride', () => {
  it('returns undefined when the context key is unset', () => {
    expect(resolveAgentCoreAzOverride(nodeWithContext())).toBeUndefined();
  });

  it('returns the validated array when provided', () => {
    const override = ['us-east-1b', 'us-east-1c'];
    expect(
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: override })),
    ).toEqual(override);
  });

  it('throws on a non-array override (typo guard)', () => {
    expect(() =>
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: 'us-east-1b' })),
    ).toThrow(/must be a JSON array/);
  });

  it('throws on a non-string / empty entry', () => {
    expect(() =>
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', ''] })),
    ).toThrow(/non-empty availability-zone-name/);
  });

  it('throws when fewer than two zones are listed (HA guidance)', () => {
    expect(() =>
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b'] })),
    ).toThrow(/at least 2 zones/);
  });
});

describe('selectSupportedAzNames', () => {
  it('returns the zone names whose IDs are AgentCore-supported', () => {
    expect(selectSupportedAzNames('us-east-1', US_EAST_1_ZONES)).toEqual([
      'us-east-1a',
      'us-east-1b',
      'us-east-1d',
    ]);
  });

  it('returns an empty array for a region with no known constraint', () => {
    expect(selectSupportedAzNames('eu-north-1', US_EAST_1_ZONES)).toEqual([]);
  });

  it('returns an empty array when no account zone matches the supported set', () => {
    const zones: AvailabilityZoneInfo[] = [{ zoneName: 'us-east-1c', zoneId: 'use1-az6' }];
    expect(selectSupportedAzNames('us-east-1', zones)).toEqual([]);
  });
});

describe('resolveAgentCoreAzs', () => {
  it('returns the validated override without calling the AZ lookup', async () => {
    const describeAzs = jest.fn<Promise<AvailabilityZoneInfo[]>, [string]>();
    const result = await resolveAgentCoreAzs({
      scope: scopeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', 'us-east-1c'] }),
      account: '123456789012',
      region: 'us-east-1',
      describeAzs,
    });
    expect(result).toEqual(['us-east-1b', 'us-east-1c']);
    expect(describeAzs).not.toHaveBeenCalled();
  });

  it('rethrows a malformed override (fails synth loudly)', async () => {
    await expect(
      resolveAgentCoreAzs({
        scope: scopeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: 'us-east-1b' }),
        account: '123456789012',
        region: 'us-east-1',
      }),
    ).rejects.toThrow(/must be a JSON array/);
  });

  it('falls back (undefined) for env-agnostic synth without touching AWS', async () => {
    const describeAzs = jest.fn<Promise<AvailabilityZoneInfo[]>, [string]>();
    expect(await resolveAgentCoreAzs({ scope: scopeWithContext(), account: undefined, region: undefined, describeAzs }))
      .toBeUndefined();
    expect(await resolveAgentCoreAzs({ scope: scopeWithContext(), account: '123456789012', region: undefined, describeAzs }))
      .toBeUndefined();
    expect(describeAzs).not.toHaveBeenCalled();
  });

  it('falls back (undefined) for a region with no known constraint', async () => {
    const describeAzs = jest.fn<Promise<AvailabilityZoneInfo[]>, [string]>();
    const result = await resolveAgentCoreAzs({
      scope: scopeWithContext(),
      account: '123456789012',
      region: 'eu-north-1',
      describeAzs,
    });
    expect(result).toBeUndefined();
    expect(describeAzs).not.toHaveBeenCalled();
  });

  it('auto-pins to the account supported zone names for a concrete env', async () => {
    const describeAzs = jest.fn<Promise<AvailabilityZoneInfo[]>, [string]>().mockResolvedValue(US_EAST_1_ZONES);
    const result = await resolveAgentCoreAzs({
      scope: scopeWithContext(),
      account: '123456789012',
      region: 'us-east-1',
      describeAzs,
    });
    expect(result).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1d']);
    expect(describeAzs).toHaveBeenCalledWith('us-east-1');
  });

  it('warns and falls back when fewer than two supported zones are found', async () => {
    const scope = scopeWithContext();
    const describeAzs = jest.fn<Promise<AvailabilityZoneInfo[]>, [string]>().mockResolvedValue([
      { zoneName: 'us-east-1a', zoneId: 'use1-az1' },
      { zoneName: 'us-east-1c', zoneId: 'use1-az6' },
    ]);
    const result = await resolveAgentCoreAzs({ scope, account: '123456789012', region: 'us-east-1', describeAzs });
    expect(result).toBeUndefined();
    Annotations.fromStack(scope).hasWarning('*', Match.stringLikeRegexp('AgentCore AZs'));
  });

  it('warns and falls back when the AZ lookup fails', async () => {
    const scope = scopeWithContext();
    const describeAzs = jest.fn<Promise<AvailabilityZoneInfo[]>, [string]>().mockRejectedValue(new Error('DescribeAZ boom'));
    const result = await resolveAgentCoreAzs({ scope, account: '123456789012', region: 'us-east-1', describeAzs });
    expect(result).toBeUndefined();
    Annotations.fromStack(scope).hasWarning('*', Match.stringLikeRegexp('AgentCore AZs'));
  });
});
