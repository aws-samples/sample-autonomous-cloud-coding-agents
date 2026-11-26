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

import { RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const HTTPS_PORT = 443;

const DEFAULT_AGENT_VPC_AZS = 2;

const MIN_AGENT_VPC_AZS = 2;

const MAX_RESERVED_NETWORK_AZS = 6;

/** Reserve unused AZ address slots without allocating subnets or other resources. */
export function resolveNetworkReservedAzs(value: unknown): number {
  if (value === undefined) return 0;
  const count = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_RESERVED_NETWORK_AZS) {
    throw new Error(`networkReservedAzs must be an integer from 0 to ${MAX_RESERVED_NETWORK_AZS}`);
  }
  return count;
}

/** The references consumed by any compute backend, regardless of stack ownership. */
export interface AgentNetwork {
  readonly vpc: ec2.IVpc;
  readonly runtimeSecurityGroup: ec2.ISecurityGroup;
}

export interface AgentVpcProps {
  /**
   * Maximum number of availability zones to use.
   * @default 2
   */
  readonly maxAzs?: number;

  /**
   * Explicit list of availability-zone *names* (e.g. `['us-east-1b', 'us-east-1c']`)
   * to place the VPC — and therefore the AgentCore Runtime ENIs — into.
   *
   * AgentCore only supports a subset of the physical availability zones in a
   * region, and AZ *names* are aliased per-account to physical zone IDs — see the AWS
   * {@link https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html#agentcore-supported-azs Supported Availability Zones}
   * table, and the per-region `AGENTCORE_SUPPORTED_AZ_IDS` map in
   * `constructs/agentcore-azs.ts`.
   *
   * Mutually exclusive with {@link maxAzs} — supplying both throws.
   * Must list at least two zones (AgentCore high-availability guidance).
   * @default - CDK selects the first `maxAzs` zones by name
   */
  readonly availabilityZones?: string[];

  /**
   * Number of NAT gateways to provision.
   * @default 1
   */
  readonly natGateways?: number;

  /**
   * Removal policy for VPC flow log resources.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Original AgentVpc construct path used for generated Name tags and endpoint
   * security-group descriptions. Keeps service properties stable across a move.
   * @default - this construct's current path
   */
  readonly resourcePath?: string;
}

/**
 * VPC with restricted egress for the AgentCore Runtime.
 *
 * Provides HTTPS-only outbound access, VPC endpoints for AWS services,
 * and NAT for internet egress (GitHub and package registries).
 * Flow logs are enabled for audit.
 */
export class AgentVpc extends Construct implements AgentNetwork {
  public readonly vpc: ec2.Vpc;

  /** Security group for the Runtime ENIs — allows only TCP 443 egress. */
  public readonly runtimeSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AgentVpcProps = {}) {
    super(scope, id);

    const pinnedAzs = props.availabilityZones;

    if (pinnedAzs?.length && props.maxAzs !== undefined) {
      throw new Error(
        'AgentVpc supports availabilityZones or maxAzs, but not both — '
        + 'an explicit zone list already fixes the zone count.',
      );
    }
    if (pinnedAzs && pinnedAzs.length < MIN_AGENT_VPC_AZS) {
      throw new Error(
        `AgentVpc requires at least ${MIN_AGENT_VPC_AZS} availability zones for AgentCore high `
        + `availability; got ${JSON.stringify(pinnedAzs)}.`,
      );
    }

    const maxAzs = props.maxAzs ?? DEFAULT_AGENT_VPC_AZS;
    const natGateways = props.natGateways ?? 1;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    const reservedAzs = resolveNetworkReservedAzs(this.node.tryGetContext('networkReservedAzs'));

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ...(pinnedAzs?.length
        // CDK appends reserved placeholders to the array it is given.
        ? { availabilityZones: [...pinnedAzs] }
        : { maxAzs }),
      reservedAzs,
      natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const resourceVpcPath = `${props.resourcePath ?? this.node.path}/Vpc`;
    if (props.resourcePath !== undefined) {
      // CDK tags the VPC and each subnet with a Name derived from its own construct path.
      Tags.of(this.vpc).add('Name', resourceVpcPath);
      for (const subnet of [...this.vpc.publicSubnets, ...this.vpc.privateSubnets]) {
        Tags.of(subnet).add('Name', `${resourceVpcPath}${subnet.node.path.slice(this.vpc.node.path.length)}`);
      }
    }

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    const flowLog = this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
    if (props.resourcePath !== undefined) Tags.of(flowLog).add('Name', `${resourceVpcPath}/FlowLog`);

    this.runtimeSecurityGroup = new ec2.SecurityGroup(this, 'RuntimeSG', {
      vpc: this.vpc,
      description: 'AgentCore Runtime - egress TCP 443 only',
      allowAllOutbound: false,
    });

    this.runtimeSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(HTTPS_PORT),
      'Allow HTTPS egress (GitHub + package registries via NAT, AWS services via endpoints)',
    );

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    const interfaceEndpoints: Array<{ id: string; service: ec2.InterfaceVpcEndpointAwsService }> = [
      { id: 'EcrApiEndpoint', service: ec2.InterfaceVpcEndpointAwsService.ECR },
      { id: 'EcrDockerEndpoint', service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER },
      { id: 'CloudWatchLogsEndpoint', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'SecretsManagerEndpoint', service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER },
      { id: 'BedrockRuntimeEndpoint', service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME },
      { id: 'StsEndpoint', service: ec2.InterfaceVpcEndpointAwsService.STS },
      { id: 'XRayEndpoint', service: ec2.InterfaceVpcEndpointAwsService.XRAY },
    ];

    for (const ep of interfaceEndpoints) {
      const endpoint = this.vpc.addInterfaceEndpoint(ep.id, {
        service: ep.service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
      if (props.resourcePath !== undefined) {
        // CloudFormation replaces a security group whose GroupDescription changes, and the CDK default includes the construct path.
        const group = endpoint.node.findChild('SecurityGroup').node.defaultChild as ec2.CfnSecurityGroup;
        group.groupDescription = `${resourceVpcPath}/${ep.id}/SecurityGroup`;
      }
      NagSuppressions.addResourceSuppressions(endpoint.connections.securityGroups, [
        {
          id: 'CdkNagValidationFailure',
          appliesTo: ['AwsSolutions-EC23'],
          reason: 'Ingress is TCP 443 from the VPC CIDR only, rendered as Fn::GetAtt Vpc.CidrBlock, which the rule cannot resolve at synth time',
        },
      ]);
    }
  }
}
