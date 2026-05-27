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

// ARN partitions are intentionally literal — this policy is a bootstrap
// template matching the exact resource patterns in DEPLOYMENT_ROLES.md.

import { aws_iam as iam } from 'aws-cdk-lib';

/**
 * Returns the IAM PolicyDocument for the IaCRole-ABCA-Observability role.
 *
 * Covers: Bedrock guardrails/logging, CloudWatch Logs and Dashboards,
 * CDK asset buckets (S3), KMS for CDK assets, ECR for Docker assets,
 * X-Ray, SSM Parameter Store, and STS for CDK.
 */
export function observabilityPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'BedrockGuardrailsAndLogging',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:CreateGuardrail',
          'bedrock:DeleteGuardrail',
          'bedrock:GetGuardrail',
          'bedrock:UpdateGuardrail',
          'bedrock:CreateGuardrailVersion',
          'bedrock:ListGuardrails',
          'bedrock:TagResource',
          'bedrock:UntagResource',
          'bedrock:ListTagsForResource',
          'bedrock:PutModelInvocationLoggingConfiguration',
          'bedrock:DeleteModelInvocationLoggingConfiguration',
          'bedrock:GetModelInvocationLoggingConfiguration',
        ],
        resources: ['*'],
      }),

      new iam.PolicyStatement({
        sid: 'CloudWatchLogsAndDashboards',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:DescribeLogGroups',
          'logs:PutRetentionPolicy',
          'logs:DeleteRetentionPolicy',
          'logs:TagLogGroup',
          'logs:UntagLogGroup',
          'logs:TagResource',
          'logs:UntagResource',
          'logs:ListTagsForResource',
          'logs:ListTagsLogGroup',
          'logs:PutResourcePolicy',
          'logs:DeleteResourcePolicy',
          'logs:DescribeResourcePolicies',
          'cloudwatch:PutDashboard',
          'cloudwatch:DeleteDashboards',
          'cloudwatch:GetDashboard',
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:DeleteAlarms',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:TagResource',
          'cloudwatch:UntagResource',
          'logs:CreateDelivery',
          'logs:DescribeDeliveries',
          'logs:GetDelivery',
          'logs:GetDeliveryDestination',
          'logs:GetDeliveryDestinationPolicy',
          'logs:GetDeliverySource',
          'logs:PutDeliveryDestination',
          'logs:PutDeliverySource',
          'logs:DescribeIndexPolicies',
          'cloudwatch:ListTagsForResource',
          'logs:CreateLogDelivery',
          'logs:DeleteLogDelivery',
          'logs:GetLogDelivery',
          'logs:UpdateLogDelivery',
          'logs:ListLogDeliveries',
          'logs:DeleteDelivery',
          'logs:DeleteDeliverySource',
          'logs:DeleteDeliveryDestination',
        ],
        resources: ['*'],
      }),

      new iam.PolicyStatement({
        sid: 'S3CDKAssets',
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:GetBucketLocation',
          's3:ListBucket',
        ],
        resources: [
          'arn:aws:s3:::cdk-hnb659fds-assets-*',
          'arn:aws:s3:::cdk-hnb659fds-assets-*/*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'KMSForCDKAssets',
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:CreateGrant',
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:Encrypt',
          'kms:GenerateDataKey',
        ],
        resources: ['*'],
      }),

      new iam.PolicyStatement({
        sid: 'ECRForDockerAssets',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:CreateRepository',
          'ecr:DescribeRepositories',
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:SetRepositoryPolicy',
          'ecr:GetRepositoryPolicy',
          'ecr:DeleteRepository',
          'ecr:ListTagsForResource',
          'ecr:TagResource',
        ],
        resources: [
          'arn:aws:ecr:*:*:repository/cdk-hnb659fds-container-assets-*',
          'arn:aws:ecr:*:*:repository/backgroundagent-*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'ECRAuthToken',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),

      new iam.PolicyStatement({
        sid: 'XRay',
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:UpdateTraceSegmentDestination',
          'xray:GetTraceSegmentDestination',
          'xray:ListResourcePolicies',
          'xray:PutResourcePolicy',
        ],
        resources: ['*'],
      }),

      new iam.PolicyStatement({
        sid: 'SSMParameterStoreForCDK',
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
        ],
        resources: ['arn:aws:ssm:*:*:parameter/cdk-bootstrap/*'],
      }),

      new iam.PolicyStatement({
        sid: 'STSForCDK',
        effect: iam.Effect.ALLOW,
        actions: [
          'sts:AssumeRole',
          'sts:GetCallerIdentity',
        ],
        resources: ['arn:aws:iam::*:role/cdk-hnb659fds-*'],
      }),
    ],
  });
}
