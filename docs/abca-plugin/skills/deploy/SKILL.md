---
name: deploy
description: >-
  Deploy, diff, or destroy the ABCA CDK stack. Handles pre-deployment validation,
  synthesis, and post-deployment verification. Use when the user says "deploy",
  "cdk deploy", "deploy the stack", "destroy", "cdk diff", "what changed",
  "redeploy", or "update the stack".
---

# ABCA Deployment

You are managing CDK deployment for the ABCA platform. Determine the user's intent and execute the appropriate workflow.

## Determine Action

Ask the user (or infer from context) which action they want:
- **deploy** — Build and deploy the CDK stack
- **diff** — Show what would change without deploying
- **destroy** — Tear down the stack (requires explicit confirmation)
- **synth** — Synthesize CloudFormation without deploying

## Pre-Deployment Checks

Before any deployment action, verify:

1. **Build is clean:**
   ```bash
   export MISE_EXPERIMENTAL=1
   mise run build
   ```
   This runs agent quality checks, CDK compilation + tests, CLI build, and docs build. Do NOT deploy if the build fails.

2. **Docker is running** — Required for CDK asset bundling
3. **AWS credentials are configured** — `aws sts get-caller-identity`

## Deploy Workflow

```bash
export MISE_EXPERIMENTAL=1
mise run //cdk:deploy
```

After successful deployment, retrieve and display stack outputs:
```bash
aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs' --output table
```

Key outputs to highlight: `ApiUrl`, `RuntimeArn`, `UserPoolId`, `AppClientId`, `GitHubTokenSecretArn`.

## Diff Workflow

```bash
export MISE_EXPERIMENTAL=1
mise run //cdk:diff
```

Summarize the changes: new resources, modified resources, removed resources. Flag any potentially destructive changes (resource replacements, security group changes).

## Destroy Workflow

**CRITICAL: Ask for explicit confirmation before destroying.** Use AskUserQuestion to confirm, explaining consequences.

```bash
export MISE_EXPERIMENTAL=1
mise run //cdk:destroy
```

## Synth Workflow

```bash
export MISE_EXPERIMENTAL=1
mise run //cdk:synth
```

Output goes to `cdk/cdk.out/`. Useful for reviewing generated CloudFormation templates.

## Post-Deployment

After a successful deploy, remind the user to:
- Store/update the GitHub PAT in Secrets Manager if this is a fresh deployment
- Onboard repositories via Blueprint constructs if needed
- Run a smoke test: `curl -s -H "Authorization: $TOKEN" $API_URL/tasks`

## Least-Privilege Deployment

By default, CDK bootstrap grants `AdministratorAccess` to the CloudFormation execution role. For production or security-sensitive accounts, re-bootstrap with a scoped execution policy:

```bash
cdk bootstrap aws://ACCOUNT/REGION \
  --cloudformation-execution-policies "arn:aws:iam::ACCOUNT:policy/IaCRole-ABCA-Infrastructure" \
  --cloudformation-execution-policies "arn:aws:iam::ACCOUNT:policy/IaCRole-ABCA-Application" \
  --cloudformation-execution-policies "arn:aws:iam::ACCOUNT:policy/IaCRole-ABCA-Observability"
```

See `docs/design/DEPLOYMENT_ROLES.md` in the repo root for the complete least-privilege IAM policies, trust policy, runtime role inventory, and iterative tightening recommendations.
