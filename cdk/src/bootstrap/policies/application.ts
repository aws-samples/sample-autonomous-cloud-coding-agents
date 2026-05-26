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
 * Returns the IAM PolicyDocument for the IaCRole-ABCA-Application role.
 *
 * Covers: DynamoDB, Lambda, API Gateway, Cognito, WAFv2, EventBridge,
 * Secrets Manager permissions.
 */
export function applicationPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'DynamoDB',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:CreateTable',
          'dynamodb:DeleteTable',
          'dynamodb:DescribeTable',
          'dynamodb:DescribeTimeToLive',
          'dynamodb:UpdateTimeToLive',
          'dynamodb:UpdateTable',
          'dynamodb:UpdateContinuousBackups',
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:TagResource',
          'dynamodb:UntagResource',
          'dynamodb:ListTagsOfResource',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DescribeContributorInsights',
          'dynamodb:DescribeKinesisStreamingDestination',
          'dynamodb:GetResourcePolicy',
        ],
        resources: ['arn:aws:dynamodb:*:*:table/backgroundagent-dev-*'],
      }),

      new iam.PolicyStatement({
        sid: 'Lambda',
        effect: iam.Effect.ALLOW,
        actions: [
          'lambda:CreateFunction',
          'lambda:DeleteFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:AddPermission',
          'lambda:RemovePermission',
          'lambda:GetPolicy',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:ListTags',
          'lambda:PublishVersion',
          'lambda:CreateAlias',
          'lambda:DeleteAlias',
          'lambda:GetAlias',
          'lambda:UpdateAlias',
          'lambda:PutFunctionEventInvokeConfig',
          'lambda:DeleteFunctionEventInvokeConfig',
          'lambda:GetFunctionEventInvokeConfig',
          'lambda:PutFunctionConcurrency',
          'lambda:DeleteFunctionConcurrency',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetProvisionedConcurrencyConfig',
          'lambda:GetRuntimeManagementConfig',
          'lambda:ListVersionsByFunction',
          'lambda:InvokeFunction',
        ],
        resources: [
          'arn:aws:lambda:*:*:function:backgroundagent-dev-*',
          'arn:aws:lambda:*:*:function:backgroundagent-dev-AWS*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'APIGateway',
        effect: iam.Effect.ALLOW,
        actions: [
          'apigateway:POST',
          'apigateway:GET',
          'apigateway:PUT',
          'apigateway:PATCH',
          'apigateway:DELETE',
          'apigateway:TagResource',
          'apigateway:UntagResource',
          'apigateway:SetWebACL',
          'apigateway:UpdateRestApiPolicy',
        ],
        resources: [
          'arn:aws:apigateway:*::/restapis',
          'arn:aws:apigateway:*::/restapis/*',
          'arn:aws:apigateway:*::/account',
          'arn:aws:apigateway:*::/tags/*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'Cognito',
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:CreateUserPool',
          'cognito-idp:DeleteUserPool',
          'cognito-idp:DescribeUserPool',
          'cognito-idp:UpdateUserPool',
          'cognito-idp:CreateUserPoolClient',
          'cognito-idp:DeleteUserPoolClient',
          'cognito-idp:DescribeUserPoolClient',
          'cognito-idp:UpdateUserPoolClient',
          'cognito-idp:TagResource',
          'cognito-idp:UntagResource',
          'cognito-idp:ListTagsForResource',
          'cognito-idp:GetUserPoolMfaConfig',
        ],
        resources: ['arn:aws:cognito-idp:*:*:userpool/*'],
      }),

      new iam.PolicyStatement({
        sid: 'WAFv2',
        effect: iam.Effect.ALLOW,
        actions: [
          'wafv2:CreateWebACL',
          'wafv2:DeleteWebACL',
          'wafv2:GetWebACL',
          'wafv2:UpdateWebACL',
          'wafv2:AssociateWebACL',
          'wafv2:DisassociateWebACL',
          'wafv2:ListTagsForResource',
          'wafv2:TagResource',
          'wafv2:UntagResource',
          'wafv2:GetWebACLForResource',
        ],
        resources: [
          'arn:aws:wafv2:*:*:regional/webacl/*',
          'arn:aws:wafv2:*:*:regional/managedruleset/*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'EventBridge',
        effect: iam.Effect.ALLOW,
        actions: [
          'events:PutRule',
          'events:DeleteRule',
          'events:DescribeRule',
          'events:PutTargets',
          'events:RemoveTargets',
          'events:ListTargetsByRule',
          'events:TagResource',
          'events:UntagResource',
          'events:ListTagsForResource',
        ],
        resources: ['arn:aws:events:*:*:rule/backgroundagent-dev-*'],
      }),

      new iam.PolicyStatement({
        sid: 'SecretsManager',
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:PutSecretValue',
          'secretsmanager:UpdateSecret',
          'secretsmanager:TagResource',
          'secretsmanager:UntagResource',
          'secretsmanager:GetResourcePolicy',
          'secretsmanager:PutResourcePolicy',
          'secretsmanager:DeleteResourcePolicy',
        ],
        resources: [
          'arn:aws:secretsmanager:*:*:secret:backgroundagent-*',
          'arn:aws:secretsmanager:*:*:secret:GitHubTokenSecret*',
        ],
      }),

      new iam.PolicyStatement({
        sid: 'SecretsManagerAccountLevel',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetRandomPassword'],
        resources: ['*'],
      }),
    ],
  });
}
