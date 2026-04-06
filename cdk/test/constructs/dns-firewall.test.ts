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
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DnsFirewall } from '../../src/constructs/dns-firewall';

function createStack(props?: Partial<ConstructorParameters<typeof DnsFirewall>[2]>): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(stack, 'Vpc');

  new DnsFirewall(stack, 'DnsFirewall', {
    vpc,
    ...props,
  });

  return Template.fromStack(stack);
}

describe('DnsFirewall', () => {
  test('creates 3 firewall domain lists', () => {
    const template = createStack();
    template.resourceCountIs('AWS::Route53Resolver::FirewallDomainList', 3);
  });

  test('creates platform baseline domain list with expected domains', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', {
      Name: 'platform-baseline',
      Domains: Match.arrayWith([
        'github.com',
        'api.github.com',
        '*.githubusercontent.com',
        'registry.npmjs.org',
        'pypi.org',
        '*.amazonaws.com',
      ]),
    });
  });

  test('creates additional domain list with placeholder when no additional domains', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', {
      Name: 'blueprint-additional',
      Domains: ['placeholder.invalid'],
    });
  });

  test('uses placeholder when additionalAllowedDomains is empty array', () => {
    const template = createStack({ additionalAllowedDomains: [] });
    template.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', {
      Name: 'blueprint-additional',
      Domains: ['placeholder.invalid'],
    });
  });

  test('creates additional domain list with provided domains', () => {
    const template = createStack({
      additionalAllowedDomains: ['npm.internal.example.com', '*.private-registry.io'],
    });
    template.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', {
      Name: 'blueprint-additional',
      Domains: ['npm.internal.example.com', '*.private-registry.io'],
    });
  });

  test('deduplicates additional domains', () => {
    const template = createStack({
      additionalAllowedDomains: ['example.com', 'other.com', 'example.com'],
    });
    template.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', {
      Name: 'blueprint-additional',
      Domains: ['example.com', 'other.com'],
    });
  });

  test('creates block-all domain list', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', {
      Name: 'block-all',
      Domains: ['*'],
    });
  });

  test('creates a firewall rule group', () => {
    const template = createStack();
    template.resourceCountIs('AWS::Route53Resolver::FirewallRuleGroup', 1);
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      Name: 'agent-egress-policy',
    });
  });

  test('rule group contains 3 rules with correct priorities and domain list references', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      FirewallRules: Match.arrayWith([
        Match.objectLike({
          Action: 'ALLOW',
          Priority: 100,
          FirewallDomainListId: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('BaselineDomainList')]),
          }),
        }),
        Match.objectLike({
          Action: 'ALLOW',
          Priority: 200,
          FirewallDomainListId: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('AdditionalDomainList')]),
          }),
        }),
        Match.objectLike({
          Priority: 300,
          FirewallDomainListId: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('BlockAllDomainList')]),
          }),
        }),
      ]),
    });
  });

  test('observation mode uses ALERT action without BlockResponse', () => {
    const template = createStack({ observationMode: true });
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      FirewallRules: Match.arrayWith([
        Match.objectLike({
          Action: 'ALERT',
          Priority: 300,
          BlockResponse: Match.absent(),
        }),
      ]),
    });
  });

  test('enforcement mode uses BLOCK action with NODATA response', () => {
    const template = createStack({ observationMode: false });
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      FirewallRules: Match.arrayWith([
        Match.objectLike({ Action: 'BLOCK', Priority: 300, BlockResponse: 'NODATA' }),
      ]),
    });
  });

  test('defaults to observation mode', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      FirewallRules: Match.arrayWith([
        Match.objectLike({ Action: 'ALERT', Priority: 300 }),
      ]),
    });
  });

  test('associates rule group with the VPC', () => {
    const template = createStack();
    template.resourceCountIs('AWS::Route53Resolver::FirewallRuleGroupAssociation', 1);
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroupAssociation', {
      Priority: 101,
      Name: 'agent-vpc-dns-firewall',
      VpcId: Match.objectLike({ Ref: Match.stringLikeRegexp('Vpc') }),
    });
  });

  test('configures fail-open mode for the VPC via custom resource', () => {
    const template = createStack();
    const customs = template.findResources('Custom::AWS');
    const firewallConfigs = Object.values(customs).filter(r => {
      const create = r.Properties?.Create;
      if (typeof create === 'string') {
        return create.includes('updateFirewallConfig') && create.includes('ENABLED');
      }
      // When VPC ID is a token, Create is an Fn::Join intrinsic
      const joined = JSON.stringify(create);
      return joined.includes('updateFirewallConfig') && joined.includes('ENABLED');
    });
    expect(firewallConfigs.length).toBe(1);
  });

  test('creates DNS query logging config', () => {
    const template = createStack();
    template.resourceCountIs('AWS::Route53Resolver::ResolverQueryLoggingConfig', 1);
    template.hasResourceProperties('AWS::Route53Resolver::ResolverQueryLoggingConfig', {
      Name: 'agent-dns-query-log',
    });
  });

  test('associates query logging with the VPC', () => {
    const template = createStack();
    template.resourceCountIs('AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation', 1);
    template.hasResourceProperties('AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation', {
      ResourceId: Match.objectLike({ Ref: Match.stringLikeRegexp('Vpc') }),
    });
  });

  test('creates a log group for DNS query logs with 30-day retention', () => {
    const template = createStack();
    const logGroups = template.findResources('AWS::Logs::LogGroup', {
      Properties: {
        RetentionInDays: 30,
      },
    });
    expect(Object.keys(logGroups).length).toBeGreaterThanOrEqual(1);
  });
});

describe('DnsFirewall validation', () => {
  test('rejects invalid additional domain', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const vpc = new ec2.Vpc(stack, 'Vpc');

    new DnsFirewall(stack, 'DnsFirewall', {
      vpc,
      additionalAllowedDomains: ['INVALID_DOMAIN'],
    });

    expect(() => app.synth()).toThrow(/Invalid additional domain/);
  });

  test('accepts valid additional domains', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const vpc = new ec2.Vpc(stack, 'Vpc');

    new DnsFirewall(stack, 'DnsFirewall', {
      vpc,
      additionalAllowedDomains: ['example.com', '*.internal.example.com'],
    });

    expect(() => app.synth()).not.toThrow();
  });
});
