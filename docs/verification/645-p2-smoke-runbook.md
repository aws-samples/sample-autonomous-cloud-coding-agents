# ADR-021 P2 Stage D — live smoke runbook

This is the working verification document for issue #645 on branch
`feat/645-lambda-microvm-p2` @ `3a4b61a97b22b7bcdd9832101f8d61a077fbf103`.
It is the companion to
[`645-p1-lambda-microvm-runbook.md`](./645-p1-lambda-microvm-runbook.md).
This run reuses all of that runbook's commands and conventions: the escaped
`ComputeTypes` comma, `bootstrap --force`, newest-first version ordering, the
image-version `N.0` spelling, two builds per version, deleting all versions but
the last and then the image, and running teardown as a finally-block.

`docs/scripts/sync-starlight.mjs` does not mirror `docs/verification/`, so this
file stays here on purpose and is not part of the Starlight site.

**Live run.** 2026-08-06 22:38Z to 2026-08-07 01:26Z, account `<account>`,
`us-east-1`. The evidence directory is `/tmp/abca-645-p2-20260806`.

**Teardown is complete.** All MicroVMs are terminated. The image and its
version are deleted. Both live IAM workarounds are reverted. The Cognito user
is deleted, and the secret was deleted with the stack. 96 of 100 stack
resources are deleted, and the 4 that remain cost nothing (#702). All billable
resources are confirmed gone, and every global and host configuration is
restored. See Phase 8.

## What Stage D was for

P2 (`ab4808c`) wired everything short of the live run. Its commit message names
what it could not assert:

> Remaining for P2 completion: the live smoke run (clone -> change -> PR with
> `bgagent watch`) and the deferred empirical items (suspend TTL >1h,
> SUSPENDED-vs-quota, `microvmImageHooks` API spelling, `NO_INGRESS` ARN).

Stage D had five jobs. The table gives the verdict on each:

| # | Job | Verdict |
|---|---|---|
| 1 | **THE SMOKE.** clone → change → PR through `bgagent watch` | **BLOCKED at `implement`, turn 0**, reproducibly. Clone, branch, `/run`, `platform_config`, progress events and terminate all work. `claude --version` times out (P2-F5). **No PR was created.** |
| 2 | Decide the CFN `AWS::Lambda::MicrovmImage` shape that P1 left half-open | **DISCHARGED. The L1 is REFUTED on 5 values** (P2-F2) |
| 3 | `microvmImageHooks` spelling | **DISCHARGED both ways.** The property name and nesting are correct, and hook *values* must be `ENABLED` or `DISABLED` (P2-F2). The API request built by the packaging script is correct, and all four hooks were accepted and served |
| 4 | `NO_INGRESS` ARN name | **DISCHARGED.** The injected ARN is right and suppresses P1 F7's default public ingress |
| 5 | Extend the suspend-TTL bound. Re-probe SUSPENDED-vs-quota | **TTL extension SKIPPED** (time-boxed, see Skipped). Quota **re-confirmed NOT OBSERVABLE** |

**Headline.** The P2 substrate gets much further than P1 did. The image builds
with all four hooks, the MicroVM launches, `/run` installs `platform_config`,
the repo clones, progress events stream to `bgagent watch`, and finalization
terminates the VM. But **four independent defects had to be worked around to
get that far**, and a fifth stops the run one step short of a PR. None of the
four is visible to `cdk synth`, `mise //cdk:test`, or any unit test. Each one
is a mismatch with the contract of the live service.

---

## Variables

```bash
set -o pipefail                      # P1's hard-won lesson: `| tee` masks failures
export AWS_PROFILE=aamorosi+workshops-AdminConsoleAccess
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT="<account>"
export STACK_NAME=backgroundagent-dev
export EXPECTED_BRANCH=feat/645-lambda-microvm-p2
export SCRATCH_REPO=dreamorosi/batch-sync-triage
export SMOKE_USER="<email>"
export CDK_DOCKER=finch              # no docker on this box (P1 deviation 3)
export EVIDENCE_DIR=/tmp/abca-645-p2-20260806
export BGAGENT_CONFIG_DIR=/tmp/abca-645-p2-bgagent
```

### ⚠️ zsh trap that bit this run

The executor's shell is zsh. zsh parses `$VAR:latest` as the `${VAR:l}`
lowercase modifier and produces `…atest` without an error. That cost one
mis-diagnosed container push. **Always use braces: `${VAR}:latest`.** zsh also
has no `PIPESTATUS` (the zsh variable is `$pipestatus`, and it is 1-indexed)
and no `timeout(1)`. P1's `test "${PIPESTATUS[0]}" -eq 0` evaluates to empty
here without an error. Use `set -o pipefail` plus a plain `$?`.

---

## Execution deviations (each is itself a result)

1. **AZ pinning was required. P1 F11 is UNFIXED on this branch.**
   `agent-vpc.ts` still sets `maxAzs: 2` with no AZ constraint, and this
   account still maps `us-east-1a → use1-az6`, which AgentCore rejects. P1
   already recorded this finding, so the run did not derive it again. Instead,
   the gitignored CDK context cache (`cdk/cdk.context.json`, a build artifact,
   so `git status` stayed clean) was trimmed to lead with `us-east-1b`
   (`use1-az1`) and `us-east-1c` (`use1-az2`). The original was saved to
   `$EVIDENCE_DIR/cdk.context.json.ORIGINAL` and **restored at teardown**. With
   the pin, AgentCore Memory and Runtime were created without errors, so the
   need for the pin is all that remains of F11's impact.
2. **The AgentCore container asset could not be pushed. An existing ECR
   manifest was retagged instead.** `finch` (v1.17.2, no docker on this box)
   built the image, but every `finch push` and `finch pull` against ECR failed
   at once with `no basic auth credentials`. The root cause is established.
   `finch push` runs in the Lima VM as
   `limactl shell finch sudo -E nerdctl push`, and the VM's `DOCKER_CONFIG`
   (`/home/aamorosi.guest/.finch-vm-config/config.json`) carries
   `credsStore: finchhost`. That helper cannot resolve this account's Isengard
   `credential_process`. A host-side `finch login` succeeded and wrote to
   `~/.finch/config.json`, but the VM never read that file. Only the AgentCore
   runtime consumes the ECR image, and this run never invokes that runtime,
   because the smoke runs on the MicroVM substrate that the Lambda MicroVMs
   service builds from the S3 zip. The required asset tag was therefore added
   to an existing manifest with `aws ecr put-image`. **The retag does not touch
   the MicroVM image under test.** As a consequence, the deployed AgentCore
   runtime carries a P1-era agent image. Nothing in this runbook depends on
   that image. All global config touched during that investigation
   (`~/.finch/config.json` and the VM's docker config) was reverted. See
   Teardown.
3. **The connector operator role's trust policy had to be patched before
   anything could deploy** (P2-F1). The patch was applied to a cloud assembly
   in `/tmp`, which is P1's technique. No repository source file was modified.
4. **Two IAM workarounds were applied live to get past P2-F3.** One removed the
   execution role's trust condition. The other added a temporary unconditioned
   `iam:PassRole`, which turned out to be unnecessary. Both were reverted. See
   Teardown.
5. **The CDK-managed `CfnMicrovmImage` path was attempted first, as briefed, and
   failed** (P2-F2). The out-of-band `--create-image` script path was used
   instead. P1 used the same path, and it is currently the only one that works.
6. **The suspend-TTL extension beyond P1's 1 h floor was skipped** (time-boxed).
7. **One error made by the executor is recorded here.** The GitHub PAT was
   first written to Secrets Manager with a trailing newline (`gh auth token |
   … --secret-string file:///dev/stdin`), and the newline produced a real clone
   failure. The error was corrected. See 3.2.

---

## Phase 0 — Preflight

### 0.1 Identity, region, branch

`aws sts get-caller-identity` returned
`arn:aws:sts::<account>:assumed-role/AdminConsoleAccess/aamorosi-Isengard`,
account `<account>`. The branch was `feat/645-lambda-microvm-p2` at SHA
`3a4b61a97b22b7bcdd9832101f8d61a077fbf103`. Two paths were untracked,
`docs/verification/` and `opencode.json`, the same two that P1 saw.

> **Credential note.** The profile's default region is `eu-west-1`, so
> `AWS_REGION` and `AWS_DEFAULT_REGION` must be exported explicitly for every
> command. A bare `aws` call in this account goes to the wrong Region.
> The credentials expired once during the run. Setting `AWS_PROFILE` again
> fixed it, because the profile resolves through `credential_process` and
> refreshes automatically. **No global AWS config was read or modified at any
> point.**

`backgroundagent-dev` was **absent**, as P1's Phase 8 hoped:

```
An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id backgroundagent-dev does not exist
```

**The stack half of P1 F12 is therefore RESOLVED.** P1 ended with
`backgroundagent-dev` in `DELETE_FAILED` (a VPC, 2 subnets and 1 SG, pinned by
two leaked `agentic_ai` ENIs) and a recorded retry command. AgentCore did
release the ENIs in the end, and the stack is gone. The three unrelated
pre-existing stacks (`serverless-api-powertools`, `BuildingServerlessAPIs`,
`aws-sam-cli-managed-default`) and `CDKToolkit` remain.

### 0.2 Tooling

| Tool | Version | Note |
|---|---|---|
| `aws-cli` | 2.36.13 | `aws lambda-microvms help` **exit 0**, **24 commands**, identical to P1 |
| `mise` | 2026.8.1 | **present this time** (P1 ran entirely on raw fallbacks) |
| node | v24.16.0 | |
| python3 | 3.9.6 | system python. The *guest* runs 3.13.13 |
| `zip` | 3.0 | |
| `rsync` | openrsync (protocol 29) | packaging script works unmodified |
| docker | **absent** | |
| `finch` | v1.17.2 | builds fine, **cannot push to ECR** (deviation 2) |

### 0.3 Bootstrap — no re-bootstrap needed

`CDKToolkit` was `UPDATE_COMPLETE` (last updated 2026-07-31T18:54:48Z, that is,
by P1's run), and it already carried what P2 needs:

- `ComputeTypes` = **`agentcore,lambda-microvm`** ✓
- `BootstrapVariant` = **`ABCA: Least-Privilege Bootstrap`**
- bootstrap version SSM parameter = `32`
- `cdk-hnb659fds-cfn-exec-role-<account>-us-east-1` carries exactly the **five**
  ABCA policies (Application, Infrastructure, Observability, Compute-Agentcore,
  **Compute-LambdaMicrovms**) and **no `AdministratorAccess`**.

So `bootstrap --force` was **not** run again.

> **P1 F10 partly corrects itself. This is a correction to the P1 record.** P1
> reported as a "durable consequence" that `BootstrapVariant` *stays* `AWS CDK: Default
> Resources` after a forced bootstrap, so every future non-forced bootstrap
> refuses forever. `BootstrapVariant` now reads
> `ABCA: Least-Privilege Bootstrap`. The reason is the next command in P1's
> own runbook. `update-stack
> --use-previous-template` with **only** `ParameterKey=ComputeTypes` supplied
> resets every unspecified parameter to its **template default**. That is
> CloudFormation's documented behaviour when `UsePreviousValue=true` is
> absent. The ABCA template's default for `BootstrapVariant` is the ABCA
> string. The first half of F10 (the silent `exit 0` no-op without `--force`)
> stands. The "recurs forever" half does not.

### 0.4 Managed base image

Unchanged from P1. `us-east-1` has exactly **one** managed base image,
`arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`, with versions `1`
(2026-07-21) and `0` (2026-06-17). The list is **newest first**, so
`items[0]` = `1`. The run selected version `1`, and the service echoes
`baseImageVersion: "1.0"`.

---

## Phase 1 — Deploy

### 1.1 Substrate synth — PASS

Synth emitted `abca:microvm-image-not-provisioned` with the full remedy text,
and `abca:microvm-image-p1-smoke-unverified` was **absent**, as it should be.
Both incidental warnings grew since P1, and one is close to its limit:

| Metric | P1 | P2 | Limit |
|---|---|---|---|
| Template size | 893,273 | **977,650** (substrate) / **983,796** (with image) | 1,000,000 |
| Resource count | 463 | **485** / **486** | 500 |

**Feeds back to design.** With the image configured, the template is at
**98.4 %** of the 1 MB CloudFormation limit. That leaves ~16 KB of headroom,
roughly one more construct. `suppressTemplateIndentation` or a stack split is
now required in the near term.

### 1.2 Substrate deploy — BLOCKED, then PASS after a trust-policy patch

**Attempts 1–2 failed on the ECR push** (deviation 2), a local tooling
problem. **Attempts 3–4 both failed on the network connectors with the same
error.** This is P2-F1:

```
Resource handler returned message: "The service is unable to assume the provided NetworkConnectorOperatorRole. Please verify the trust policy on the role. (Service: Lambda, Status Code: 400, Request ID: dbe1d2f4-dd0c-4319-8f5d-b4be4f076843) (SDK Attempt Count: 1)" (RequestToken: d6e21be9-9857-f452-bf12-3b93f89a4c75, HandlerErrorCode: InvalidRequest)
```

Both `LambdaMicrovmCompute/EgressConnector` and
`LambdaMicrovmCompute/BuildEgressConnector` went to `CREATE_FAILED`. Attempt 4
ran against a **freshly deleted stack**, so the failure is **deterministic, not
IAM propagation lag**. The distinction matters, because that error message is
the usual symptom of propagation lag, and a re-run is the obvious first guess.
That guess is wrong.

**Attempt 5** deployed a cloud assembly in `/tmp` with exactly one edit. The
edit removed the `aws:SourceAccount` condition from the
`AssumeRolePolicyDocument` of `LambdaMicrovmComputeConnectorOperatorRole`:

```json
{"Statement":[{"Action":"sts:AssumeRole","Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"}}],"Version":"2012-10-17"}
```

Both connectors went `CREATE_IN_PROGRESS → Resource creation Initiated` within a
second. The stack reached `CREATE_COMPLETE` with 485 resources. The deploy ran
from 23:13:43Z to 23:27:03Z, which is **13 min 20 s**. P1's comparable figure
is 13 min 42 s for 464 resources.

Two problems from P1 recurred unchanged, and their remedies still work:

- `AWS::BedrockAgentCore::Memory` cannot be deleted while `CREATING`
  (`Validation failed during DeleteMemory: Memory is in transitional state
  CREATING. Cannot delete memory.`), so the rollback ends in
  `ROLLBACK_FAILED`. A plain `aws cloudformation delete-stack` clears it
  (~3 min). **The Memory half of P1 F12 is unfixed.**
- Edits made to the template after synth are ignored without an error unless
  the template's S3 asset object is deleted first. The object key is the
  content hash from *before* the edit.

### 1.3 Substrate outputs — PASS

`ComputeSubstrate = lambda-microvm`. All **seven** MicroVM outputs are
populated: the six that P1 had, plus `MicrovmBuildEgressConnectorArns`. The
artifact key is exactly `microvm-images/agent-artifact.zip`. The runtime and
build egress connectors have distinct ARNs, as designed.

### 1.4 No-image orchestrator env — PASS, and a correction to P1 F14

`MICROVM_*` keys = **`[]`** (23 env keys in total). The all-or-nothing rule
holds.

> **P1 F14's `--no-paginate` remedy is WRONG and truncates without an error.**
> P1 concluded that `list-stack-resources --query "…|[0]"` needs
> `--no-paginate`. With 485 resources, `--no-paginate` returns **only the first
> page**. That page held 6 Lambda functions and *no* `TaskOrchestrator`, so
> `ORCHESTRATOR_FN` resolved to the literal string `None`, and the lookup
> produced a misleading `Function not found: …:function:None`. That is worse
> than P1's original bug, because the original printed five values and failed
> with a visible error. **The correct approach is to let the CLI paginate (its
> default) and filter client-side.** That returns all 485:
> ```bash
> aws cloudformation list-stack-resources --stack-name "$STACK_NAME" --output json \
>   | python3 -c 'import json,sys; print([r["PhysicalResourceId"] for r in json.load(sys.stdin)["StackResourceSummaries"] if "TaskOrchestrator" in r["LogicalResourceId"] and r["ResourceType"]=="AWS::Lambda::Function"])'
> ```

**The new `agentPlatformConfig` env vars are present, 11 of 13.** All seven
`agentPlatformConfig` fields and the four inherited ones are set on the
orchestrator:

| `platform_config` key | Orchestrator env var | Present |
|---|---|---|
| `task_table_name` | `TASK_TABLE_NAME` | ✓ |
| `task_events_table_name` | `TASK_EVENTS_TABLE_NAME` | ✓ |
| `github_token_secret_arn` | `GITHUB_TOKEN_SECRET_ARN` | ✓ |
| `agent_session_role_arn` | `AGENT_SESSION_ROLE_ARN` | ✓ |
| `task_approvals_table_name` | `TASK_APPROVALS_TABLE_NAME` | ✓ |
| `nudges_table_name` | `NUDGES_TABLE_NAME` | ✓ |
| `log_group_name` | `LOG_GROUP_NAME` | ✓ |
| `artifacts_bucket_name` | `ARTIFACTS_BUCKET_NAME` | ✓ |
| `trace_artifacts_bucket_name` | `TRACE_ARTIFACTS_BUCKET_NAME` | ✓ |
| `aws_sdk_ua_app_id` | `AWS_SDK_UA_APP_ID` | ✓ (`uksb-wt64nei4u6#backgroundagent-dev`) |
| `anthropic_default_haiku_model` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` | ✓ (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) |
| `linear_oauth_secret_arn` | `LINEAR_OAUTH_SECRET_ARN` | no (per-workspace, created by the CLI, correctly absent) |
| `jira_oauth_secret_arn` | `JIRA_OAUTH_SECRET_ARN` | no (same) |

The two absent keys are **not** in the contract's `required` list, so the
producer's handling of optional keys is exercised and correct.

*Incidental.* `ARTIFACTS_BUCKET_NAME` and `TRACE_ARTIFACTS_BUCKET_NAME` resolve
to the **same** bucket (`…-traceartifactsbucket8cbd5207-pwjbv0diorys`). This is
not a MicroVM issue, but it deserves a look. When two distinct
`platform_config` keys carry one bucket, traces and artifacts are separate in
name only.

### 1.5 The CDK-managed `CfnMicrovmImage` path — **REFUTED** (P2-F2)

P1 left this question open, and it is now closed. Synth produced the expected
warning (`abca:microvm-image-p1-smoke-unverified`) and the exact L1 under test:

```json
"CpuConfigurations": [{ "Architecture": "arm64" }],
"Hooks": {
  "Port": 8080,
  "MicrovmHooks":      { "Run":   "/aws/lambda-microvms/runtime/v1/run",   "RunTimeoutInSeconds": 60,
                         "Terminate": "/aws/lambda-microvms/runtime/v1/terminate", "TerminateTimeoutInSeconds": 15 },
  "MicrovmImageHooks": { "Ready": "/aws/lambda-microvms/runtime/v1/ready", "ReadyTimeoutInSeconds": 60,
                         "Validate": "/aws/lambda-microvms/runtime/v1/validate", "ValidateTimeoutInSeconds": 60 }
}
```

CloudFormation **rejected the L1 at change-set early validation**. The stack
was never touched, so there was no rollback:

```
Early validation failed for change set cdk-deploy-change-set:
backgroundagent-dev/LambdaMicrovmCompute/Image  (AWS::Lambda::MicrovmImage LambdaMicrovmComputeImage16B48539)
  /aws/lambda-microvms/runtime/v1/run is not a valid enum value. Supported values: [DISABLED, ENABLED] (at
  /Resources/LambdaMicrovmComputeImage16B48539/Properties/Hooks/MicrovmHooks/Run)
  /aws/lambda-microvms/runtime/v1/terminate is not a valid enum value. Supported values: [DISABLED, ENABLED] (at
  /Resources/LambdaMicrovmComputeImage16B48539/Properties/Hooks/MicrovmHooks/Terminate)
  arm64 is not a valid enum value. Supported values: [ARM_64] (at
  /Resources/LambdaMicrovmComputeImage16B48539/Properties/CpuConfigurations/0/Architecture)
  /aws/lambda-microvms/runtime/v1/ready is not a valid enum value. Supported values: [DISABLED, ENABLED] (at
  /Resources/LambdaMicrovmComputeImage16B48539/Properties/Hooks/MicrovmImageHooks/Ready)
  /aws/lambda-microvms/runtime/v1/validate is not a valid enum value. Supported values: [DISABLED, ENABLED] (at
  /Resources/LambdaMicrovmComputeImage16B48539/Properties/Hooks/MicrovmImageHooks/Validate)
```

**CloudFormation rejected five values, and the CFN surface is identical to the
API surface.** This refutes the construct's explicit reasoning: *"The CDK L1 remains
intentionally unchanged because its generated CloudFormation types accept string
values and document no architecture/hook allowed-value constraint"*. The types
accept strings. The **service** enforces the enum, at change-set time.

Two results follow:

- **The `microvmImageHooks` *spelling* is CORRECT.** The errors point at
  `…/Hooks/MicrovmImageHooks/Ready` and `…/Validate`, so CFN resolved the
  property name and its children. Only the *values* are wrong. Together with
  2.1 below, where the API accepted the identical structure, this result
  discharges the naming question in both directions.
- **Hook paths are not configurable anywhere.** Neither CFN nor the API takes a
  path. Both take `ENABLED` or `DISABLED`. The service calls fixed well-known
  routes, and 2.2 proves that they are exactly the `/aws/lambda-microvms/runtime/v1/*`
  strings that the agent serves. So `RUN_HOOK_PATH` and the other hook-path
  constants are correct *as route constants for the agent*, and they must not
  be sent as property values.

### 1.6 Wired deploy (out-of-band image) — PASS

After the image existed (Phase 2), a redeploy with
`--context microvm_image_identifier=<ARN>` completed in **3 min 33 s**
(00:06:00Z to 00:09:33Z) and ended at `UPDATE_COMPLETE`. The warning
`abca:microvm-image-p1-smoke-unverified` was emitted. **All six `MICROVM_*`
vars are present, which confirms all-or-nothing WITH the image:**

```
MICROVM_EGRESS_CONNECTOR_ARNS  = arn:aws:lambda:us-east-1:<account>:network-connector:nc-d306f00f-1bd0-45ea-9457-0fcec0dab2a4
MICROVM_EXECUTION_ROLE_ARN     = arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R
MICROVM_IMAGE_IDENTIFIER       = arn:aws:lambda:us-east-1:<account>:microvm-image:backgroundagent-dev-abca-agent
MICROVM_IMAGE_VERSION          = 1.0
MICROVM_INGRESS_CONNECTOR_ARNS = arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS
MICROVM_PAYLOAD_BUCKET         = backgroundagent-dev-lambdamicrovmcomputepayloadbuc-bctl5ej8aazr
```

**P1 F3 is FIXED.** `MICROVM_IMAGE_IDENTIFIER` is a full ARN, not a bare name.

---

## Phase 2 — Image

### 2.1 `create-microvm-image` — PASS with all four hooks

`package-microvm-artifact.sh` without `--create-image` staged and uploaded the
artifact first. The artifact is **904K, and the S3 object is 922,056 bytes with
SSE `AES256`**. P1's figures were 584K and 597,305 bytes. The difference is the
growth of `server.py` in P2. The script was then run with `--create-image`. It
exited **0**, and the service echoed the request back:

```json
"cpuConfigurations": [{ "architecture": "ARM_64" }],
"resources":         [{ "minimumMemoryInMiB": 8192 }],
"hooks": {
  "port": 8080,
  "microvmHooks":      { "run": "ENABLED", "runTimeoutInSeconds": 60,
                         "terminate": "ENABLED", "terminateTimeoutInSeconds": 15 },
  "microvmImageHooks": { "ready": "ENABLED", "readyTimeoutInSeconds": 60,
                         "validate": "ENABLED", "validateTimeoutInSeconds": 60 }
},
"state": "CREATING", "imageVersion": "1.0",
"imageArn": "arn:aws:lambda:us-east-1:<account>:microvm-image:backgroundagent-dev-abca-agent"
```

**`microvmImageHooks` with `ready` and `validate`, and `microvmHooks` with `run`
and `terminate`, are all ACCEPTED.** P1 could not test this. P1 never got a
four-hook image created (F1), and its attempt with only `/ready` failed the
build.

The script printed its P2 reminder banner both before and after the call.
`8192 MiB` was accepted, so P1 F5's ceiling holds.

### 2.2 Build — PASS in 4 min 35 s, `/ready` **and** `/validate` served

There were again two builds per version (`chipsetGeneration` 3 and 4). Both
were `SUCCESSFUL`. The result was `state=SUCCESSFUL`, `status=ACTIVE`. The
build ran from 00:00:01Z to 00:04:36Z, which is **4 min 35 s** (P1: 5 min 51 s).

The decisive evidence comes from
`/aws/lambda-microvms/backgroundagent-dev-abca-agent`. **P1 F1 blocked this
item entirely:**

```
[server/build-hook] /ready hook: server is up, reporting ready for snapshot
INFO:     127.0.0.1:52856 - "POST /aws/lambda-microvms/runtime/v1/ready HTTP/1.1" 200 OK
[server/build-hook] /validate hook: ok (python=3.13.13, platform_config_keys=13, warnings=0)
INFO:     127.0.0.1:50860 - "POST /aws/lambda-microvms/runtime/v1/validate HTTP/1.1" 200 OK
```

Both lines appear twice, once per chipset. The log proves more than "the hooks
work". The service POSTs to **exactly** the `/aws/lambda-microvms/runtime/v1/*`
paths, which confirms the fixed-route model inferred in 1.5. `/validate`
reports `platform_config_keys=13`, so the cross-package contract loaded inside
the snapshot. `/validate` also reports `warnings=0`, so the baked-secret scan
found nothing.

**P1 F4 is FIXED.** `apt-get` reached `deb.debian.org` over port 80 through the
dedicated build connector. The build log shows
`Get:… http://deb.debian.org/…` succeeding. No temporary security-group rule
was needed this time.

`agent/Dockerfile` now also installs Go tooling. The build log shows
`go: downloading …` completing, so build-time egress is sufficient.

### 2.3 Sizes — P1 F13 reconfirmed and slightly worse

| Field | Bytes | Human | vs P1 |
|---|---|---|---|
| `codeInstallSizeInBytes` | 2,342,203,392 | **2.18 GiB** | 2.17 GiB |
| `memorySnapshotSizeInBytes` | 1,223,421,952 | 1.14 GiB | 1.13 GiB |
| `diskSnapshotSizeInBytes` | 34,959,360 | 33.3 MiB | 35.4 MiB |

`codeInstallSizeInBytes` still **exceeds AgentCore's 2 GB container-image
limit**. The same tree as an OCI image is 1.803 GB, or 631.1 MB compressed
(measured locally). P1 F13's recommendation, "say which measure you mean",
stands. `snapshotBuild` is still returned only by `get-microvm-image-build`,
not on the version.

---

## Phase 3 — Platform user, secret, repo onboarding

### 3.1 Cognito user — PASS, no first-login dance needed

`bgagent admin invite-user <email> --stack-name … --region …`
created the user with a **permanent** password (`UserStatus: CONFIRMED`, not
`FORCE_CHANGE_PASSWORD`). The command wrote the credentials to
`$BGAGENT_CONFIG_DIR/invites/…txt` with mode `0600` and printed a `configure`
bundle. `bgagent configure --stack-name` followed by
`bgagent login --username …` printed `Login successful.` **`admin invite-user`
is the whole first-login flow. That answers "find the exact bgagent
commands".** There is no `RespondToAuthChallenge` step to drive. P1's 7.1
blocker ("user pool has zero users") therefore takes two commands to fix.

### 3.2 GitHub PAT into the stack secret — PASS on the second attempt

The token was piped from `gh auth token` straight into
`aws secretsmanager put-secret-value`. It was **never** written to disk, to a
log, or to this file.

**An operator error is recorded here, because it produced a convincing false
defect.** `gh auth token` emits a trailing newline, and
`--secret-string file:///dev/stdin` stores the newline verbatim, so the secret
was **41 bytes**. My own verification used `.strip()` and reported "length 40",
so it did not show the newline. The task then failed inside the guest with:

```
RuntimeError: clone failed (non-transient): Post "https://api.github.com/graphql": net/http: invalid …
```

The error is an invalid HTTP header value, because the token carried `\n`.
Writing the secret again without the newline (40 bytes, no trailing whitespace)
fixed the clone immediately.

*Verification lesson.* Assert on the **raw** secret, never on a stripped copy:

```bash
aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --output json \
  | python3 -c 'import json,sys; s=json.load(sys.stdin)["SecretString"]; print(len(s), s!=s.strip())'
```

*Minor robustness observation (not a defect found by this run's design).* The
agent passes the secret value to `gh` and `git` unstripped. Any whitespace that an
operator introduces therefore appears as a confusing `net/http` error, not as
"your token looks malformed". A `.strip()` at the token resolver would prevent
a 20-minute misdiagnosis.

### 3.3 Repo onboarding — PASS, gate and probe both behaved

`bgagent repo onboard dreamorosi/batch-sync-triage --compute-type lambda-microvm`:

```json
{ "repo": "dreamorosi/batch-sync-triage", "status": "active",
  "compute_type": "lambda-microvm", "onboarded_at": "2026-08-07T00:10:43.376Z" }
```

Both guards ran as designed and in the documented order. The **ComputeSubstrate
gate** passed because the stack output reads `lambda-microvm`, and the live
**`ListManagedMicrovmImages` availability probe** passed. The command also
printed the two ADR-021 advisory notes, including the smoke-unverified warning.
The warning is correct, and it is still accurate at the end of this run.

`bgagent platform doctor` returned `passed: true` on **all 7 checks**. The
checks include `Managed MicroVM images are available in us-east-1` and, because
3.2 had already run, `GitHubTokenSecretArn contains a token value`. P1 noted
that this check cannot distinguish a real PAT from the 32-char generated
placeholder. That is still true. Here the result happens to be a true positive.

---

## Phase 4 — THE SMOKE

There were five submissions. Each failure moved the point of failure forward,
so all five are recorded.

| # | Task ID | Outcome | Finding |
|---|---|---|---|
| 1 | `01KZCRY70HRBP236GECR768JJX` | `FAILED`. `RunMicrovm … AccessDeniedException … iam:PassRole` | P2-F3 |
| 2 | `01KZCS6451HRPSXAG33Z4R5XRV` | identical, **with an unconditioned `iam:PassRole` attached**, so PassRole was never the real problem | P2-F3 |
| 3 | `01KZCSCD6PKDZNC8WRTFNRQG3H` | identical, 3 min after the IAM change, so **not propagation lag** | P2-F3 |
| 4 | `01KZCSNM8MD4MB17ZTW1VDB6PY` | **`RUNNING`** after removing the execution-role trust condition, then `clone failed … net/http: invalid` | P2-F3 root cause proven. 3.2 token bug |
| 5 | `01KZCSVRHZXVHXQ4T29XYZKBAM` | **`RUNNING` → clone OK → branch OK → `implement` failed at turn 0** | **P2-F5** |
| 5r | `01KZCT8SWZ1DDZC7P0RYS982ES` | identical to #5, **reproducible** | P2-F5 |

### 4.1 P2-F3 — the `iam:PassRole` deny that was really a trust-policy deny

```
Session start failed: Error: MicroVM RunMicrovm failed: AccessDeniedException: User: arn:aws:sts::<account>:assumed-role/backgroundagent-dev-TaskOrchestratorOrchestratorFnS-kyEY8iz3mrcm/backgroundagent-dev-TaskOrchestratorOrchestratorFn-huSs3tbuFbJs is not authorized to perform: iam:PassRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R because no identity-based policy allows the iam:PassRole action
```

The message is misleading, and the diagnosis is the useful part of this
section. The orchestrator's inline policy **does** carry the grant, exactly as
P1 4.4 recorded it:

```json
{ "Sid": "MicrovmPassExecutionRole", "Effect": "Allow", "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R",
  "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } } }
```

The elimination sequence:

1. Attached a **temporary unconditioned** `iam:PassRole` on the same resource.
   The call was **still denied** (submission 2). So the `iam:PassedToService`
   condition was *not* the cause.
2. `aws iam get-role` showed **no permissions boundary** and path `/`.
3. `aws iam simulate-principal-policy … --action-names iam:PassRole` returned
   **`allowed`** and matched my temporary statement. So IAM itself allows the
   action.
4. Waited 3 minutes and resubmitted. The call was **still denied**
   (submission 3). The cause is not propagation.
5. Read the **target** role's trust policy, and found the same
   `aws:SourceAccount` condition that had just broken the network connectors:

```json
{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole",
 "Condition":{"StringEquals":{"aws:SourceAccount":"<account>"}}}
{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:TagSession",
 "Condition":{"StringEquals":{"aws:SourceAccount":"<account>"}}}
```

6. Removed both conditions. **Submission 4 reached `RUNNING` in 6 seconds.**

**So when `RunMicrovm` cannot pass and assume a role, it reports an
`iam:PassRole` identity-policy denial on the *caller*.** P2-F1 and P2-F3 are
therefore **one root cause with two symptoms**. The Lambda MicroVMs service
does not present `aws:SourceAccount` when it assumes ABCA's MicroVM-facing
roles, so the service cannot assume any role whose trust policy carries that
confused-deputy condition.

### 4.2 THE SMOKE (submission 5) — `bgagent watch`, verbatim

```
Watching task 01KZCSVRHZXVHXQ4T29XYZKBAM... (Ctrl+C to stop)
[5:28:03 PM] ★ repo_setup_complete: branch=bgagent/01KZCSVRHZXVHXQ4T29XYZKBAM/add-a-codeowners-file-at-the-repository-root-conta build_before=False
[5:28:04 PM] ★ step:implement:start
[5:28:15 PM] ★ step:implement:failed
[5:28:15 PM] ★ agent_execution_complete: status=error turns=0
Task 01KZCSVRHZXVHXQ4T29XYZKBAM failed. timeout: Build/tests didn't finish in time (timed out) — Workflow run_agent step failed: TimeoutExpired: Command '['claude', '--version']' timed out after 10 seconds
```

**Time-to-RUNNING is ~6 s.** The task was submitted at 00:27:09Z, `started_at`
is `2026-08-07T00:27:11`, and the VM's `startedAt` is 00:27:12Z. That is much
faster than an AgentCore or ECS cold start, and it is the backend's main
advantage. It is the one positive performance result of the run.

**`/run` accepted the envelope, and `platform_config` was installed.** This is
the required observation, from the guest log group:

```
[server/run-pre-config] /run hook received: microvm_id='microvm-8ad29e93-99c2-3ccc-b079-12f8bdab2936' bytes=2120
[server/debug] /run hook installed platform_config env: ['AGENT_SESSION_ROLE_ARN', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ARTIFACTS_BUCKET_NAME', 'AWS_SDK_UA_APP_ID', 'GITHUB_TOKEN_SECRET_ARN', 'LOG_GROUP_NAME', 'NUDGES_TABLE_NAME', 'TASK_APPROVALS_TABLE_NAME', 'TASK_EVENTS_TABLE_NAME', 'TASK_TABLE_NAME', 'TRACE_ARTIFACTS_BUCKET_NAME']
[server/debug] /run hook accepted task_id='01KZCSVRHZXVHXQ4T29XYZKBAM' microvm_id='microvm-8ad29e93-99c2-3ccc-b079-12f8bdab2936'
```

The log confirms everything in the P2 delivery design. The envelope is **2,120
bytes**, so it went **inline** and stayed under the real 4,096-byte cap
(P1 F6). The installed set is **exactly the 11 available keys**, logged as
names only, with no values. The pre-install line goes to stdout only
(`run-pre-config`), and the post-install line is the first to reach CloudWatch,
as the snapshot-credential-hygiene work intended.

**Progress events streamed.** `repo_setup_complete`, `step:implement:start`,
`step:implement:failed` and `agent_execution_complete` all arrived live in
`watch`.

**The path from clone through change to PR got exactly one step.** The clone
succeeded, the branch was created, and `build_before=False` was reported. Then
`implement` failed at turn 0. **There was no commit, no push and no PR.**

**Heartbeats were NOT observed.** `agent_heartbeat_at` was `None` at every poll
across all six submissions. The task was `RUNNING` for only ~12 s, and the
agent updates the heartbeat every 45 s, so the heartbeat had no time to fire.
**The dual-signal liveness path is therefore NOT discharged.** See Skipped.

### 4.3 P2-F5 — `claude --version` times out in the guest

```
[00:28:04] AGENT claude-agent-sdk version: 0.2.110
[00:28:15] ERROR step 'implement' handler raised: TimeoutExpired: Command '['claude', '--version']' timed out after 10 seconds
[00:28:15] WORKFLOW step 'implement' failed (on_failure=fail) — workflow FAILED
```

`METRICS_REPORT`: `"turns": 0, "duration_s": 12.7, "code_changed": null,
"pr_url": null, "memory_written": true`.

The probe is `agent/src/runner.py:476`:

```python
["claude", "--version"], capture_output=True, text=True, timeout=10
```

These observations separate "broken binary" from "slow substrate":

- **In the identical image, run locally under finch, `claude --version` returns `2.1.191
  (Claude Code)` in under 1 second.** So the binary, its symlink and `PATH` are
  all fine.
- `/usr/bin/claude` points to
  `../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
  a **236,305,136-byte (225 MiB) statically-linked ELF**.
- The MicroVM had been restored from a snapshot ~50 s earlier and had already
  done a full `git clone` over the network.

The reading consistent with all three is **lazy snapshot hydration**. The
binary was never touched before the snapshot was taken. Its first `exec` must
therefore fault the pages of a 225 MiB file in from lazily-restored storage,
and that takes more than 10 s. There are two independent fixes. The second is
the more interesting one, because P2 already built the mechanism and then chose
not to use it:

1. Raise the `timeout=10`, or make it backend-aware. The probe is a *liveness
   probe for a version string*, so a tight bound gains nothing.
2. **Warm `claude` in the `/ready` build hook so that the binary is in the
   memory snapshot.** P2's `/ready` does the minimum on purpose and reports `"server is up,
   reporting ready for snapshot"`. Its own docstring explains that
   `/ready` exists so "the snapshot is taken with a warm server". The
   snapshot is warm for *uvicorn* and cold for the 225 MiB binary that does all
   the work.

**`build_passed: true, lint_passed: false`** in the same report is incidental.
It comes from the scratch repo (`mise ERROR no tasks defined …`, `unknown command:
lint`) and is unrelated to the substrate.

### 4.4 P2-F4 — the execution role cannot write to the application log group

This defect was found while reading logs for F5, and it is independent of F5.
The agent writes structured log lines to the log group that `platform_config`
itself delivers, and every one of those writes is denied:

```
[server/debug/self] CloudWatch write failed: AccessDeniedException: … User: arn:aws:sts::<account>:assumed-role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R/Lambda-microvmsExecutor-86cfecce-… is not authorized to perform: logs:CreateLogStream on resource: arn:aws:logs:us-east-1:<account>:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev:log-stream:server_debug/01KZCSVRHZXVHXQ4T29XYZKBAM because no identity-based policy allows the logs:CreateLogStream action
```

The `metrics/<task_id>` stream gets the same denial, so `METRICS_REPORT` is
never written either. P2 wired `log_group_name` into `platform_config`, so the
agent *attempts* the write. But the execution role's logs grant is scoped to
`/aws/lambda-microvms/*` only. The construct's own cdk-nag suppression says so:
*"the `MICROVM_LOG_GROUP_PREFIX/*` namespace"*.

The defect is not fatal. The agent falls back to stdout, and the MicroVM log
group captures stdout. That fallback is the reason this run could be debugged
at all. But the defect is a real gap in smoke parity. On `lambda-microvm`, the
platform's canonical per-task observability streams are empty, and anything
that reads those streams and not the guest's stdout sees nothing. P2 added this
class of grant for Bedrock, Secrets Manager and Memory, and missed this one.

---

## Phase 5 — Post-smoke verification

### 5.1 Finalization called `TerminateMicrovm` — PASS

`get-microvm` on the smoke VM:

```
microvmId  = microvm-8ad29e93-99c2-3ccc-b079-12f8bdab2936
state      = TERMINATED
stateReason= Success.
startedAt  = 2026-08-06T17:27:12.144000-07:00
```

The in-guest log record was written, and the hook returned 200 OK:

```
[server/debug] /terminate hook: {"active_pipeline_threads": 0, "background_pipeline_failed": false, "event": "microvm_terminate", "microvm_id": "", "timestamp": "2026-08-07T00:28:42.926428+00:00"}
INFO:     127.0.0.1:37364 - "POST /aws/lambda-microvms/runtime/v1/terminate HTTP/1.1" 200 OK
```

So `/terminate` is served, returns 200, reports a clean pipeline state, and does
not write terminal task status. **Note `"microvm_id": ""`.** The `microvmId` in
the hook body arrives empty, unlike in `/run`, where it is populated. The
effect is cosmetic, but it defeats the hook's stated purpose of joining the
guest record to the control-plane record. The `/run` line has to carry that
correlation instead, and it does.

**P1 F8 is reconfirmed.** The VM stayed at `TERMINATED` for the whole
observation window, and `ResourceNotFoundException` never arrived. `TERMINATED`
must map to completed in its own right.

### 5.2 `NO_INGRESS` — DISCHARGED

```
ingressNetworkConnectors = ['arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS']
egressNetworkConnectors  = ['arn:aws:lambda:us-east-1:<account>:network-connector:nc-d306f00f-1bd0-45ea-9457-0fcec0dab2a4']
```

The ARN that P2 injects is **correct and effective**. The service accepted it,
and `HTTP_INGRESS` (P1 F7's unrequested default public ingress) is **gone**.
P1's security finding is mitigated.

**One caveat applies to later work.** A `NO_INGRESS` VM **still returns a public
endpoint hostname** (`<vm-id>.lambda-microvm.us-east-1.on.aws`).
So the presence of an `endpoint` in a `RunMicrovm` response is *not* evidence of
reachability, and any doc or alarm that treats "endpoint exists" as "ingress is
open" will be wrong in both directions.

### 5.3 Dual-signal liveness — NOT DISCHARGED

`agent_heartbeat_at` stayed `None` throughout. The heartbeat interval is 45 s,
and no task was `RUNNING` for more than ~13 s, because F5 fails every task at
turn 0. **This item is blocked behind P2-F5 and cannot be tested
independently.** The `heartbeatLivenessApplies` switch is `RUNNING`-scoped, and
no `RUNNING` window was long enough to exercise it.

---

## Phase 6 — Lifecycle extras

### 6.1 A run-hook 4xx **self-terminates** the VM — supersedes P1 F9

A second MicroVM was launched from the image with **no** `runHookPayload` (the
image has `run: ENABLED`). The result is one that P1 could not see, because the
only image that P1 could create had no hooks:

```
state       = TERMINATED
stateReason = Run lifecycle hook returned HTTP status 400. Please check your hook endpoint and application logs for more details.
```

The VM was terminal within ~12 s of launch, and `suspend-microvm` then refused,
as it should:
`The MicroVM … has been terminated and its state cannot be changed.`

**P1 F9 said "hook-less MicroVMs run indefinitely and bill", and warned that
nothing cleans up after itself.** With `/run` ENABLED that is no longer true.
**The service terminates a VM whose run hook returns 4xx.** That lowers the
cost risk and is a direct benefit of declaring hooks. An active
`TerminateMicrovm` remains correct for the *success* path, but on the *failure*
path the service now also terminates the VM.

An incidental result confirms that `executionRoleArn` must be a **full ARN**.
A bare role name is rejected with
`Member must satisfy regular expression pattern: arn:aws[a-z\-]*:iam::[0-9]{12}:role/?…`.

### 6.2 Suspend / resume on a hook-ENABLED image — PASS

To get a VM that stays `RUNNING`, a **valid envelope built by hand** was passed
as `runHookPayload`. The envelope is 713 bytes: `agent_payload` with
`task_id`, `repo_url`, `task_description` and `resolved_workflow`, plus the
four required `platform_config` keys. `/run` returned 200 and the VM stayed
`RUNNING`. That is a result in itself. **The documented envelope shape can be
reproduced by hand from the contract alone.**

| Step | Latency | State | Notes |
|---|---|---|---|
| launch → `RUNNING` | ~11 s | `RUNNING`, `stateReason` `None` | |
| `suspend-microvm` | **~2 s** | `SUSPENDED` | `/suspend` hook **DISABLED** in the image |
| `resume-microvm` | **~3 s** | `RUNNING` | `/resume` hook **DISABLED** |
| `terminate-microvm` | **~3 s** | `TERMINATED`, `stateReason` `Success.` | `/terminate` hook fired, 200 OK |

`microvmId` **and** `endpoint`
(`<vm-id>.lambda-microvm.us-east-1.on.aws`) were
**byte-identical** before and after the suspend and resume cycle. `startedAt`
and `maximumDurationInSeconds` (28800) never changed.

**This extends P1 5.3 and 5.6 to a hook-enabled image.** Suspend and resume
work *without* `/suspend` and `/resume` being declared, so P3's interface
widening does not depend on the hooks. A stored `SessionHandle` survives a
cycle here too. `SUSPENDING` was again never observable.

### 6.3 Quota — re-probed, still NOT OBSERVABLE

`L-CD1C0CC4` "Max allocated MicroVM memory" = **1024 Gigabytes**, and its
`UsageMetric` = **`null`**. `AWS/Usage` still exposes **only** `CallCount` per
API name (`GetMicrovm`, `CreateMicrovmImage`, `ListMicrovmImages`, …), and **no
namespace has a memory metric**. **P1 5.5's verdict is unchanged. The claim "a
suspended VM still holds account memory quota" remains NOT OBSERVABLE SAFELY and
undischarged.** Proving the claim would still need ~128 concurrent 8 GiB VMs.

---

## Phase 7 — Scratch repo

**There is nothing to clean up, and no PR to leave open.**
`dreamorosi/batch-sync-triage` is byte-for-byte as it was found:

- Branches: `main` and the five pre-existing `dependabot/*` branches. **No
  `bgagent/*` branch was ever pushed.** The agent created the branch locally in
  the guest and failed at `implement` before any commit or push.
- PRs: the same five open dependabot PRs (#1–#5) from 2025-11-24. **No PR was
  created by this run.**

So the instruction to leave the CODEOWNERS PR open does not apply. **P2-F5
prevented any PR from existing.** That absence is the single most important line
in this document.

---

## Phase 8 — Teardown (executed as a finally-block)

### 8.1 MicroVMs — all TERMINATED

Nine MicroVMs existed across the run: six from the six task submissions, the
two Phase 6 lifecycle VMs, and one from an orchestrator retry. **All nine were
already `TERMINATED`** at teardown. Each one was finalized by the orchestrator's
`TerminateMicrovm`, terminated by the service after a run-hook 4xx (6.1), or
terminated explicitly in 6.2. No VM had to be tracked down, and none approached
the 8 h bound.

### 8.2 Image and versions — deleted

Only one version existed (`1.0`, `ACTIVE`), so `delete-microvm-image` alone was
sufficient and deleted the version too. `list-microvm-images` returned
`{"items": []}`, and `get-microvm-image` returned
`ResourceNotFoundException: MicroVMImage not found for MicroVMImageID: …`.
P1's ordering correction (delete all but the last version, then the image) was
therefore not exercised, but nothing contradicts it.

*Incidental.* One `ListMicrovmImages` call returned `502 Bad Gateway (reached max
retries: 2)` while the image was `DELETING`. The call succeeded 30 s later.
Retry this error, and do not treat it as a failure.

### 8.3 Live IAM workarounds — reverted

- The temporary unconditioned `iam:PassRole` inline policy
  (`abca645p2-verification-passrole`) was **deleted** from the orchestrator
  role.
- The execution role's trust policy was **restored** to its deployed form, with
  both `aws:SourceAccount` conditions back (verified by reading the policy
  again). The defect is left exactly as the branch produces it.

### 8.4 Cognito user — deleted

`bgagent admin delete-user <email>` printed
`✓ Deleted Cognito user`. `list-users` then returned an **empty** list. The
local invite file that held the user's password was `rm`'d. The GitHub-token
secret was left to be deleted with the stack, and it was.

### 8.5 Stack — DELETE_FAILED, 96/100 deleted, identical to P1's residual

There were three delete attempts, and each failed differently. That progression
is itself the finding:

| Attempt | Duration | Outcome |
|---|---|---|
| 1 | 00:55:35Z → 01:04:28Z (8 min 53 s) | `DELETE_FAILED`. `AWS::BedrockAgentCore::Runtime`: `"Request timed out while deleting AWS::BedrockAgentCore::Runtime"`, `HandlerErrorCode: NotStabilized` |
| 2 (the briefed retry) | 01:04:55Z → 01:06:00Z (1 min) | `DELETE_FAILED`. Same resource, **different error**: `"Access denied for operation 'AWS::BedrockAgentCore::Runtime'."`, `HandlerErrorCode: AccessDenied` |
| 3 (informed) | 01:07:02Z → 01:24:47Z (17 min 45 s) | `DELETE_FAILED`, but the Runtime, Memory and both IAM roles **did** delete. Only the VPC set remains |

Attempt 3 was not a blind third retry. Between attempts,
`bedrock-agentcore-control list-agent-runtimes` returned an **empty** list.
That proves the runtime was already gone on the server side, and that the
failures were an artifact of handler stabilization and authorization, not a
real leftover. Acting on that evidence took the residual from 7 resources to 4.

**The final residual is 4 resources, all zero-cost, exactly P1's set:**

```
CREATE_COMPLETE  AWS::EC2::VPC            vpc-072fddf653ccdcfc4
DELETE_FAILED    AWS::EC2::Subnet         subnet-0e6a6a0ed18100c8a
DELETE_FAILED    AWS::EC2::Subnet         subnet-02d91450e51cf72a0
DELETE_FAILED    AWS::EC2::SecurityGroup  sg-00997a58c1f4c5775
```

```
resource sg-00997a58c1f4c5775 has a dependent object (Service: Ec2, Status Code: 400 …)
Resource handler returned message: "The subnet 'subnet-0e6a6a0ed18100c8a' has dependencies and cannot be deleted. (Service: Ec2, Status Code: 400 …)" HandlerErrorCode: InvalidRequest
```

The cause is the same two AgentCore-managed ENIs, which are still `in-use`:
`eni-04911e11e08d670f9` and `eni-04a1c5a27966ee08b`, both
`InterfaceType: agentic_ai`. **This is #702 and P1 F12, reproduced exactly.**
Nothing was force-deleted outside CloudFormation. P1's experience says these
are eventually released (P1's stack is gone now, see 0.1), so the retry command
is:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev
aws cloudformation wait stack-delete-complete --stack-name backgroundagent-dev
```

### 8.6 Billing confirmed stopped

| Check | Result |
|---|---|
| NAT gateways in the ABCA VPC | **none** (the 2 `available` ones belong to the pre-existing `vpc-01c9984d163d2965e` and were not touched, same as P1) |
| VPC endpoints in the ABCA VPC | **none** |
| ABCA S3 buckets | **none** |
| Unattached (billable) EIPs | **none** |
| MicroVM images / non-terminated VMs | **none** |
| AgentCore runtimes / memories | **none** |
| `/aws/lambda-microvms/*` log groups | **none** |

### 8.7 Environment restored — nothing global left modified

- `cdk/cdk.context.json` was **restored** to the original six-AZ list. The file
  is a gitignored build artifact, and `git status` shows only
  `docs/verification/` and the pre-existing `opencode.json`.
- `~/.finch/config.json` was **restored** to `credsStore: osxkeychain` with
  **no stored credential**, and the Lima VM's `DOCKER_CONFIG` was restored to
  `{"credsStore":"finchhost"}`. The `/root/.docker/config.json` written during
  the push investigation was removed. **The short-lived ECR token written during
  that investigation is no longer on disk anywhere.**
- The ECR tag this run added (`34fbc1d4…`) was removed with
  `batch-delete-image`. The three pre-existing tags and the underlying manifest
  are exactly as found.
- The finch VM was stopped, as in P1.
- **No AWS global configuration was read or modified at any point**
  (`~/.aws/config` and `~/.aws/credentials` are untouched), and `~/.cdk.json`
  was never created. Credentials and the Region were selected only through
  environment variables in the run's own shell.

### 8.8 Deliberately retained

1. **`CDKToolkit`.** `UPDATE_COMPLETE`, `ComputeTypes = agentcore,lambda-microvm`,
   `BootstrapVariant = ABCA: Least-Privilege Bootstrap`, five ABCA policies, no
   `AdministratorAccess`. This run did not change it. ⚠️ The shared-account
   caveat that P1 raised still applies. Other CDK apps in `<account>` deploy
   through the ABCA-scoped execution role.
2. **`backgroundagent-dev` in `DELETE_FAILED`.** The 4 zero-cost resources in
   8.5.
3. **Bootstrap S3 and ECR assets.** Normal bootstrap content, including the
   three pre-existing agent container images.
4. **Service-vended log groups** created outside CloudFormation
   (`/aws/bedrock-agentcore/runtimes/…`, `/aws/lambda/backgroundagent-dev-…`).
5. **`dreamorosi/batch-sync-triage`.** Untouched (Phase 7).

### 8.9 Scratch repo — verified unchanged

Branches: `main` and the five pre-existing `dependabot/*` branches. Open
PRs: #1–#5, all dependabot. **There is no `bgagent/*` branch and no smoke PR.**
There was nothing to close and nothing to delete. Because of P2-F5, there was
also nothing to leave open for the operator to look at.

---

## Findings summary

Live run 2026-08-06/07, account `<account>`, `us-east-1`, branch
`feat/645-lambda-microvm-p2` @ `3a4b61a9`. Evidence:
`/tmp/abca-645-p2-20260806`.

**Verdict on Stage D's primary objective. The smoke did NOT pass. No pull
request was created.** The run reached
`clone ✓ → branch ✓ → implement ✗ (turn 0)`, reproducibly, and it took four
separate live workarounds to get that far. None of the five defects below is
visible to synth, unit tests or `cdk-nag`. All five are mismatches with the
contract of the live service, and finding such mismatches is the purpose of
Stage D.

### Items DISCHARGED (behaved as designed)

1. **`microvmImageHooks` spelling, both directions.** The API accepted
   `microvmImageHooks:{ready,validate}` and `microvmHooks:{run,terminate}` with
   timeouts, and CloudFormation resolved the identical property path
   (`…/Hooks/MicrovmImageHooks/Ready`). The open P2 item is closed.
2. **All four hooks are served and exercised.** `/ready` returned 200 and
   `/validate` returned 200
   (`python=3.13.13, platform_config_keys=13, warnings=0`) during the build, on
   both chipsets. `/run` returned 200 with the envelope. `/terminate` returned
   200 at teardown. **P1 F1, "a P1 image that declares `/run` is not creatable
   at all", is fully fixed.**
3. **`NO_INGRESS` ARN.** The ARN is correct and accepted, and it suppresses
   P1 F7's default public `HTTP_INGRESS`. As a caveat, a public endpoint
   hostname is still returned.
4. **`platform_config` delivery end to end.** The 2,120-byte envelope went
   inline under the real 4,096-byte cap. Exactly the 11 available keys were
   installed. Logging shows names only, and pre-install logging goes to stdout
   only, as designed.
5. **Image buildability.** The build took 4 min 35 s, with two builds per
   version, and the image is `ACTIVE`. 8192 MiB was accepted. `apt-get` and Go
   egress worked over port 80 through the dedicated build connector. **P1 F4
   (443-only SG) and F5 (32 GiB memory) are fixed.**
6. **`MICROVM_IMAGE_IDENTIFIER` is a full ARN, so P1 F3 is fixed.** All six
   `MICROVM_*` vars appear together (all-or-nothing, both directions).
7. **`agentPlatformConfig` wiring.** 11 of 13 keys are on the orchestrator. The
   two absent keys are optional per-workspace secrets, so the optional-key path
   is also verified.
8. **CLI end to end.** `admin invite-user` (permanent password, so no first-login
   challenge to drive), `configure --stack-name`, `login`, `repo onboard
   --compute-type lambda-microvm` (the ComputeSubstrate gate **and** the live
   `ListManagedMicrovmImages` probe both pass), `platform doctor` 7/7,
   `submit`, and `watch` streaming progress events.
9. **Finalization terminates the VM** (`TERMINATED`, `stateReason: Success.`).
10. **Suspend and resume on a hook-enabled image** with `/suspend` and `/resume`
    undeclared. Suspend took ~2 s and resume ~3 s, and `microvmId` **and**
    `endpoint` were preserved.
11. **Time-to-RUNNING ≈ 6 s.** The backend's main advantage is now measured.
12. **The stack half of P1 F12 is resolved.** The leaked AgentCore ENIs were
    eventually released, and P1's `DELETE_FAILED` stack is gone.

### Items CONTRADICTING design assumptions — `feeds-back-to-design: YES`

**P2-F1 and P2-F3 (ONE root cause, two symptoms, both blocking). The
`aws:SourceAccount` confused-deputy condition makes ABCA's MicroVM-facing roles
unassumable by the Lambda MicroVMs service.**

*Symptom A. The substrate cannot deploy.* Both `AWS::Lambda::NetworkConnector`
resources go to `CREATE_FAILED`, deterministically, on a freshly deleted stack:

```
"The service is unable to assume the provided NetworkConnectorOperatorRole. Please verify the trust policy on the role. (Service: Lambda, Status Code: 400, Request ID: dbe1d2f4-dd0c-4319-8f5d-b4be4f076843)" HandlerErrorCode: InvalidRequest
```

When the condition is removed from the trust policy of `ConnectorOperatorRole`,
both connectors are created within a second. This is a **regression introduced
by the P1 F2 fix**. P1's validated probe role trusted `lambda.amazonaws.com`
with **no conditions**. The construct's comment says trust "mirrors the
build/execution roles (`lambda.amazonaws.com` + `aws:SourceAccount`)", and that
mirroring is what breaks the role.

*Symptom B. No task can start.* `RunMicrovm` fails with a misleading
`iam:PassRole` denial **on the caller**. The denial occurs although the
orchestrator's grant is present, `simulate-principal-policy` returns `allowed`,
and there is no permissions boundary. The cause was proven by elimination: an
unconditioned `iam:PassRole` was still denied, and a 3-minute wait was still
denied. After the **execution role's** trust conditions were removed, the next
submission reached `RUNNING` in 6 s.

Both the build role and the execution role carry the same pattern, so the fix is
one decision applied consistently. **Drop `aws:SourceAccount` from the trust
policy of every MicroVM-facing role, or find the condition key that the service
does present.** `aws:SourceArn` and `aws:SourceAccount` are not populated on
this path. The *identity-side* `iam:PassedToService: lambda.amazonaws.com`
condition on the orchestrator was never shown to be wrong. Step 1 exonerated
it, and it can stay.

**P2-F2. CloudFormation rejects the `CfnMicrovmImage` L1 on five values, so the
CDK-managed image path does not work at all.** The verbatim early-validation
output is in 1.5. `arm64` must be `ARM_64`. All four hooks must be `ENABLED` or
`DISABLED`, not paths. This **refutes the construct's stated reasoning** that
the L1 could keep CloudFormation's "path/string shape" because the generated
types "document no architecture/hook allowed-value constraint". The service
enforces the enum at change-set time. There are two consequences. First, the
documented "CDK-managed (recommended)" bootstrap path in
`cdk/scripts/package-microvm-artifact.sh` does not work at present, and the
"out-of-band alternative" is the *only* working path. Second, hook paths are
not configurable in CloudFormation or in the API, so the `*_HOOK_PATH`
constants are agent route constants only and must never be sent as property
values.

**P2-F4. The MicroVM execution role cannot write to the application log group
that `platform_config` tells the agent to use.** `logs:CreateLogStream` is
denied on
`/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev`
for both the `server_debug/<task_id>` and `metrics/<task_id>` streams, because
the role's logs grant is scoped to `/aws/lambda-microvms/*`. P2 delivered
`log_group_name`, so the agent *attempts* the write, but P2 did not add the
matching grant. The P2 grants for Bedrock, Secrets and Memory were added to fix
the same class of omission. The defect is not fatal, because the stdout
fallback is captured in the MicroVM log group. But the canonical per-task
observability streams are empty on this backend, including `METRICS_REPORT`.

**P2-F5. `claude --version` times out after 10 s inside the MicroVM, and every
task fails at turn 0. This is the blocker that prevented the PR.** It was
reproduced on two consecutive submissions:

```
TimeoutExpired: Command '['claude', '--version']' timed out after 10 seconds
```

`agent/src/runner.py:476` uses `timeout=10`. The binary works. In the identical
image, run locally, it answers `2.1.191 (Claude Code)` in **under 1 s**. The
binary is a **225 MiB (236,305,136-byte) statically-linked ELF** whose pages
were never touched before the snapshot was taken, and it was exec'd on a guest
restored ~50 s earlier. Those facts are consistent with lazy snapshot
hydration. There are two fixes. The first is to raise the timeout or make it
backend-aware, because a version-string probe gains nothing from a tight bound.
The second, more interesting fix is to **warm `claude` in the `/ready` build
hook**. That hook exists so that "the snapshot is taken with a warm server",
but at present it warms only uvicorn and leaves the 225 MiB binary that does
all the work cold.

**P2-F6. P1 F9 is superseded, in the safe direction.** With `run: ENABLED`, a
run-hook 4xx makes the **service** terminate the VM
(`stateReason: "Run lifecycle hook returned HTTP status 400."`) within ~12 s. P1's
"hook-less MicroVMs run indefinitely and bill; nothing self-cleans" no longer
describes this image. ADR-021 should be corrected, because the result changes
the cost-risk argument for the failure path.

**P2-F7. Template size is at 98.4 % of the CloudFormation 1 MB limit**
(983,796/1,000,000), with 486/500 resources, when the image is configured. That
leaves ~16 KB of headroom, roughly one more construct before deploys start to
fail for reasons unrelated to MicroVMs.

**P2-F8. Runbook and tooling corrections (lower severity, but each would
corrupt a future pass).**

- **P1 F14's `--no-paginate` remedy is wrong and truncates without an error.**
  At 485 resources it returns only the first page. `ORCHESTRATOR_FN` then
  resolved to the literal `None`, and the lookup produced
  `Function not found: …:function:None`. Let the CLI paginate, and filter
  client-side.
- **The "recurs forever" half of P1 F10 is wrong.** `BootstrapVariant` now
  reads `ABCA: Least-Privilege Bootstrap`, because P1's own
  `update-stack --use-previous-template` with only `ComputeTypes` supplied resets
  unspecified parameters to template defaults. The half about the silent
  `exit 0` stands.
- **`--execution-role-arn` requires a full ARN** (regex in 6.1). A bare role
  name is rejected.
- **`zsh`.** `"$VAR:latest"` is the `${VAR:l}` lowercase modifier, and that
  parse cost one mis-diagnosed push. zsh has no `PIPESTATUS` (the zsh variable
  is `$pipestatus`, 1-indexed), so P1's `test "${PIPESTATUS[0]}" -eq 0`
  evaluates to empty without an error. zsh has no `timeout(1)`.
- **Verify secrets on the raw value, never a `.strip()`ed copy.** A trailing
  newline from `gh auth token` produced a convincing false clone defect (3.2).
- **`finch` cannot push to ECR on this box.** `finch push` runs
  `limactl shell finch sudo -E nerdctl push`, and the VM's `DOCKER_CONFIG` uses
  the `finchhost` creds helper, which cannot resolve an Isengard
  `credential_process`. A host-side `finch login` does not help. Both `push`
  and `pull` fail with `no basic auth credentials`.
- The `/terminate` hook body's **`microvmId` arrives empty** (`"microvm_id": ""`).
  That defeats the hook's stated purpose of correlating the guest with the
  control plane.
- **`ARTIFACTS_BUCKET_NAME` and `TRACE_ARTIFACTS_BUCKET_NAME` resolve to the same
  bucket**, so that separation exists in name only.

### Items SKIPPED, BLOCKED, or INCONCLUSIVE

| Item | Verdict | Reason |
|---|---|---|
| **clone → change → PR (the point of Stage D)** | **FAILED, no PR** | P2-F5, reproduced twice. Stopped at two retries as briefed. |
| Dual-signal liveness, `agent_heartbeat_at` fresh during RUN | **BLOCKED behind P2-F5** | Heartbeat interval is 45 s, and no task stayed `RUNNING` beyond ~13 s. `agent_heartbeat_at` was `None` on all six submissions. Not independently testable until F5 is fixed. |
| Suspend TTL beyond P1's ≥1 h floor | **SKIPPED (time-boxed)** | Would have added 2 h+ of wall clock for a marginal bound after ~2.5 h already spent on five blocking defects. P1's result stands unchanged: **survives ≥ 1 h 0 min 17 s with no `idlePolicy`**. A TTL between 1 h and the 8 h `maximumDurationInSeconds` bound remains **OPEN**. |
| SUSPENDED VM consumes account memory quota | **STILL NOT OBSERVABLE, undischarged** | Re-probed. `L-CD1C0CC4` = 1024 GB with `UsageMetric: null`. `AWS/Usage` has only `CallCount`. No memory metric in any namespace. Identical to P1 5.5. |
| CDK-managed `CfnMicrovmImage` deploy | **REFUTED (P2-F2)** | Fell back to the out-of-band script path, as the brief directed. |
| AgentCore container asset push | **WORKED AROUND** | finch and ECR auth (deviation 2). ECR manifest retagged, which does not affect the MicroVM image under test. |
| P1 F11 (AgentCore-unsupported AZ) | **STILL UNFIXED** | `agent-vpc.ts` unchanged. Worked around via the gitignored AZ context cache, restored at teardown. |
| P1 F12 Memory-delete half | **STILL UNFIXED** | `AWS::BedrockAgentCore::Memory` still undeletable while `CREATING`. It still turns a rollback into `ROLLBACK_FAILED`. Plain `delete-stack` still clears it. |
| Orchestrator-role IAM negatives | **NOT ATTEMPTED** | P1 5.0 established that the Lambda trust does not allow operator assumption. Trust was not modified for this purpose. |

### Elapsed and approximate cost

**Elapsed.** 22:38Z to 01:26Z ≈ **2 h 48 min**. A rough breakdown: ~35 min on
the failed finch push to ECR and the ECR-retag workaround, ~40 min on the five
deploy attempts plus two cycles of `ROLLBACK_FAILED` and `delete-stack`, ~10 min on
image create and build, ~35 min on the six submissions and the P2-F3
elimination sequence, ~10 min on lifecycle extras, ~30 min on teardown (three
delete attempts), and the remainder on evidence capture and this document.

**Approximate cost: well under US$5.** As in P1, NAT and VPC-endpoint hours
dominate the cost, not MicroVMs.

| Item | Quantity | Est. |
|---|---|---|
| NAT gateway (1 × $0.045/h) | ~1.6 h across 3 stack lifetimes | ~$0.08 |
| Interface VPC endpoints (7 × $0.01/h × 2 AZ) | ~1.6 h | ~$0.22 |
| MicroVM runtime | 9 VMs, all short-lived (~12 s to ~3 min each). Longest suspended window ~1 min | < $0.10 |
| MicroVM image builds | 2 builds (1 version × 2 chipsets), ~4.5 min each | low single-digit cents |
| Snapshot/image storage | ~3.6 GiB × ~1 h | negligible |
| AgentCore runtime + Memory | created 3×, **never invoked** | negligible |
| Bedrock | **zero model tokens**, because every task failed before turn 1 | $0 |
| S3 / DynamoDB / Lambda / API GW / Cognito / Secrets / logs | brief, mostly idle | < $1 |

No VM approached the 8 h `maximumDurationInSeconds`. Every VM was either
terminated explicitly or terminated by the service.

### Recommended follow-up before P2 is called complete

The order follows what unblocks what:

1. **P2-F1/F3** (`aws:SourceAccount` on MicroVM-facing role trust). Nothing
   deploys or runs without this fix. It is one decision for three roles.
2. **P2-F5** (`claude --version` timeout). Nothing *completes* without this
   fix. It is the only thing between this run and a PR. Consider the option of
   warming in `/ready` on its merits, and not only a higher timeout.
3. **P2-F2** (L1 enum values). The documented recommended path does not work
   until this is fixed. The fix is five one-word changes plus the tests that
   assert the old strings.
4. **P2-F4** (application-log-group grant). The fix is cheap, and with it the
   next failure can be debugged through the platform and not through guest
   stdout.
5. **P2-F7** (template size). It is unrelated to MicroVMs, but the limit will
   be reached soon.
6. Re-run Stage D after items 1 and 2. The dual-signal-liveness item and the
   suspend-TTL extension both need a task that stays `RUNNING` for minutes, and
   only F5's fix provides one.

---

## Stage D-redux (run 2)

This is a narrow re-run on branch `feat/645-lambda-microvm-p2` @
`b927d1d6a58e2b040c2ed4ce4e9f1dc9be9fc981`, the commit that fixed P2-F1..F5
against run 1's evidence. **The purpose is to convert "fixed-against-evidence"
into "re-exercised live", and to get the pull request.**

**Live run.** 2026-08-07 02:58Z to 04:55Z (≈1 h 57 min), account `<account>`,
`us-east-1`. The evidence directory is `/tmp/abca-645-p2r2-20260806`.

**Teardown is complete.** The live IAM workaround is reverted. The Cognito user
is deleted. The image and its version are deleted. The ECR retag is removed,
and the AZ context cache is restored. 481 of 485 stack resources are deleted,
and the 4 that remain cost nothing (#702). All billable resources are confirmed
gone, and no global or host configuration was touched. Both smoke PRs are left
open as briefed. See 2.12.

> **Provenance note. HEAD moved during the run, and the move came from outside
> this run.** Preflight confirmed `HEAD = b927d1d` with a clean tree at 02:58Z.
> At **03:04Z** an unrelated user commit landed on the branch, `045722c fix(deps): refresh
> js-yaml lock entry to 4.3.1`, **`yarn.lock` only, 3 insertions / 3 deletions**.
> This run issued no `git` write command, and `b927d1d` remains an ancestor of
> `HEAD`. **The commit cannot have affected any finding.** Neither
> `mise run install` nor `yarn install` was run again, so `cdk/node_modules`
> still reflected `b927d1d`'s lock for every synth and deploy. The MicroVM
> artifact is built from `agent/`, `contracts/` and `agent/Dockerfile` (Python
> and uv), and the commit touches none of them. Every verdict below is
> therefore against `b927d1d`'s tree.

### 2.0 Headline

> **THE SMOKE PASSED. `https://github.com/dreamorosi/batch-sync-triage/pull/6`**
> The task went from clone through change, commit and push to a PR. It ended
> `COMPLETED` after 12 turns, $0.279 and 153 s. Run 1's single most important
> line ("no PR was created") no longer holds.

But the PR required **one live IAM workaround**, and finding out *why* produced
the run's most consequential result. **P2-F3 is NOT fixed, and run 1's
exoneration of its identity-side condition was a false negative.** Two of the
five P2 fixes are fully discharged, two are discharged, and one is refuted. One
new blocking defect was found on the path that run 1 never reached.

| Fix | Run-1 verdict | Run-2 live verdict |
|---|---|---|
| **P2-F1** (connector trust) | blocking | ✅ **DISCHARGED.** Substrate deployed **first try**, zero workarounds, 0 `CREATE_FAILED` in 485 resources |
| **P2-F2** (`ARM_64`/`ENABLED` enums) | REFUTED at change-set validation | ✅ **DISCHARGED.** Early validation **passed**, resource reached `CREATE_IN_PROGRESS` |
| **P2-F3** (`RunMicrovm` PassRole) | blocking, "trust was the sole cause" | ❌ **NOT FIXED (P2r2-F10).** Isolated to the *identity-side* `iam:PassedToService` condition that run 1 explicitly exonerated |
| **P2-F4** (application-log grant) | blocking observability | ✅ **DISCHARGED.** `server_debug/`, `metrics/` **and** `trajectory/` streams exist, with content |
| **P2-F5** (`claude` warm-up) | **the blocker**, no PR | ✅ **DISCHARGED.** Cold `claude` measured at **17–38 s**, warm **0.1 s**, `/ready` 200, no 503 |
| *(new)* **P2r2-F9** | not reachable in run 1 | ❌ CDK-managed image path blocked: bootstrap `IAMPassRole` denies the build role to CloudFormation |
| *(new)* **P2r2-F11** | mis-attributed in run 1 | ⚠️ `agent_heartbeat_at` is never projected into the API response |
| Dual-signal liveness | BLOCKED behind F5 | ✅ **DISCHARGED.** 45 s cadence observed live over a 181 s `RUNNING` window |

### 2.1 Deltas from run 1's setup

```bash
export SMOKE_USER="<email>"
export EVIDENCE_DIR=/tmp/abca-645-p2r2-20260806
export BGAGENT_CONFIG_DIR=/tmp/abca-645-p2r2-bgagent
```

Everything else carried over unchanged, and all of it still applies: the zsh
traps, `set -o pipefail`, the explicit `AWS_REGION`, and newest-first version
ordering. Two notes from run 1 were useful at once: the **raw-secret
assertion** (2.6) and **client-side pagination** for the `TaskOrchestrator`
lookup.

`bgagent` was invoked as `node cli/lib/bin/bgagent.js` after
`mise //cli:compile` (there is no linked binary in this tree).

### 2.2 Preflight — run 1's residual had to be cleared first, and it did not clear itself

`backgroundagent-dev` was still `DELETE_FAILED` with run 1's exact 4-resource
residual. **The two `agentic_ai` ENIs were still `in-use` 1 h 32 min later**
(`eni-04911e11e08d670f9`, `eni-04a1c5a27966ee08b`, both with requester
`amazon-aws` and `InstanceOwnerId: amazon-aws`). At the same time,
`bedrock-agentcore-control list-agent-runtimes` and `list-memories` both
returned **empty** lists. So the ENIs outlive the resources that created them
by a long time.

Run 1's documented retry command was executed verbatim and **failed again after
17 min 17 s** (02:58:41Z to 03:15:58Z):

```
The following resource(s) failed to delete: [AgentVpcRuntimeSG96507CD0, AgentVpcPrivateSubnet1Subnet8051BB57, AgentVpcPrivateSubnet2SubnetC66971D0].
```

**Correction to the advice in run 1's section 8.5.** Run 1 concluded from P1's
experience that "these are eventually released, so the retry command is
`delete-stack`". That is true over several days and **useless within one
session**. A 17-minute retry that fails in the same way is not a remedy. The
remedy that works is `--retain-resources`, which cleared the stack record in
**33 seconds**:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev \
  --retain-resources AgentVpcA6796801 AgentVpcPrivateSubnet1Subnet8051BB57 \
                     AgentVpcPrivateSubnet2SubnetC66971D0 AgentVpcRuntimeSG96507CD0
```

List the VPC (`CREATE_COMPLETE`, never attempted) together with the three
`DELETE_FAILED` children, or the delete fails on the VPC. The cost is an
orphaned zero-cost VPC, 2 subnets and 1 SG that CloudFormation no longer tracks
(2.12).

*Unchanged from run 1.* `CDKToolkit` `UPDATE_COMPLETE`, `ComputeTypes =
agentcore,lambda-microvm`, `BootstrapVariant = ABCA: Least-Privilege
Bootstrap`, bootstrap SSM version `32`, five ABCA policies, no
`AdministratorAccess`. So **no re-bootstrap was run**. That decision matters
later. See P2r2-F9.

**Managed base image.** There is still exactly one in `us-east-1`,
`arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`, with versions `1`
(newest first) and `0`. The run selected `1`, and the service echoed
`baseImageVersion: "1.0"`.

**P1 F11 is still UNFIXED.** `agent-vpc.ts` still has `maxAzs: 2` with no AZ
constraint, and `us-east-1a` is still `use1-az6`. So the gitignored
`cdk/cdk.context.json` AZ cache was again trimmed to lead with
`us-east-1b` and `us-east-1c`. The original was saved to
`$EVIDENCE_DIR/cdk.context.json.ORIGINAL` and **restored at teardown**.
`git status` stayed clean throughout.

### 2.3 The AgentCore container asset — retag workaround reused, and the tag had moved

`finch` still cannot push to ECR (run 1 deviation 2). The Lima VM's
`credsStore: finchhost` cannot resolve an Isengard `credential_process`. The
required asset tag was **`7a71005f…`, not run 1's `34fbc1d4…`**, because
`agent/src/server.py` grew in `b927d1d`. Run 1's tag had been removed at its
teardown, as it should have been. The same `aws ecr put-image` retag was
applied to the existing manifest `sha256:cdf5436a…`:

```
{"imageDigest": "sha256:cdf5436ab8d9d17bcd5b555ad22c52b4e6d6622f1fc0373cdc97a73c3eb8e6a4",
 "imageTag": "7a71005fe6f520a2741cdd1fb2a47ffa919b13e63476226ec39bc66eb4c150c5"}
```

The same caveat applies, and it is restated here because it is easy to
overlook. **The deployed AgentCore runtime therefore carries a stale agent
image, and nothing in this run depends on that image.** The smoke runs on the
MicroVM substrate built from the S3 zip. The finch VM was never started in this
run, and `~/.finch/config.json` was never touched (verified: it still has
`credsStore: osxkeychain` with no stored credential).

### 2.4 Substrate deploy — P2-F1 DISCHARGED, first try, zero workarounds

Synth emitted `abca:microvm-image-not-provisioned`, and
`…-p1-smoke-unverified` was absent, as it should be. The deploy ran
`03:19:25Z → 03:33:59Z = 14 min 34 s` and ended with **`EXIT=0` on the first
attempt** and 485 resources.

**This is the whole verification of P2-F1, and it is unambiguous.** Run 1 needed
five attempts and a trust-policy patch to a cloud assembly in `/tmp` to get
here. Run 2 needed no retry and no patch:

```
2026-08-07T03:21:47Z LambdaMicrovmComputeEgressConnector9C36AAC2      CREATE_IN_PROGRESS
2026-08-07T03:21:48Z LambdaMicrovmComputeBuildEgressConnector3B762F80 CREATE_IN_PROGRESS
2026-08-07T03:26:05Z LambdaMicrovmComputeEgressConnector9C36AAC2      CREATE_COMPLETE
2026-08-07T03:26:06Z LambdaMicrovmComputeBuildEgressConnector3B762F80 CREATE_COMPLETE
```

A scan of every stack event for `*FAILED` returned **`NONE`**. The live trust
policies on both the execution role and the build role read exactly as the
source intends: `lambda.amazonaws.com`, `sts:AssumeRole` and `sts:TagSession`,
with **no conditions**.

All seven MicroVM outputs are populated. `ComputeSubstrate = lambda-microvm`.
The artifact key is exactly `microvm-images/agent-artifact.zip`.

**P2-F7 is reconfirmed and slightly worse.** The substrate template is
979,867 B with 485 resources. With the image it is **985,886 B with 486
resources**, which is **98.6 %** of the 1 MB limit and leaves ~14 KB of
headroom. Run 1 had ~16 KB.

### 2.5 The CDK-managed image path — P2-F2 DISCHARGED, then blocked by a NEW defect (P2r2-F9)

The synthesized L1 now carries exactly the five values CloudFormation rejected in
run 1:

```json
"CpuConfigurations": [{ "Architecture": "ARM_64" }],
"Hooks": {
  "Port": 8080,
  "MicrovmHooks":      { "Run": "ENABLED", "RunTimeoutInSeconds": 60,
                         "Terminate": "ENABLED", "TerminateTimeoutInSeconds": 15 },
  "MicrovmImageHooks": { "Ready": "ENABLED", "ReadyTimeoutInSeconds": 300,
                         "Validate": "ENABLED", "ValidateTimeoutInSeconds": 60 }
}
```

**P2-F2 is DISCHARGED.** Change-set early validation **passed**, with zero
`not a valid enum value` errors and no `Early validation failed`, and the
resource progressed to `CREATE_IN_PROGRESS`. The refutation in run 1's
section 1.5 is fully answered, and the enum fix is correct for CloudFormation.

The resource then failed on something that run 1 could not have seen, because
run 1 never got past early validation:

```
LambdaMicrovmComputeImage16B48539  CREATE_FAILED
Resource handler returned message: "User: arn:aws:sts::<account>:assumed-role/cdk-hnb659fds-cfn-exec-role-<account>-us-east-1/AWSCloudFormation is not authorized to perform: iam:PassRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeBuildRoleF0-9FxjQbiJC3px because no identity-based policy allows the iam:PassRole action (Service: LambdaMicrovms, Status Code: 403, Request ID: f8c45ab5-49c4-42fd-ac61-a6a3ac00dc26) (SDK Attempt Count: 1)" HandlerErrorCode: AccessDenied
```

The stack ended at `UPDATE_ROLLBACK_COMPLETE`. The substrate was intact (all
seven outputs still populated), so the failure cost one deploy cycle and
nothing else.

**Diagnosis. The cause is NOT a stale bootstrap.** The live
`…IaCRole-ABCA-Infrastructure…` policy is **byte-identical to
`cdk/bootstrap/policies/infrastructure.json` on this branch**, so
`bootstrap --force` would change nothing. Its `IAMPassRole` statement is:

```json
{ "Sid": "IAMPassRole", "Effect": "Allow", "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::*:role/backgroundagent-dev-*",
  "Condition": { "StringEquals": { "iam:PassedToService": [
    "lambda.amazonaws.com", "ecs-tasks.amazonaws.com", "ecs.amazonaws.com",
    "apigateway.amazonaws.com", "logs.amazonaws.com", "bedrock.amazonaws.com",
    "bedrock-agentcore.amazonaws.com", "events.amazonaws.com",
    "vpc-flow-logs.amazonaws.com" ] } } }
```

The resource pattern matches the build role. `simulate-principal-policy` on the
deploy role returns **`allowed`** with
`iam:PassedToService=lambda.amazonaws.com` and **`implicitDeny`** with no
context. So the resource is right, and the *condition* is the only remaining
variable.

**A control confirms the diagnosis.** The out-of-band `--create-image` path
(2.6) passed **the same build role** to the same service successfully, with
operator credentials that carry no such condition. So the build role's trust is
fine, and the service can assume the role. The denial is on the caller's side.

This contradicts the construct's own account, which asserts that `buildRole` is
passed "via the bootstrap `infrastructure` policy's `IAMPassRole`". In the live
service, it is not.

*Incidental.* **CloudTrail has no `lambda-microvms` events at all** for this
run. `lookup-events` across the window returns nothing for `CreateMicrovmImage`
or `RunMicrovm`. The service appears not to emit management events yet. The
actual `iam:PassedToService` value therefore cannot be read from a log, and
every determination in this section had to be made by elimination.

### 2.6 Image + build — P2-F5 DISCHARGED, with numbers

The artifact is **935,874 bytes** with SSE `AES256` (run 1: 922,056).
`--create-image` exited **0**. The service echoed `ARM_64`,
`minimumMemoryInMiB: 8192`, all four hooks `ENABLED`, and
`readyTimeoutInSeconds: 300`.

The build ran `03:42:53Z → 03:47:23Z = 4 min 30 s`. Both chipsets
(`GRAVITON` generation `3` and `4`) were `SUCCESSFUL`. The result was
`state=SUCCESSFUL`, `status=ACTIVE`. **The warm-up cost the build ~22 s** against run 1's
baseline of 4 min 35 s, which had no warm-up in the hook. That is a small cost
for what the warm-up gains.

**The decisive evidence, verbatim** (per build stream):

```
[server/build-hook] /ready hook: server is up, warming the snapshot before it is taken
[server/build-hook] /ready hook: warmed 'claude' in 17.2s (version='2.1.191 (Claude Code)')
[server/build-hook] /ready hook: warmed 'claude' in 37.8s (version='2.1.191 (Claude Code)')
[server/build-hook] /ready hook: warmed 'git' in 0.0s (version='git version 2.47.3')
[server/build-hook] /ready hook: warmed 'claude' in 0.1s (version='2.1.191 (Claude Code)')
[server/build-hook] /ready hook: warmed 'node' in 3.0s (version='v24.19.0')
[server/build-hook] /ready hook: reporting ready for snapshot
INFO:     127.0.0.1:33946 - "POST /aws/lambda-microvms/runtime/v1/ready HTTP/1.1" 200 OK
[server/build-hook] /validate hook: ok (python=3.13.13, platform_config_keys=13, warnings=0)
INFO:     127.0.0.1:53154 - "POST /aws/lambda-microvms/runtime/v1/validate HTTP/1.1" 200 OK
```

**The log proves four independent things, and three of them are new:**

1. **The lazy-hydration diagnosis was correct, and now it is measured.** A cold
   `exec` of the 225 MiB `claude` binary takes **17.1–37.8 s**. Run 1 inferred
   this from a 10 s timeout. Run 2 has the number. **`timeout=10` could never
   have passed.** It was 2–4× too short.
2. **The warm-up works.** The same binary in the same guest answers in
   **0.1 s** once its pages are faulted in. The mechanism does what the
   `/ready` docstring claims.
3. **The service calls `/ready` three times per build, and the first two calls
   run concurrently.** Both concurrent calls warm `claude` at the same time and
   contend (17.2 s and 37.8 s in the same stream). The worst-case single call
   is ≈ 37.8 + 0.0 + 6.4 ≈ **44 s**. So the 120 s required budget carries a
   ~3.2× margin. The move of `readyTimeoutInSeconds` from 60 to 300 was more
   than a precaution, because a 60 s hook budget would have had ~16 s of slack
   against a contended cold start.
4. **No 503 at any point.** The "required warm-up failed" path was never taken,
   and `/validate` still reports `platform_config_keys=13, warnings=0`.

*Not re-captured.* The 2.3 size table (`codeInstallSizeInBytes` and the other
fields) was not captured again, because the image was deleted at teardown
before those fields were read. Run 1's figures stand. This run adds nothing for
or against P1 F13.

**Wired deploy** with `--context microvm_image_identifier=<ARN>`:
`03:48:34Z → 03:53:37Z = 5 min 3 s`, `UPDATE_COMPLETE`.

**`MICROVM_*` is FIVE vars this run, not run 1's six, and that is correct by
design.** `MICROVM_IMAGE_VERSION` is emitted only when the optional
`microvm_image_version` context is supplied (passed from `agent.ts:245` to
`task-orchestrator.ts:467`), and the construct documents the absent state as
"let the service pick". Run 1 recorded six because it supplied the version.
This is not a regression. It is stated here because "all-or-nothing" is
asserted of the `MICROVM_*` block, and the version is the one member that may
legitimately be absent.

`platform_config` wiring is reconfirmed at **11 of 13** keys.
`LINEAR_OAUTH_SECRET_ARN` and `JIRA_OAUTH_SECRET_ARN` are absent, as they
should be.

**P2-F4's grant is present on the live execution role.** The second statement
is new since run 1:

```json
{ "Action": ["logs:CreateLogStream","logs:PutLogEvents"],
  "Resource": "arn:aws:logs:us-east-1:<account>:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev:*",
  "Effect": "Allow" }
```

### 2.7 Platform user, secret, onboarding — all PASS

`admin invite-user` created a `CONFIRMED` user with a permanent password. Then
`configure --stack-name` ran, and `login` printed `Login successful.` This is
exactly run 1's two-command flow.

**The PAT was written correctly this time.** `gh auth token | tr -d '\n\r'` was
piped into `--secret-string file:///dev/stdin`, and the **raw** value was then
asserted, following the lesson of run 1's section 3.2:

```
len 40 differs_from_stripped False prefix gho_
```

Run 1's 41-byte operator error did not recur. `repo onboard
--compute-type lambda-microvm` returned
`status: active`, and both the ComputeSubstrate gate and the live
`ListManagedMicrovmImages` probe passed. `platform doctor` returned **7/7**.

### 2.8 THE SMOKE — five submissions, and the last two are an experiment

| # | Task ID | Orchestrator `iam:PassRole` grant in force | Settle | Outcome |
|---|---|---|---|---|
| 1 | `01KZD5SZ55N707GMWY14P09JGR` | **source only** (exact ARN + `iam:PassedToService`) | ~2.5 min | `FAILED`, PassRole denial |
| 2 | `01KZD61FHYH3QT774PFETDNVKY` | + unconditioned, exact ARN | 20 s | `FAILED`, identical |
| 3 | `01KZD6D95P5VXJTJ06BFJXF8J6` | + unconditioned, `backgroundagent-dev-*` | 3.5 min | ✅ **`RUNNING` in 5 s → `COMPLETED` → PR #6** |
| 4 | `01KZD71DJSTGZK2A91MZJ8GFHJ` | **source only** (workaround removed) | **5 min** | `FAILED`, identical. This is the **control** |
| 5 | `01KZD7D7HD3CT2APBT3DH12XFE` | + unconditioned, **exact ARN** (source's resource) | **5 min** | ✅ **`RUNNING` in 9 s → `COMPLETED` → PR #7** |

**Submissions 4 and 5 are the isolation experiment, and they are the most
important result in this document.** Both used the same exact-ARN resource as
the source and the same 5-minute settle. The one variable was the
`iam:PassedToService: lambda.amazonaws.com` condition. With the condition, the
call was denied. Without it, the task was `RUNNING` in 9 s. See P2r2-F10.

#### 2.8.1 THE SMOKE (submission 3), `bgagent watch`, verbatim highlights

```
[9:07:17 PM] ★ repo_setup_complete: branch=bgagent/01KZD6D95P5VXJTJ06BFJXF8J6/add-a-codeowners-file-at-the-repository-root-conta build_before=False
[9:07:18 PM] ★ step:implement:start
[9:08:14 PM] ★ pre_approvals_loaded {"scopes":[],"count":0}
[9:08:31 PM] Turn #1 (claude-opus-4-8, 0 tool calls)
         Text: This is a simple, well-defined task. Let me create the CODEOWNERS file.
[9:08:37 PM]   ▶ Write: {'file_path': '/workspace/01KZD6D95P5VXJTJ06BFJXF8J6/CODEOWNERS', 'content': '* @dreamorosi\n'}
[9:09:27 PM]   ▶ Bash: git add CODEOWNERS && git commit -m "chore(github): add CODEOWNERS file" && git push -u origin bgagent/…
[9:09:43 PM]   ▶ Bash: gh pr create --repo dreamorosi/batch-sync-triage --head bgagent/… --base main --title "chore(github): add CODEO…
[9:09:45 PM]   ◀ Bash: https://github.com/dreamorosi/batch-sync-triage/pull/6
[9:09:50 PM] Cost: $0.2792 (1947 in / 3554 out tokens)
[9:09:50 PM] ★ step:implement:succeeded
[9:09:50 PM] ★ agent_execution_complete: status=success turns=22
[9:09:50 PM] ★ pr_created: https://github.com/dreamorosi/batch-sync-triage/pull/6
Task 01KZD6D95P5VXJTJ06BFJXF8J6 completed.
```

The final record: `status COMPLETED`, `duration_s 153.4`, `cost_usd 0.279`,
`turns_completed 12`, `build_passed true`, `lint_passed false`,
`session_id microvm-082ebde7-…`. **Time-to-`RUNNING` was 5 s.** That confirms
run 1's main performance result on a task that finishes.

*A minor inconsistency.* `watch` prints
`agent_execution_complete: turns=22`, while the persisted record and
`METRICS_REPORT` both say `turns: 12`. Two different notions of "turn" (SDK
messages and counted iterations) appear under one word in the same stream.

*Incidental, both tasks.* `lint_passed: false` comes from the scratch repo
(`tsc: not found`, a `biome` schema mismatch, `mise ERROR no tasks defined`).
The agent correctly treated these failures as pre-existing before it proceeded.

#### 2.8.2 P2-F4 — DISCHARGED with content, not just stream existence

The brief's test was whether `server_debug/<task_id>` now *exists*. It does, and
so do other streams:

```
metrics/01KZD6D95P5VXJTJ06BFJXF8J6
server_debug/01KZD6D95P5VXJTJ06BFJXF8J6
server_debug/server
trajectory/01KZD6D95P5VXJTJ06BFJXF8J6
```

All three per-task streams were `AccessDenied` in run 1. `server_debug` carries
the `/run` log lines, including the **11-key** `platform_config` install line
with names only. `metrics/<task_id>` carries the `METRICS_REPORT` that run 1
lost entirely:

```json
{"event": "METRICS_REPORT", "status": "success", "agent_status": "success",
 "pr_url": "https://github.com/dreamorosi/batch-sync-triage/pull/6",
 "build_passed": true, "lint_passed": false, "cost_usd": 0.27916625,
 "turns": 12, "duration_s": 153.4, "task_id": "01KZD6D95P5VXJTJ06BFJXF8J6",
 "disk_before": "167.5 KB", "disk_after": "261.0 MB", …}
```

**P2-F4 is fully discharged**, and the platform's canonical per-task
observability is no longer empty on this backend.

#### 2.8.3 Dual-signal liveness — DISCHARGED, and run 1's verdict was partly an artifact

The table shows polls **against DynamoDB** during submission 5's `RUNNING`
window:

| Wall clock | Status | Running for | `agent_heartbeat_at` | Freshness |
|---|---|---|---|---|
| 04:25:11Z | `RUNNING` | 71 s | `2026-08-07T04:24:47Z` | 24 s |
| 04:25:38Z | `RUNNING` | 99 s | `2026-08-07T04:25:32Z` | **6 s** |
| 04:26:05Z | `RUNNING` | 126 s | `2026-08-07T04:25:32Z` | 34 s |
| 04:26:33Z | `RUNNING` | 153 s | `2026-08-07T04:26:17Z` | 16 s |
| 04:27:00Z | `COMPLETED` | 181 s | `2026-08-07T04:26:17Z` | 44 s |

Successive values are `04:24:47 → 04:25:32 → 04:26:17`, which is **exactly the
45 s `_HEARTBEAT_INTERVAL_SECONDS` cadence**. Freshness was never worse than
34 s while `RUNNING`. **The dual-signal liveness path is DISCHARGED on
`lambda-microvm`.** `heartbeatLivenessApplies` has a real, fresh signal to
read. Progress events streamed live in `watch` at the same time (2.8.1).

**But the signal became visible only when DynamoDB was read directly.**
`bgagent status` reported `agent_heartbeat_at = None` on every poll of *both*
completed tasks. That includes submission 3, whose stored value was
`2026-08-07T04:09:39Z`, 12 s before `completed_at`. The cause is that
`toTaskDetail` (`cdk/src/handlers/shared/types.ts:786`) never maps the field,
although `TaskRecord` declares it at line 95 and `orchestrator.ts` consumes it
for liveness. See P2r2-F11. This cause also makes run 1's "heartbeats NOT
observed" partly a measurement artifact, not purely a consequence of P2-F5.

### 2.9 Lifecycle — PASS

Both smoke MicroVMs finalized cleanly: `state TERMINATED`, `stateReason
Success.`, `maximumDurationInSeconds 28800` never approached. `NO_INGRESS`
was reconfirmed on both, and **run 1's caveat holds**. A `NO_INGRESS` VM still
returns a public endpoint hostname
(`76cfed33-…lambda-microvm.us-east-1.on.aws`), so "an endpoint exists" is still
no evidence of reachability.

`list-microvms` showed **11** VMs, all `TERMINATED`: run 1's 9 plus this
run's 2. So the list is cumulative across runs, and none of run 1's VMs came
back.

### 2.10 Not attempted this run

These items were left out of the narrow scope on purpose: suspend, resume and
suspend-TTL (run 1's section 6.2 covered a hook-enabled image), the
SUSPENDED-vs-quota probe (the quota still has `UsageMetric: null`), and the
run-hook-4xx self-termination of run 1's section 6.1 (P2-F6, which is already
recorded, and for which `b927d1d` corrected the ADR).

### 2.11 Scratch repo — TWO PRs left open

```
#7 docs(contributors): add CONTRIBUTORS.md  | bgagent/01KZD7D7HD3CT2APBT3DH12XFE/…
#6 chore(github): add CODEOWNERS file       | bgagent/01KZD6D95P5VXJTJ06BFJXF8J6/…
#1–#5 pre-existing dependabot PRs
```

**PR #6 is the briefed smoke and is left open as instructed.** **PR #7 is a
by-product of the 2.8 isolation experiment.** Submission 5 needed a task that
would run, and a second, distinct file avoided a collision with PR #6. PR #7 is
left open next to PR #6 and not closed, so that the evidence for the experiment
survives. Two `bgagent/*` branches were pushed, and `main` is untouched.

### 2.12 Teardown (executed as a finally-block)

| Step | Result |
|---|---|
| **Live IAM workaround** | `abca645p2r2-verification-passrole` **deleted** from the orchestrator role. `list-role-policies` shows only the CDK-managed default policy. **No trust policy was modified at any point this run** (verified: the execution role still has `sts:AssumeRole` + `sts:TagSession`, with no conditions, exactly as the source produces). |
| **MicroVMs** | All 11 `TERMINATED` before teardown began. None had to be tracked down. |
| **Image + version** | Single version `1.0`. `delete-microvm-image` → `DELETING`, and the version was deleted with the image. |
| **Cognito user** | `admin delete-user` → `✓ Deleted`. `list-users` → `[]`. Invite file `rm`'d. |
| **Secret** | Left to be deleted with the stack. |
| **`cdk/cdk.context.json`** | **Restored** to the original six-AZ list. `git status` shows only `docs/verification/` and the pre-existing `opencode.json`. |
| **ECR retag** | `7a71005f…` removed with `batch-delete-image`. Pre-existing tags and the underlying manifest untouched. |
| **finch** | Never started this run. `~/.finch/config.json` never touched (still `credsStore: osxkeychain`, no stored credential). |
| **Global/host config** | **`~/.aws/*` never read or modified.** All credential and Region selection via environment variables in the run's own shell. `~/.cdk.json` never created. |

**Stack. Two delete attempts ended at run 1's exact residual:**

| Attempt | Window | Outcome |
|---|---|---|
| 1 | 04:29:02Z → 04:37:24Z (8 min 22 s) | `DELETE_FAILED`. `AWS::BedrockAgentCore::Runtime`: `"Request timed out while deleting AWS::BedrockAgentCore::Runtime"`, `HandlerErrorCode: NotStabilized`. **19** resources left. |
| 2 (informed) | 04:37:50Z → 04:55:17Z (17 min 27 s) | `DELETE_FAILED`, but the Runtime, Memory, all IAM roles, all DynamoDB tables, the S3 bucket and the secret **did** delete. **4** resources left. |

Attempt 2 was not a blind retry. `bedrock-agentcore-control list-agent-runtimes`
returned an **empty** list first. That proves the runtime was already gone on
the server side and the failure was a handler stabilization artifact. **Run 1's
attempt-3 technique reproduced exactly and is confirmed as the right
procedure.** It took the residual from 19 to 4.

**The final residual is 4 resources, all zero-cost, identical in shape to run 1
and P1:**

```
CREATE_COMPLETE  AWS::EC2::VPC            vpc-07dad8897791f477b
DELETE_FAILED    AWS::EC2::Subnet         subnet-09a1ff1f7568d05ef
DELETE_FAILED    AWS::EC2::Subnet         subnet-068397b48a25bf13f
DELETE_FAILED    AWS::EC2::SecurityGroup  sg-05e3f48665c47b358
```

Two new `agentic_ai` ENIs pin these resources (`eni-0942f1b0b3b6553ea`,
`eni-07876963c2818da63`, both `in-use`). **This is #702 and P1 F12, reproduced
for the third consecutive run.** Nothing was force-deleted outside
CloudFormation.

**Billing confirmed stopped:**

| Check | Result |
|---|---|
| NAT gateways in either orphaned ABCA VPC | **none** |
| VPC endpoints | **none** |
| ABCA S3 buckets | **none** |
| Unattached (billable) EIPs | **none** |
| MicroVM images / non-`TERMINATED` VMs | **none** |
| AgentCore runtimes / memories | **none** |
| `/aws/lambda-microvms/*` log groups | **none** |
| ABCA DynamoDB tables / GitHub-token secret | **none** |

**Deliberately retained.** The run retained `CDKToolkit` (unchanged, and still
subject to the shared-account caveat that P1 raised), the bootstrap S3 and ECR
assets, the service-vended log groups created outside CloudFormation, the two
scratch-repo PRs (2.11), and **two** orphaned zero-cost VPC sets. The first set
is run 2's four resources above, which are still inside the `DELETE_FAILED`
stack. The second set is **run 1's**, which `--retain-resources` moved outside
CloudFormation entirely (`vpc-072fddf653ccdcfc4`, `subnet-0e6a6a0ed18100c8a`,
`subnet-02d91450e51cf72a0`, `sg-00997a58c1f4c5775`).

A manual, best-effort cleanup of run 1's set was attempted and **refused**, with
`DependencyViolation` on both subnets, the SG and the VPC, because
`eni-04911e11e08d670f9` and `eni-04a1c5a27966ee08b` were **still `in-use`
3 h 30 min after run 1's teardown**. Nothing was forced. The retry commands for
both sets:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev   # run 2's set
# run 1's set is no longer CFN-managed:
aws ec2 delete-subnet --subnet-id subnet-0e6a6a0ed18100c8a
aws ec2 delete-subnet --subnet-id subnet-02d91450e51cf72a0
aws ec2 delete-security-group --group-id sg-00997a58c1f4c5775
aws ec2 delete-vpc --vpc-id vpc-072fddf653ccdcfc4
```

### 2.13 Findings summary

Live run 2026-08-07 02:58Z to 04:55Z, account `<account>`, `us-east-1`, branch
`feat/645-lambda-microvm-p2` @ `b927d1d6`. Evidence:
`/tmp/abca-645-p2r2-20260806`.

**Verdict on the primary objective. THE SMOKE PASSED.
`https://github.com/dreamorosi/batch-sync-triage/pull/6`.** The task went from
clone through change, commit and push to a PR, and was `COMPLETED` in 153 s for
$0.28, with progress events and a live heartbeat. Run 1's headline no longer
holds. **The PR required one live IAM workaround, and finding the reason is the
run's most valuable output.**

#### Fixes CONVERTED to "re-exercised live"

1. **P2-F1 is DISCHARGED.** The substrate deployed on the **first try** with
   `EXIT=0`, in 14 min 34 s, with **zero workarounds**. Both
   `AWS::Lambda::NetworkConnector` resources reached `CREATE_COMPLETE`, and
   there was **no `*FAILED` event anywhere** in 485 resources. Run 1 needed
   five attempts and a cloud-assembly patch.
2. **P2-F2 is DISCHARGED.** Change-set **early validation passed** with `ARM_64`
   and four `ENABLED` hooks, and the resource reached `CREATE_IN_PROGRESS`.
   Run 1's five-value refutation is answered for CloudFormation. The path is
   still blocked at a later step (P2r2-F9), but *not* on the enums.
3. **P2-F4 is DISCHARGED with content.** `server_debug/<task_id>`,
   `metrics/<task_id>` **and** `trajectory/<task_id>` all exist, and the
   `METRICS_REPORT` that run 1 lost entirely is now written.
4. **P2-F5 is DISCHARGED, and now quantified.** A cold `claude` exec was
   measured at **17.1–37.8 s**, so `timeout=10` was 2–4× too short and could
   never have passed. A warm exec takes **0.1 s**. `/ready` returned 200, with
   no 503. `/validate` still reports
   `platform_config_keys=13, warnings=0`. The whole build took 4 min 30 s,
   that is, the warm-up cost ~22 s. **A new empirical detail:** the service
   calls `/ready` **three times per build, the first two concurrently**, so two
   cold `claude` execs contend, and the worst single call is ≈ 44 s. The 120 s
   required budget and the move of `readyTimeoutInSeconds` from 60 to 300 are
   both sized correctly. 60 s would have left ~16 s of slack.
5. **Dual-signal liveness is DISCHARGED** (run 1: BLOCKED). `agent_heartbeat_at`
   advanced `04:24:47 → 04:25:32 → 04:26:17`, an exact 45 s cadence, across a
   181 s `RUNNING` window, with freshness ≤ 34 s.

#### Items CONTRADICTING design assumptions — `feeds-back-to-design: YES`

**P2r2-F10 (BLOCKING). P2-F3 is NOT fixed. The orchestrator's *identity-side*
`iam:PassedToService: lambda.amazonaws.com` condition is a second, independent
blocker. Run 1 explicitly exonerated that condition, and `b927d1d` deliberately
kept it.**

A two-arm experiment isolated the condition, with the same exact-ARN resource
as the source, the same 5-minute settle, and one variable:

| Orchestrator grant | Result |
|---|---|
| exact ARN **+ `iam:PassedToService: lambda.amazonaws.com`** (source as written) | **DENIED**, submissions 1 *and* 4 |
| exact ARN, **no condition** | **`RUNNING` in 9 s**, submission 5 |

```
Session start failed: Error: MicroVM RunMicrovm failed: AccessDeniedException: User: arn:aws:sts::<account>:assumed-role/backgroundagent-dev-TaskOrchestratorOrchestratorFnS-a7sP6rFzoIkU/backgroundagent-dev-TaskOrchestratorOrchestratorFn-p41lJqwFmxNG is not authorized to perform: iam:PassRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-pZQWXvKsITBa because no identity-based policy allows the iam:PassRole action
```

The trust half of run 1's fix was **necessary but not sufficient**. Run 1's
exoneration was a **false negative with an identifiable cause**. Run 1 attached
its temporary unconditioned `iam:PassRole` at step 1 of its section 4.1.
According to its own section 8.3, that grant **was still attached through
submissions 4 and 5**, the ones that reached `RUNNING`. So run 1 never tested
the conditioned grant against a *working* trust, and it attributed the whole
effect to the trust change.

The comment in `task-orchestrator.ts` that asserts the condition "was
EXONERATED live … so it stays" must be reversed, and two source statements must
therefore change:

- `cdk/src/constructs/task-orchestrator.ts`, sid `MicrovmPassExecutionRole`
- `cdk/bootstrap/policies/infrastructure.json`, sid `IAMPassRole` (P2r2-F9)

**P2r2-F9 (BLOCKING, same root cause). The CDK-managed image path fails one
step later than run 1 thought, because CloudFormation cannot pass the build
role.** The verbatim `CREATE_FAILED` is in 2.5. **The cause is not a stale
bootstrap.** The live policy is byte-identical to this branch's
`cdk/bootstrap/policies/infrastructure.json`. `simulate-principal-policy` returns
`allowed` for `iam:PassedToService=lambda.amazonaws.com` and `implicitDeny`
without it, so the resource pattern is right and the condition is the variable.
The out-of-band `--create-image` call **succeeded while passing the same build
role**. That success proves that the trust is fine and that the denial is on
the caller's side.

**P2r2-F9 and P2r2-F10 are ONE root cause with TWO symptoms.** This is the same
shape as run 1's P2-F1/F3, one layer further in. **The Lambda MicroVMs service
does not present `iam:PassedToService: lambda.amazonaws.com` on either
`PassRole` path.** The first path is CloudFormation passing the build role at
`CreateMicrovmImage`. The second is the orchestrator passing the execution role
at `RunMicrovm`. The consequence for the docs is that the "CDK-managed
(recommended)" bootstrap path in `package-microvm-artifact.sh` **still** does
not work, and `--create-image` is **still** the only working path, now for a
new reason.

**P2r2-F11. `agent_heartbeat_at` is written and consumed correctly, but the API
does not return it.** `toTaskDetail`
(`cdk/src/handlers/shared/types.ts:786`) does not map the field, although
`TaskRecord` declares it (line 95) and `orchestrator.ts` reads it for liveness.
`cli/src/types.ts` has no such field at all. So `bgagent status` and `watch`
report `None` even when DynamoDB holds a 6-second-old value. The fix is cheap
and should be made, because **the defect already caused a wrong conclusion**.
Run 1 recorded "heartbeats NOT observed" and attributed it wholly to P2-F5.

**P2r2-F12. The stack-delete retry advice in run 1's section 8.5 does not work
within one session, and the ENI leak is worse than #702 records.** Run 1's
documented `delete-stack` retry failed **in the same way after 17 min 17 s**.
At that time the `agentic_ai` ENIs were still `in-use`, 1 h 32 min after
run 1's teardown, and *no* AgentCore runtimes or memories existed. At the end
of *this* run, those same two ENIs were **still `in-use` 3 h 30 min after run 1's
teardown**, and a manual sweep with `delete-subnet`, `delete-security-group` and `delete-vpc` was
refused with `DependencyViolation` on all four. So the leak is not "slow". It
is **unbounded relative to a developer's session**, and it accumulates, because
each run leaves another VPC set behind. The workaround that works is
`--retain-resources` (33 s). The command must list the `CREATE_COMPLETE` VPC
together with the three `DELETE_FAILED` children:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev \
  --retain-resources AgentVpcA6796801 AgentVpcPrivateSubnet1Subnet8051BB57 \
                     AgentVpcPrivateSubnet2SubnetC66971D0 AgentVpcRuntimeSG96507CD0
```

Issue #702 should record both the evidence of the unbounded hold and this
workaround, so that later runs do not have to rediscover them. Run 1's
attempt-3 technique (verify that `list-agent-runtimes` is empty, *then* retry)
is separately **confirmed correct**. It took this run's residual from 19
resources to 4.

**P2r2-F13. `MICROVM_IMAGE_VERSION` is legitimately optional.** This run has
five `MICROVM_*` vars against run 1's six, because the optional
`microvm_image_version` context was not supplied. That is correct by design
(`task-orchestrator.ts:467`), but it qualifies the "all-or-nothing `MICROVM_*`"
claim. The claim should name the version as the one member that may be absent.

**P2r2-F14. `turns` is reported inconsistently in one stream.** `watch` prints
`agent_execution_complete: turns=22`. The persisted record and `METRICS_REPORT`
both say `12`.

**P2-F7 is reconfirmed, and worse.** 985,886 B with 486 resources is **98.6 %**
of the 1 MB limit, with ~14 KB of headroom (run 1: ~16 KB).

**CloudTrail blind spot.** There are no `lambda-microvms` management events at
all, so `PassRole` context values cannot be read from logs. Every determination
in 2.5 and 2.8 had to be made by elimination. The next person to investigate
should know this first.

**Still unfixed from earlier runs.** These are P1 F11 (the AZ constraint,
worked around again through the gitignored AZ cache, which was restored at
teardown), the failure of the finch push to ECR, and P1 F8 (`TERMINATED` is
terminal, and `ResourceNotFoundException` never arrives).

#### Recommended follow-up

1. **P2r2-F10 and P2r2-F9 together.** Drop or correct `iam:PassedToService` on
   both the orchestrator statement and the bootstrap `IAMPassRole`. Nothing runs
   without the first change, and the recommended image path stays broken
   without the second. To determine the value that the service *does* present,
   either get confirmation from AWS or sweep a bounded set of candidates.
   `microvms.lambda.amazonaws.com`, `lambda-microvms.amazonaws.com` and
   `microvms.amazonaws.com` are all `implicitDeny` against the current policy,
   so any of them would work as the allow-list entry if it is the right one.
   Reverse the "EXONERATED … so it stays" comment in the same change.
2. **P2r2-F11.** Add one line in `toTaskDetail` and the CLI type. This change
   makes the liveness signal observable to the people who need it.
3. **P2r2-F12.** Record the `--retain-resources` workaround in #702.
4. **P2-F7.** Use `suppressTemplateIndentation` or split the stack. ~14 KB is
   left.
5. **A third Stage D is NOT needed for P2-F1/F2/F4/F5 or dual-signal
   liveness.** All five are now verified live. The scope of the next run is
   P2r2-F9/F10 plus the empirical items that are still deferred (suspend
   TTL > 1 h, SUSPENDED-vs-quota).

### 2.14 Elapsed and cost

**Elapsed.** 02:58Z to 04:55Z ≈ **1 h 57 min**. Of that time, ~18 min was the
failed delete retry, ~15 min the substrate deploy, ~6 min the refuted
CDK-managed image attempt, ~10 min image create and build, ~5 min the wired
deploy, ~30 min the five submissions and the isolation experiment (mostly IAM
settle waits), ~26 min the two teardown delete attempts, and the remainder
evidence capture.

**Approximate cost: well under US$5.** NAT and VPC-endpoint hours dominate, as
always. Unlike run 1, this run spent Bedrock tokens, **$0.478 in total across
two completed tasks** ($0.279 + $0.199). Two MicroVMs ran ~2.5 min each. Two
image builds ran ~4.5 min each. One NAT gateway and 7×2 interface endpoints ran
for ~1.6 h across a single stack lifetime.

No VM approached the 8 h `maximumDurationInSeconds`. The orchestrator's
finalization terminated every VM explicitly.
