# ADR-002: Least-privilege CDK bootstrap policies as code

**Status:** accepted
**Date:** 2026-05-19
**Last-updated:** 2026-11-26
**Implementation:** Core shipped (#158, #162). The typed policies (`cdk/src/bootstrap/policies/`), triple-layer versioning (`cdk/src/bootstrap/version.ts` — `BOOTSTRAP_VERSION = '1.1.0'`, `computeBootstrapHash()`), the generated bootstrap template (`cdk/bootstrap/bootstrap-template.yaml`), and the `mise //cdk:bootstrap` + `mise //cdk:bootstrap:generate` tasks are all present on `main`. The deploy-time `mise //cdk:preflight` validator (#126) shipped in #976. The synth-time CDK Aspect (#125, depends on the resource-action-map #124) remains pending. See RFC #120 for the original stack.

## Context

CDK bootstrap creates five roles for each account and region. The **CloudFormation execution role** (cdk-hnb659fds-cfn-exec-role) receives `AdministratorAccess` by default. CloudFormation assumes this role to create, modify, and delete stack resources. That default violates least privilege and may conflict with organizational SCPs or compliance gates.

The ABCA project documented three scoped policies in `docs/design/DEPLOYMENT_ROLES.md` (PR #46), validated against a live deployment through 7 iterations and 36 CloudTrail-discovered actions. However, these policies exist only as JSON blobs in a Markdown file. They are unversioned, untested, and manually applied.

**Failure mode without automation.** When a new release adds a resource type (for example, an SQS queue), operators who pull and deploy hit a mid-rollback CloudFormation failure because their bootstrap policy predates the new permissions. The deploy fails 15 minutes in with no prior warning.

**Constraints:**
- IAM managed policies have a 6,144-character limit. That limit is the reason for the three-policy split (Infrastructure, Application, Observability).
- Bootstrap must exist before the CDK app can deploy. That circular dependency prevents managing bootstrap from within the app stack.
- The default template already scopes the four other bootstrap roles (deploy, lookup, file-publishing, image-publishing). They need no modification.

## Decision

### Policies as typed TypeScript code in `cdk/src/bootstrap/` *(shipped)*

Rationale for location:
- **Agent routing.** `AGENTS.md` routes CDK and IAM changes to `cdk/`. An agent that modifies a construct that adds a DynamoDB table looks here for the policy it must update.
- **Testability.** Jest tests can assert policy size limits, validate structure, and verify coverage against the synthesized template.
- **Co-location.** The CDK app defines what resources exist, and therefore what permissions are needed. Both live in the same package.
- **Self-contained.** `cdk/` has its own `mise.toml`, build, and test pipeline.

### Triple-layer versioning

| Layer | Purpose |
|-------|---------|
| **Semver** | Quick operator answer: "do I need to re-bootstrap?" Major = breaking. |
| **SHA256 hash** | Detects console drift, meaning manual IAM edits that diverge from code. |
| **Action-set comparison** | Precise gap reporting: exactly which actions are missing. |

`cdk/src/bootstrap/version.ts` computes the semver and the hash (`BOOTSTRAP_VERSION`, `computeBootstrapHash()`). They are emitted into the generated template and the `cdk/bootstrap/{BOOTSTRAP_VERSION,BOOTSTRAP_HASH}` files, so that preflight checks can be automated.

### Two-layer preflight validation

1. **CDK Aspect (synth-time)** *(pending, #125)*. The aspect will run during `mise //cdk:synth`. It will visit every `CfnResource`, look up the required actions in a resource-action-map (#124), and compare them against the declared policy. It will catch issues at dev time. **Not yet implemented.** `cdk/src/main.ts` currently registers only `AwsSolutionsChecks` (cdk-nag). There is no bootstrap-policy aspect.
2. **Live-account validator (deploy-time)** *(shipped, #126)*. `mise //cdk:preflight` reads the outputs of the `CDKToolkit` stack and compares the policy version, hash and policy set they publish with what the checkout needs. It fails with a message that names the remedy when the account has no bootstrap, a standard CDK bootstrap, an older policy version, or a policy set that lacks a policy the app needs. A different hash at the same version is a warning, not a failure. `mise //cdk:deploy` runs the same check before `cdk deploy`.

### Custom bootstrap template

*(shipped)* The template at `cdk/bootstrap/bootstrap-template.yaml` is generated from the policy source code, not maintained by hand. Operators run `mise //cdk:bootstrap` to provision least-privilege roles in a single command. That task depends on `mise //cdk:bootstrap:generate`, which regenerates the policy JSON, the template YAML, and the version and hash files. The template replaces `AdministratorAccess` with the three managed policies and keeps all other default bootstrap resources.

### Delivery via stacked PRs (ADR-001)

The implementation is decomposed into 8 sub-issues, each independently reviewable and deployable. See RFC #120 for the full stack.

## Consequences

- (+) Policies are diffable in PRs, so IAM changes are code-reviewed like any other code
- (+) Tests enforce the 6,144-char limit and structural validity on every commit
- (+) Preflight prevents the "deploy, wait 15 minutes, fail, rollback" loop
- (+) A single `mise //cdk:bootstrap` command replaces the multi-step manual process
- (+) Agents can automatically update policies when they add new resource types
- (-) The resource-action-map requires maintenance when new AWS resource types are added
- (-) Rebase complexity from the 8-PR stack
- (!) The bootstrap template can drift. CDK upstream may change defaults, so the template requires a rebase on CDK major upgrades
- (!) Operators with existing deployments must re-bootstrap (documented upgrade path provided)
- (!) `mise //cdk:bootstrap` passes `--force` to `cdk bootstrap` (#701), so it replaces the bootstrap (the `CDKToolkit` stack) that the account and Region already have, for every CDK app that deploys through it. That includes a standard CDK bootstrap and one whose CDK bootstrap version is newer than the template's. `bgagent setup` does not run the task on a standard bootstrap and leaves it unchanged. `mise //cdk:bootstrap -- --no-force` cancels the flag for a run. [Using these policies](../design/DEPLOYMENT_ROLES.md#using-these-policies) says what the task changes and how to check the result.
  - Without the flag, the CDK CLI warns, changes nothing and exits 0 when the `BootstrapVariant` parameter of the `CDKToolkit` stack differs from the template's, as it does after a standard `cdk bootstrap`. The other option of #701 was to detect that mismatch and fail, naming `--force` as the remedy.
  - That option was not taken, for two reasons. The deploy-time preflight names the bare task as the remedy, and `bgagent setup` runs it when the account has no bootstrap or an older ABCA one. A stack can keep the standard variant value after the template has replaced the standard bootstrap, so a task that fails on the mismatch would fail on every later run.

## References

- [ADR-001](./ADR-001-stacked-pull-requests.md), the delivery methodology (stacked PRs)
- RFC #120, the parent issue with the full design and the sub-issue breakdown
- `docs/design/DEPLOYMENT_ROLES.md`, the current documentation (will become generated)
- PR #46, the original policy derivation and validation methodology
- [CDK bootstrapping your environment](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
- [IAM managed policy size limit](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)

## Changelog

- 2026-11-23 — Recorded under Consequences that `mise //cdk:bootstrap` passes `--force` (#701), what the task replaces on an account that already has a bootstrap, and why it does not fail on a variant mismatch instead. Corrected the status of the deploy-time preflight (#126), which shipped in #976 (decision unchanged).
- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
