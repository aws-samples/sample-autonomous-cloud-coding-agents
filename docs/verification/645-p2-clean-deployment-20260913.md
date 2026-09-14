# ADR-021 P2 clean deployment — 2026-09-13–14

Live verification of the P2 source fixes and deployment prerequisites from
[`645-p3-implementation-plan.md`](./645-p3-implementation-plan.md).

**Status: infrastructure and managed image deployed.** CloudFormation reached
`UPDATE_COMPLETE`; image version `1.0` is `SUCCESSFUL` and `ACTIVE`. Build hooks
and authenticated API reads pass. The later
[live task verification](./645-p2-live-task-20260914.md) also passed normal-task,
PR-iteration and cancellation checks. Remaining P2 acceptance conditions are
listed there; the broad smoke warnings have not been discharged.

The detailed chronology below records the infrastructure handoff at
2026-09-14 04:48 UTC. Repository/PAT setup and task execution occurred afterward
and are documented in the linked follow-up.

## Target and isolation

- Source: `fix/645-microvm-readiness`, deployed commit `29dcaa74`.
  The initial runtime revision was `eb7e2071a3affa09ca0fd2f0064028545537d21f`;
  the four deployment fixes below are included in the final source.
- AWS profile: `sphia-dev`; account: `<account-id>`; Region: `us-west-2`.
- Application stack: `backgroundagent-dev`; bootstrap stack: `CDKToolkit`.
- Compute selection: `lambda-microvm`, with the existing AgentCore resources
  still provisioned. Bootstrap compute policies: `agentcore,lambda-microvm`.
  This provisions a backend; each repository separately chooses its backend.
- Managed base image:
  `arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1`, version `1`.
- Local evidence: `/tmp/abca-645-p2-clean-20260913`.

The existing application and shared bootstrap in `us-east-1` are outside this
deployment. That Region already has five VPCs against a quota of five, and its
Bedrock invocation logging belongs to the existing development stack. No existing
VPC was deleted and no quota increase was requested.

Before this run, `us-west-2` had no active CloudFormation stacks, one default VPC
(`vpc-053c23d0618a71e91`), and no Bedrock invocation logging configuration.
Using this Region permits the repository's normal stack name and bootstrap
qualifier without modifying another application's resources.

## Local prerequisites

Docker is available on native ARM64. The installed mise `2026.2.8` cannot parse
the root monorepo task configuration. This run uses the official macOS ARM64
mise `2026.9.7` binary in the evidence directory's `tools/` folder, with its
SHA-256 checked against the GitHub release:
`3c3f377e7123a466274a20f01502ddd8c58f76028907f471c9bc42fbf83846e1`.
The global tool installation was not changed.

The full root build runs with `JEST_MAX_WORKERS=2` and `MISE_JOBS=2`.
The final deployed source passed in 704.66 seconds; its output is retained as
`full-build-managed-image-nag.log`.

**Final result: passed**, exit 0. CDK: 222 suites / 4,783 tests;
CLI: 62 suites / 928 tests; Python: 1,823 tests. Compilation, lint, formatting,
type checks, the 77-page documentation build and drift checks passed. Two CDK suites / 38
DynamoDB Local integration cases were skipped because that local service was
not running; those cases passed during the preceding implementation session.

Earlier builds are recorded below beside the fixes they validated. Target
synthesis was run after the final build and passed. Deployment cleanup must
not run concurrently with tests/synthesis using the shared CDK temporary files.

## Acceptance record

- [x] Full root build passes on deployed infrastructure source (`29dcaa74`).
- [x] Fresh least-privilege bootstrap has the required policies.
- [x] No-image application infrastructure deploys from source.
- [x] Current agent artifact is packaged and uploaded.
- [x] CloudFormation creates the managed image using the pinned base.
- [x] Image version is active; `/ready` and `/validate` return HTTP 200.
- [x] Coordinator image/network/role configuration and authenticated API reads are verified.
- [x] A normal task completes with live progress and heartbeat evidence (follow-up).
- [x] Runtime logs, successful/canceled-task payload cleanup and VM termination are verified (follow-up).
- [ ] Failure/recovery cleanup and automatic repository build/lint gates are verified.
- [ ] Relevant allowed/denied IAM and network cases are exercised.
- [x] Current resource state, temporary-login cleanup and remaining limits are recorded.

Automatic P3 suspension remains disabled in this source revision. A successful
P2 deployment would not establish P3 lifecycle correctness.

## Bootstrap and application synthesis

`CDKToolkit` reached `CREATE_COMPLETE` with bootstrap version `32` and ABCA
policy bundle `1.6.0`. The original generated template was deployed through
CloudFormation so the custom `ComputeTypes=agentcore,lambda-microvm` parameter
could be supplied at creation. No generated template or live IAM policy was
patched. The reviewed change set contained 18 additions.

At initial bootstrap 1.6.0 creation, the CloudFormation execution role had exactly
the five expected ABCA policies:
Infrastructure, Application, Observability, Compute-Agentcore and
Compute-LambdaMicrovms. Each deployed policy document equaled its source JSON.
There were no inline execution-role policies and no `AdministratorAccess`.
Bootstrap 1.7.0 adds the exact-role inline policy described below while
preserving those five managed policies.
Evidence: `bootstrap-policy-comparison.json`.

The target-specific no-image synthesis passed for
`aws://<account-id>/us-west-2`: 472 parent resources and a 693,882-byte parent
template. Registry resources occupy two nested stacks. Asset publication and
the application change-set preparation follow this reviewed cloud assembly.

## First application attempt and source fix

The agent container built and every code/image asset uploaded successfully.
Application change-set preparation then failed before resource creation:
CloudFormation's execution role lacked `iam:PassRole` on itself while validating
the registry nested stacks. Evidence: `substrate-prepare.log`.

The source fix adds `PassExecutionRoleToCloudFormation` as a generated inline
policy, permitting only the exact execution role ARN and only the CloudFormation
service. Bootstrap bundle `1.7.0` is required. No live IAM patch was applied.

The bootstrap hash also needed correction: its root-key JSON replacer omitted
nested Action, Effect, Resource and Condition changes. It now recursively sorts
keys, keeps those fields, and includes the new inline policy.

Five new regressions failed on old source: the missing self-role policy and four
permission changes that left the old hash unchanged. After the fixes, the two
bootstrap suites pass all 58 tests, including object-key ordering and inline-policy
hash coverage. The generated template is 47,446 bytes on disk; the CDK CLI sends
46,307 characters, within both the budget and AWS's inline limit.

The complete build passed again: 4,773 CDK tests, 928 CLI tests and 1,823 Python
tests; total runtime 362.54 seconds. The fix is committed as `16941828`.
Bootstrap 1.7.0 reached `UPDATE_COMPLETE`. Its actual inline policy equals the
resolved source policy, its five managed attachments are unchanged, and every
existing bootstrap parameter was preserved. AWS IAM simulation verified six
resource/service combinations, allowing only this role passed to CloudFormation.

## Second application attempt: global names

The application retry passed the self-PassRole check, then failed early
validation because `BackgroundAgent-Tasks-backgroundagent-dev` already exists.
CloudWatch dashboard names are account-global. The existing dashboard was last
modified on 2026-08-28 and was not changed by this run.

An audit of the other global resources found a second collision before another
attempt: the screenshot CloudFront origin access control (OAC),
`backgroundagentdevGitHubScreOrigin1S3OriginAccessControl544B0DF8`, already exists
as `E7LV4IA65D59K`. The OAC controls how CloudFront authenticates requests to the
private screenshot bucket. It belongs to the existing deployment and must not
be deleted or repurposed.

The source now gives the dashboard a Region suffix and gives each screenshot
OAC a bounded construct-path name plus Region. Four regressions failed the old
names; all 15 tests in the two construct suites now pass. Tests cover identical
stack names in two Regions, long names, distinct controls, and SigV4 signing.

For existing deployments adopting this source, the dashboard and OAC resources
are replaced; the distribution references the new OAC. Dashboard bookmarks need
the new name. This run updates only the new Oregon deployment.

The full build passed: 4,777 CDK tests, 928 CLI tests, 1,823 Python tests and
77 documentation pages; total runtime 358.95 seconds. The fix is committed as
`4ea7e88b`. Refreshed target synthesis passed with 472 parent resources.

## Third application attempt: registry waiter

The third change set passed validation and all 472 additions were reviewed
before execution. Actual creation failed in the registry nested stack:
CloudFormation generated the Step Functions name
`AgentRegistryProviderwaiterstatemachineE27177B2-SxOkWE4lO56U`, outside the
bootstrap policy's `backgroundagent-dev-*` namespace. The execution role therefore
denied `states:CreateStateMachine`.

The registry construct now explicitly names this helper using the outer stack
name and a bounded construct-path hash. No bootstrap permission expansion is
needed. Four regressions failed on old source; the registry suite now passes
all 11 tests, including actual nested templates, long stack names, two distinct
registries, and comparison against the bootstrap ARN pattern. The full root
build passed in 715.27 seconds: 4,781 CDK tests, 928 CLI tests, 1,823 Python
tests and 77 documentation pages. The fix is committed as `edaa144c`.

The target template now names the waiter
`backgroundagent-dev-AgentRegistryStack-AgentRegistry-Provider-77C0EB2A`.
IAM simulation using the actual deployed execution role allows its creation
and denies the old name. The registry nested template changes only that name;
the parent remains at 472 resources. Evidence:
`registry-waiter-iam-simulation.json` and `substrate-waiter-template-review.json`.

Rollback initially could not delete the two MicroVM network connectors and
AgentCore memory while AWS was still creating them. A normal stack deletion
after they stabilized reached `DELETE_COMPLETE`, including the connectors,
memory and VPC. No forced deletion or VPC retention was used. This removed only
the new failed Oregon application; the Oregon bootstrap remains for the retry.

Post-deletion inventory found one intentionally retained API Gateway logging
role and two regional logging settings. With no REST or HTTP APIs remaining,
the API Gateway setting was cleared and that exact failed-stack role deleted.
Bedrock invocation logging, still pointing to the deleted stack's log group and
role, was cleared too. Both settings now match the observed empty initial state.
Stack and VPC inventories now contain only the new bootstrap and the original
default VPC; existing resources in other Regions were not changed.

## Fourth application attempt

Change set `abca-645-p2-substrate-r4` passed AWS validation. Its 472 changes are
all additions, with the intended restricted CloudFormation execution role.
The proposal was executed for the new stack
`df112e20-afe6-11f1-963f-02fff900428b`. The stack and all 472 root resources
reached `CREATE_COMPLETE` at 2026-09-14 03:03 UTC.
Source fixes are `16941828`, `4ea7e88b` and `edaa144c` on top of the original
runtime revision recorded above. Bootstrap remains 1.7.0.

The registry and its waiter both reached `CREATE_COMPLETE`. The registry ID is
`5v3pQEkpkvjdS4q6`; the waiter uses the explicit name above. This verifies the
previous failure is fixed during actual resource creation, not only simulation.
Evidence: `substrate-r4-registry-resources.json`.

Both connectors are `ACTIVE`. `aws lambda-core` is the CLI namespace for network
connectors. Their actual security groups have no ingress rules; runtime egress
allows TCP 443, while build egress allows TCP 80 and 443. This verifies deployed
configuration; in-guest traffic tests remain outstanding.

The DNS firewall is in the source's hardcoded observation mode. Live rules
allow baseline/additional domains at priorities 100/200 and use a catch-all
`ALERT` at priority 300. Unlisted domains are logged, not blocked; domain
allowlisting must not be claimed as an enforced isolation boundary here.
Evidence: `live-dns-firewall-rules.json`.

## Agent artifact and API checks

The official packaging script uploaded the artifact successfully. Downloading
that S3 object and comparing the 106 image inputs against the checkout verified
every byte. The ZIP is 1,046,220 bytes with SHA-256
`e6f37030b0517374359927ac3c1480d85195fba37db8052ed339b9a34dcd94a1`.
Evidence: `uploaded-artifact-verification.json`.

A temporary user in the new Cognito pool authenticated through the built CLI,
and an authenticated task list returned an empty result. Missing and invalid
tokens both returned HTTP 401. Invitation messages were suppressed. The CLI
used a separate private configuration, leaving the operator's default login
untouched. Authenticated listing passed again after the managed-image update.

Platform doctor passes the API, Cognito, active-repo and model-catalog checks.
It fails only the GitHub token check: the new secret still contains its
placeholder. Repository choice and GitHub setup remain pending. Catalog
visibility alone does not prove runtime model invocation.
Evidence: `post-update-task-list.json` and `post-update-platform-doctor.json`.

`bgagent runtime status` confirms that the only seeded repository,
`awslabs/agent-plugins`, still resolves to **AgentCore**, whose control plane is
`READY`. There are no repositories configured for MicroVM yet. Stack output
`ComputeSubstrate=lambda-microvm` describes provisioned infrastructure; it does
not change the seeded repository's selection. Onboard the chosen test repository
with `--compute-type lambda-microvm` before submitting a task. Evidence:
`post-update-runtime-status.json`.

## Managed-image synthesis: overflow-policy check

The first managed-image synth failed locally on one `AwsSolutions-IAM5` finding:
the orchestrator's Jira OAuth secret-prefix grant moved into `OverflowPolicy1`
when image lifecycle permissions enlarged the role's policy. Constructor-time
suppression metadata does not reach policies generated later during synthesis.
The source fix extends the existing overflow-policy Aspect only for that role
and that resource pattern. Both production-entry-point regression cases pass,
including an unrelated wildcard grant that still triggers an error. The fix is
committed as `29dcaa74`; the final full-build result is recorded above.

The corrected managed-image synth passed with 474 parent resources and a
697,733-byte template. Compared with the failed synth, all IAM Role, Policy
and ManagedPolicy resource properties are identical: the fix changes the narrow
security-check exception metadata, not permissions. Evidence:
`managed-image-template-review.json` and `managed-image-synth-r2.log`.

## Managed-image deployment and live checks

Change set `abca-645-p2-managed-image-r1` contained 42 changes: four additions,
36 modifications and two removals. The removals were old immutable Lambda and
guardrail versions. No existing data bucket, table or VPC was replaced.
CloudFormation executed the update successfully; `UPDATE_COMPLETE` was observed
at 2026-09-14 04:39:46 UTC. The stack has 474 root resources.

| Item | Observed result |
|---|---|
| Stack | `backgroundagent-dev`, ID suffix `df112e20-afe6-11f1-963f-02fff900428b`, `UPDATE_COMPLETE` |
| Image | `arn:aws:lambda:us-west-2:<account-id>:microvm-image:backgroundagent-dev-abca-agent` |
| Image record | `CREATED`, `latestActiveImageVersion=1.0` |
| Image version `1.0` | Build state `SUCCESSFUL`, status `ACTIVE` |
| Base | `al2023-1`; input version `1` is reported by AWS as `1.0` |
| Configuration | `ARM_64`, 8,192 MiB minimum memory, hook port 8080 |
| Build hooks | Ready enabled / 300 seconds; validate enabled / 60 seconds |
| Runtime hooks | Run enabled / 60 seconds; terminate enabled / 15 seconds; no suspend/resume hooks |
| CloudWatch logs | `/aws/lambda-microvms/backgroundagent-dev-abca-agent` |
| Active task VMs | None; no coding task has been submitted |

The actual `/ready` log records warm-up of Claude CLI 2.1.191, git 2.47.3 and
Node 24.21.0, followed by HTTP 200. `/validate` reports Python 3.13.13,
13 supported platform configuration keys and zero validator warnings, followed
by HTTP 200. Some generic Uvicorn “Invalid HTTP request received” warnings
precede validation; their cause was not established. These build-hook results
do not exercise runtime AWS credentials, model invocation or task execution.

The live coordinator alias points to version `2`, with Lambda state `Active`
and last update `Successful`. Its actual environment includes the managed image
ARN, the runtime execution role, runtime egress connector, AWS `NO_INGRESS`
connector and the dedicated payload bucket. No image-version override is set,
so launch resolves the latest active version.

Evidence: `managed-image-change-set-r1.json`, `managed-image-r1-state.json`,
`managed-image-r1-resources.json`, `final-managed-image.json`,
`final-managed-image-version.json`, `final-orchestrator-configuration.json`,
`final-microvms.json` and `image-build-log-snapshot.json`.

## Retained deployment, cleanup and next verification

The successful application, managed image, artifact and bootstrap remain live.
The default Oregon VPC and existing deployment in other Regions were preserved.
The failed earlier application was fully removed as described above.
The final read at 2026-09-14 04:48:54 UTC confirms `UPDATE_COMPLETE`, no task
MicroVMs and zero objects in the payload bucket. Since no task ran, an empty
bucket does not prove the cleanup path works. Evidence:
`final-deployment-status.json`.

After the final authenticated API check, the temporary Cognito user
`p2-verification-20260913@example.invalid` was deleted from the new pool.
`AdminGetUser` confirmed `UserNotFoundException`. Its three private request files
and cached CLI credentials were removed. The non-secret isolated CLI
configuration and deployment evidence remain. Evidence:
`verification-user-cleanup.json`.

At infrastructure handoff, the planned verification sequence was the following.
The [live task record](./645-p2-live-task-20260914.md) records the completed
steps and the remaining limits:

1. Select the test repository and populate the new deployment's GitHub token
   using `bgagent github set-token --region us-west-2 --stack-name backgroundagent-dev`.
   No GitHub token was copied and no repository, branch or PR was created by this run.
2. Onboard that repository with `bgagent repo onboard OWNER/REPO --compute-type
   lambda-microvm --region us-west-2 --stack-name backgroundagent-dev`. Confirm
   its effective backend with `bgagent runtime status --repo OWNER/REPO`.
   Use this deployment's isolated CLI configuration and an authorized login.
3. Submit the normal clone/change/test/PR task from the P2 runbook and capture
   progress, heartbeat, model invocation, Memory writes and logs while the VM
   is running. The image build and empty API list are not substitutes.
4. Verify success, failure and cancellation cleanup, including S3 payload
   deletion and service-reported VM termination. Exercise the pending IAM and
   in-guest network positive/negative cases. The DNS observation-mode limit
   remains applicable.
5. Record those results before discharging P2 warnings or enabling automatic
   P3 suspension.

The rebuild follow-up identified here is now resolved in the
[managed image update record](./645-microvm-image-rebuild-20260914.md):
overwriting the fixed S3 key did not change CloudFormation image properties.
Commit `e1d5debe` adds immutable hash-suffixed artifacts and requires their digest
in deployment context. A normal update built and activated image `2.0`; repeat
packaging reused the verified object and a same-assembly deployment made no
changes. Packaging and passing the printed digest remain explicit operator steps.
