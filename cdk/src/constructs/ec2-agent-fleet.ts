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

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface Ec2AgentFleetProps {
  readonly vpc: ec2.IVpc;
  readonly agentImageAsset: ecr_assets.DockerImageAsset;
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
  readonly userConcurrencyTable: dynamodb.ITable;
  readonly githubTokenSecret: secretsmanager.ISecret;
  readonly memoryId?: string;
  readonly instanceType?: ec2.InstanceType;
  readonly desiredCapacity?: number;
  readonly maxCapacity?: number;
}

export class Ec2AgentFleet extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly instanceRole: iam.Role;
  public readonly payloadBucket: s3.Bucket;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly fleetTagKey: string;
  public readonly fleetTagValue: string;

  constructor(scope: Construct, id: string, props: Ec2AgentFleetProps) {
    super(scope, id);

    this.fleetTagKey = 'bgagent:fleet';
    this.fleetTagValue = id;

    // Security group — egress TCP 443 only
    this.securityGroup = new ec2.SecurityGroup(this, 'FleetSG', {
      vpc: props.vpc,
      description: 'EC2 Agent Fleet - egress TCP 443 only',
      allowAllOutbound: false,
    });

    this.securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS egress (GitHub API, AWS services)',
    );

    // S3 bucket for payload overflow
    this.payloadBucket = new s3.Bucket(this, 'PayloadBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { expiration: Duration.days(7) },
      ],
    });

    // CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'FleetLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // IAM Role for instances
    this.instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // DynamoDB read/write on task tables
    props.taskTable.grantReadWriteData(this.instanceRole);
    props.taskEventsTable.grantReadWriteData(this.instanceRole);
    props.userConcurrencyTable.grantReadWriteData(this.instanceRole);

    // Secrets Manager read for GitHub token
    props.githubTokenSecret.grantRead(this.instanceRole);

    // Bedrock model invocation
    this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*'],
    }));

    // CloudWatch Logs write
    logGroup.grantWrite(this.instanceRole);

    // ECR pull
    this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
      ],
      resources: ['*'],
    }));
    this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
      ],
      resources: [props.agentImageAsset.repository.repositoryArn],
    }));

    // S3 read on payload bucket
    this.payloadBucket.grantRead(this.instanceRole);

    // EC2 tag management on self (conditioned on fleet tag)
    this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags', 'ec2:DeleteTags'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          [`ec2:ResourceTag/${this.fleetTagKey}`]: this.fleetTagValue,
        },
      },
    }));

    const imageUri = props.agentImageAsset.imageUri;

    // User data: install Docker, pull image, tag as idle
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# Install Docker',
      'dnf install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      '',
      '# ECR login and pre-pull agent image',
      'REGION=$(ec2-metadata --availability-zone | cut -d" " -f2 | sed \'s/.$//\')',
      `aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin $(echo '${imageUri}' | cut -d/ -f1)`,
      `docker pull '${imageUri}'`,
      '',
      '# Tag self as idle',
      'INSTANCE_ID=$(ec2-metadata -i | cut -d" " -f2)',
      'aws ec2 create-tags --resources "$INSTANCE_ID" --region "$REGION" --tags Key=bgagent:status,Value=idle',
    );

    // Auto Scaling Group
    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: props.instanceType ?? new ec2.InstanceType('m7g.xlarge'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: this.instanceRole,
      securityGroup: this.securityGroup,
      userData,
      desiredCapacity: props.desiredCapacity ?? 1,
      minCapacity: props.desiredCapacity ?? 1,
      maxCapacity: props.maxCapacity ?? 3,
      healthCheck: autoscaling.HealthCheck.ec2(),
    });

    // Tag the ASG instances for fleet identification
    // CDK auto-propagates tags from the ASG to instances
    this.autoScalingGroup.node.defaultChild;
    this.autoScalingGroup.addUserData(`aws ec2 create-tags --resources "$(ec2-metadata -i | cut -d' ' -f2)" --region "$(ec2-metadata --availability-zone | cut -d' ' -f2 | sed 's/.$//')" --tags Key=${this.fleetTagKey},Value=${this.fleetTagValue}`);

    NagSuppressions.addResourceSuppressions(this.instanceRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonSSMManagedInstanceCore is the AWS-recommended managed policy for SSM-managed instances',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; Bedrock InvokeModel requires * resource; Secrets Manager wildcards from CDK grantRead; CloudWatch Logs wildcards from CDK grantWrite; ECR GetAuthorizationToken requires * resource; EC2 CreateTags/DeleteTags conditioned on fleet tag; S3 read wildcards from CDK grantRead',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.autoScalingGroup, [
      {
        id: 'AwsSolutions-AS3',
        reason: 'ASG scaling notifications are not required for this dev/preview compute backend',
      },
      {
        id: 'AwsSolutions-EC26',
        reason: 'EBS encryption uses default AWS-managed key — sufficient for agent ephemeral workloads',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.payloadBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Server access logging not required for ephemeral payload overflow bucket with 7-day lifecycle',
      },
    ], true);
  }
}
