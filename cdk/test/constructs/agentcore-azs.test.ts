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
import { Template } from 'aws-cdk-lib/assertions';
import { AgentVpc } from '../../src/constructs/agent-vpc';
import {
  AGENTCORE_AZS_CONTEXT_KEY,
  AGENTCORE_SUPPORTED_AZ_IDS,
  AGENTCORE_SUPPORTED_AZ_IDS_SNAPSHOT_DATE,
  AUTO_PIN_AZ_COUNT,
  AgentCoreAzResolution,
  AvailabilityZoneInfo,
  DescribeAzsFn,
  MIN_AGENTCORE_AZS,
  ResolveCallerAccountFn,
  applyAgentCoreAzDiagnostics,
  resolveAgentCoreAzOverride,
  resolveAgentCoreAzs,
  selectSupportedAzNames,
} from '../../src/constructs/agentcore-azs';

const ACCOUNT = '123456789012';

function nodeWithContext(context?: Record<string, unknown>) {
  const app = new App({ context });
  return new Stack(app, 'TestStack').node;
}

/**
 * Independent transcription of the AWS source table, kept separate from the
 * production constant on purpose: asserting the map against itself (its own key
 * list, its own shape) cannot detect drift or a mis-typed zone ID.
 *
 * Source: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html#agentcore-supported-azs
 */
const EXPECTED_SUPPORTED_AZ_IDS: Record<string, string[]> = {
  'us-east-1': ['use1-az1', 'use1-az2', 'use1-az4'],
  'us-east-2': ['use2-az1', 'use2-az2', 'use2-az3'],
  'us-west-2': ['usw2-az1', 'usw2-az2', 'usw2-az3'],
  'ca-central-1': ['cac1-az1', 'cac1-az2', 'cac1-az4'],
  'sa-east-1': ['sae1-az1', 'sae1-az2', 'sae1-az3'],
  'eu-west-1': ['euw1-az1', 'euw1-az2', 'euw1-az3'],
  'eu-west-2': ['euw2-az1', 'euw2-az2', 'euw2-az3'],
  'eu-west-3': ['euw3-az1', 'euw3-az2', 'euw3-az3'],
  'eu-central-1': ['euc1-az1', 'euc1-az2', 'euc1-az3'],
  'eu-north-1': ['eun1-az1', 'eun1-az2', 'eun1-az3'],
  'eu-south-1': ['eus1-az1', 'eus1-az2', 'eus1-az3'],
  'eu-south-2': ['eus2-az1', 'eus2-az2', 'eus2-az3'],
  'ap-south-1': ['aps1-az1', 'aps1-az2', 'aps1-az3'],
  'ap-northeast-1': ['apne1-az1', 'apne1-az2', 'apne1-az4'],
  'ap-northeast-2': ['apne2-az1', 'apne2-az2', 'apne2-az3'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2', 'apse1-az3'],
  'ap-southeast-2': ['apse2-az1', 'apse2-az2', 'apse2-az3'],
  'ap-southeast-5': ['apse5-az1', 'apse5-az2', 'apse5-az3'],
  'ap-southeast-7': ['apse7-az1', 'apse7-az2', 'apse7-az3'],
  'us-gov-west-1': ['usgw1-az1', 'usgw1-az2', 'usgw1-az3'],
};

/** Realistic us-east-1 mapping; supported IDs are use1-az1/az2/az4. */
const US_EAST_1_ZONES: AvailabilityZoneInfo[] = [
  { zoneName: 'us-east-1a', zoneId: 'use1-az2' }, // supported
  { zoneName: 'us-east-1b', zoneId: 'use1-az4' }, // supported
  { zoneName: 'us-east-1c', zoneId: 'use1-az6' }, // unsupported
  { zoneName: 'us-east-1d', zoneId: 'use1-az1' }, // supported
  { zoneName: 'us-east-1e', zoneId: 'use1-az3' }, // unsupported
  { zoneName: 'us-east-1f', zoneId: 'use1-az5' }, // unsupported
];

const okAccount: ResolveCallerAccountFn = async () => ACCOUNT;
const okZones: DescribeAzsFn = async () => US_EAST_1_ZONES;

/** Resolve with concrete env and injected lookups (no AWS access). */
function resolveConcrete(overrides: {
  context?: Record<string, unknown>;
  region?: string;
  account?: string;
  describeAzs?: DescribeAzsFn;
  resolveCallerAccount?: ResolveCallerAccountFn;
} = {}): Promise<AgentCoreAzResolution> {
  return resolveAgentCoreAzs({
    node: nodeWithContext(overrides.context),
    account: overrides.account ?? ACCOUNT,
    region: overrides.region ?? 'us-east-1',
    describeAzs: overrides.describeAzs ?? okZones,
    resolveCallerAccount: overrides.resolveCallerAccount ?? okAccount,
  });
}

describe('AGENTCORE_SUPPORTED_AZ_IDS', () => {
  it('matches the AWS source table exactly (drift detector)', () => {
    // Deep-equal against an independently transcribed literal: catches a wrong
    // zone ID ('us-east-1': ['usw2-az1']) and a dropped/added region, neither of
    // which a self-referential assertion can see.
    expect(AGENTCORE_SUPPORTED_AZ_IDS).toEqual(EXPECTED_SUPPORTED_AZ_IDS);
  });

  it('covers the regions AWS publishes, including the ones that skip -az3', () => {
    // ca-central-1, us-east-1 and ap-northeast-1 use az4 rather than az3, so the
    // sets cannot be derived as az1..az3.
    expect(AGENTCORE_SUPPORTED_AZ_IDS['ca-central-1']).toContain('cac1-az4');
    expect(AGENTCORE_SUPPORTED_AZ_IDS['ca-central-1']).not.toContain('cac1-az3');
    expect(AGENTCORE_SUPPORTED_AZ_IDS['us-east-1']).toContain('use1-az4');
    expect(AGENTCORE_SUPPORTED_AZ_IDS['ap-northeast-1']).toContain('apne1-az4');
    // Regions the earlier revision of this map omitted entirely.
    for (const region of [
      'ap-northeast-2', 'ap-southeast-5', 'ap-southeast-7', 'ca-central-1',
      'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'sa-east-1',
    ]) {
      expect(AGENTCORE_SUPPORTED_AZ_IDS[region]).toBeDefined();
    }
  });

  it('lists at least the HA floor of distinct zone IDs per region', () => {
    for (const [region, ids] of Object.entries(AGENTCORE_SUPPORTED_AZ_IDS)) {
      expect(ids.length).toBeGreaterThanOrEqual(MIN_AGENTCORE_AZS);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[a-z]+[0-9]+-az[0-9]+$/);
      }
      expect(region).toMatch(/^[a-z]{2}(-[a-z]+)+-\d$/);
    }
  });

  it('carries a snapshot date so staleness is visible', () => {
    expect(AGENTCORE_SUPPORTED_AZ_IDS_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('AUTO_PIN_AZ_COUNT', () => {
  it('equals the AgentVpc default zone count (topology stays unchanged)', () => {
    // The coupling the constants' comments claim, asserted rather than trusted:
    // a default AgentVpc must produce exactly AUTO_PIN_AZ_COUNT zones, i.e.
    // AUTO_PIN_AZ_COUNT * 2 subnets (one public + one private per zone).
    const stack = new Stack(new App(), 'DefaultVpcStack');
    new AgentVpc(stack, 'AgentVpc');
    Template.fromStack(stack).resourceCountIs('AWS::EC2::Subnet', AUTO_PIN_AZ_COUNT * 2);
    expect(AUTO_PIN_AZ_COUNT).toBeGreaterThanOrEqual(MIN_AGENTCORE_AZS);
  });
});

describe('resolveAgentCoreAzOverride', () => {
  it('returns undefined when the context key is unset', () => {
    expect(resolveAgentCoreAzOverride(nodeWithContext())).toBeUndefined();
  });

  it('returns the validated array when provided', () => {
    const override = ['us-east-1b', 'us-east-1c'];
    expect(resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: override })))
      .toEqual(override);
  });

  it('parses a JSON-string array (the `-c key=value` CLI form)', () => {
    expect(
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: '["us-east-1b","us-east-1c"]' })),
    ).toEqual(['us-east-1b', 'us-east-1c']);
  });

  it('throws on a bare (non-JSON) string override', () => {
    expect(() => resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: 'us-east-1b' })))
      .toThrow(/must be a JSON array of availability-zone names/);
  });

  it('throws on a JSON string that does not parse to an array', () => {
    expect(() => resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: '"us-east-1b"' })))
      .toThrow(/must be a JSON array of availability-zone names/);
  });

  it('throws on a non-string / empty entry', () => {
    expect(() => resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', ''] })))
      .toThrow(/entries must be non-empty availability-zone-name strings/);
  });

  it('throws when fewer than two DISTINCT zones are listed', () => {
    // Duplicates previously satisfied the HA check: 4 subnets, 1 real zone.
    expect(() =>
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', 'us-east-1b'] })),
    ).toThrow(/at least 2 distinct zones/);
    expect(() => resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b'] })))
      .toThrow(/at least 2 distinct zones/);
  });

  it('rejects zone IDs with a message pointing at the name/ID mix-up', () => {
    // `describe-availability-zones` prints ZoneName then ZoneId; copying column 2
    // used to synthesize as AvailabilityZone: "use1-az2".
    expect(() =>
      resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['use1-az2', 'use1-az4'] })),
    ).toThrow(/is a zone \*ID\*, not a zone \*name\*/);
  });

  it('rejects names outside the target region when the region is known', () => {
    expect(() =>
      resolveAgentCoreAzOverride(
        nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-west-2a', 'us-west-2b'] }),
        'us-east-1',
      ),
    ).toThrow(/is not in the target region us-east-1/);
  });

  it('skips the region check when the region is unknown (env-agnostic synth)', () => {
    expect(resolveAgentCoreAzOverride(nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-west-2a', 'us-west-2b'] })))
      .toEqual(['us-west-2a', 'us-west-2b']);
  });
});

describe('selectSupportedAzNames', () => {
  it('returns supported zone names in deterministic sorted order', () => {
    // Deliberately unsorted input: DescribeAvailabilityZones contracts no order,
    // and an unstable pin would replace every subnet on a later synth.
    const shuffled = [...US_EAST_1_ZONES].reverse();
    expect(selectSupportedAzNames('us-east-1', shuffled)).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1d']);
    expect(selectSupportedAzNames('us-east-1', US_EAST_1_ZONES))
      .toEqual(selectSupportedAzNames('us-east-1', shuffled));
  });

  it('returns an empty array for a region with no known constraint', () => {
    // A region genuinely absent from the map — NOT eu-north-1, which is supported.
    expect(selectSupportedAzNames('me-central-1', US_EAST_1_ZONES)).toEqual([]);
  });

  it('returns an empty array when no account zone matches the supported set', () => {
    expect(selectSupportedAzNames('us-east-1', [{ zoneName: 'us-east-1c', zoneId: 'use1-az6' }])).toEqual([]);
  });
});

describe('applyAgentCoreAzDiagnostics', () => {
  it('maps error diagnostics to addError and warnings to addWarning', () => {
    const stack = new Stack(new App(), 'DiagStack');
    applyAgentCoreAzDiagnostics(stack, {
      zones: undefined,
      diagnostics: [
        { level: 'error', message: 'boom-error' },
        { level: 'warning', message: 'boom-warning' },
      ],
    });
    const errors = stack.node.metadata.filter(m => m.type === 'aws:cdk:error').map(m => m.data);
    const warnings = stack.node.metadata.filter(m => m.type === 'aws:cdk:warning').map(m => m.data);
    expect(errors).toEqual(['boom-error']);
    expect(warnings).toEqual(['boom-warning']);
  });
});

describe('resolveAgentCoreAzs', () => {
  it('auto-pins exactly AUTO_PIN_AZ_COUNT supported zones, sorted', async () => {
    const describeAzs = jest.fn(okZones);
    const result = await resolveConcrete({ describeAzs });
    expect(result.zones).toEqual(['us-east-1a', 'us-east-1b']);
    expect(result.zones).toHaveLength(AUTO_PIN_AZ_COUNT);
    expect(result.diagnostics).toEqual([]);
    expect(describeAzs).toHaveBeenCalledWith('us-east-1');
  });

  it('returns the override without any AWS lookup', async () => {
    const describeAzs = jest.fn(okZones);
    const resolveCallerAccount = jest.fn(okAccount);
    const result = await resolveAgentCoreAzs({
      node: nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', 'us-east-1c'] }),
      describeAzs,
      resolveCallerAccount,
    });
    expect(result.zones).toEqual(['us-east-1b', 'us-east-1c']);
    expect(result.diagnostics).toEqual([]);
    expect(describeAzs).not.toHaveBeenCalled();
    expect(resolveCallerAccount).not.toHaveBeenCalled();
  });

  it('honors the override BEFORE the env-agnostic guard (the CI/CD path)', async () => {
    // Reordering these two checks would silently disable the only pinning
    // mechanism the pipeline artifact has.
    const result = await resolveAgentCoreAzs({
      node: nodeWithContext({ [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1b', 'us-east-1c'] }),
      account: undefined,
      region: undefined,
    });
    expect(result.zones).toEqual(['us-east-1b', 'us-east-1c']);
    expect(result.diagnostics).toEqual([]);
  });

  it('rethrows a malformed override (fails synth loudly)', async () => {
    await expect(resolveConcrete({ context: { [AGENTCORE_AZS_CONTEXT_KEY]: 'us-east-1b' } }))
      .rejects.toThrow(/must be a JSON array of availability-zone names/);
  });

  it('errors when the override names zones whose IDs are unsupported', async () => {
    const result = await resolveConcrete({
      context: { [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1c', 'us-east-1e'] },
    });
    expect(result.zones).toEqual(['us-east-1c', 'us-east-1e']);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('not AgentCore-supported in us-east-1');
    expect(result.diagnostics[0].message).toContain('us-east-1c (use1-az6)');
  });

  it('errors when the override names zones that do not exist', async () => {
    const result = await resolveConcrete({
      context: { [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1a', 'us-east-1z'] },
    });
    expect(result.diagnostics.some(d => d.level === 'error' && d.message.includes('do not exist in us-east-1')))
      .toBe(true);
  });

  it('warns (not errors) when the override cannot be verified', async () => {
    const result = await resolveConcrete({
      context: { [AGENTCORE_AZS_CONTEXT_KEY]: ['us-east-1a', 'us-east-1b'] },
      describeAzs: async () => {
        throw new Error('AccessDenied');
      },
    });
    // The escape hatch must keep working when the lookup cannot.
    expect(result.zones).toEqual(['us-east-1a', 'us-east-1b']);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('warning');
    expect(result.diagnostics[0].message).toContain('Could not verify');
  });

  it('warns and does not pin for env-agnostic synth, without touching AWS', async () => {
    const describeAzs = jest.fn(okZones);
    const resolveCallerAccount = jest.fn(okAccount);
    for (const env of [{}, { account: ACCOUNT }, { region: 'us-east-1' }]) {
      const result = await resolveAgentCoreAzs({
        node: nodeWithContext(), ...env, describeAzs, resolveCallerAccount,
      });
      expect(result.zones).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].level).toBe('warning');
      expect(result.diagnostics[0].message).toContain('without a bound account/region');
    }
    expect(describeAzs).not.toHaveBeenCalled();
    expect(resolveCallerAccount).not.toHaveBeenCalled();
  });

  it('treats an unresolved token account as env-agnostic', async () => {
    // Defensive guard for a future caller passing stack.account.
    const result = await resolveAgentCoreAzs({
      node: nodeWithContext(),
      account: '${Token[AWS.AccountId.1]}',
      region: 'us-east-1',
      // Both injected so that dropping the token guard cannot reach AWS from a
      // unit test — it fails the assertion below instead.
      describeAzs: async () => {
        throw new Error('must not be called');
      },
      resolveCallerAccount: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics[0].message).toContain('without a bound account/region');
  });

  it('warns and does not pin for a region absent from the map', async () => {
    const describeAzs = jest.fn(okZones);
    const result = await resolveConcrete({ region: 'me-central-1', describeAzs });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('warning');
    expect(result.diagnostics[0].message).toContain('No supported-zone data for region me-central-1');
    expect(describeAzs).not.toHaveBeenCalled();
  });

  it('ERRORS when the AZ lookup fails (fail closed, not a silent fallback)', async () => {
    const result = await resolveConcrete({
      describeAzs: async () => {
        throw new Error('User: arn:aws:iam::123456789012:user/dev is not authorized');
      },
    });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('Could not resolve AgentCore-supported availability zones');
    // Error identity only — the authz message echoes the caller ARN, and this
    // string lands in cdk.out, which CI uploads as an artifact.
    expect(result.diagnostics[0].message).not.toContain('arn:aws:iam::');
  });

  it('ERRORS when synth credentials belong to a different account', async () => {
    const describeAzs = jest.fn(okZones);
    const result = await resolveConcrete({
      resolveCallerAccount: async () => '999999999999',
      describeAzs,
    });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('resolve to account 999999999999');
    // Must not read a mapping from the wrong account.
    expect(describeAzs).not.toHaveBeenCalled();
  });

  it('ERRORS when the caller account cannot be confirmed', async () => {
    const result = await resolveConcrete({
      resolveCallerAccount: async () => {
        throw new Error('ExpiredToken');
      },
    });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('Could not confirm which account');
  });

  it('ERRORS when fewer than the HA floor of supported zones exist', async () => {
    const result = await resolveConcrete({
      describeAzs: async () => [
        { zoneName: 'us-east-1a', zoneId: 'use1-az1' },
        { zoneName: 'us-east-1c', zoneId: 'use1-az6' },
      ],
    });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('Found only 1 AgentCore-supported availability zone(s)');
  });
});
