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
 * Returns the IAM PolicyDocument for the IaCRole-ABCA-Infrastructure role.
 *
 * Covers: CloudFormation, IAM roles/policies, VPC networking, and
 * Route 53 Resolver DNS Firewall permissions.
 */
export function infrastructurePolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'CloudFormationSelf',
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
          'cloudformation:ListStackResources',
          'cloudformation:CreateChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:SetStackPolicy',
          'cloudformation:ValidateTemplate',
          'cloudformation:ListChangeSets',
        ],
        resources: [
          'arn:aws:cloudformation:*:*:stack/backgroundagent-dev/*',
          'arn:aws:cloudformation:*:*:stack/CDKToolkit/*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'IAMRolesAndPolicies',
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:UpdateRole',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:ListRoleTags',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:GetRolePolicy',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
          'iam:CreatePolicy',
          'iam:DeletePolicy',
          'iam:GetPolicy',
          'iam:GetPolicyVersion',
          'iam:CreatePolicyVersion',
          'iam:DeletePolicyVersion',
          'iam:ListPolicyVersions',
          'iam:TagPolicy',
          'iam:CreateServiceLinkedRole',
          'iam:ListInstanceProfilesForRole',
        ],
        resources: [
          'arn:aws:iam::*:role/backgroundagent-dev-*',
          'arn:aws:iam::*:policy/backgroundagent-dev-*',
          'arn:aws:iam::*:role/aws-service-role/*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'IAMPassRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: ['arn:aws:iam::*:role/backgroundagent-dev-*'],
        conditions: {
          StringEquals: {
            'iam:PassedToService': [
              'lambda.amazonaws.com',
              'ecs-tasks.amazonaws.com',
              'ecs.amazonaws.com',
              'apigateway.amazonaws.com',
              'logs.amazonaws.com',
              'bedrock.amazonaws.com',
              'bedrock-agentcore.amazonaws.com',
              'events.amazonaws.com',
              'vpc-flow-logs.amazonaws.com',
            ],
          },
        },
      }),

      new iam.PolicyStatement({
        sid: 'VPCNetworking',
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateVpc',
          'ec2:DeleteVpc',
          'ec2:DescribeVpcs',
          'ec2:ModifyVpcAttribute',
          'ec2:CreateSubnet',
          'ec2:DeleteSubnet',
          'ec2:DescribeSubnets',
          'ec2:CreateInternetGateway',
          'ec2:DeleteInternetGateway',
          'ec2:AttachInternetGateway',
          'ec2:DetachInternetGateway',
          'ec2:DescribeInternetGateways',
          'ec2:AllocateAddress',
          'ec2:ReleaseAddress',
          'ec2:DescribeAddresses',
          'ec2:CreateNatGateway',
          'ec2:DeleteNatGateway',
          'ec2:DescribeNatGateways',
          'ec2:CreateRouteTable',
          'ec2:DeleteRouteTable',
          'ec2:DescribeRouteTables',
          'ec2:AssociateRouteTable',
          'ec2:DisassociateRouteTable',
          'ec2:CreateRoute',
          'ec2:DeleteRoute',
          'ec2:CreateSecurityGroup',
          'ec2:DeleteSecurityGroup',
          'ec2:DescribeSecurityGroups',
          'ec2:AuthorizeSecurityGroupEgress',
          'ec2:RevokeSecurityGroupEgress',
          'ec2:AuthorizeSecurityGroupIngress',
          'ec2:RevokeSecurityGroupIngress',
          'ec2:CreateVpcEndpoint',
          'ec2:DeleteVpcEndpoints',
          'ec2:DescribeVpcEndpoints',
          'ec2:ModifyVpcEndpoint',
          'ec2:CreateFlowLogs',
          'ec2:DeleteFlowLogs',
          'ec2:DescribeFlowLogs',
          'ec2:CreateTags',
          'ec2:DeleteTags',
          'ec2:DescribeTags',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribePrefixLists',
          'ec2:DescribeNetworkAcls',
          'ec2:DescribeVpcAttribute',
          'ec2:ModifySubnetAttribute',
        ],
        resources: ['*'],
      }),

      new iam.PolicyStatement({
        sid: 'Route53ResolverDNSFirewall',
        effect: iam.Effect.ALLOW,
        actions: [
          'route53resolver:CreateFirewallRuleGroup',
          'route53resolver:DeleteFirewallRuleGroup',
          'route53resolver:GetFirewallRuleGroup',
          'route53resolver:CreateFirewallRule',
          'route53resolver:DeleteFirewallRule',
          'route53resolver:ListFirewallRules',
          'route53resolver:UpdateFirewallRule',
          'route53resolver:CreateFirewallDomainList',
          'route53resolver:DeleteFirewallDomainList',
          'route53resolver:GetFirewallDomainList',
          'route53resolver:UpdateFirewallDomains',
          'route53resolver:AssociateFirewallRuleGroup',
          'route53resolver:DisassociateFirewallRuleGroup',
          'route53resolver:GetFirewallRuleGroupAssociation',
          'route53resolver:ListFirewallRuleGroupAssociations',
          'route53resolver:UpdateFirewallConfig',
          'route53resolver:GetFirewallConfig',
          'route53resolver:TagResource',
          'route53resolver:UntagResource',
          'route53resolver:ListTagsForResource',
          'route53resolver:CreateResolverQueryLogConfig',
          'route53resolver:DeleteResolverQueryLogConfig',
          'route53resolver:GetResolverQueryLogConfig',
          'route53resolver:AssociateResolverQueryLogConfig',
          'route53resolver:DisassociateResolverQueryLogConfig',
          'route53resolver:GetResolverQueryLogConfigAssociation',
          'route53resolver:ListResolverQueryLogConfigAssociations',
          'route53resolver:ListResolverQueryLogConfigs',
        ],
        resources: ['*'],
      }),
    ],
  });
}
