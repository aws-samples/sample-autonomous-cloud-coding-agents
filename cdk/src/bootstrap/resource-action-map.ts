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

import { aws_iam as iam } from 'aws-cdk-lib';

import { allPolicies, policiesForComputeType } from './policies';

/**
 * CloudFormation resource types that do not require IAM actions on the
 * CloudFormation execution role (metadata, references, or permissions-only).
 */
export const CFN_TYPES_WITHOUT_EXEC_ROLE_IAM = new Set([
  'AWS::CDK::Metadata',
  'AWS::Lambda::Permission',
  'AWS::Lambda::Version',
  'AWS::Lambda::Alias',
  'AWS::ApiGateway::Deployment',
  'AWS::ApiGateway::Stage',
  'AWS::ApiGateway::Account',
  'AWS::S3::BucketPolicy',
  'AWS::SQS::QueuePolicy',
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::Logs::ResourcePolicy',
]);

/**
 * IAM actions the CloudFormation execution role needs per resource lifecycle
 * phase. Actions are sourced from the CloudTrail-validated policies in
 * docs/design/DEPLOYMENT_ROLES.md.
 *
 * ``create`` is the deploy-verified subset that CI exercises today. The
 * ``read``/``update``/``delete`` phases exist because a create-only map cannot
 * catch the failure mode that actually recurs: every one of the reactive
 * permission fixes since this map was introduced (#351, #403, #405, #408, #410,
 * #494, #595) was a missing ``Update*``/``Tag*``/``Delete*`` action, surfaced by
 * a failed stack UPDATE or DELETE rather than by the initial deploy.
 *
 * Parent issue: #350 (map) / #124 (CRUD depth). Synth-time aspect: #125.
 */
export interface ResourceActions {
  /** Actions required to create the resource (exercised by CI's deploy). */
  create: readonly string[];
  /** Actions CloudFormation issues to read state back (drift / no-op detection). */
  read: readonly string[];
  /** Actions required to modify the resource in place on a stack update. */
  update: readonly string[];
  /** Actions required to remove the resource on a stack update or delete. */
  delete: readonly string[];
}

export const RESOURCE_ACTION_MAP: Record<string, ResourceActions> = {
  // ─── ApiGateway ────────────────────────────────────────────────────
  'AWS::ApiGateway::Account': {
    create: ['apigateway:PATCH'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH'],
    delete: ['apigateway:PATCH'],
  },
  'AWS::ApiGateway::Authorizer': {
    create: ['apigateway:POST'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH'],
    delete: ['apigateway:DELETE'],
  },
  'AWS::ApiGateway::Deployment': {
    create: ['apigateway:POST'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH'],
    delete: ['apigateway:DELETE'],
  },
  'AWS::ApiGateway::Method': {
    create: ['apigateway:PUT', 'apigateway:POST'],
    read: ['apigateway:GET'],
    update: ['apigateway:PUT'],
    delete: ['apigateway:DELETE'],
  },
  'AWS::ApiGateway::RequestValidator': {
    create: ['apigateway:POST'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH'],
    delete: ['apigateway:DELETE'],
  },
  'AWS::ApiGateway::Resource': {
    create: ['apigateway:POST'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH'],
    delete: ['apigateway:DELETE'],
  },
  'AWS::ApiGateway::RestApi': {
    create: ['apigateway:POST', 'apigateway:TagResource'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH', 'apigateway:TagResource', 'apigateway:UntagResource'],
    delete: ['apigateway:DELETE'],
  },
  'AWS::ApiGateway::Stage': {
    create: ['apigateway:POST', 'apigateway:TagResource'],
    read: ['apigateway:GET'],
    update: ['apigateway:PATCH', 'apigateway:TagResource', 'apigateway:UntagResource'],
    delete: ['apigateway:DELETE'],
  },
  // ─── Bedrock ───────────────────────────────────────────────────────
  'AWS::Bedrock::Guardrail': {
    create: ['bedrock:CreateGuardrail', 'bedrock:TagResource'],
    read: ['bedrock:GetGuardrail', 'bedrock:ListTagsForResource'],
    update: ['bedrock:UpdateGuardrail', 'bedrock:TagResource', 'bedrock:UntagResource'],
    delete: ['bedrock:DeleteGuardrail'],
  },
  'AWS::Bedrock::GuardrailVersion': {
    create: ['bedrock:CreateGuardrailVersion'],
    read: ['bedrock:GetGuardrail'],
    update: ['bedrock:CreateGuardrailVersion'],
    delete: ['bedrock:DeleteGuardrail'],
  },
  // ─── BedrockAgentCore ──────────────────────────────────────────────
  'AWS::BedrockAgentCore::Memory': {
    create: ['bedrock-agentcore:CreateMemory'],
    read: ['bedrock-agentcore:GetMemory'],
    update: ['bedrock-agentcore:UpdateMemory'],
    delete: ['bedrock-agentcore:DeleteMemory'],
  },
  'AWS::BedrockAgentCore::Runtime': {
    create: ['bedrock-agentcore:CreateRuntime'],
    read: ['bedrock-agentcore:GetRuntime'],
    update: ['bedrock-agentcore:UpdateRuntime'],
    delete: ['bedrock-agentcore:DeleteRuntime'],
  },
  // ─── CloudFront ────────────────────────────────────────────────────
  'AWS::CloudFront::Distribution': {
    create: ['cloudfront:CreateDistribution'],
    read: [],
    update: [],
    delete: [],
  },
  'AWS::CloudFront::OriginAccessControl': {
    create: ['cloudfront:CreateOriginAccessControl'],
    read: [],
    update: [],
    delete: [],
  },
  // ─── CloudWatch ────────────────────────────────────────────────────
  'AWS::CloudWatch::Alarm': {
    create: ['cloudwatch:PutMetricAlarm', 'cloudwatch:TagResource'],
    read: ['cloudwatch:DescribeAlarms', 'cloudwatch:ListTagsForResource'],
    update: ['cloudwatch:PutMetricAlarm', 'cloudwatch:TagResource', 'cloudwatch:UntagResource'],
    delete: ['cloudwatch:DeleteAlarms'],
  },
  'AWS::CloudWatch::Dashboard': {
    create: ['cloudwatch:PutDashboard'],
    read: ['cloudwatch:GetDashboard'],
    update: ['cloudwatch:PutDashboard'],
    delete: ['cloudwatch:DeleteDashboards'],
  },
  // ─── Cognito ───────────────────────────────────────────────────────
  'AWS::Cognito::UserPool': {
    create: ['cognito-idp:CreateUserPool', 'cognito-idp:TagResource'],
    read: [
      'cognito-idp:DescribeUserPool',
      'cognito-idp:ListTagsForResource',
      'cognito-idp:GetUserPoolMfaConfig',
    ],
    update: ['cognito-idp:UpdateUserPool', 'cognito-idp:TagResource', 'cognito-idp:UntagResource'],
    delete: ['cognito-idp:DeleteUserPool'],
  },
  'AWS::Cognito::UserPoolClient': {
    create: ['cognito-idp:CreateUserPoolClient'],
    read: ['cognito-idp:DescribeUserPoolClient'],
    update: ['cognito-idp:UpdateUserPoolClient'],
    delete: ['cognito-idp:DeleteUserPoolClient'],
  },
  // ─── Custom ────────────────────────────────────────────────────────
  'Custom::AWS': {
    create: ['lambda:InvokeFunction'],
    read: [],
    update: [],
    delete: [],
  },
  'Custom::S3AutoDeleteObjects': {
    create: ['lambda:InvokeFunction'],
    read: [],
    update: [],
    delete: [],
  },
  'Custom::VpcRestrictDefaultSG': {
    create: ['lambda:InvokeFunction'],
    read: [],
    update: [],
    delete: [],
  },
  // ─── DynamoDB ──────────────────────────────────────────────────────
  'AWS::DynamoDB::Table': {
    create: [
      'dynamodb:CreateTable',
      'dynamodb:TagResource',
      'dynamodb:DescribeTable',
      'dynamodb:UpdateTimeToLive',
      'dynamodb:UpdateContinuousBackups',
    ],
    read: [
      'dynamodb:DescribeTable',
      'dynamodb:DescribeTimeToLive',
      'dynamodb:DescribeContinuousBackups',
      'dynamodb:ListTagsOfResource',
      'dynamodb:DescribeContributorInsights',
      'dynamodb:DescribeKinesisStreamingDestination',
      'dynamodb:GetResourcePolicy',
    ],
    update: [
      'dynamodb:UpdateTable',
      'dynamodb:TagResource',
      'dynamodb:UntagResource',
      'dynamodb:UpdateTimeToLive',
      'dynamodb:UpdateContinuousBackups',
    ],
    delete: ['dynamodb:DeleteTable'],
  },
  // ─── EC2 ───────────────────────────────────────────────────────────
  'AWS::EC2::EIP': {
    create: ['ec2:AllocateAddress', 'ec2:CreateTags'],
    read: ['ec2:DescribeAddresses'],
    update: ['ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:ReleaseAddress'],
  },
  'AWS::EC2::FlowLog': {
    create: ['ec2:CreateFlowLogs', 'ec2:CreateTags'],
    read: ['ec2:DescribeFlowLogs'],
    update: ['ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteFlowLogs'],
  },
  'AWS::EC2::InternetGateway': {
    create: ['ec2:CreateInternetGateway', 'ec2:CreateTags'],
    read: ['ec2:DescribeInternetGateways'],
    update: ['ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteInternetGateway'],
  },
  'AWS::EC2::NatGateway': {
    create: ['ec2:CreateNatGateway', 'ec2:CreateTags'],
    read: ['ec2:DescribeNatGateways'],
    update: ['ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteNatGateway'],
  },
  'AWS::EC2::Route': {
    create: ['ec2:CreateRoute'],
    read: ['ec2:DescribeRouteTables'],
    update: ['ec2:CreateRoute', 'ec2:DeleteRoute'],
    delete: ['ec2:DeleteRoute'],
  },
  'AWS::EC2::RouteTable': {
    create: ['ec2:CreateRouteTable', 'ec2:CreateTags'],
    read: ['ec2:DescribeRouteTables'],
    update: ['ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteRouteTable'],
  },
  'AWS::EC2::SecurityGroup': {
    create: [
      'ec2:CreateSecurityGroup',
      'ec2:CreateTags',
      'ec2:AuthorizeSecurityGroupEgress',
      'ec2:AuthorizeSecurityGroupIngress',
    ],
    read: ['ec2:DescribeSecurityGroups'],
    update: [
      'ec2:AuthorizeSecurityGroupEgress',
      'ec2:RevokeSecurityGroupEgress',
      'ec2:AuthorizeSecurityGroupIngress',
      'ec2:RevokeSecurityGroupIngress',
      'ec2:CreateTags',
      'ec2:DeleteTags',
    ],
    delete: ['ec2:DeleteSecurityGroup'],
  },
  'AWS::EC2::Subnet': {
    create: ['ec2:CreateSubnet', 'ec2:CreateTags', 'ec2:ModifySubnetAttribute'],
    read: ['ec2:DescribeSubnets'],
    update: ['ec2:ModifySubnetAttribute', 'ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteSubnet'],
  },
  'AWS::EC2::SubnetRouteTableAssociation': {
    create: ['ec2:AssociateRouteTable'],
    read: ['ec2:DescribeRouteTables'],
    update: ['ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable'],
    delete: ['ec2:DisassociateRouteTable'],
  },
  'AWS::EC2::VPC': {
    create: [
      'ec2:CreateVpc',
      'ec2:CreateTags',
      'ec2:ModifyVpcAttribute',
      'ec2:DescribeVpcAttribute',
    ],
    read: ['ec2:DescribeVpcs', 'ec2:DescribeVpcAttribute'],
    update: ['ec2:ModifyVpcAttribute', 'ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteVpc'],
  },
  'AWS::EC2::VPCEndpoint': {
    create: ['ec2:CreateVpcEndpoint', 'ec2:CreateTags'],
    read: ['ec2:DescribeVpcEndpoints'],
    update: ['ec2:ModifyVpcEndpoint', 'ec2:CreateTags', 'ec2:DeleteTags'],
    delete: ['ec2:DeleteVpcEndpoints'],
  },
  'AWS::EC2::VPCGatewayAttachment': {
    create: ['ec2:AttachInternetGateway'],
    read: ['ec2:DescribeInternetGateways'],
    update: ['ec2:AttachInternetGateway', 'ec2:DetachInternetGateway'],
    delete: ['ec2:DetachInternetGateway'],
  },
  // ─── ECS ───────────────────────────────────────────────────────────
  'AWS::ECS::Cluster': {
    create: ['ecs:CreateCluster', 'ecs:TagResource'],
    read: [],
    update: [],
    delete: [],
  },
  'AWS::ECS::TaskDefinition': {
    create: ['ecs:RegisterTaskDefinition', 'ecs:TagResource'],
    read: [],
    update: [],
    delete: [],
  },
  // ─── Events ────────────────────────────────────────────────────────
  'AWS::Events::Rule': {
    create: ['events:PutRule', 'events:PutTargets', 'events:TagResource'],
    read: ['events:DescribeRule', 'events:ListTargetsByRule', 'events:ListTagsForResource'],
    update: [
      'events:PutRule',
      'events:PutTargets',
      'events:RemoveTargets',
      'events:TagResource',
      'events:UntagResource',
    ],
    delete: ['events:DeleteRule', 'events:RemoveTargets'],
  },
  // ─── IAM ───────────────────────────────────────────────────────────
  'AWS::IAM::ManagedPolicy': {
    create: ['iam:CreatePolicy', 'iam:TagPolicy'],
    read: ['iam:GetPolicy', 'iam:GetPolicyVersion', 'iam:ListPolicyVersions'],
    update: ['iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:TagPolicy'],
    delete: ['iam:DeletePolicy', 'iam:DeletePolicyVersion'],
  },
  'AWS::IAM::Policy': {
    create: ['iam:PutRolePolicy', 'iam:CreatePolicy'],
    read: ['iam:GetRolePolicy'],
    update: ['iam:PutRolePolicy'],
    delete: ['iam:DeleteRolePolicy'],
  },
  'AWS::IAM::Role': {
    create: [
      'iam:CreateRole',
      'iam:TagRole',
      'iam:AttachRolePolicy',
      'iam:PutRolePolicy',
      'iam:PassRole',
    ],
    read: [
      'iam:GetRole',
      'iam:ListRoleTags',
      'iam:ListRolePolicies',
      'iam:ListAttachedRolePolicies',
      'iam:GetRolePolicy',
      'iam:ListInstanceProfilesForRole',
    ],
    update: [
      'iam:UpdateRole',
      'iam:TagRole',
      'iam:UntagRole',
      'iam:AttachRolePolicy',
      'iam:DetachRolePolicy',
      'iam:PutRolePolicy',
      'iam:DeleteRolePolicy',
    ],
    delete: ['iam:DeleteRole', 'iam:DetachRolePolicy', 'iam:DeleteRolePolicy'],
  },
  // ─── Lambda ────────────────────────────────────────────────────────
  'AWS::Lambda::Alias': {
    create: ['lambda:CreateAlias'],
    read: ['lambda:GetAlias'],
    update: ['lambda:UpdateAlias'],
    delete: ['lambda:DeleteAlias'],
  },
  'AWS::Lambda::EventInvokeConfig': {
    create: ['lambda:PutFunctionEventInvokeConfig'],
    read: ['lambda:GetFunctionEventInvokeConfig'],
    update: ['lambda:PutFunctionEventInvokeConfig'],
    delete: ['lambda:DeleteFunctionEventInvokeConfig'],
  },
  'AWS::Lambda::EventSourceMapping': {
    create: ['lambda:CreateEventSourceMapping'],
    read: ['lambda:GetEventSourceMapping'],
    update: ['lambda:UpdateEventSourceMapping'],
    delete: ['lambda:DeleteEventSourceMapping'],
  },
  'AWS::Lambda::Function': {
    create: ['lambda:CreateFunction', 'lambda:TagResource'],
    read: [
      'lambda:GetFunction',
      'lambda:GetFunctionConfiguration',
      'lambda:GetPolicy',
      'lambda:ListTags',
      'lambda:GetFunctionCodeSigningConfig',
      'lambda:GetFunctionRecursionConfig',
      'lambda:GetRuntimeManagementConfig',
    ],
    update: [
      'lambda:UpdateFunctionCode',
      'lambda:UpdateFunctionConfiguration',
      'lambda:TagResource',
      'lambda:UntagResource',
      'lambda:PutFunctionConcurrency',
      'lambda:DeleteFunctionConcurrency',
    ],
    delete: ['lambda:DeleteFunction'],
  },
  'AWS::Lambda::LayerVersion': {
    create: ['lambda:PublishLayerVersion'],
    read: ['lambda:GetLayerVersion'],
    update: ['lambda:PublishLayerVersion'],
    delete: ['lambda:DeleteLayerVersion'],
  },
  'AWS::Lambda::Permission': {
    create: ['lambda:AddPermission'],
    read: ['lambda:GetPolicy'],
    update: ['lambda:AddPermission', 'lambda:RemovePermission'],
    delete: ['lambda:RemovePermission'],
  },
  'AWS::Lambda::Version': {
    create: ['lambda:PublishVersion'],
    read: ['lambda:GetFunction', 'lambda:GetProvisionedConcurrencyConfig'],
    update: ['lambda:PublishVersion'],
    delete: ['lambda:DeleteFunction'],
  },
  // ─── Logs ──────────────────────────────────────────────────────────
  'AWS::Logs::Delivery': {
    create: ['logs:CreateDelivery'],
    read: ['logs:GetDelivery', 'logs:DescribeDeliveries'],
    update: ['logs:CreateDelivery', 'logs:DeleteDelivery'],
    delete: ['logs:DeleteDelivery'],
  },
  'AWS::Logs::DeliveryDestination': {
    create: ['logs:PutDeliveryDestination'],
    read: ['logs:GetDeliveryDestination', 'logs:GetDeliveryDestinationPolicy'],
    update: ['logs:PutDeliveryDestination'],
    delete: ['logs:DeleteDeliveryDestination'],
  },
  'AWS::Logs::DeliverySource': {
    create: ['logs:PutDeliverySource'],
    read: ['logs:GetDeliverySource'],
    update: ['logs:PutDeliverySource'],
    delete: ['logs:DeleteDeliverySource'],
  },
  'AWS::Logs::LogGroup': {
    create: ['logs:CreateLogGroup', 'logs:TagResource', 'logs:PutRetentionPolicy'],
    read: ['logs:DescribeLogGroups', 'logs:ListTagsForResource', 'logs:ListTagsLogGroup'],
    update: [
      'logs:PutRetentionPolicy',
      'logs:DeleteRetentionPolicy',
      'logs:TagResource',
      'logs:UntagResource',
    ],
    delete: ['logs:DeleteLogGroup'],
  },
  'AWS::Logs::ResourcePolicy': {
    create: ['logs:PutResourcePolicy'],
    read: ['logs:DescribeResourcePolicies'],
    update: ['logs:PutResourcePolicy'],
    delete: ['logs:DeleteResourcePolicy'],
  },
  // ─── Route53Resolver ───────────────────────────────────────────────
  'AWS::Route53Resolver::FirewallDomainList': {
    create: ['route53resolver:CreateFirewallDomainList', 'route53resolver:TagResource'],
    read: ['route53resolver:GetFirewallDomainList', 'route53resolver:ListTagsForResource'],
    update: [
      'route53resolver:UpdateFirewallDomains',
      'route53resolver:TagResource',
      'route53resolver:UntagResource',
    ],
    delete: ['route53resolver:DeleteFirewallDomainList'],
  },
  'AWS::Route53Resolver::FirewallRuleGroup': {
    create: [
      'route53resolver:CreateFirewallRuleGroup',
      'route53resolver:CreateFirewallRule',
      'route53resolver:TagResource',
    ],
    read: [
      'route53resolver:GetFirewallRuleGroup',
      'route53resolver:ListFirewallRules',
      'route53resolver:ListTagsForResource',
    ],
    update: [
      'route53resolver:UpdateFirewallRule',
      'route53resolver:CreateFirewallRule',
      'route53resolver:DeleteFirewallRule',
      'route53resolver:TagResource',
      'route53resolver:UntagResource',
    ],
    delete: ['route53resolver:DeleteFirewallRuleGroup', 'route53resolver:DeleteFirewallRule'],
  },
  'AWS::Route53Resolver::FirewallRuleGroupAssociation': {
    create: ['route53resolver:AssociateFirewallRuleGroup', 'route53resolver:TagResource'],
    read: [
      'route53resolver:GetFirewallRuleGroupAssociation',
      'route53resolver:ListFirewallRuleGroupAssociations',
      'route53resolver:ListTagsForResource',
    ],
    update: ['route53resolver:TagResource', 'route53resolver:UntagResource'],
    delete: ['route53resolver:DisassociateFirewallRuleGroup'],
  },
  'AWS::Route53Resolver::ResolverQueryLoggingConfig': {
    create: ['route53resolver:CreateResolverQueryLogConfig', 'route53resolver:TagResource'],
    read: [
      'route53resolver:GetResolverQueryLogConfig',
      'route53resolver:ListResolverQueryLogConfigs',
      'route53resolver:ListTagsForResource',
    ],
    update: ['route53resolver:TagResource', 'route53resolver:UntagResource'],
    delete: ['route53resolver:DeleteResolverQueryLogConfig'],
  },
  'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation': {
    create: ['route53resolver:AssociateResolverQueryLogConfig'],
    read: [
      'route53resolver:GetResolverQueryLogConfigAssociation',
      'route53resolver:ListResolverQueryLogConfigAssociations',
    ],
    update: [
      'route53resolver:AssociateResolverQueryLogConfig',
      'route53resolver:DisassociateResolverQueryLogConfig',
    ],
    delete: ['route53resolver:DisassociateResolverQueryLogConfig'],
  },
  // ─── S3 ────────────────────────────────────────────────────────────
  'AWS::S3::Bucket': {
    create: [
      's3:CreateBucket',
      's3:PutBucketPolicy',
      's3:PutBucketPublicAccessBlock',
      's3:PutEncryptionConfiguration',
      's3:PutBucketVersioning',
      's3:PutBucketTagging',
    ],
    read: [
      's3:GetBucketPolicy',
      's3:GetBucketTagging',
      's3:GetEncryptionConfiguration',
      's3:GetBucketVersioning',
      's3:GetBucketPublicAccessBlock',
      's3:GetBucketLocation',
      's3:ListBucket',
    ],
    update: [
      's3:PutBucketPolicy',
      's3:PutBucketPublicAccessBlock',
      's3:PutEncryptionConfiguration',
      's3:PutBucketVersioning',
      's3:PutBucketTagging',
      's3:DeleteBucketPolicy',
    ],
    delete: ['s3:DeleteBucket', 's3:DeleteBucketPolicy'],
  },
  'AWS::S3::BucketPolicy': {
    create: ['s3:PutBucketPolicy'],
    read: ['s3:GetBucketPolicy'],
    update: ['s3:PutBucketPolicy'],
    delete: ['s3:DeleteBucketPolicy'],
  },
  // ─── SQS ───────────────────────────────────────────────────────────
  'AWS::SQS::Queue': {
    create: ['sqs:CreateQueue', 'sqs:TagQueue', 'sqs:GetQueueUrl', 'sqs:GetQueueAttributes'],
    read: ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
    update: ['sqs:SetQueueAttributes', 'sqs:TagQueue', 'sqs:UntagQueue'],
    delete: ['sqs:DeleteQueue', 'sqs:GetQueueUrl'],
  },
  'AWS::SQS::QueuePolicy': {
    create: ['sqs:AddPermission', 'sqs:SetQueueAttributes', 'sqs:GetQueueUrl'],
    read: ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
    update: ['sqs:SetQueueAttributes', 'sqs:RemovePermission', 'sqs:AddPermission'],
    delete: ['sqs:RemovePermission', 'sqs:SetQueueAttributes', 'sqs:GetQueueUrl'],
  },
  // ─── SecretsManager ────────────────────────────────────────────────
  'AWS::SecretsManager::Secret': {
    create: [
      'secretsmanager:CreateSecret',
      'secretsmanager:TagResource',
      'secretsmanager:GetRandomPassword',
    ],
    read: [
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
      'secretsmanager:GetResourcePolicy',
    ],
    update: [
      'secretsmanager:UpdateSecret',
      'secretsmanager:PutSecretValue',
      'secretsmanager:TagResource',
      'secretsmanager:UntagResource',
      'secretsmanager:PutResourcePolicy',
      'secretsmanager:DeleteResourcePolicy',
    ],
    delete: ['secretsmanager:DeleteSecret'],
  },
  // ─── WAFv2 ─────────────────────────────────────────────────────────
  'AWS::WAFv2::WebACL': {
    create: ['wafv2:CreateWebACL', 'wafv2:TagResource'],
    read: ['wafv2:GetWebACL', 'wafv2:ListTagsForResource'],
    update: ['wafv2:UpdateWebACL', 'wafv2:TagResource', 'wafv2:UntagResource'],
    delete: ['wafv2:DeleteWebACL'],
  },
  'AWS::WAFv2::WebACLAssociation': {
    create: ['wafv2:AssociateWebACL'],
    read: ['wafv2:GetWebACLForResource'],
    update: ['wafv2:AssociateWebACL', 'wafv2:DisassociateWebACL'],
    delete: ['wafv2:DisassociateWebACL'],
  },
};

/**
 * Returns true when {@link allowedAction} covers {@link requiredAction}.
 * Supports service-level wildcards (e.g. `bedrock-agentcore:*`).
 */
export function actionIsAllowed(requiredAction: string, allowedAction: string): boolean {
  if (allowedAction === requiredAction) {
    return true;
  }
  if (allowedAction.endsWith(':*')) {
    const prefix = allowedAction.slice(0, -1);
    return requiredAction.startsWith(prefix);
  }
  return false;
}

/**
 * Collects all Allow actions declared across bootstrap managed policies.
 *
 * Pass ``computeType`` to scope the set to the policies an operator on that
 * substrate actually deploys (RFC #120's `deployed ⊇ required` model). Omitting
 * it keeps the historical UNION behaviour, which is right for "is this action
 * grantable by SOME configuration?" but too permissive for validating a
 * specific deploy: an agentcore-only operator never installs `compute-ecs`, so
 * the union silently accepts `ecs:*` their real IaCRole cannot perform.
 */
export function collectBootstrapAllowActions(computeType?: string): Set<string> {
  const actions = new Set<string>();
  const policies = computeType === undefined
    ? allPolicies()
    : policiesForComputeType(computeType);
  for (const policy of policies) {
    const json = policy.toJSON();
    for (const stmt of json.Statement ?? []) {
      if (stmt.Effect !== 'Allow') {
        continue;
      }
      const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      for (const action of stmtActions) {
        if (action) {
          actions.add(action);
        }
      }
    }
  }
  return actions;
}

/** Lifecycle phases a resource's required actions are grouped under. */
export type LifecyclePhase = keyof ResourceActions;

/** Flattens an entry's phases into one action list (deduplicated, order kept). */
export function actionsForResource(
  cfnType: string,
  phases: readonly LifecyclePhase[] = ['create', 'read', 'update', 'delete'],
): string[] {
  const entry = RESOURCE_ACTION_MAP[cfnType];
  if (!entry) {
    return [];
  }
  return [...new Set(phases.flatMap((phase) => entry[phase]))];
}

/**
 * Returns IAM actions required by a CloudFormation type that are not covered
 * by the bootstrap policy bundle.
 *
 * Defaults to the ``create`` phase only, which preserves the pre-CRUD contract
 * for existing callers (CI validates a deploy, not an update/delete). Pass
 * explicit ``phases`` to widen: `['create', 'update', 'delete']` is what would
 * have caught the reactive fixes listed on {@link RESOURCE_ACTION_MAP}, and is
 * only safe to gate on once those grants exist (tracked in #124).
 */
export function findMissingBootstrapActions(
  cfnType: string,
  allowedActions: Set<string>,
  phases: readonly LifecyclePhase[] = ['create'],
): string[] {
  return actionsForResource(cfnType, phases).filter((req) =>
    ![...allowedActions].some((allowed) => actionIsAllowed(req, allowed)),
  );
}

/**
 * Resolves bootstrap policies for use in tests (ensures CDK token resolution).
 */
export function resolveBootstrapPolicies(stack: { resolve: (doc: iam.PolicyDocument) => unknown }): void {
  for (const policy of allPolicies()) {
    stack.resolve(policy);
  }
}
