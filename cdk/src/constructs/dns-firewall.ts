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

import { RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IValidation } from 'constructs';

const DOMAIN_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const PLATFORM_BASELINE_DOMAINS: readonly string[] = [
  'github.com',
  'api.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  '*.npmjs.org',
  'pypi.org',
  '*.pypi.org',
  'files.pythonhosted.org',
  // AWS services — VPC endpoint private DNS resolves at the Resolver level;
  // this wildcard ensures DNS Firewall does not interfere with endpoint resolution.
  '*.amazonaws.com',
];

export interface DnsFirewallProps {
  readonly vpc: ec2.IVpc;

  /**
   * Additional domains to allow, aggregated from Blueprint egressAllowlists.
   * These are appended to the platform baseline.
   * @default - no additional domains
   */
  readonly additionalAllowedDomains?: string[];

  /**
   * When true (default), non-allowlisted domains trigger ALERT (log only)
   * rather than BLOCK.
   * @default true
   */
  readonly observationMode?: boolean;

  /**
   * Removal policy for DNS Firewall resources.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Route 53 Resolver DNS Firewall for the agent VPC.
 *
 * Enforces a platform-wide DNS allowlist: only domains on the baseline list
 * (and any additional domains from Blueprint egressAllowlists) can be resolved.
 * All other DNS queries are either logged (observation mode) or blocked.
 *
 * **Limitations:**
 * - VPC-wide policy — all agent sessions share the same rules; per-repo
 *   egressAllowlists are aggregated into the platform allowlist.
 * - DNS-only — does not block direct IP connections (no DNS lookup to intercept).
 * - Fail-open (by design) — transient DNS Firewall issues allow queries through
 *   rather than blocking, prioritizing session availability over strict enforcement.
 */
export class DnsFirewall extends Construct {
  constructor(scope: Construct, id: string, props: DnsFirewallProps) {
    super(scope, id);

    const observationMode = props.observationMode ?? true;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    const additionalDomains = [...new Set(props.additionalAllowedDomains ?? [])];

    this.node.addValidation(new DomainListValidation(additionalDomains));

    const baselineDomainList = new route53resolver.CfnFirewallDomainList(this, 'BaselineDomainList', {
      name: 'platform-baseline',
      domains: [...PLATFORM_BASELINE_DOMAINS],
    });
    baselineDomainList.applyRemovalPolicy(removalPolicy);

    // CloudFormation requires a domain list to have at least one entry.
    // '.invalid' is an RFC 2606 reserved TLD that never resolves.
    const additionalDomainList = new route53resolver.CfnFirewallDomainList(this, 'AdditionalDomainList', {
      name: 'blueprint-additional',
      domains: additionalDomains.length > 0 ? additionalDomains : ['placeholder.invalid'],
    });
    additionalDomainList.applyRemovalPolicy(removalPolicy);

    const blockAllDomainList = new route53resolver.CfnFirewallDomainList(this, 'BlockAllDomainList', {
      name: 'block-all',
      domains: ['*'],
    });
    blockAllDomainList.applyRemovalPolicy(removalPolicy);

    const catchAllAction = observationMode ? 'ALERT' : 'BLOCK';
    const rules: route53resolver.CfnFirewallRuleGroup.FirewallRuleProperty[] = [
      {
        action: 'ALLOW',
        firewallDomainListId: baselineDomainList.attrId,
        priority: 100,
      },
      {
        action: 'ALLOW',
        firewallDomainListId: additionalDomainList.attrId,
        priority: 200,
      },
      {
        action: catchAllAction,
        firewallDomainListId: blockAllDomainList.attrId,
        priority: 300,
        ...(!observationMode ? { blockResponse: 'NODATA' } : {}),
      },
    ];

    const ruleGroup = new route53resolver.CfnFirewallRuleGroup(this, 'RuleGroup', {
      name: 'agent-egress-policy',
      firewallRules: rules,
    });
    ruleGroup.applyRemovalPolicy(removalPolicy);

    new route53resolver.CfnFirewallRuleGroupAssociation(this, 'RuleGroupAssociation', {
      firewallRuleGroupId: ruleGroup.attrId,
      vpcId: props.vpc.vpcId,
      priority: 101,
      name: 'agent-vpc-dns-firewall',
    });

    // CloudFormation does not recognise AWS::Route53Resolver::FirewallConfig in all regions.
    const firewallConfig = new cr.AwsCustomResource(this, 'FirewallConfig', {
      onCreate: {
        service: 'Route53Resolver',
        action: 'updateFirewallConfig',
        parameters: {
          ResourceId: props.vpc.vpcId,
          FirewallFailOpen: 'ENABLED',
        },
        physicalResourceId: cr.PhysicalResourceId.of('dns-firewall-config'),
      },
      onUpdate: {
        service: 'Route53Resolver',
        action: 'updateFirewallConfig',
        parameters: {
          ResourceId: props.vpc.vpcId,
          FirewallFailOpen: 'ENABLED',
        },
        physicalResourceId: cr.PhysicalResourceId.of('dns-firewall-config'),
      },
      onDelete: {
        service: 'Route53Resolver',
        action: 'updateFirewallConfig',
        parameters: {
          ResourceId: props.vpc.vpcId,
          FirewallFailOpen: 'DISABLED',
        },
        ignoreErrorCodesMatching: 'ResourceNotFoundException|ValidationException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['route53resolver:UpdateFirewallConfig', 'ec2:DescribeVpcs'],
          resources: ['*'],
        }),
      ]),
    });

    NagSuppressions.addResourceSuppressions(firewallConfig, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'route53resolver:UpdateFirewallConfig requires ec2:DescribeVpcs — neither supports resource-level permissions',
      },
    ], true);

    const queryLogGroup = new logs.LogGroup(this, 'QueryLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    const queryLogConfig = new route53resolver.CfnResolverQueryLoggingConfig(this, 'QueryLogConfig', {
      destinationArn: queryLogGroup.logGroupArn,
      name: 'agent-dns-query-log',
    });

    new route53resolver.CfnResolverQueryLoggingConfigAssociation(this, 'QueryLogAssociation', {
      resolverQueryLogConfigId: queryLogConfig.attrId,
      resourceId: props.vpc.vpcId,
    });
  }
}

class DomainListValidation implements IValidation {
  constructor(private readonly domains: string[]) {}

  public validate(): string[] {
    const errors: string[] = [];
    for (const domain of this.domains) {
      if (!DOMAIN_PATTERN.test(domain)) {
        errors.push(`Invalid additional domain: '${domain}'. Expected a lowercase domain (e.g. 'example.com' or '*.example.com').`);
      }
    }
    return errors;
  }
}
