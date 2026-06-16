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
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/** HTTPS port — the only egress allowed from the Runtime ENIs. */
const HTTPS_PORT = 443;

/**
 * Properties for the AgentVpc construct.
 */
export interface AgentVpcProps {
  /**
   * Maximum number of availability zones to use.
   *
   * Ignored when {@link availabilityZones} is provided (CDK does not allow
   * both `maxAzs` and an explicit zone list on the same VPC).
   * @default 2
   */
  readonly maxAzs?: number;

  /**
   * Explicit list of availability-zone *names* (e.g. `['us-east-1b', 'us-east-1c']`)
   * to place the VPC — and therefore the AgentCore Runtime ENIs — into.
   *
   * AgentCore only supports a subset of the physical availability zones in a
   * region, and AZ *names* are aliased per-account to physical zone IDs (so
   * `us-east-1a` is not the same physical zone across accounts). When CDK is
   * left to pick zones by name (the `maxAzs` default) it can land the Runtime
   * subnets in a zone AgentCore does not support, and the
   * `AWS::BedrockAgentCore::Runtime` resource fails to stabilize with
   * `NotStabilized` ("subnets are in unsupported availability zones"), rolling
   * back the whole stack.
   *
   * Pin this to AZ names whose physical zone IDs are AgentCore-supported to
   * make a fresh deploy deterministic regardless of the account's
   * name → zone-ID mapping. Discover the mapping with:
   *
   * ```sh
   * aws ec2 describe-availability-zones --region <region> \
   *   --query 'AvailabilityZones[].[ZoneName,ZoneId]' --output text
   * ```
   *
   * then choose names whose zone IDs are in the AgentCore-supported set for
   * the region (for `us-east-1` at time of writing: `use1-az1`, `use1-az2`,
   * `use1-az4`). The error message returned by a failed Runtime creation also
   * lists the currently supported zone IDs.
   *
   * When provided, takes precedence over {@link maxAzs}.
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
}

/**
 * VPC with restricted egress for the AgentCore Runtime.
 *
 * Provides HTTPS-only outbound access, VPC endpoints for AWS services,
 * and NAT for internet egress (GitHub and package registries).
 * Flow logs are enabled for audit.
 */
export class AgentVpc extends Construct {
  /** The VPC where the Runtime will be deployed. */
  public readonly vpc: ec2.Vpc;

  /** Security group for the Runtime ENIs — allows only TCP 443 egress. */
  public readonly runtimeSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AgentVpcProps = {}) {
    super(scope, id);

    const maxAzs = props.maxAzs ?? 2;
    const natGateways = props.natGateways ?? 1;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- VPC ---
    // When explicit AZs are provided (to target AgentCore-supported physical
    // zones), pass them directly and omit maxAzs — CDK does not allow both.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ...(props.availabilityZones
        ? { availabilityZones: props.availabilityZones }
        : { maxAzs }),
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

    // --- Flow logs (satisfies AwsSolutions-VPC7) ---
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    NagSuppressions.addResourceSuppressions(this.vpc, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'VPC flow log role requires wildcard permissions for CloudWatch Logs — generated by CDK',
      },
    ], true);

    // --- Security group (HTTPS-only egress) ---
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

    // --- Gateway endpoints (free, no ENI cost) ---
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // --- Interface endpoints (private DNS enabled, placed in private subnets) ---
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
      this.vpc.addInterfaceEndpoint(ep.id, {
        service: ep.service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }
  }
}
