---
title: "Deployment roles"
---

This document defines least-privilege IAM policies for the CloudFormation execution role used during `cdk deploy`. The default CDK bootstrap grants `AdministratorAccess` to this role; the policies below scope it to only what ABCA needs.

> **Origin**: These IAM policies were derived from a thorough review of the repository's CDK constructs, stacks, and handler code, then **validated against a live deployment** in `us-east-1` (create, update, task execution, and destroy). CloudTrail analysis identified 36 additional actions beyond the initial code review, and 7 deployment iterations refined the policies to their current form. The policies are split into six managed policies — three always-applied (Infrastructure, Application, Observability) plus three compute-variant policies (Compute-AgentCore, Compute-ECS, Compute-LambdaMicrovms) — to stay under the IAM 6,144-character limit and to support per-compute-backend bootstrap selection. The policy sources live in `cdk/src/bootstrap/policies/*.ts` and are compiled to `cdk/bootstrap/policies/*.json`.

## How CDK deployment roles work

CDK uses a **four-role model** created during `cdk bootstrap`:

1. **CDK Deploy Role** -- assumed by the CLI user to initiate deployment
2. **CDK File Publishing Role** -- uploads Lambda zip assets to S3
3. **CDK Image Publishing Role** -- pushes Docker images to ECR
4. **CloudFormation Execution Role** -- assumed by CloudFormation to create/modify/delete resources

The policy below is a **CloudFormation Execution Role** replacement. The other three roles are scoped by the bootstrap template and do not need modification for least-privilege deployment.

## Using these policies

The policies are split into six IAM managed policies (each under the 6,144-character limit):

| Policy Name | Scope | When applied |
|-------------|-------|--------------|
| `IaCRole-ABCA-Infrastructure` | CloudFormation, IAM, VPC networking, Route 53 Resolver DNS Firewall | Always |
| `IaCRole-ABCA-Application` | DynamoDB, Lambda, API Gateway, Cognito, WAFv2, EventBridge, SQS, SNS, CloudFront, Secrets Manager | Always |
| `IaCRole-ABCA-Observability` | Bedrock Guardrails, CloudWatch, X-Ray, S3, ECR, KMS, SSM, STS | Always |
| `IaCRole-ABCA-Compute-Agentcore` | Bedrock AgentCore (`bedrock-agentcore:*`) | Always (default compute backend) |
| `IaCRole-ABCA-Compute-ECS` | ECS cluster + task-definition operations | Only when `ecs` is in `ComputeTypes` |
| `IaCRole-ABCA-Compute-LambdaMicrovms` | Lambda MicroVM image + network-connector operations | Only when `lambda-microvm` is in `ComputeTypes` |

> **Placeholder substitution**: Replace `ACCOUNT_ID` with your 12-digit AWS account ID and `REGION` with your deployment region (e.g., `us-east-1`) throughout this document.
>
> **Partition scope**: Every resource ARN in the six managed policies names the commercial `aws` partition (`arn:aws:...`), so the policies work in that partition only: they cannot authorize an ABCA deployment in another one, such as `aws-us-gov` or `aws-cn`. The inline policy `PassExecutionRoleToCloudFormation` (described below) resolves the partition of the account being bootstrapped, which does not change that. Partition support is an open question ([#928](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/928)).

These policies are not created or attached manually. The repository generates them and a custom bootstrap template that attaches the selected policies to the CloudFormation execution role:

```bash
# Regenerate artifacts (policies JSON + template YAML) and bootstrap.
# ComputeTypes defaults to "agentcore".
mise //cdk:bootstrap

# To ALSO enable the ECS compute backend (attach IaCRole-ABCA-Compute-ECS), set the
# ComputeTypes CFN *parameter*. cdk bootstrap cannot pass template parameters — it
# has no --parameters flag, and --context sets CDK construct context, not a CFN
# parameter — so bootstrap first (above), then update the parameter on CDKToolkit.
# The first command below lists the other parameters of the stack, and the update names
# each with UsePreviousValue, because CloudFormation sets a parameter that an update
# leaves out to its template default. The update runs only if the list was read. A
# --profile or --region option goes on every aws command. Keep the single quotes:
# without them the shell removes the backslash, and the AWS CLI splits the value at the
# comma and rejects it.
keep=($(aws cloudformation describe-stacks --stack-name CDKToolkit --output text \
    --query "Stacks[0].Parameters[?ParameterKey!='ComputeTypes'].[ParameterKey]" \
  | sed 's/.*/ParameterKey=&,UsePreviousValue=true/'))
[ ${#keep[@]} -gt 0 ] && aws cloudformation update-stack --stack-name CDKToolkit \
  --use-previous-template --capabilities CAPABILITY_NAMED_IAM \
  --parameters 'ParameterKey=ComputeTypes,ParameterValue=agentcore\,ecs' "${keep[@]}"
# verify it took:
aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].Parameters'
```

Under the hood, `mise //cdk:bootstrap` runs `npx cdk bootstrap --force --template bootstrap/bootstrap-template.yaml` (see `cdk/mise.toml`). The generated template defines six `AWS::IAM::ManagedPolicy` resources that **replace** the default `AdministratorAccess` on the CloudFormation execution role; the `IaCRole-ABCA-Compute-ECS` and `IaCRole-ABCA-Compute-LambdaMicrovms` policies are conditional on the `ComputeTypes` parameter including their respective backend. The policy sources are `cdk/src/bootstrap/policies/{infrastructure,application,observability,compute-agentcore,compute-ecs,compute-lambda-microvm}.ts`, compiled to `cdk/bootstrap/policies/*.json` by `cdk/scripts/generate-bootstrap-artifacts.ts`.

**An account that is already bootstrapped.** The task replaces the bootstrap it finds, which is why it passes `--force`. Without the flag, the CDK CLI does not overwrite a `CDKToolkit` stack whose `BootstrapVariant` parameter differs from the template's: it prints `Not overwriting it with a template containing 'ABCA: Least-Privilege Bootstrap' (use --force if you intend to overwrite)`, changes nothing and exits 0 ([#701](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/701)). A standard `cdk bootstrap` records `AWS CDK: Default Resources`, and the stack can keep that value after this template has replaced the standard one, because the CLI keeps previous parameter values. A later standard `cdk bootstrap` makes the same comparison: on such a stack it finds no difference and puts the standard template back, and `mise //cdk:preflight` then reports a standard bootstrap. Know what the task changes before you run it on an account that already has a bootstrap:

- **Other CDK apps in the account and Region deploy through the same execution role.** Once the task has replaced a standard bootstrap, CloudFormation deploys them with the ABCA policies only. This is why `bgagent setup` leaves a standard bootstrap unchanged, and why replacing it is a command you run yourself. In a script that must not replace one, cancel the flag: `mise //cdk:bootstrap -- --no-force`.
- **`--force` also lifts the CLI's refusal to replace a newer CDK bootstrap version** (the `BootstrapVersion` output) with this template's.
- **An execution-policy list set by the earlier bootstrap stays.** If that bootstrap passed `--cloudformation-execution-policies`, the CLI sends the same list again, and the template attaches it in place of the ABCA policies. Pass an empty list to drop it: `mise //cdk:bootstrap -- --cloudformation-execution-policies ""`. The CLI rejects an empty list for a bootstrap that trusts another account (`--trust`).

Check the result on the execution role, not on the `BootstrapVariant` parameter. Every policy name the command prints contains `IaCRole-ABCA-`, and `AdministratorAccess` is not among them:

```bash
aws iam list-attached-role-policies \
  --role-name cdk-hnb659fds-cfn-exec-role-ACCOUNT_ID-REGION \
  --query 'AttachedPolicies[].PolicyName'
```

On a bootstrap that is already current, the task changes nothing and the CLI prints `You used the --force flag, but CloudFormation reported that the deployment would not make any changes`. That is expected.

**Re-bootstrap to bundle 1.7.0 or later before deploying nested stacks.** The
execution role also needs the generated inline policy
`PassExecutionRoleToCloudFormation`, from
`cdk/src/bootstrap/nested-stack-policy.ts`. It grants `iam:PassRole` on that exact
execution role, with `iam:PassedToService=cloudformation.amazonaws.com`. The ARN
uses the bootstrap partition, account, Region and qualifier; it grants no access
to pass other roles. Without it, a fresh 1.6.0 deployment fails change-set
validation when CloudFormation tries to pass its role to the registry's nested
stacks. Preserve all existing bootstrap parameters when updating the template.

Bundle 1.7.0 also corrects `BootstrapPolicyHash`: it includes nested policy fields
and the generated inline policy. Earlier hashes could remain unchanged after
Action, Resource or Condition changes. A matching old hash is insufficient proof
that deployed permissions match source.

> **CloudFormation inline-template limit — 51,200 characters**: This is a second, independent size ceiling, distinct from the per-policy IAM 6,144-character limit above. `cdk bootstrap --template` sends the template inline as `TemplateBody`; above 51,200 characters the CLI has to stage it in S3 instead, which it **cannot** do while bootstrapping a fresh account, because that bucket is one of the resources bootstrap creates. The result is a hard `BootstrapStackRequired` failure with no way through `cdk bootstrap`, `--force` included ([#864](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/864)).
>
> Two consequences for anyone editing the policies:
>
> - **The gated size is not the file's size on disk.** The CLI parses the file, discards its formatting, and re-serialises the parsed object before measuring. Reformatting `bootstrap-template.yaml` therefore changes nothing; only the *content* moves the number. Check it with `npx cdk bootstrap --show-template --template bootstrap/bootstrap-template.yaml | wc -c`.
> - **Each managed-policy `PolicyDocument` is emitted as a minified JSON string**, not a nested YAML mapping. Both are valid for this `Json`-typed property and IAM stores the string parsed, but a string scalar survives the CLI's re-serialisation on one line. The original fix reduced the body to 45,743 characters from 53,369; subsequent policy additions remain subject to the budget. The small inline self-role policy uses a mapping to resolve its ARN with `Fn::Sub`.
>
> `cdk/scripts/generate-bootstrap-template.ts` fails the build when the body exceeds the budget in `cdk/src/bootstrap/template-size.ts`, so adding statements surfaces the problem at generation time rather than against somebody's fresh account. Both the guard and its regression test obtain the size by invoking `cdk bootstrap --show-template` on the committed artifact — the CLI is the component that makes the inline-vs-S3 decision, so asking it directly cannot drift the way a local copy of its serialiser would. No AWS credentials are required.

## Versioning

The bootstrap template publishes three values as outputs of the `CDKToolkit` stack. `mise //cdk:bootstrap:generate` writes them into the template:

| Layer | `CDKToolkit` output | Where it comes from | What it answers |
|-------|---------------------|---------------------|-----------------|
| Version | `BootstrapPolicyVersion` | `BOOTSTRAP_VERSION` in `cdk/src/bootstrap/version.ts`, copied to `cdk/bootstrap/BOOTSTRAP_VERSION` | Does the account have to be bootstrapped again? A new policy or statement is a minor bump, because it reaches an account only through a re-bootstrap |
| Hash | `BootstrapPolicyHash` | `computeBootstrapHash()`: SHA-256 over the six managed policies and the inline `PassExecutionRoleToCloudFormation` policy, copied to `cdk/bootstrap/BOOTSTRAP_HASH` | Was the account bootstrapped from the same policies as this checkout? At an equal version it differs when a policy changed without a version bump |
| Policy set | `BootstrapPolicySet` | The names of the policies the template selects for the stack's `ComputeTypes` parameter | Which compute policies does the account's bootstrap carry? |

Before `mise //cdk:deploy` deploys, the bootstrap preflight compares the three with the checkout. [Bootstrap preflight](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#bootstrap-preflight) in the deployment guide lists the results and what to do about each. The three values come from the template: they say which bundle was deployed and what `ComputeTypes` selects, not what is attached to the execution role. They stay the same when a policy is edited in IAM, and when the stack's `CloudFormationExecutionPolicies` parameter is set, which attaches that list in place of the ABCA policies.

The actions themselves are checked at build time, without an account. `cdk/test/bootstrap/synth-coverage.test.ts` synthesizes the app and fails when a resource type has no entry in `cdk/src/bootstrap/resource-action-map.ts`, or when the policies do not allow an action of its entry.

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

For deploying the `backgroundagent-dev` stack. This single stack contains all platform resources including the AgentCore runtime, ECS compute (when enabled), API Gateway, Cognito, DynamoDB tables, VPC, DNS Firewall, and observability infrastructure. The operator console (`backgroundagent-dev-console`: S3 bucket, CloudFront distribution, Cognito app client and managed-login domain) is an optional separate stack (`-c operatorConsole=true`, deployed with `--all`) under the same roles.

> **IAM managed policy size limit**: A single managed policy cannot exceed 6,144 characters. The permissions below are split into six policies to stay under this limit (four always applied, including AgentCore, plus optional ECS and MicroVM policies). The separate inline self-role grant is described above. They are wired into the CloudFormation execution role by the generated bootstrap template; see [Using these policies](#using-these-policies).

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
        "arn:aws:cloudformation:*:*:stack/backgroundagent-dev-*",
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
            "states.amazonaws.com",
            "vpc-flow-logs.amazonaws.com"
          ]
        }
      }
    },
    {
      "Sid": "NestedStackPassRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/cdk-*-cfn-exec-role-*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "cloudformation.amazonaws.com"
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

`NestedStackPassRole` (bundle 1.7.0) exists because the app contains nested stacks. CloudFormation creates them *as* the execution role and passes that same role on to each child stack, which needs `iam:PassRole` on the role itself. Without it, every deploy fails at change-set creation with `cfn-exec-role ... is not authorized to perform: iam:PassRole on resource: ...cfn-exec-role...`. The statement is limited to the CDK execution role and to `cloudformation.amazonaws.com`, so it grants nothing the role does not already hold (#865). `test/bootstrap/synth-coverage.test.ts` now walks every nested stack (#757) and pins this statement's resource and condition, which an action-level check cannot distinguish from `IAMPassRole`.

### IaCRole-ABCA-Application

DynamoDB tables, Lambda functions, API Gateway, Cognito, WAFv2, EventBridge, SQS, CloudFront, and Secrets Manager. When ECS Fargate compute is enabled, add the ECS statement below to this policy.

Agent Registry provisioning also uses a Step Functions workflow to wait for
asynchronous creation and deletion. Its construct explicitly names the workflow
with the parent stack's `backgroundagent-dev-` prefix so it fits this policy,
including when deployed in a nested stack. Adopting this name in an existing
deployment replaces the provider's waiter state machine. The registry's own API
calls (`agent-registry` actions) are in none of these policies: see
[Custom resource providers](#custom-resource-providers).

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
        "cognito-idp:CreateGroup",
        "cognito-idp:DeleteGroup",
        "cognito-idp:GetGroup",
        "cognito-idp:UpdateGroup",
        "cognito-idp:TagResource",
        "cognito-idp:UntagResource",
        "cognito-idp:ListTagsForResource",
        "cognito-idp:GetUserPoolMfaConfig",
        "cognito-idp:CreateUserPoolDomain",
        "cognito-idp:UpdateUserPoolDomain",
        "cognito-idp:DeleteUserPoolDomain"
      ],
      "Resource": "arn:aws:cognito-idp:*:*:userpool/*"
    },
    {
      "Sid": "CognitoDomainRead",
      "Effect": "Allow",
      "Action": "cognito-idp:DescribeUserPoolDomain",
      "Resource": "*"
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
      "Sid": "SNS",
      "Effect": "Allow",
      "Action": [
        "sns:CreateTopic",
        "sns:DeleteTopic",
        "sns:GetTopicAttributes",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:Unsubscribe",
        "sns:GetSubscriptionAttributes",
        "sns:ListSubscriptionsByTopic",
        "sns:TagResource",
        "sns:UntagResource",
        "sns:ListTagsForResource"
      ],
      "Resource": "arn:aws:sns:*:*:backgroundagent-dev-*"
    },
    {
      "Sid": "StepFunctions",
      "Effect": "Allow",
      "Action": [
        "states:CreateStateMachine",
        "states:DeleteStateMachine",
        "states:DescribeStateMachine",
        "states:UpdateStateMachine",
        "states:TagResource",
        "states:UntagResource",
        "states:ListTagsForResource"
      ],
      "Resource": "arn:aws:states:*:*:stateMachine:backgroundagent-dev-*"
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
      "Sid": "KMSCustomerManagedKeys",
      "Effect": "Allow",
      "Action": [
        "kms:CreateKey",
        "kms:GetKeyPolicy",
        "kms:GetKeyRotationStatus",
        "kms:TagResource",
        "kms:ListResourceTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "KMSCustomerManagedKeysLifecycle",
      "Effect": "Allow",
      "Action": [
        "kms:PutKeyPolicy",
        "kms:ScheduleKeyDeletion",
        "kms:EnableKeyRotation",
        "kms:DisableKeyRotation",
        "kms:UntagResource"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/ABCA": "operational-alerts"
        }
      }
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

When the ECS Fargate compute backend is enabled (set the `ComputeTypes` CFN parameter to `agentcore,ecs` on the `CDKToolkit` stack — see the bootstrap snippet near the top of this doc), the generated template conditionally attaches this policy to the CloudFormation execution role. It is a standalone managed policy, not an addition to `IaCRole-ABCA-Application`.

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

### IaCRole-ABCA-Compute-LambdaMicrovms

When the Lambda MicroVM compute backend is enabled (include `lambda-microvm` in the `ComputeTypes` CFN parameter on the `CDKToolkit` stack), the generated template conditionally attaches this policy to the CloudFormation execution role. It permits CloudFormation to manage MicroVM images and network connectors; runtime session lifecycle permissions remain on the orchestrator role.

The second statement, `MicrovmPassRoles`, is the one exception to the rule that every `iam:PassRole` in this bundle carries an `iam:PassedToService` condition (`IaCRole-ABCA-Infrastructure` → `IAMPassRole`). It has to be: the Lambda MicroVMs service does not present a usable value for that key, so the conditioned statement is **denied** when CloudFormation passes the build role to `CreateMicrovmImage` — live-verified in `us-east-1` (ADR-021 P2r2-F9), with the out-of-band `create-microvm-image` call passing the *same* role successfully as the control. It is deliberately scoped to the two role-name prefixes CloudFormation actually passes (the image build role and the network-connector operator role) and excludes the MicroVM **execution** role, which only the orchestrator passes, at `RunMicrovm`. The shared allowlisted `IAMPassRole` statement (`role/backgroundagent-dev-*`) is left intact to avoid widening the grant for ~30 other roles in the stack, so while it technically matches the execution role, only the orchestrator actively reaches for it.

> **Operators must re-bootstrap for this.** The statement ships in bootstrap policy bundle **1.6.0**; a CDKToolkit stack bootstrapped at 1.5.0 or earlier will fail the CDK-managed MicroVM image deploy with a caller-side `iam:PassRole` AccessDenied on the build role. Check `CDKToolkit`'s `BootstrapPolicyVersion` output, and re-run `mise //cdk:bootstrap` (with `ComputeTypes` including `lambda-microvm`) if it is behind.

P3 additionally requires **bundle 1.8.0** for `MicrovmSuspendConfiguration`.

The nested MicroVM layout requires **bundle 1.12.0**. Its child stack uses the
explicit parent-derived names `<stack>-MicrovmBuildRole` and
`<stack>-MicrovmConnectorRole`, where `<stack>` is `backgroundagent-dev` or a
suffixed `backgroundagent-dev-<name>`; `MicrovmPassRoles` admits those names, for
the default and suffixed stacks, in addition to the legacy flat-layout prefixes.
Bundles 1.9.0–1.11.0 admitted only the default stack's two names. The execution role
stays in the parent and is still excluded. Re-bootstrap before deploying the
child stack. Before upgrading an existing flat deployment, set and retain
`microvm_nested_stack=false` until its resource migration is complete; changing ownership is not an ordinary
in-place update. See the [nested-stack runbook](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/verification/645-p3-nested-stack.md).

For a reviewed migration that keeps old and new resources side by side,
`microvm_resource_name_prefix` gives the nested image, network connectors and log
group distinct names. It requires nested mode and a concrete 1–40 character
letter/digit/hyphen prefix. Build/operator IAM role names remain derived from the
parent deployment so the bootstrap's existing `PassRole` scope still applies.
Keep the selected prefix stable in later deployments. This option alone does
not preserve the old resources or their runtime permissions; those remain part
of the migration procedure.
This statement lets CloudFormation manage and tag the live suspension setting
at `/<backgroundagent-stack-name>/microvm-approval-suspend-enabled`. The
coordinator gets only `GetParameter` on its exact parameter. Existing durable
executions retain their Lambda version and reread this setting before new
suspension, so disable can reach executions already running.

```json
{
  "Statement": [
    {
      "Action": [
        "lambda:CreateMicrovmImage",
        "lambda:GetMicrovmImage",
        "lambda:UpdateMicrovmImage",
        "lambda:DeleteMicrovmImage",
        "lambda:ListMicrovmImages",
        "lambda:GetMicrovmImageVersion",
        "lambda:UpdateMicrovmImageVersion",
        "lambda:DeleteMicrovmImageVersion",
        "lambda:ListMicrovmImageVersions",
        "lambda:GetMicrovmImageBuild",
        "lambda:ListMicrovmImageBuilds",
        "lambda:ListManagedMicrovmImages",
        "lambda:ListManagedMicrovmImageVersions",
        "lambda:CreateNetworkConnector",
        "lambda:GetNetworkConnector",
        "lambda:UpdateNetworkConnector",
        "lambda:DeleteNetworkConnector",
        "lambda:ListNetworkConnectors",
        "lambda:PassNetworkConnector"
      ],
      "Effect": "Allow",
      "Resource": "*",
      "Sid": "LambdaMicrovms"
    },
    {
      "Action": "iam:PassRole",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeBuild*",
        "arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeConnector*",
        "arn:aws:iam::*:role/backgroundagent-dev-MicrovmBuildRole",
        "arn:aws:iam::*:role/backgroundagent-dev-*-MicrovmBuildRole",
        "arn:aws:iam::*:role/backgroundagent-dev-MicrovmConnectorRole",
        "arn:aws:iam::*:role/backgroundagent-dev-*-MicrovmConnectorRole"
      ],
      "Sid": "MicrovmPassRoles"
    },
    {
      "Action": [
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
        "ssm:ListTagsForResource"
      ],
      "Effect": "Allow",
      "Resource": "arn:aws:ssm:*:*:parameter/backgroundagent-*/microvm-approval-suspend-enabled",
      "Sid": "MicrovmSuspendConfiguration"
    }
  ],
  "Version": "2012-10-17"
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
| PrOutcomeSweep Lambda role | Lambda | Hourly read of pull-request outcomes; DynamoDB Query on the task table's status index, UpdateItem on the task table and PutItem on the task events table, Secrets Manager read of the platform GitHub token |
| TaskApi Lambda roles (9-10) | Lambda | API handler functions; DynamoDB, Secrets Manager (webhook handlers), Bedrock Guardrail, Lambda invoke |
| AwsCustomResource Lambda role | Lambda | Blueprint DDB writes, Bedrock logging config, DNS firewall config |
| Agent Registry provisioning Lambda roles (2, when enabled) | Lambda | Custom resource handlers (`onEvent`, `isComplete`): create, read, update and delete the registry, delete its records first; the registry's service-linked role and workload identity |
| API Gateway CloudWatch role | API Gateway | Pushes API Gateway access logs |
| VPC Flow Log role | VPC Flow Logs | Writes flow logs to CloudWatch |
| ECS task execution role (when enabled) | ECS (pull images) | ECR image pull, CloudWatch Logs write |
| ECS task role (when enabled) | ECS (container runtime) | DynamoDB, Secrets Manager, Bedrock InvokeModel |

### Custom resource providers

For a custom resource (`Custom::*`), CloudFormation's only call as the execution role is `lambda:InvokeFunction` on the provider function. The AWS calls that do the work are made by the provider's Lambda function under its own role: a runtime role like those above, created by the stack together with its permissions. The execution role needs none of those actions, and adding them to the policies in this document would give it privilege that nothing uses. `RESOURCE_ACTION_MAP` in `cdk/src/bootstrap/resource-action-map.ts` records the rule: it maps every `Custom::*` type to `lambda:InvokeFunction` alone.

This is why no policy here grants an `agent-registry` action, although the stack provisions an AWS Agent Registry ([REGISTRY.md](/sample-autonomous-cloud-coding-agents/architecture/registry)). The registry is a `Custom::AgentRegistry` resource: `CreateRegistry`, `GetRegistry`, `UpdateRegistry`, `DeleteRegistry` and the deletion of its records run under the roles of its two handlers, granted in `cdk/src/constructs/registry.ts` and pinned by `cdk/test/constructs/registry.test.ts`. The execution role creates what surrounds it: the nested stack, the handler functions and their roles, and the waiter state machine. `cdk/test/bootstrap/synth-coverage.test.ts` checks that side only; it cannot see a provider's role.

Seven actions in the policies predate this rule: `dynamodb:PutItem`, `dynamodb:UpdateItem`, `bedrock:PutModelInvocationLoggingConfiguration`, `bedrock:DeleteModelInvocationLoggingConfiguration`, `bedrock:GetModelInvocationLoggingConfiguration`, `route53resolver:UpdateFirewallConfig` and `route53resolver:GetFirewallConfig`. They belong to three settings that `AwsCustomResource` providers apply (Blueprint records, Bedrock model invocation logging, DNS Firewall configuration) under the `AwsCustomResource` role, which holds its own grants. They have been here since the first version of these policies and are not a precedent for a new custom resource.

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
