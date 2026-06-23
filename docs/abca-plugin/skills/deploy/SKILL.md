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
   This runs agent quality checks, CDK compilation + tests, CLI build, and docs build. Do NOT deploy if the build fails. Note: a passing build is noisy — it prints many `ERROR`/`WARN` and cdk-nag lines from test fixtures. Trust the **exit code (0 = pass)**, not the log volume.

2. **Docker is running** — Required for CDK asset bundling.
3. **Build host architecture** — The agent image targets `linux/arm64` (AgentCore is Graviton). On an **x86_64** host without QEMU/binfmt, the deploy fails partway with `exec /bin/sh: exec format error`. Register emulation once with `docker run --privileged --rm tonistiigi/binfmt --install arm64`, or deploy from a native arm64 host (Graviton / Apple Silicon). Skip on arm64 hosts.
4. **AWS credentials are configured** — `aws sts get-caller-identity` (confirm it's the intended account/region).

## Deploy Workflow

```bash
export MISE_EXPERIMENTAL=1
mise //cdk:deploy -- --require-approval never
```

`--require-approval never` lets the deploy run unattended. **In a non-interactive shell (CI, agent, script) it's required** — without it, `cdk deploy` hangs forever on the IAM/security-group approval prompt. Drop the flag if you're deploying interactively and want to review those changes.

After successful deployment, retrieve and display stack outputs:
```bash
aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs' --output table
```

Key outputs to highlight: `ApiUrl`, `RuntimeArn`, `UserPoolId`, `AppClientId`, `GitHubTokenSecretArn`.

## Diff Workflow

```bash
export MISE_EXPERIMENTAL=1
mise //cdk:diff
```

Summarize the changes: new resources, modified resources, removed resources. Flag any potentially destructive changes (resource replacements, security group changes).

## Destroy Workflow

**CRITICAL: Ask for explicit confirmation before destroying.** Use AskUserQuestion to confirm, explaining consequences.

```bash
export MISE_EXPERIMENTAL=1
mise //cdk:destroy
```

**Teardown can stall in `DELETE_FAILED`** on a security group / private subnet: AgentCore injects service-managed (Hyperplane) ENIs into the VPC, and AWS reclaims them **asynchronously (~20–40 min)** after the runtime is gone. Wait for the ENIs to clear, then retry `mise //cdk:destroy`. Do **not** force-delete past the stuck VPC resources (`--deletion-mode FORCE_DELETE_STACK` / retaining them) — that orphans the VPC, and VPCs are quota-capped per Region. Also note: a first-create failure leaves the stack in `ROLLBACK_COMPLETE`, which can't be updated — destroy and redeploy fresh.

## Synth Workflow

```bash
export MISE_EXPERIMENTAL=1
mise //cdk:synth
```

Output goes to `cdk/cdk.out/`. Useful for reviewing generated CloudFormation templates.

## Post-Deployment

After a successful deploy, remind the user to:
- Store/update the GitHub PAT in Secrets Manager if this is a fresh deployment.
- Onboard a repository. `bgagent repo onboard <owner/repo>` is a runtime operation (no redeploy) that works when the repo can use the **platform/default-blueprint** setup — the default GitHub token secret, an already-granted model, and the default egress allowlist. A repo that needs its **own** config — a per-repo GitHub token, a model not yet granted to the runtime, custom egress domains, Cedar HITL policies, or system-prompt overrides — needs a dedicated CDK `Blueprint` construct and a redeploy (with the correct permissions). See the `onboard-repo` skill for both paths.
- **Verify readiness before submitting a task:** `bgagent platform doctor` smoke-checks the API, Cognito, GitHub token, Bedrock model access, and onboarded repos — confirm everything is green first.
- (Lower-level alternative) raw API smoke test: `curl -s -H "Authorization: $TOKEN" $API_URL/tasks`.

## Least-Privilege Bootstrap (the default)

`mise //cdk:bootstrap` provisions a **custom least-privilege** CloudFormation execution role by default — NOT `AdministratorAccess` (ADR-002). It deploys `cdk/bootstrap/bootstrap-template.yaml`, which creates scoped `IaCRole-ABCA-*` managed policies (Infrastructure / Application / Observability) generated from `cdk/src/bootstrap/policies/`.

A consequence worth knowing when you **add a new resource type or a new feature on an existing resource**: the scoped role must allow the IAM action CloudFormation will call, or the deploy rolls back with `AccessDenied` on that action (e.g. `s3:PutBucketVersioning`, `lambda:TagResource`). The fix is to add the action to the relevant policy in `cdk/src/bootstrap/policies/`, regenerate (`mise //cdk:bootstrap:generate`), re-bootstrap, and redeploy. The policy source and the `DEPLOYMENT_ROLES.md` golden doc are kept in sync by tests.

See `docs/design/DEPLOYMENT_ROLES.md` for the complete IAM policies, trust policy, runtime role inventory, and tightening recommendations.
