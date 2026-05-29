# ADR-002: Least-privilege CDK bootstrap policies as code

**Status:** accepted
**Date:** 2026-05-19
**Implementation:** Tracked in RFC #120; artifacts referenced below land progressively across the 8-PR stack and are not yet present on `main`.

## Context

CDK bootstrap creates five roles per account/region. The **CloudFormation execution role** (cdk-hnb659fds-cfn-exec-role) receives `AdministratorAccess` by default — CloudFormation assumes it to create, modify, and delete stack resources. This violates least-privilege and may conflict with organizational SCPs or compliance gates.

The ABCA project documented three scoped policies in `docs/design/DEPLOYMENT_ROLES.md` (PR #46), validated against a live deployment through 7 iterations and 36 CloudTrail-discovered actions. However, these policies exist only as JSON blobs in a Markdown file — unversioned, untested, and manually applied.

**Failure mode without automation:** When a new release adds a resource type (e.g., SQS queue), operators who pull and deploy hit a mid-rollback CloudFormation failure because their bootstrap policy predates the new permissions. The deploy fails 15 minutes in with no prior warning.

**Constraints:**
- IAM managed policies have a 6,144-character limit — hence the three-policy split (Infrastructure, Application, Observability).
- Bootstrap must exist before the CDK app can deploy — circular dependency prevents managing bootstrap from within the app stack.
- The four other bootstrap roles (deploy, lookup, file-publishing, image-publishing) are already scoped by the default template and don't need modification.

## Decision

### Policies as typed TypeScript code in `cdk/src/bootstrap/` *(lands in #122)*

Rationale for location:
- **Agent routing** — `AGENTS.md` routes CDK/IAM changes to `cdk/`. An agent modifying a construct that adds a DynamoDB table naturally looks here for the policy it must update.
- **Testability** — Jest tests can assert policy size limits, validate structure, and verify coverage against the synthesized template.
- **Co-location** — the CDK app defines what resources exist (and therefore what permissions are needed); both live in the same package.
- **Self-contained** — `cdk/` has its own `mise.toml`, build, and test pipeline.

### Triple-layer versioning

| Layer | Purpose |
|-------|---------|
| **Semver** | Quick operator answer: "do I need to re-bootstrap?" Major = breaking. |
| **SHA256 hash** | Detects console drift — manual IAM edits that diverge from code. |
| **Action-set comparison** | Precise gap reporting: exactly which actions are missing. |

Semver and hash are emitted as CloudFormation outputs on the CDKToolkit stack, enabling automated preflight checks.

### Two-layer preflight validation

1. **CDK Aspect (synth-time)** *(lands in #125)* — will run during `mise //cdk:synth`, visiting every `CfnResource`, looking up required actions in a resource-action-map (#124), and comparing against declared policy. Catches issues at dev time.
2. **Live-account validator (deploy-time)** *(lands in #126)* — `mise //cdk:preflight` will read CDKToolkit stack outputs, compare version/hash against requirements, and fail fast with an actionable "re-bootstrap required" message before CloudFormation starts.

### Custom bootstrap template

*(Lands in #123)* — will be generated from the policy source code (not hand-maintained). Operators will run `mise //cdk:bootstrap` to provision least-privilege roles in a single command. The template replaces `AdministratorAccess` with the three managed policies while retaining all other default bootstrap resources.

### Delivery via stacked PRs (ADR-001)

The implementation is decomposed into 8 sub-issues, each independently reviewable and deployable. See RFC #120 for the full stack.

## Consequences

- (+) Policies are diffable in PRs — IAM changes are code-reviewed like any other code
- (+) Tests enforce the 6,144-char limit and structural validity on every commit
- (+) Preflight prevents the "deploy, wait 15 minutes, fail, rollback" loop
- (+) Single `mise //cdk:bootstrap` command replaces the multi-step manual process
- (+) Agents can automatically update policies when they add new resource types
- (-) Resource-action-map requires maintenance when new AWS resource types are added
- (-) Rebase complexity from the 8-PR stack
- (!) Bootstrap template drift — CDK upstream may change defaults; requires rebase on CDK major upgrades
- (!) Operators with existing deployments must re-bootstrap (documented upgrade path provided)

## References

- [ADR-001](./ADR-001-stacked-pull-requests.md) — delivery methodology (stacked PRs)
- RFC #120 — parent issue with full design and sub-issue breakdown
- `docs/design/DEPLOYMENT_ROLES.md` — current documentation (will become generated)
- PR #46 — original policy derivation and validation methodology
- [CDK default bootstrap template](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml)
- [IAM managed policy size limit](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
