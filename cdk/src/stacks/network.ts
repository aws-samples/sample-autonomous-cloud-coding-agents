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

import { Stack, StackProps } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AgentNetwork, AgentVpc } from '../constructs/agent-vpc';
import { DnsFirewall } from '../constructs/dns-firewall';

export type NetworkTopology = 'inline' | 'split';

export function resolveNetworkTopology(value: unknown): NetworkTopology {
  if (value === undefined || value === 'inline') return 'inline';
  if (value === 'split') return 'split';
  throw new Error('networkTopology must be inline or split');
}

export interface NetworkStackProps extends StackProps {
  /** Original application stack name used in generated network service properties. */
  readonly applicationStackName: string;
  /** Account-specific names selected by the shared AgentCore AZ policy. */
  readonly agentCoreAvailabilityZones?: string[];
  /** Plain Blueprint configuration, resolved before constructing either stack. */
  readonly additionalAllowedDomains?: string[];
}

/** Owns VPC and DNS resources; application consumers only reference this stack. */
export class NetworkStack extends Stack implements AgentNetwork {
  public readonly vpc: AgentNetwork['vpc'];
  public readonly runtimeSecurityGroup: AgentNetwork['runtimeSecurityGroup'];

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const network = new AgentVpc(this, 'AgentVpc', {
      resourcePath: `${props.applicationStackName}/AgentVpc`,
      ...(props.agentCoreAvailabilityZones?.length
        ? { availabilityZones: props.agentCoreAvailabilityZones }
        : {}),
    });
    this.vpc = network.vpc;
    this.runtimeSecurityGroup = network.runtimeSecurityGroup;
    new DnsFirewall(this, 'DnsFirewall', {
      vpc: this.vpc,
      additionalAllowedDomains: props.additionalAllowedDomains,
      observationMode: true,
    });

    // CloudFormation rejects the removal of an export that another stack still imports,
    // so every value is exported even when the selected backend does not use it.
    this.exportValue(this.vpc.vpcId);
    this.exportValue(this.runtimeSecurityGroup.securityGroupId);
    for (const subnet of this.vpc.privateSubnets) this.exportValue(subnet.subnetId);

    NagSuppressions.addResourceSuppressionsByPath(this, [
      `${this.node.path}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
      `${this.node.path}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AwsCustomResource singleton Lambda uses AWS managed AWSLambdaBasicExecutionRole — required by CDK custom-resources framework',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'AwsCustomResource singleton Lambda runtime is managed by the CDK custom-resources framework',
      },
    ]);
  }
}
