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

/**
 * Covers the **default** (live) lookups in `agentcore-azs.ts`, which every other
 * test replaces by injection. The SDK modules are mocked, so nothing here talks
 * to AWS; what is asserted is the request shape those lookups depend on —
 * `state=available` filtering, bounded timeouts/attempts, and the solution
 * User-Agent required by AGENTS.md (#319).
 */

const ec2Send = jest.fn();
const stsSend = jest.fn();
const ec2Ctor = jest.fn();
const stsCtor = jest.fn();

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation((cfg: Record<string, unknown>) => {
    ec2Ctor(cfg);
    return { send: ec2Send };
  }),
  DescribeAvailabilityZonesCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation((cfg: Record<string, unknown>) => {
    stsCtor(cfg);
    return { send: stsSend };
  }),
  GetCallerIdentityCommand: jest.fn().mockImplementation((input: unknown) => ({ input, isGetCallerIdentity: true })),
}));

import { App, Stack } from 'aws-cdk-lib';
import { resolveAgentCoreAzs } from '../../src/constructs/agentcore-azs';

const ACCOUNT = '123456789012';

function node() {
  return new Stack(new App(), 'LiveLookupStack').node;
}

describe('default live lookups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stsSend.mockResolvedValue({ Account: ACCOUNT });
    ec2Send.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'us-east-1a', ZoneId: 'use1-az2' },
        { ZoneName: 'us-east-1b', ZoneId: 'use1-az4' },
        { ZoneName: 'us-east-1c', ZoneId: 'use1-az6' },
        // Malformed entries must be skipped, not crash the resolver.
        { ZoneName: undefined, ZoneId: 'use1-az1' },
        { ZoneName: 'us-east-1z', ZoneId: undefined },
      ],
    });
  });

  it('auto-pins through the real EC2 + STS code paths', async () => {
    const result = await resolveAgentCoreAzs({ node: node(), account: ACCOUNT, region: 'us-east-1' });
    expect(result.zones).toEqual(['us-east-1a', 'us-east-1b']);
    expect(result.diagnostics).toEqual([]);
    expect(stsSend).toHaveBeenCalledTimes(1);
    expect(ec2Send).toHaveBeenCalledTimes(1);
  });

  it('requests only available standard zones', async () => {
    await resolveAgentCoreAzs({ node: node(), account: ACCOUNT, region: 'us-east-1' });
    const command = ec2Send.mock.calls[0][0] as { input: { Filters: { Name: string; Values: string[] }[] } };
    expect(command.input.Filters).toEqual(
      expect.arrayContaining([
        { Name: 'zone-type', Values: ['availability-zone'] },
        { Name: 'state', Values: ['available'] },
      ]),
    );
  });

  it('bounds both clients with timeouts, retries, region and solution UA', async () => {
    await resolveAgentCoreAzs({ node: node(), account: ACCOUNT, region: 'us-east-1' });
    for (const ctor of [ec2Ctor, stsCtor]) {
      const cfg = ctor.mock.calls[0][0] as Record<string, any>;
      expect(cfg.region).toBe('us-east-1');
      expect(cfg.maxAttempts).toBe(2);
      expect(cfg.requestHandler).toEqual({ requestTimeout: 5000, connectionTimeout: 5000 });
      // makeClient() attribution — a naked client would drop the md/ segment.
      expect(cfg.customUserAgent).toEqual([['md/uksb-wt64nei4u6', expect.any(String)]]);
    }
  });

  it('errors (fail closed) when the live AZ lookup rejects', async () => {
    ec2Send.mockRejectedValue(Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' }));
    const result = await resolveAgentCoreAzs({ node: node(), account: ACCOUNT, region: 'us-east-1' });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('UnauthorizedOperation');
  });

  it('errors (fail closed) when the live account lookup rejects', async () => {
    stsSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'ExpiredTokenException' }));
    const result = await resolveAgentCoreAzs({ node: node(), account: ACCOUNT, region: 'us-east-1' });
    expect(result.zones).toBeUndefined();
    expect(result.diagnostics[0].level).toBe('error');
    expect(result.diagnostics[0].message).toContain('ExpiredTokenException');
    expect(ec2Send).not.toHaveBeenCalled();
  });
});
