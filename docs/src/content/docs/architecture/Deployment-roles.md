---
title: Deployment roles
---

# Deployment roles

This document defines least-privilege IAM policies for the CloudFormation execution role used during `cdk deploy`. The default CDK bootstrap grants `AdministratorAccess` to this role; the policies below scope it to only what ABCA needs.

> **Origin**: These IAM policies were derived from a thorough review of the repository's CDK constructs, stacks, and handler code, then **validated against a live deployment** in `us-east-1` (create, update, task execution, and destroy). CloudTrail analysis identified 36 additional actions beyond the initial code review, and 7 deployment iterations refined the policies to their current form. The policies are split into five managed policies — three always-applied (Infrastructure, Application, Observability) plus two compute-variant policies (Compute-AgentCore, Compute-ECS) — to stay under the IAM 6,144-character limit and to support per-compute-backend bootstrap selection. The policy sources live in `cdk/src/bootstrap/policies/*.ts` and are compiled to `cdk/bootstrap/policies/*.json`.

## How CDK deployment roles work

CDK uses a **four-role model** created during `cdk bootstrap`:

1. **CDK Deploy Role** -- assumed by the CLI user to initiate deployment
2. **CDK File Publishing Role** -- uploads Lambda zip assets to S3
3. **CDK Image Publishing Role** -- pushes Docker images to ECR
4. **CloudFormation Execution Role** -- assumed by CloudFormation to create/modify/delete resources

The policy below is a **CloudFormation Execution Role** replacement. The other three roles are scoped by the bootstrap template and do not need modification for least-privilege deployment.

## Using these policies

The policies are split into five IAM managed policies (each under the 6,144-character limit):

| Policy Name | Scope | When applied |
|-------------|-------|--------------|
| `IaCRole-ABCA-Infrastructure` | CloudFormation, IAM, VPC networking, Route 53 Resolver DNS Firewall | Always |
| `IaCRole-ABCA-Application` | DynamoDB, Lambda, API Gateway, Cognito, WAFv2, EventBridge, SQS, CloudFront, Secrets Manager | Always |
| `IaCRole-ABCA-Observability` | Bedrock Guardrails, CloudWatch, X-Ray, S3, ECR, KMS, SSM, STS | Always |
| `IaCRole-ABCA-Compute-Agentcore` | Bedrock AgentCore (`bedrock-agentcore:*`) | Always (default compute backend) |
| `IaCRole-ABCA-Compute-ECS` | ECS cluster + task-definition operations | Only when `ecs` is in `ComputeTypes` |

> **Placeholder substitution**: Replace `ACCOUNT_ID` with your 12-digit AWS account ID and `REGION` with your deployment region (e.g., `us-east-1`) throughout this document.

These policies are not created or attached manually. The repository generates them — and a custom bootstrap template that wires all five into the CloudFormation execution role — from the TypeScript sources, then bootstraps with that template:

```bash
# Regenerate artifacts (policies JSON + template YAML) and bootstrap.
# Default ComputeTypes is "agentcore"; pass ECS via context to also include Compute-ECS:
MISE_EXPERIMENTAL=1 mise //cdk:bootstrap
MISE_EXPERIMENTAL=1 mise //cdk:bootstrap -- --context ComputeTypes=agentcore,ecs
```

Under the hood, `mise //cdk:bootstrap` runs `npx cdk bootstrap --template bootstrap/bootstrap-template.yaml` (see `cdk/mise.toml`). The generated template defines five inline `AWS::IAM::ManagedPolicy` resources that **replace** the default `AdministratorAccess` on the CloudFormation execution role; the `IaCRole-ABCA-Compute-ECS` policy is conditional on the `ComputeTypes` parameter including `ecs`. The policy sources are `cdk/src/bootstrap/policies/{infrastructure,application,observability,compute-agentcore,compute-ecs}.ts`, compiled to `cdk/bootstrap/policies/*.json` by `cdk/scripts/generate-bootstrap-artifacts.ts`.

## Trust policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudformation.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    },
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT_ID:root"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "cdk-hnb659fds"
        }
      }
    }
  ]
}
```

## IaCRole-ABCA

For deploying the `backgroundagent-dev` stack. This single stack contains all platform resources including the AgentCore runtime, ECS compute (when enabled), API Gateway, Cognito, DynamoDB tables, VPC, DNS Firewall, and observability infrastructure.

> **IAM managed policy size limit**: A single managed policy cannot exceed 6,144 characters. The permissions below are split into five policies to stay under this limit (three always-applied, plus two compute-variant policies). They are wired into the CloudFormation execution role by the generated bootstrap template; see [Using these policies](#using-these-policies).

### IaCRole-ABCA-Infrastructure

CloudFormation stack operations, IAM roles/policies, VPC networking, and Route 53 Resolver DNS Firewall.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationSelf",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:SetStackPolicy",
        "cloudformation:ValidateTemplate",
        "cloudformation:ListChangeSets"
      ],
      "Resource": [
        "arn:aws:cloudformation:*:*:stack/backgroundagent-dev/*",
        "arn:aws:cloudformation:*:*:stack/CDKToolkit/*"
      ]
    },
    {
      "Sid": "IAMRolesAndPolicies",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:ListRoleTags",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:ListPolicyVersions",
        "iam:TagPolicy",
        "iam:CreateServiceLinkedRole",
        "iam:ListInstanceProfilesForRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/backgroundagent-dev-*",
        "arn:aws:iam::*:policy/backgroundagent-dev-*",
        "arn:aws:iam::*:role/aws-service-role/*"
      ]
    },
    {
      "Sid": "IAMPassRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/backgroundagent-dev-*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": [
            "lambda.amazonaws.com",
            "ecs-tasks.amazonaws.com",
            "ecs.amazonaws.com",
            "apigateway.amazonaws.com",
            "logs.amazonaws.com",
            "bedrock.amazonaws.com",
            "bedrock-agentcore.amazonaws.com",
            "events.amazonaws.com",
            "vpc-flow-logs.amazonaws.com"
          ]
        }
      }
    },
    {
      "Sid": "VPCNetworking",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateVpc",
        "ec2:DeleteVpc",
        "ec2:DescribeVpcs",
        "ec2:ModifyVpcAttribute",
        "ec2:CreateSubnet",
        "ec2:DeleteSubnet",
        "ec2:DescribeSubnets",
        "ec2:CreateInternetGateway",
        "ec2:DeleteInternetGateway",
        "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway",
        "ec2:DescribeInternetGateways",
        "ec2:AllocateAddress",
        "ec2:ReleaseAddress",
        "ec2:DescribeAddresses",
        "ec2:CreateNatGateway",
        "ec2:DeleteNatGateway",
        "ec2:DescribeNatGateways",
        "ec2:CreateRouteTable",
        "ec2:DeleteRouteTable",
        "ec2:DescribeRouteTables",
        "ec2:AssociateRouteTable",
        "ec2:DisassociateRouteTable",
        "ec2:CreateRoute",
        "ec2:DeleteRoute",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:DescribeSecurityGroups",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:CreateVpcEndpoint",
        "ec2:DeleteVpcEndpoints",
        "ec2:DescribeVpcEndpoints",
        "ec2:ModifyVpcEndpoint",
        "ec2:CreateFlowLogs",
        "ec2:DeleteFlowLogs",
        "ec2:DescribeFlowLogs",
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "ec2:DescribeTags",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribePrefixLists",
        "ec2:DescribeNetworkAcls",
        "ec2:DescribeVpcAttribute",
        "ec2:ModifySubnetAttribute"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Route53ResolverDNSFirewall",
      "Effect": "Allow",
      "Action": [
        "route53resolver:CreateFirewallRuleGroup",
        "route53resolver:DeleteFirewallRuleGroup",
        "route53resolver:GetFirewallRuleGroup",
        "route53resolver:CreateFirewallRule",
        "route53resolver:DeleteFirewallRule",
        "route53resolver:ListFirewallRules",
        "route53resolver:UpdateFirewallRule",
        "route53resolver:CreateFirewallDomainList",
        "route53resolver:DeleteFirewallDomainList",
        "route53resolver:GetFirewallDomainList",
        "route53resolver:UpdateFirewallDomains",
        "route53resolver:AssociateFirewallRuleGroup",
        "route53resolver:DisassociateFirewallRuleGroup",
        "route53resolver:UpdateFirewallRuleGroupAssociation",
        "route53resolver:GetFirewallRuleGroupAssociation",
        "route53resolver:ListFirewallRuleGroupAssociations",
        "route53resolver:UpdateFirewallConfig",
        "route53resolver:GetFirewallConfig",
        "route53resolver:TagResource",
        "route53resolver:UntagResource",
        "route53resolver:ListTagsForResource",
        "route53resolver:CreateResolverQueryLogConfig",
        "route53resolver:DeleteResolverQueryLogConfig",
        "route53resolver:GetResolverQueryLogConfig",
        "route53resolver:AssociateResolverQueryLogConfig",
        "route53resolver:DisassociateResolverQueryLogConfig",
        "route53resolver:GetResolverQueryLogConfigAssociation",
        "route53resolver:ListResolverQueryLogConfigAssociations",
        "route53resolver:ListResolverQueryLogConfigs"
      ],
      "Resource": "*"
    }
  ]
}
```

### IaCRole-ABCA-Application

DynamoDB tables, Lambda functions, API Gateway, Cognito, WAFv2, EventBridge, SQS, CloudFront, and Secrets Manager. When ECS Fargate compute is enabled, add the ECS statement below to this policy.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDB",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:UpdateTable",
        "dynamodb:UpdateContinuousBackups",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
        "dynamodb:ListTagsOfResource",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DescribeContributorInsights",
        "dynamodb:DescribeKinesisStreamingDestination",
        "dynamodb:GetResourcePolicy"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/backgroundagent-dev-*"
    },
    {
      "Sid": "Lambda",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:GetPolicy",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags",
        "lambda:PublishVersion",
        "lambda:CreateAlias",
        "lambda:DeleteAlias",
        "lambda:GetAlias",
        "lambda:UpdateAlias",
        "lambda:PutFunctionEventInvokeConfig",
        "lambda:DeleteFunctionEventInvokeConfig",
        "lambda:GetFunctionEventInvokeConfig",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:GetFunctionRecursionConfig",
        "lambda:GetProvisionedConcurrencyConfig",
        "lambda:PutProvisionedConcurrencyConfig",
        "lambda:DeleteProvisionedConcurrencyConfig",
        "lambda:GetRuntimeManagementConfig",
        "lambda:ListVersionsByFunction",
        "lambda:InvokeFunction",
        "lambda:PublishLayerVersion",
        "lambda:DeleteLayerVersion",
        "lambda:GetLayerVersion"
      ],
      "Resource": [
        "arn:aws:lambda:*:*:function:backgroundagent-dev-*",
        "arn:aws:lambda:*:*:function:backgroundagent-dev-AWS*",
        "arn:aws:lambda:*:*:layer:*"
      ]
    },
    {
      "Sid": "LambdaEventSourceMappings",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:GetEventSourceMapping",
        "lambda:TagResource",
        "lambda:UntagResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "APIGateway",
      "Effect": "Allow",
      "Action": [
        "apigateway:POST",
        "apigateway:GET",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE",
        "apigateway:TagResource",
        "apigateway:UntagResource",
        "apigateway:SetWebACL",
        "apigateway:UpdateRestApiPolicy"
      ],
      "Resource": [
        "arn:aws:apigateway:*::/restapis",
        "arn:aws:apigateway:*::/restapis/*",
        "arn:aws:apigateway:*::/account",
        "arn:aws:apigateway:*::/tags/*"
      ]
    },
    {
      "Sid": "Cognito",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:CreateUserPool",
        "cognito-idp:DeleteUserPool",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:UpdateUserPool",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:DeleteUserPoolClient",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:UpdateUserPoolClient",
        "cognito-idp:TagResource",
        "cognito-idp:UntagResource",
        "cognito-idp:ListTagsForResource",
        "cognito-idp:GetUserPoolMfaConfig"
      ],
      "Resource": "arn:aws:cognito-idp:*:*:userpool/*"
    },
    {
      "Sid": "WAFv2",
      "Effect": "Allow",
      "Action": [
        "wafv2:CreateWebACL",
        "wafv2:DeleteWebACL",
        "wafv2:GetWebACL",
        "wafv2:UpdateWebACL",
        "wafv2:AssociateWebACL",
        "wafv2:DisassociateWebACL",
        "wafv2:ListTagsForResource",
        "wafv2:TagResource",
        "wafv2:UntagResource",
        "wafv2:GetWebACLForResource"
      ],
      "Resource": [
        "arn:aws:wafv2:*:*:regional/webacl/*",
        "arn:aws:wafv2:*:*:regional/managedruleset/*"
      ]
    },
    {
      "Sid": "EventBridge",
      "Effect": "Allow",
      "Action": [
        "events:PutRule",
        "events:DeleteRule",
        "events:DescribeRule",
        "events:PutTargets",
        "events:RemoveTargets",
        "events:ListTargetsByRule",
        "events:TagResource",
        "events:UntagResource",
        "events:ListTagsForResource"
      ],
      "Resource": "arn:aws:events:*:*:rule/backgroundagent-dev-*"
    },
    {
      "Sid": "SQS",
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:GetQueueUrl",
        "sqs:ListQueueTags"
      ],
      "Resource": "arn:aws:sqs:*:*:backgroundagent-dev-*"
    },
    {
      "Sid": "CloudFront",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateDistribution",
        "cloudfront:UpdateDistribution",
        "cloudfront:DeleteDistribution",
        "cloudfront:GetDistribution",
        "cloudfront:TagResource",
        "cloudfront:UntagResource",
        "cloudfront:ListTagsForResource",
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:GetOriginAccessControl"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SecretsManager",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:PutResourcePolicy",
        "secretsmanager:DeleteResourcePolicy"
      ],
      "Resource": [
        "arn:aws:secretsmanager:*:*:secret:backgroundagent-*",
        "arn:aws:secretsmanager:*:*:secret:GitHubTokenSecret*",
        "arn:aws:secretsmanager:*:*:secret:SlackIntegration*",
        "arn:aws:secretsmanager:*:*:secret:LinearIntegration*",
        "arn:aws:secretsmanager:*:*:secret:JiraIntegration*",
        "arn:aws:secretsmanager:*:*:secret:GitHubScreenshot*",
        "arn:aws:secretsmanager:*:*:secret:bgagent/*"
      ]
    },
    {
      "Sid": "SecretsManagerAccountLevel",
      "Effect": "Allow",
      "Action": "secretsmanager:GetRandomPassword",
      "Resource": "*"
    }
  ]
}
```

### IaCRole-ABCA-Observability

Bedrock Guardrails, CloudWatch Logs/Dashboards/Alarms, X-Ray, S3 (CDK assets), KMS, ECR, SSM, and STS.

> The golden baseline below keeps the `BedrockAgentCore` statement (`bedrock-agentcore:*`) as the first entry of this block, since it is the canonical action list parsed by `cdk/test/bootstrap/golden-baseline.test.ts`. At **deploy** time those actions are emitted as the standalone `IaCRole-ABCA-Compute-Agentcore` managed policy (see the next subsection), not as part of the runtime Observability policy — the test extracts the statement from here and validates it against the separate `computeAgentcorePolicy()`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockAgentCore",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "BedrockGuardrailsAndLogging",
      "Effect": "Allow",
      "Action": [
        "bedrock:CreateGuardrail",
        "bedrock:DeleteGuardrail",
        "bedrock:GetGuardrail",
        "bedrock:UpdateGuardrail",
        "bedrock:CreateGuardrailVersion",
        "bedrock:ListGuardrails",
        "bedrock:TagResource",
        "bedrock:UntagResource",
        "bedrock:ListTagsForResource",
        "bedrock:PutModelInvocationLoggingConfiguration",
        "bedrock:DeleteModelInvocationLoggingConfiguration",
        "bedrock:GetModelInvocationLoggingConfiguration"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogsAndDashboards",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
        "logs:ListTagsLogGroup",
        "logs:PutResourcePolicy",
        "logs:DeleteResourcePolicy",
        "logs:DescribeResourcePolicies",
        "cloudwatch:PutDashboard",
        "cloudwatch:DeleteDashboards",
        "cloudwatch:GetDashboard",
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
        "logs:CreateDelivery",
        "logs:UpdateDeliveryConfiguration",
        "logs:DescribeDeliveries",
        "logs:GetDelivery",
        "logs:GetDeliveryDestination",
        "logs:GetDeliveryDestinationPolicy",
        "logs:GetDeliverySource",
        "logs:PutDeliveryDestination",
        "logs:PutDeliverySource",
        "logs:DescribeIndexPolicies",
        "cloudwatch:ListTagsForResource",
        "logs:CreateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:ListLogDeliveries",
        "logs:DeleteDelivery",
        "logs:DeleteDeliverySource",
        "logs:DeleteDeliveryDestination"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3CDKAssets",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetBucketLocation",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-hnb659fds-assets-*",
        "arn:aws:s3:::cdk-hnb659fds-assets-*/*"
      ]
    },
    {
      "Sid": "S3ApplicationBuckets",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketPublicAccessBlock",
        "s3:PutEncryptionConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketVersioning",
        "s3:GetBucketVersioning",
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:PutBucketTagging",
        "s3:GetBucketTagging"
      ],
      "Resource": [
        "arn:aws:s3:::backgroundagent-dev-*",
        "arn:aws:s3:::backgroundagent-dev-*/*"
      ]
    },
    {
      "Sid": "KMSForCDKAssets",
      "Effect": "Allow",
      "Action": [
        "kms:CreateGrant",
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECRForDockerAssets",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:SetRepositoryPolicy",
        "ecr:GetRepositoryPolicy",
        "ecr:DeleteRepository",
        "ecr:ListTagsForResource",
        "ecr:TagResource"
      ],
      "Resource": [
        "arn:aws:ecr:*:*:repository/cdk-hnb659fds-container-assets-*",
        "arn:aws:ecr:*:*:repository/backgroundagent-*"
      ]
    },
    {
      "Sid": "ECRAuthToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "XRay",
      "Effect": "Allow",
      "Action": [
        "xray:UpdateTraceSegmentDestination",
        "xray:GetTraceSegmentDestination",
        "xray:ListResourcePolicies",
        "xray:PutResourcePolicy"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SSMParameterStoreForCDK",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter"
      ],
      "Resource": "arn:aws:ssm:*:*:parameter/cdk-bootstrap/*"
    },
    {
      "Sid": "STSForCDK",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:GetCallerIdentity"
      ],
      "Resource": [
        "arn:aws:iam::*:role/cdk-hnb659fds-*"
      ]
    }
  ]
}
```

### IaCRole-ABCA-Compute-Agentcore

Bedrock AgentCore runtime/memory operations — a single statement granting `bedrock-agentcore:*` on `*` (the `BedrockAgentCore` statement shown in the Observability block above). This policy is always applied (AgentCore is the default compute backend) and is emitted as its own managed policy (`computeAgentcorePolicy()`, compiled to `cdk/bootstrap/policies/compute-agentcore.json`) so each compute variant can be bootstrapped independently. No separate JSON baseline is repeated here: the golden-file test reads the action list from the Observability block and validates it against this policy.

### IaCRole-ABCA-Compute-ECS

When the ECS Fargate compute backend is enabled (bootstrap with `--context ComputeTypes=agentcore,ecs`), the generated template conditionally attaches this policy to the CloudFormation execution role. It is a standalone managed policy, not an addition to `IaCRole-ABCA-Application`.

```json
{
  "Sid": "ECS",
  "Effect": "Allow",
  "Action": [
    "ecs:CreateCluster",
    "ecs:DeleteCluster",
    "ecs:DescribeClusters",
    "ecs:UpdateCluster",
    "ecs:UpdateClusterSettings",
    "ecs:PutClusterCapacityProviders",
    "ecs:RegisterTaskDefinition",
    "ecs:DeregisterTaskDefinition",
    "ecs:DescribeTaskDefinition",
    "ecs:ListTaskDefinitions",
    "ecs:TagResource",
    "ecs:UntagResource",
    "ecs:ListTagsForResource",
    "ecs:PutAccountSetting"
  ],
  "Resource": "*"
}
```

## Runtime IAM roles (created by the stack)

These roles are created inside the CloudFormation stack at deploy time, not by the deployer. They are documented here for a complete picture of the IAM footprint.

| Role | Assumed By | Purpose |
|------|-----------|---------|
| AgentCore Runtime execution role | AgentCore Runtime | Runs MicroVM containers; DynamoDB, Secrets Manager, CloudWatch Logs, Bedrock, AgentCore Memory access |
| BedrockLoggingRole | `bedrock.amazonaws.com` | Writes model invocation logs to CloudWatch |
| TaskOrchestrator Lambda role | Lambda | Durable orchestrator; DynamoDB, Secrets Manager, AgentCore Runtime invocation, AgentCore Memory |
| ConcurrencyReconciler Lambda role | Lambda | Scheduled reconciliation; DynamoDB scan + conditional updates |
| TaskApi Lambda roles (9-10) | Lambda | API handler functions; DynamoDB, Secrets Manager (webhook handlers), Bedrock Guardrail, Lambda invoke |
| AwsCustomResource Lambda role | Lambda | Blueprint DDB writes, Bedrock logging config, DNS firewall config |
| API Gateway CloudWatch role | API Gateway | Pushes API Gateway access logs |
| VPC Flow Log role | VPC Flow Logs | Writes flow logs to CloudWatch |
| ECS task execution role (when enabled) | ECS (pull images) | ECR image pull, CloudWatch Logs write |
| ECS task role (when enabled) | ECS (container runtime) | DynamoDB, Secrets Manager, Bedrock InvokeModel |

### CDK bootstrap roles

| Role | Purpose |
|------|---------|
| `cdk-hnb659fds-deploy-role-*` | Assumed by CDK CLI to initiate deployments |
| `cdk-hnb659fds-cfn-exec-role-*` | Assumed by CloudFormation to create resources (**this is what IaCRole-ABCA replaces**) |
| `cdk-hnb659fds-file-publish-role-*` | Uploads Lambda zip assets to S3 |
| `cdk-hnb659fds-image-publish-role-*` | Pushes Docker images to ECR |
| `cdk-hnb659fds-lookup-role-*` | Context lookups (VPC, AZs, etc.) |

## Resource-level permission constraints

Several services require `Resource: "*"` because they do not support resource-level permissions for create/describe operations:

| Service | Actions Requiring `"*"` | Reason |
|---------|------------------------|--------|
| EC2 (VPC) | `Create*`, `Describe*`, `Allocate*` | VPC resource ARNs unknown at policy creation time |
| Route 53 Resolver | All DNS Firewall actions | No resource-level ARN support for firewall rule groups |
| Bedrock | Guardrail + logging config actions | Account-level APIs (`PutModelInvocationLoggingConfiguration`) |
| Bedrock AgentCore | All actions (`bedrock-agentcore:*`) | CloudFormation resource handler uses internal action names that differ from the public API; wildcard required for reliable deployment |
| CloudWatch Logs | `CreateLogGroup`, `PutResourcePolicy` | Log group ARNs unknown at policy creation; resource policies are account-scoped |
| ECS | Cluster + task definition actions | `RegisterTaskDefinition` doesn't support resource-level permissions |
| ECR | `GetAuthorizationToken` | Account-level operation |
| KMS | `CreateGrant`, `Decrypt`, `Encrypt`, `GenerateDataKey` | CDK asset encryption keys; key ARNs unknown at policy time |
| Secrets Manager | `GetRandomPassword` | Account-level API (no secret ARN); isolated in its own statement with `Resource: "*"` |
| X-Ray | `UpdateTraceSegmentDestination`, `PutResourcePolicy` | Account-level operations |

These constraints align with the CDK Nag `AwsSolutions-IAM5` suppressions in the codebase.

## Iterative tightening

These policies are conservative-but-scoped starting points. To tighten further:

1. **Deploy once with CloudTrail enabled**, then use [IAM Access Analyzer policy generation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-policy-generation.html) to generate a least-privilege policy based on the actual API calls recorded in CloudTrail.
2. **Replace `*` resources** with actual ARNs after the first deploy (e.g., once you know the VPC ID, scope EC2 actions to that VPC).
3. **Add region conditions** where possible (e.g., `"aws:RequestedRegion": "us-east-1"`) to prevent cross-region resource creation.
4. **Restrict `iam:AttachRolePolicy`** with an `iam:PolicyARN` condition to limit which policies can be attached to `backgroundagent-dev-*` roles. This requires enumerating the AWS managed policies CDK attaches (e.g., `service-role/AWSLambdaBasicExecutionRole`) from a synthesized template, so it is deferred to a post-deployment tightening pass.
5. **Scope `iam:CreateServiceLinkedRole`** with an `iam:AWSServiceName` condition to limit which AWS services can have service-linked roles created. After a first deploy, check CloudTrail for which service-linked roles were actually created and restrict accordingly.
6. **Scope KMS actions** with a `kms:ResourceAliases` condition (e.g., `"kms:ResourceAliases": "alias/cdk-hnb659fds-*"`) to limit `CreateGrant`, `Decrypt`, `Encrypt`, and `GenerateDataKey` to the deterministic CDK bootstrap key.
7. **Use permission boundaries** on the IaC role to set an outer limit even if the policy is too broad.
8. **Review after each CDK version upgrade** -- new CDK versions may add/remove custom resources that need different permissions.

## Reference

- [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security) -- Runtime IAM, memory isolation, custom step trust boundaries.
- [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) -- Compute backend options (AgentCore vs ECS Fargate).
- [COST_MODEL.md](/sample-autonomous-cloud-coding-agents/architecture/cost-model) -- Infrastructure baseline costs and scale-to-zero analysis.
