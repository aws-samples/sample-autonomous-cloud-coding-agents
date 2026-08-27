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

import { allPolicies } from './policies';

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
  'AWS::SNS::TopicPolicy',
  'AWS::SQS::QueuePolicy',
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::Logs::ResourcePolicy',
]);

/**
 * Minimum IAM actions the CloudFormation execution role needs to create each
 * resource type. This is a deploy-time subset — update when constructs add new
 * AWS services or when CloudTrail shows additional actions during deploy.
 *
 * Parent issue: #350. Full synth-time aspect tracked in #125.
 */
export const RESOURCE_ACTION_MAP: Record<string, readonly string[]> = {
  'AWS::ApiGateway::Authorizer': ['apigateway:POST'],
  'AWS::ApiGateway::Method': ['apigateway:POST'],
  'AWS::ApiGateway::RequestValidator': ['apigateway:POST'],
  'AWS::ApiGateway::Resource': ['apigateway:POST'],
  'AWS::ApiGateway::RestApi': ['apigateway:POST'],
  'AWS::Bedrock::Guardrail': ['bedrock:CreateGuardrail'],
  'AWS::Bedrock::GuardrailVersion': ['bedrock:CreateGuardrailVersion'],
  // ADR-019 tool-gateway feature. Only synthesized under
  // `--context enableToolGateway=true`, so the default-context synth-coverage
  // test never sees these — they are mapped anyway so the map stays a complete
  // statement of what the bootstrap bundle must cover (same pattern as the
  // lambda-microvm entries below). All create actions fall under the
  // `bedrock-agentcore:*` grant in `policies/compute-agentcore.ts`.
  'AWS::BedrockAgentCore::Gateway': ['bedrock-agentcore:CreateGateway'],
  'AWS::BedrockAgentCore::GatewayTarget': ['bedrock-agentcore:CreateGatewayTarget'],
  'AWS::BedrockAgentCore::Memory': ['bedrock-agentcore:CreateMemory'],
  'AWS::BedrockAgentCore::Runtime': ['bedrock-agentcore:CreateRuntime'],
  'AWS::CloudFront::Distribution': ['cloudfront:CreateDistribution'],
  'AWS::CloudFront::OriginAccessControl': ['cloudfront:CreateOriginAccessControl'],
  // NestedStack for Agent Registry (#246) — CFN creates a child stack.
  'AWS::CloudFormation::Stack': ['cloudformation:CreateStack'],
  'AWS::CloudWatch::Alarm': ['cloudwatch:PutMetricAlarm'],
  'AWS::CloudWatch::Dashboard': ['cloudwatch:PutDashboard'],
  'AWS::Cognito::UserPool': ['cognito-idp:CreateUserPool'],
  'AWS::Cognito::UserPoolClient': ['cognito-idp:CreateUserPoolClient'],
  // RegistryPublisher / RegistryApprover groups (#246).
  'AWS::Cognito::UserPoolGroup': ['cognito-idp:CreateGroup'],
  'AWS::DynamoDB::Table': ['dynamodb:CreateTable'],
  'AWS::EC2::EIP': ['ec2:AllocateAddress'],
  'AWS::EC2::FlowLog': ['ec2:CreateFlowLogs'],
  'AWS::EC2::InternetGateway': ['ec2:CreateInternetGateway'],
  'AWS::EC2::NatGateway': ['ec2:CreateNatGateway'],
  'AWS::EC2::Route': ['ec2:CreateRoute'],
  'AWS::EC2::RouteTable': ['ec2:CreateRouteTable'],
  'AWS::EC2::SecurityGroup': ['ec2:CreateSecurityGroup'],
  'AWS::EC2::Subnet': ['ec2:CreateSubnet'],
  'AWS::EC2::VPC': ['ec2:CreateVpc'],
  'AWS::EC2::VPCEndpoint': ['ec2:CreateVpcEndpoint'],
  'AWS::Events::Rule': ['events:PutRule'],
  'AWS::IAM::Policy': ['iam:CreatePolicy', 'iam:PutRolePolicy'],
  'AWS::IAM::Role': ['iam:CreateRole'],
  'AWS::KMS::Key': ['kms:CreateKey'],
  'AWS::Lambda::EventInvokeConfig': ['lambda:PutFunctionEventInvokeConfig'],
  'AWS::Lambda::EventSourceMapping': ['lambda:CreateEventSourceMapping'],
  'AWS::Lambda::Function': ['lambda:CreateFunction'],
  'AWS::Lambda::LayerVersion': ['lambda:PublishLayerVersion'],
  // ADR-021 lambda-microvm backend. Only synthesized under
  // `--context compute_type=lambda-microvm`, so the default-context
  // synth-coverage test never sees these — they are mapped anyway so the map
  // stays a complete statement of what the bootstrap bundle must cover.
  'AWS::Lambda::MicrovmImage': ['lambda:CreateMicrovmImage'],
  'AWS::Lambda::NetworkConnector': ['lambda:CreateNetworkConnector'],
  'AWS::Logs::Delivery': ['logs:CreateDelivery'],
  'AWS::Logs::DeliveryDestination': ['logs:PutDeliveryDestination'],
  'AWS::Logs::DeliverySource': ['logs:PutDeliverySource'],
  'AWS::Logs::LogGroup': ['logs:CreateLogGroup'],
  'AWS::Route53Resolver::FirewallDomainList': ['route53resolver:CreateFirewallDomainList'],
  'AWS::Route53Resolver::FirewallRuleGroup': ['route53resolver:CreateFirewallRuleGroup'],
  'AWS::Route53Resolver::FirewallRuleGroupAssociation': ['route53resolver:AssociateFirewallRuleGroup'],
  'AWS::Route53Resolver::ResolverQueryLoggingConfig': ['route53resolver:CreateResolverQueryLogConfig'],
  'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation': ['route53resolver:AssociateResolverQueryLogConfig'],
  'AWS::S3::Bucket': ['s3:CreateBucket'],
  'AWS::SecretsManager::Secret': ['secretsmanager:CreateSecret'],
  'AWS::SNS::Subscription': ['sns:Subscribe'],
  'AWS::SNS::Topic': ['sns:CreateTopic'],
  'AWS::SQS::Queue': ['sqs:CreateQueue'],
  // The Agent Registry provisioning custom resource uses the CDK Provider
  // framework, whose async waiter is a Step Functions state machine (#246).
  'AWS::StepFunctions::StateMachine': ['states:CreateStateMachine'],
  'AWS::WAFv2::WebACL': ['wafv2:CreateWebACL'],
  'AWS::WAFv2::WebACLAssociation': ['wafv2:AssociateWebACL'],
  'Custom::AWS': ['lambda:InvokeFunction'],
  'Custom::AgentRegistry': ['lambda:InvokeFunction'],
  'Custom::S3AutoDeleteObjects': ['lambda:InvokeFunction'],
  'Custom::VpcRestrictDefaultSG': ['lambda:InvokeFunction'],
};

/**
 * Returns true when {@link allowedAction} covers {@link requiredAction}.
 * Supports service-level wildcards (e.g. `bedrock-agentcore:*`).
 */
function actionIsAllowed(requiredAction: string, allowedAction: string): boolean {
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
 */
export function collectBootstrapAllowActions(): Set<string> {
  const actions = new Set<string>();
  for (const policy of allPolicies()) {
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

/**
 * Returns IAM actions required by a CloudFormation type that are not covered
 * by the bootstrap policy bundle.
 */
export function findMissingBootstrapActions(
  cfnType: string,
  allowedActions: Set<string>,
): string[] {
  const required = RESOURCE_ACTION_MAP[cfnType];
  if (!required) {
    return [];
  }
  return required.filter((req) =>
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
