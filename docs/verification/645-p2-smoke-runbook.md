# ADR-021 P2 Stage D — live smoke runbook

Working verification document for issue #645 on branch
`feat/645-lambda-microvm-p2` @ `3a4b61a97b22b7bcdd9832101f8d61a077fbf103`.
Companion to [`645-p1-lambda-microvm-runbook.md`](./645-p1-lambda-microvm-runbook.md),
whose command incantations this run reuses wholesale (escaped `ComputeTypes`
comma, `bootstrap --force`, newest-first version ordering, image-version `N.0`
spelling, two builds per version, delete-all-but-last then delete-image,
teardown-as-finally).

`docs/scripts/sync-starlight.mjs` does not mirror `docs/verification/`, so this
file intentionally stays here and is not part of the Starlight site.

**Live run:** 2026-08-06 22:38Z → 2026-08-07 01:26Z, account `<account>`,
`us-east-1`. Evidence directory: `/tmp/abca-645-p2-20260806`.

**Teardown: complete.** All MicroVMs terminated, image + version deleted, both
live IAM workarounds reverted, Cognito user deleted, secret died with the stack,
96/100 stack resources deleted (4 zero-cost residual, #702), **all billable
resources confirmed gone**, and every global/host configuration restored. See
Phase 8.

## What Stage D was for

P2 (`ab4808c`) wired everything short of the live run. Its commit message names
what it could not assert:

> Remaining for P2 completion: the live smoke run (clone -> change -> PR with
> `bgagent watch`) and the deferred empirical items (suspend TTL >1h,
> SUSPENDED-vs-quota, `microvmImageHooks` API spelling, `NO_INGRESS` ARN).

Five jobs, and their verdicts:

| # | Job | Verdict |
|---|---|---|
| 1 | **THE SMOKE** — clone → change → PR through `bgagent watch` | **BLOCKED at `implement`, turn 0** — reproducible. Clone, branch, `/run`, `platform_config`, progress events and terminate all work; `claude --version` times out (P2-F5). **No PR was created.** |
| 2 | Adjudicate the CFN `AWS::Lambda::MicrovmImage` shape P1 left half-open | **DISCHARGED — the L1 is REFUTED on 5 values** (P2-F2) |
| 3 | `microvmImageHooks` spelling | **DISCHARGED both ways** — property name/nesting correct, hook *values* must be `ENABLED`/`DISABLED` (P2-F2); the API request built by the packaging script is correct and all four hooks were accepted and served |
| 4 | `NO_INGRESS` ARN name | **DISCHARGED** — the injected ARN is right and does suppress P1 F7's default public ingress |
| 5 | Extend suspend-TTL bound; re-probe SUSPENDED-vs-quota | **TTL extension SKIPPED** (time-boxed, see Skipped); quota **re-confirmed NOT OBSERVABLE** |

**Headline:** the P2 substrate is much closer than P1 — the image builds with all
four hooks, the MicroVM launches, `/run` installs `platform_config`, the repo
clones, progress events stream to `bgagent watch`, and finalization terminates
the VM. But **four independent defects had to be worked around to get that far**,
and the run still ends one step short of a PR on a fifth. None of the four is
visible to `cdk synth`, `mise //cdk:test`, or any unit test: every one is a
live-service contract mismatch.

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

The executor's shell is **zsh**, where `$VAR:latest` is parsed as the
`${VAR:l}` *lowercase modifier*, silently producing `…atest`. It cost one
mis-diagnosed container push. **Always brace: `${VAR}:latest`.** Likewise zsh has
no `PIPESTATUS` (it is `$pipestatus`, 1-indexed) and no `timeout(1)` — P1's
`test "${PIPESTATUS[0]}" -eq 0` silently evaluates to empty here. Use
`set -o pipefail` plus a plain `$?`.

---

## Execution deviations (each is itself a result)

1. **AZ pinning was required — P1 F11 is UNFIXED on this branch.**
   `agent-vpc.ts` still does `maxAzs: 2` with no AZ constraint, and this account
   still maps `us-east-1a → use1-az6`, which AgentCore rejects. Rather than
   re-derive a finding P1 already recorded, the gitignored CDK context cache
   (`cdk/cdk.context.json`, a build artifact — `git status` stayed clean) was
   trimmed to lead with `us-east-1b` (`use1-az1`) + `us-east-1c` (`use1-az2`).
   Original saved to `$EVIDENCE_DIR/cdk.context.json.ORIGINAL` and **restored at
   teardown**. With the pin, AgentCore Memory and Runtime created cleanly, so
   this is the whole of F11's remaining impact.
2. **The AgentCore container asset could not be pushed; an existing ECR manifest
   was retagged instead.** `finch` (v1.17.2, no docker on this box) *built* the
   image fine but every `finch push`/`finch pull` against ECR failed instantly
   with `no basic auth credentials`. Root cause established: `finch push` shells
   into the Lima VM as `limactl shell finch sudo -E nerdctl push`, and the VM's
   `DOCKER_CONFIG` (`/home/aamorosi.guest/.finch-vm-config/config.json`) carries
   `credsStore: finchhost`, a helper that cannot resolve this account's
   Isengard `credential_process`. A host-side `finch login` succeeded and wrote
   to `~/.finch/config.json`, but the VM never consulted it. Since the ECR image
   is **only** consumed by the AgentCore runtime — which this run never invokes,
   because the smoke runs on the MicroVM substrate built from the S3 zip by the
   Lambda MicroVMs service — the required asset tag was added to an existing
   manifest with `aws ecr put-image`. **This does not touch the MicroVM image
   under test.** Consequence to be honest about: the deployed AgentCore runtime
   carries a P1-era agent image. Nothing in this runbook depends on it.
   *(All global config touched during that investigation — `~/.finch/config.json`
   and the VM's docker config — was reverted; see Teardown.)*
3. **The connector operator role's trust policy had to be patched to deploy at
   all** (P2-F1) — via a `/tmp` cloud-assembly patch, P1's technique. No
   repository source file was modified.
4. **Two IAM workarounds were applied live to get past P2-F3** (execution-role
   trust condition, plus a temporary unconditioned `iam:PassRole` that turned out
   to be unnecessary). Both reverted; see Teardown.
5. **The CDK-managed `CfnMicrovmImage` path was attempted first, as briefed, and
   failed** (P2-F2). The out-of-band `--create-image` script path was used
   instead — the same path P1 used, and currently the only one that works.
6. **The suspend-TTL extension beyond P1's 1 h floor was skipped** (time-boxed).
7. **One self-inflicted error is recorded rather than hidden:** the GitHub PAT was
   first written to Secrets Manager with a trailing newline (`gh auth token |
   … --secret-string file:///dev/stdin`), which produced a real clone failure.
   Corrected; see 3.2.

---

## Phase 0 — Preflight

### 0.1 Identity, region, branch

`aws sts get-caller-identity` →
`arn:aws:sts::<account>:assumed-role/AdminConsoleAccess/aamorosi-Isengard`,
account `<account>`. Branch `feat/645-lambda-microvm-p2`, SHA
`3a4b61a97b22b7bcdd9832101f8d61a077fbf103`. Untracked: `docs/verification/`,
`opencode.json` — the same two P1 saw.

> **Credential note.** The profile's default region is `eu-west-1`, so
> `AWS_REGION`/`AWS_DEFAULT_REGION` must be exported explicitly for every
> command. A bare `aws` call in this account goes to the wrong Region.
> Mid-run the credentials expired once; re-pinning `AWS_PROFILE` (which resolves
> through `credential_process` and auto-refreshes) fixed it. **No global AWS
> config was read or modified at any point.**

`backgroundagent-dev` was **absent**, exactly as P1's Phase 8 hoped:

```
An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id backgroundagent-dev does not exist
```

**P1 F12's stack half is therefore RESOLVED**: P1 ended with `backgroundagent-dev`
in `DELETE_FAILED` (VPC + 2 subnets + 1 SG pinned by two leaked `agentic_ai`
ENIs) and a recorded retry command. AgentCore did eventually release them and the
stack is gone. The three unrelated pre-existing stacks
(`serverless-api-powertools`, `BuildingServerlessAPIs`,
`aws-sam-cli-managed-default`) plus `CDKToolkit` remain.

### 0.2 Tooling

| Tool | Version | Note |
|---|---|---|
| `aws-cli` | 2.36.13 | `aws lambda-microvms help` **exit 0**, **24 commands** — identical to P1 |
| `mise` | 2026.8.1 | **present this time** (P1 ran entirely on raw fallbacks) |
| node | v24.16.0 | |
| python3 | 3.9.6 | system python; the *guest* runs 3.13.13 |
| `zip` | 3.0 | |
| `rsync` | openrsync (protocol 29) | packaging script works unmodified |
| docker | **absent** | |
| `finch` | v1.17.2 | builds fine, **cannot push to ECR** (deviation 2) |

### 0.3 Bootstrap — no re-bootstrap needed

`CDKToolkit` `UPDATE_COMPLETE` (last updated 2026-07-31T18:54:48Z, i.e. P1's run),
and it already carries what P2 needs:

- `ComputeTypes` = **`agentcore,lambda-microvm`** ✓
- `BootstrapVariant` = **`ABCA: Least-Privilege Bootstrap`**
- bootstrap version SSM parameter = `32`
- `cdk-hnb659fds-cfn-exec-role-<account>-us-east-1` carries exactly the **five**
  ABCA policies (Application, Infrastructure, Observability, Compute-Agentcore,
  **Compute-LambdaMicrovms**) and **no `AdministratorAccess`**.

So `bootstrap --force` was **not** re-run.

> **P1 F10 is partly self-healing — correction to the P1 record.** P1 reported as
> a "durable consequence" that `BootstrapVariant` *stays* `AWS CDK: Default
> Resources` after a forced bootstrap, so every future non-forced bootstrap
> refuses forever. It now reads `ABCA: Least-Privilege Bootstrap`. The reason is
> the very next command in P1's own runbook: `update-stack
> --use-previous-template` with **only** `ParameterKey=ComputeTypes` supplied
> resets every unspecified parameter to its **template default** (that is
> CloudFormation's documented behaviour absent `UsePreviousValue=true`), and the
> ABCA template's default for `BootstrapVariant` is the ABCA string. F10's
> *first* half (the silent `exit 0` no-op without `--force`) stands; the
> "recurs forever" half does not.

### 0.4 Managed base image

Unchanged from P1: exactly **one** managed base image in `us-east-1`,
`arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`, versions `1`
(2026-07-21) and `0` (2026-06-17), **newest first**, so `items[0]` = `1`.
Selected version `1`; the service echoes `baseImageVersion: "1.0"`.

---

## Phase 1 — Deploy

### 1.1 Substrate synth — PASS

`abca:microvm-image-not-provisioned` emitted with the full remedy text;
`abca:microvm-image-p1-smoke-unverified` correctly **absent**. Both incidental
warnings grew since P1 and one is close to the wall:

| Metric | P1 | P2 | Limit |
|---|---|---|---|
| Template size | 893,273 | **977,650** (substrate) / **983,796** (with image) | 1,000,000 |
| Resource count | 463 | **485** / **486** | 500 |

**Feeds back to design:** the template is at **98.4 %** of the 1 MB
CloudFormation limit with the image configured. That is ~16 KB of headroom —
roughly one more construct. `suppressTemplateIndentation` or a stack split is
now a near-term requirement, not a nicety.

### 1.2 Substrate deploy — BLOCKED, then PASS after a trust-policy patch

**Attempts 1–2 failed on the ECR push** (deviation 2), a purely local tooling
problem. **Attempts 3–4 failed identically on the network connectors** — this is
P2-F1:

```
Resource handler returned message: "The service is unable to assume the provided NetworkConnectorOperatorRole. Please verify the trust policy on the role. (Service: Lambda, Status Code: 400, Request ID: dbe1d2f4-dd0c-4319-8f5d-b4be4f076843) (SDK Attempt Count: 1)" (RequestToken: d6e21be9-9857-f452-bf12-3b93f89a4c75, HandlerErrorCode: InvalidRequest)
```

Both `LambdaMicrovmCompute/EgressConnector` and
`LambdaMicrovmCompute/BuildEgressConnector` `CREATE_FAILED`. Attempt 4 ran
against a **freshly deleted stack**, so this is **deterministic, not IAM
propagation lag** — an important distinction, because that error message is the
classic propagation symptom and a re-run is the obvious (wrong) first guess.

**Attempt 5** deployed a `/tmp` cloud assembly with exactly one edit — the
`aws:SourceAccount` condition removed from
`LambdaMicrovmComputeConnectorOperatorRole`'s `AssumeRolePolicyDocument`:

```json
{"Statement":[{"Action":"sts:AssumeRole","Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"}}],"Version":"2012-10-17"}
```

Both connectors went `CREATE_IN_PROGRESS → Resource creation Initiated` within a
second. **`CREATE_COMPLETE` 23:13:43Z → 23:27:03Z = 13 min 20 s**, 485 resources
(P1's comparable figure: 13 min 42 s / 464 resources).

*Two P1 gotchas recurred verbatim and their remedies still work:*

- `AWS::BedrockAgentCore::Memory` cannot be deleted while `CREATING`
  (`Validation failed during DeleteMemory: Memory is in transitional state
  CREATING. Cannot delete memory.`) → rollback ends `ROLLBACK_FAILED`; a plain
  `aws cloudformation delete-stack` clears it (~3 min). **P1 F12's Memory half is
  unfixed.**
- Post-synth template edits are silently ignored unless the template's S3 asset
  object is deleted first (the object key is the *pre-edit* content hash).

### 1.3 Substrate outputs — PASS

`ComputeSubstrate = lambda-microvm`; all **seven** MicroVM outputs populated
(the six P1 had, plus `MicrovmBuildEgressConnectorArns`); artifact key exactly
`microvm-images/agent-artifact.zip`. Runtime and build egress connectors are
distinct ARNs, as designed.

### 1.4 No-image orchestrator env — PASS, and a correction to P1 F14

`MICROVM_*` keys = **`[]`** (23 env keys total). All-or-nothing holds.

> **P1 F14's `--no-paginate` remedy is WRONG and silently truncates.** P1
> concluded that `list-stack-resources --query "…|[0]"` needs `--no-paginate`.
> With 485 resources, `--no-paginate` returns **only the first page** — it
> yielded 6 Lambda functions and *no* `TaskOrchestrator`, resolving
> `ORCHESTRATOR_FN` to the literal string `None` and producing a confident
> `Function not found: …:function:None`. That is worse than P1's original bug,
> because the original at least printed five values and broke loudly. **The
> correct approach is to let the CLI paginate (its default) and filter
> client-side**, which returns all 485:
> ```bash
> aws cloudformation list-stack-resources --stack-name "$STACK_NAME" --output json \
>   | python3 -c 'import json,sys; print([r["PhysicalResourceId"] for r in json.load(sys.stdin)["StackResourceSummaries"] if "TaskOrchestrator" in r["LogicalResourceId"] and r["ResourceType"]=="AWS::Lambda::Function"])'
> ```

**The new `agentPlatformConfig` env vars are present — 11 of 13.** All seven
`agentPlatformConfig` fields plus the four inherited ones landed on the
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
| `linear_oauth_secret_arn` | `LINEAR_OAUTH_SECRET_ARN` | — (per-workspace, CLI-created; correctly absent) |
| `jira_oauth_secret_arn` | `JIRA_OAUTH_SECRET_ARN` | — (same) |

The two absentees are **not** in the contract's `required` list, so the
producer's optional-key handling is exercised and correct.

*Incidental:* `ARTIFACTS_BUCKET_NAME` and `TRACE_ARTIFACTS_BUCKET_NAME` resolve
to the **same** bucket (`…-traceartifactsbucket8cbd5207-pwjbv0diorys`). Not a
MicroVM issue, but worth a glance — two distinct `platform_config` keys carrying
one bucket makes the trace/artifact separation notional.

### 1.5 The CDK-managed `CfnMicrovmImage` path — **REFUTED** (P2-F2)

This is the question P1 left open, and it is now closed. Synth produced the
warning correctly (`abca:microvm-image-p1-smoke-unverified`) and the exact L1
under test:

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

CloudFormation **rejected it at change-set early validation** — the stack was
never touched, so there was no rollback:

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

**Five rejected values, and the CFN surface is identical to the API surface.**
This refutes the construct's explicit reasoning — *"The CDK L1 remains
intentionally unchanged because its generated CloudFormation types accept string
values and document no architecture/hook allowed-value constraint"*. The types
accept strings; the **service** enforces the enum, at change-set time.

Two useful corollaries:

- **The `microvmImageHooks` *spelling* is CORRECT.** The errors are scoped to
  `…/Hooks/MicrovmImageHooks/Ready` and `…/Validate`, so CFN resolved the
  property name and its children. Only the *values* are wrong. Combined with 2.1
  below (the API accepted the identical structure), the naming question is
  discharged in both directions.
- **Hook paths are not configurable anywhere.** Neither CFN nor the API takes a
  path; both take `ENABLED`/`DISABLED`. The service calls fixed well-known routes
  — 2.2 proves they are exactly the `/aws/lambda-microvms/runtime/v1/*` strings
  the agent serves. So `RUN_HOOK_PATH` and friends are correct *as route
  constants for the agent* and simply must not be sent as property values.

### 1.6 Wired deploy (out-of-band image) — PASS

After the image existed (Phase 2), redeploying with
`--context microvm_image_identifier=<ARN>` completed in **3 min 33 s**
(00:06:00Z → 00:09:33Z), `UPDATE_COMPLETE`, warning
`abca:microvm-image-p1-smoke-unverified` emitted. **All six `MICROVM_*` vars
present — all-or-nothing WITH the image confirmed:**

```
MICROVM_EGRESS_CONNECTOR_ARNS  = arn:aws:lambda:us-east-1:<account>:network-connector:nc-d306f00f-1bd0-45ea-9457-0fcec0dab2a4
MICROVM_EXECUTION_ROLE_ARN     = arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R
MICROVM_IMAGE_IDENTIFIER       = arn:aws:lambda:us-east-1:<account>:microvm-image:backgroundagent-dev-abca-agent
MICROVM_IMAGE_VERSION          = 1.0
MICROVM_INGRESS_CONNECTOR_ARNS = arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS
MICROVM_PAYLOAD_BUCKET         = backgroundagent-dev-lambdamicrovmcomputepayloadbuc-bctl5ej8aazr
```

**P1 F3 is FIXED:** `MICROVM_IMAGE_IDENTIFIER` is a full ARN, not a bare name.

---

## Phase 2 — Image

### 2.1 `create-microvm-image` — PASS with all four hooks

`package-microvm-artifact.sh` (no `--create-image`) staged and uploaded first:
**904K artifact / 922,056 bytes in S3, SSE `AES256`** (P1: 584K / 597,305 — the
P2 `server.py` growth). Then with `--create-image`, exit **0**, and the service
echoed the request back:

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

**`microvmImageHooks` with `ready` + `validate`, and `microvmHooks` with `run` +
`terminate`, are all ACCEPTED.** P1 could not test this: it never got a
four-hook image created (F1), and its `/ready`-only attempt failed the build.

The script's P2 reminder banner printed both before and after the call, and
`8192 MiB` was accepted — P1 F5's ceiling holds.

### 2.2 Build — PASS in 4 min 35 s, `/ready` **and** `/validate` served

Two builds per version again (`chipsetGeneration` 3 and 4), both `SUCCESSFUL`;
`state=SUCCESSFUL`, `status=ACTIVE`. **00:00:01Z → 00:04:36Z = 4 min 35 s**
(P1: 5 min 51 s).

The decisive evidence, from `/aws/lambda-microvms/backgroundagent-dev-abca-agent`
— **this is the item P1 F1 blocked entirely**:

```
[server/build-hook] /ready hook: server is up, reporting ready for snapshot
INFO:     127.0.0.1:52856 - "POST /aws/lambda-microvms/runtime/v1/ready HTTP/1.1" 200 OK
[server/build-hook] /validate hook: ok (python=3.13.13, platform_config_keys=13, warnings=0)
INFO:     127.0.0.1:50860 - "POST /aws/lambda-microvms/runtime/v1/validate HTTP/1.1" 200 OK
```

(both lines twice, once per chipset). Note what this proves beyond "the hooks
work": the service POSTs to **exactly** the `/aws/lambda-microvms/runtime/v1/*`
paths, confirming the fixed-route model inferred in 1.5; `/validate` reports
`platform_config_keys=13`, so the cross-package contract loaded inside the
snapshot; and `warnings=0`, so the baked-secret scan found nothing.

**P1 F4 is FIXED:** `apt-get` reached `deb.debian.org` over port 80 through the
dedicated build connector — the build log shows `Get:… http://deb.debian.org/…`
succeeding. No temporary security-group rule was needed this time.

`agent/Dockerfile` also now installs Go tooling; the build log shows
`go: downloading …` completing, so build-time egress is sufficient.

### 2.3 Sizes — P1 F13 reconfirmed and slightly worse

| Field | Bytes | Human | vs P1 |
|---|---|---|---|
| `codeInstallSizeInBytes` | 2,342,203,392 | **2.18 GiB** | 2.17 GiB |
| `memorySnapshotSizeInBytes` | 1,223,421,952 | 1.14 GiB | 1.13 GiB |
| `diskSnapshotSizeInBytes` | 34,959,360 | 33.3 MiB | 35.4 MiB |

`codeInstallSizeInBytes` still **exceeds AgentCore's 2 GB container-image
limit**, while the same tree as an OCI image is 1.803 GB / 631.1 MB compressed
(measured locally). P1 F13's "say which measure you mean" recommendation stands.
`snapshotBuild` is still only on `get-microvm-image-build`, not on the version.

---

## Phase 3 — Platform user, secret, repo onboarding

### 3.1 Cognito user — PASS, no first-login dance needed

`bgagent admin invite-user <email> --stack-name … --region …`
created the user with a **permanent** password (`UserStatus: CONFIRMED`, not
`FORCE_CHANGE_PASSWORD`), wrote credentials to
`$BGAGENT_CONFIG_DIR/invites/…txt` mode `0600`, and printed a `configure`
bundle. `bgagent configure --stack-name` + `bgagent login --username …` →
`Login successful.` **This is the answer to "find the exact bgagent commands":
`admin invite-user` is the whole first-login flow** — there is no
`RespondToAuthChallenge` step to drive, which is why P1's 7.1 blocker
("user pool has zero users") is a two-command fix, not an obstacle.

### 3.2 GitHub PAT into the stack secret — PASS on the second attempt

The token was piped from `gh auth token` straight into
`aws secretsmanager put-secret-value` and **never** written to disk, a log, or
this file.

**Operator error worth recording, because it produced a convincing false
defect.** `gh auth token` emits a trailing newline and
`--secret-string file:///dev/stdin` stores it verbatim, so the secret was **41
bytes**. My own verification used `.strip()` and reported "length 40", hiding it.
The task then failed inside the guest with:

```
RuntimeError: clone failed (non-transient): Post "https://api.github.com/graphql": net/http: invalid …
```

— i.e. an invalid HTTP header value, because the token carried `\n`. Rewriting
the secret stripped (40 bytes, no trailing whitespace) fixed the clone
immediately.

*Verification lesson:* assert on the **raw** secret, never a stripped copy:

```bash
aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --output json \
  | python3 -c 'import json,sys; s=json.load(sys.stdin)["SecretString"]; print(len(s), s!=s.strip())'
```

*Minor robustness observation (not a defect found by this run's design):* the
agent passes the secret value through to `gh`/`git` unstripped, so any
whitespace an operator introduces surfaces as a confusing `net/http` error rather
than "your token looks malformed". A `.strip()` at the token resolver would turn
a 20-minute misdiagnosis into a non-event.

### 3.3 Repo onboarding — PASS, gate and probe both behaved

`bgagent repo onboard dreamorosi/batch-sync-triage --compute-type lambda-microvm`:

```json
{ "repo": "dreamorosi/batch-sync-triage", "status": "active",
  "compute_type": "lambda-microvm", "onboarded_at": "2026-08-07T00:10:43.376Z" }
```

Both guards fired as designed and in the documented order: the **ComputeSubstrate
gate** passed because the stack output reads `lambda-microvm`, and the live
**`ListManagedMicrovmImages` availability probe** passed. The command also
printed the two ADR-021 advisory notes, including the smoke-unverified warning —
correct, and still accurate at the end of this run.

`bgagent platform doctor` → `passed: true`, **all 7 checks**, including
`Managed MicroVM images are available in us-east-1` and — because 3.2 had already
run — `GitHubTokenSecretArn contains a token value`. (P1 noted this check cannot
distinguish a real PAT from the 32-char generated placeholder; that is still
true, it just happens to be a true positive here.)

---

## Phase 4 — THE SMOKE

Five submissions. Each failure moved the boundary forward, so all five are
recorded.

| # | Task ID | Outcome | Finding |
|---|---|---|---|
| 1 | `01KZCRY70HRBP236GECR768JJX` | `FAILED` — `RunMicrovm … AccessDeniedException … iam:PassRole` | P2-F3 |
| 2 | `01KZCS6451HRPSXAG33Z4R5XRV` | identical, **with an unconditioned `iam:PassRole` attached** → so PassRole was never the real problem | P2-F3 |
| 3 | `01KZCSCD6PKDZNC8WRTFNRQG3H` | identical, 3 min after the IAM change → **not propagation lag** | P2-F3 |
| 4 | `01KZCSNM8MD4MB17ZTW1VDB6PY` | **`RUNNING`** after removing the execution-role trust condition, then `clone failed … net/http: invalid` | P2-F3 root cause proven; 3.2 token bug |
| 5 | `01KZCSVRHZXVHXQ4T29XYZKBAM` | **`RUNNING` → clone OK → branch OK → `implement` failed at turn 0** | **P2-F5** |
| 5r | `01KZCT8SWZ1DDZC7P0RYS982ES` | identical to #5 — **reproducible** | P2-F5 |

### 4.1 P2-F3 — the `iam:PassRole` deny that was really a trust-policy deny

```
Session start failed: Error: MicroVM RunMicrovm failed: AccessDeniedException: User: arn:aws:sts::<account>:assumed-role/backgroundagent-dev-TaskOrchestratorOrchestratorFnS-kyEY8iz3mrcm/backgroundagent-dev-TaskOrchestratorOrchestratorFn-huSs3tbuFbJs is not authorized to perform: iam:PassRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R because no identity-based policy allows the iam:PassRole action
```

The message is actively misleading, and the diagnosis is the useful part of this
section. The orchestrator's inline policy **does** carry the grant, exactly as
P1 4.4 recorded it:

```json
{ "Sid": "MicrovmPassExecutionRole", "Effect": "Allow", "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R",
  "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } } }
```

Elimination sequence:

1. Attached a **temporary unconditioned** `iam:PassRole` on the same resource →
   **still denied** (submission 2). So the `iam:PassedToService` condition was
   *not* the cause.
2. `aws iam get-role` → **no permissions boundary**, path `/`.
3. `aws iam simulate-principal-policy … --action-names iam:PassRole` →
   **`allowed`**, matching my temporary statement. So IAM itself says yes.
4. Waited 3 minutes and resubmitted → **still denied** (submission 3). Not
   propagation.
5. Read the **target** role's trust policy — and found the same
   `aws:SourceAccount` condition that had just broken the network connectors:

```json
{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole",
 "Condition":{"StringEquals":{"aws:SourceAccount":"<account>"}}}
{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:TagSession",
 "Condition":{"StringEquals":{"aws:SourceAccount":"<account>"}}}
```

6. Removed both conditions → **submission 4 reached `RUNNING` in 6 seconds.**

**So `RunMicrovm` reports a role it cannot pass-and-assume as an `iam:PassRole`
identity-policy denial on the *caller*.** P2-F1 and P2-F3 are therefore **one
root cause with two symptoms**: the Lambda MicroVMs service does not present
`aws:SourceAccount` when assuming ABCA's MicroVM-facing roles, so every trust
policy carrying that confused-deputy condition is unassumable.

### 4.2 THE SMOKE (submission 5) — `bgagent watch`, verbatim

```
Watching task 01KZCSVRHZXVHXQ4T29XYZKBAM... (Ctrl+C to stop)
[5:28:03 PM] ★ repo_setup_complete: branch=bgagent/01KZCSVRHZXVHXQ4T29XYZKBAM/add-a-codeowners-file-at-the-repository-root-conta build_before=False
[5:28:04 PM] ★ step:implement:start
[5:28:15 PM] ★ step:implement:failed
[5:28:15 PM] ★ agent_execution_complete: status=error turns=0
Task 01KZCSVRHZXVHXQ4T29XYZKBAM failed. timeout: Build/tests didn't finish in time (timed out) — Workflow run_agent step failed: TimeoutExpired: Command '['claude', '--version']' timed out after 10 seconds
```

**Time-to-RUNNING: ~6 s.** Submitted 00:27:09Z, `started_at`
`2026-08-07T00:27:11`, VM `startedAt` 00:27:12Z. That is materially faster than
AgentCore or ECS cold start and is the backend's main selling point — worth
recording as the one positive performance result of the run.

**`/run` accepted the envelope, and `platform_config` was installed** — the
required observation, from the guest log group:

```
[server/run-pre-config] /run hook received: microvm_id='microvm-8ad29e93-99c2-3ccc-b079-12f8bdab2936' bytes=2120
[server/debug] /run hook installed platform_config env: ['AGENT_SESSION_ROLE_ARN', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ARTIFACTS_BUCKET_NAME', 'AWS_SDK_UA_APP_ID', 'GITHUB_TOKEN_SECRET_ARN', 'LOG_GROUP_NAME', 'NUDGES_TABLE_NAME', 'TASK_APPROVALS_TABLE_NAME', 'TASK_EVENTS_TABLE_NAME', 'TASK_TABLE_NAME', 'TRACE_ARTIFACTS_BUCKET_NAME']
[server/debug] /run hook accepted task_id='01KZCSVRHZXVHXQ4T29XYZKBAM' microvm_id='microvm-8ad29e93-99c2-3ccc-b079-12f8bdab2936'
```

Everything in the P2 delivery design is confirmed here: **2,120 bytes**, so the
envelope went **inline** and stayed under the real 4,096-byte cap (P1 F6); the
installed set is **exactly the 11 available keys**, names only, no values; the
pre-install line is stdout-only (`run-pre-config`) and the post-install line is
the first to reach CloudWatch, exactly as the snapshot-credential-hygiene work
intended.

**Progress events streamed** — `repo_setup_complete`, `step:implement:start`,
`step:implement:failed`, `agent_execution_complete` all arrived live in `watch`.

**Clone → change → PR got exactly one step:** clone ✓, branch ✓,
`build_before=False` ✓ … then `implement` died at turn 0. **No commit, no push,
no PR.**

**Heartbeats: NOT observed.** `agent_heartbeat_at` was `None` at every poll
across all six submissions. The task was `RUNNING` for only ~12 s and the agent
bumps the heartbeat every 45 s, so it never had a chance to fire. **The
dual-signal liveness path is therefore NOT discharged** — see Skipped.

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

Characterisation, to separate "broken binary" from "slow substrate":

- **In the identical image, locally under finch: `claude --version` → `2.1.191
  (Claude Code)` in under 1 second.** So the binary, its symlink and `PATH` are
  all fine.
- `/usr/bin/claude` → `../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
  a **236,305,136-byte (225 MiB) statically-linked ELF**.
- The MicroVM had been restored from a snapshot ~50 s earlier and had already
  done a full `git clone` over the network.

The consistent reading is **lazy snapshot hydration**: the first `exec` of a
225 MiB binary that was never touched before the snapshot was taken must fault
its pages in from lazily-restored storage, and that exceeds 10 s. Two
independent fixes suggest themselves, and the second is the more interesting
because P2 already built the mechanism and then deliberately declined to use it:

1. Raise / make backend-aware the `timeout=10` (it is a *liveness probe for a
   version string* — a tight bound buys nothing).
2. **Warm `claude` in the `/ready` build hook so it lands in the memory
   snapshot.** P2's `/ready` deliberately does the minimum — `"server is up,
   reporting ready for snapshot"` — and its own docstring explains that `/ready`
   exists so "the snapshot is taken with a warm server". The snapshot is warm for
   *uvicorn* and stone cold for the 225 MiB binary that does all the work.

**`build_passed: true, lint_passed: false`** in the same report is incidental
noise from the scratch repo (`mise ERROR no tasks defined …`, `unknown command:
lint`) and unrelated to the substrate.

### 4.4 P2-F4 — the execution role cannot write to the application log group

Found while reading logs for F5, and independent of it. Every structured agent
log line to the log group that `platform_config` itself delivers is denied:

```
[server/debug/self] CloudWatch write failed: AccessDeniedException: … User: arn:aws:sts::<account>:assumed-role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-tF8Idpc9aT0R/Lambda-microvmsExecutor-86cfecce-… is not authorized to perform: logs:CreateLogStream on resource: arn:aws:logs:us-east-1:<account>:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev:log-stream:server_debug/01KZCSVRHZXVHXQ4T29XYZKBAM because no identity-based policy allows the logs:CreateLogStream action
```

Same denial for the `metrics/<task_id>` stream, so `METRICS_REPORT` never lands
either. P2 wired `log_group_name` into `platform_config` (making the agent
*attempt* the write) but the execution role's logs grant is scoped to
`/aws/lambda-microvms/*` only — the construct's own cdk-nag suppression says so:
*"the `MICROVM_LOG_GROUP_PREFIX/*` namespace"*.

Not fatal — the agent degrades to stdout, which the MicroVM log group captures,
which is why this run could be debugged at all. But it is a genuine smoke-parity
hole: on `lambda-microvm`, the platform's canonical per-task observability
streams are empty, and anything reading them (rather than the guest's stdout)
sees nothing. Exactly the class of grant P2 added for Bedrock, Secrets Manager
and Memory — this one was missed.

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

and the in-guest breadcrumb fired, 200 OK:

```
[server/debug] /terminate hook: {"active_pipeline_threads": 0, "background_pipeline_failed": false, "event": "microvm_terminate", "microvm_id": "", "timestamp": "2026-08-07T00:28:42.926428+00:00"}
INFO:     127.0.0.1:37364 - "POST /aws/lambda-microvms/runtime/v1/terminate HTTP/1.1" 200 OK
```

So `/terminate` is served, returns 200, reports a clean pipeline state, and does
not write terminal task status. **Note `"microvm_id": ""`** — the hook body's
`microvmId` arrives empty, unlike `/run` where it is populated. Cosmetic, but it
defeats the hook's stated purpose of joining the guest record to the
control-plane one, and the `/run` line has to carry that correlation instead
(which it does).

**P1 F8 reconfirmed:** the VM sat at `TERMINATED` for the whole observation
window; `ResourceNotFoundException` never arrived. `TERMINATED` must map to
completed in its own right.

### 5.2 `NO_INGRESS` — DISCHARGED

```
ingressNetworkConnectors = ['arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS']
egressNetworkConnectors  = ['arn:aws:lambda:us-east-1:<account>:network-connector:nc-d306f00f-1bd0-45ea-9457-0fcec0dab2a4']
```

The ARN P2 injects is **correct and effective**: the service accepted it and
`HTTP_INGRESS` (P1 F7's unrequested default public ingress) is **gone**. P1's
security finding is mitigated.

**One caveat worth carrying forward:** a `NO_INGRESS` VM **still returns a public
endpoint hostname** (`<vm-id>.lambda-microvm.us-east-1.on.aws`).
So the presence of an `endpoint` in a `RunMicrovm` response is *not* evidence of
reachability, and any doc or alarm that treats "endpoint exists" as "ingress is
open" will be wrong in both directions.

### 5.3 Dual-signal liveness — NOT DISCHARGED

`agent_heartbeat_at` stayed `None` throughout. The heartbeat interval is 45 s and
no task was `RUNNING` for more than ~13 s, because F5 kills every task at turn 0.
**This item is blocked behind P2-F5, not independently testable.** The
`heartbeatLivenessApplies` switch is `RUNNING`-scoped and never got a
long-enough `RUNNING` window to exercise.

---

## Phase 6 — Lifecycle extras

### 6.1 A run-hook 4xx **self-terminates** the VM — supersedes P1 F9

Launching a second MicroVM from the image with **no** `runHookPayload` (the image
has `run: ENABLED`) produced a result P1 could not see, because P1's only
creatable image was hook-less:

```
state       = TERMINATED
stateReason = Run lifecycle hook returned HTTP status 400. Please check your hook endpoint and application logs for more details.
```

Terminal within ~12 s of launch, and `suspend-microvm` then correctly refused:
`The MicroVM … has been terminated and its state cannot be changed.`

**P1 F9 said "hook-less MicroVMs run indefinitely and bill", and warned that
nothing self-cleans.** With `/run` ENABLED that is no longer true: **the service
reaps a VM whose run hook returns 4xx.** This materially improves the cost
posture and is a direct benefit of declaring hooks. Active `TerminateMicrovm`
remains correct for the *success* path, but the *failure* path now has a
service-side backstop.

Incidental confirmation: `executionRoleArn` must be a **full ARN** —
a bare role name is rejected with
`Member must satisfy regular expression pattern: arn:aws[a-z\-]*:iam::[0-9]{12}:role/?…`.

### 6.2 Suspend / resume on a hook-ENABLED image — PASS

To get a VM that stays `RUNNING`, a **hand-built valid envelope** (713 bytes:
`agent_payload` with `task_id`/`repo_url`/`task_description`/`resolved_workflow`
plus the four required `platform_config` keys) was passed as `runHookPayload`.
`/run` returned 200 and the VM held `RUNNING`. This is itself a useful result:
**the documented envelope shape is reproducible by hand from the contract alone.**

| Step | Latency | State | Notes |
|---|---|---|---|
| launch → `RUNNING` | ~11 s | `RUNNING`, `stateReason` `None` | |
| `suspend-microvm` | **~2 s** | `SUSPENDED` | `/suspend` hook **DISABLED** in the image |
| `resume-microvm` | **~3 s** | `RUNNING` | `/resume` hook **DISABLED** |
| `terminate-microvm` | **~3 s** | `TERMINATED`, `stateReason` `Success.` | `/terminate` hook fired, 200 OK |

`microvmId` **and** `endpoint`
(`<vm-id>.lambda-microvm.us-east-1.on.aws`) were
**byte-identical** before and after the suspend/resume cycle, and `startedAt` /
`maximumDurationInSeconds` (28800) never moved.

**This extends P1 5.3/5.6 to a hook-enabled image:** suspend and resume work
*without* `/suspend` and `/resume` being declared, so P3's interface widening is
not gated on the hooks — a stored `SessionHandle` survives a cycle here too.
`SUSPENDING` was again never observable.

### 6.3 Quota — re-probed, still NOT OBSERVABLE

`L-CD1C0CC4` "Max allocated MicroVM memory" = **1024 Gigabytes**, and critically
`UsageMetric` = **`null`**. `AWS/Usage` still exposes **only** `CallCount` per API
name (`GetMicrovm`, `CreateMicrovmImage`, `ListMicrovmImages`, …) and **no memory
metric in any namespace**. **P1 5.5's verdict is unchanged: the claim "a
suspended VM still holds account memory quota" remains NOT OBSERVABLE SAFELY and
undischarged.** Proving it would still need ~128 concurrent 8 GiB VMs.

---

## Phase 7 — Scratch repo

**Nothing to clean up, and no PR to leave open.** `dreamorosi/batch-sync-triage`
is byte-for-byte as it was found:

- Branches: `main` + the five pre-existing `dependabot/*`. **No `bgagent/*`
  branch was ever pushed** — the agent created the branch locally in the guest
  and died at `implement` before any commit or push.
- PRs: the same five open dependabot PRs (#1–#5) from 2025-11-24. **No PR was
  created by this run.**

So the instruction to leave the CODEOWNERS PR open is moot: **P2-F5 prevented any
PR from existing.** That absence is the single most important line in this
document.

---

## Phase 8 — Teardown (executed as a finally-block)

### 8.1 MicroVMs — all TERMINATED

Nine MicroVMs existed across the run (six from the six task submissions, plus
the two Phase 6 lifecycle VMs and one orchestrator retry). **All nine were
already `TERMINATED`** at teardown — every one either finalized by the
orchestrator's `TerminateMicrovm`, service-reaped after a run-hook 4xx (6.1), or
explicitly terminated in 6.2. No VM needed chasing, and none ever approached the
8 h bound.

### 8.2 Image and versions — deleted

Only one version existed (`1.0`, `ACTIVE`), so `delete-microvm-image` alone was
sufficient and reaped it. `list-microvm-images` → `{"items": []}`;
`get-microvm-image` →
`ResourceNotFoundException: MicroVMImage not found for MicroVMImageID: …`.
P1's ordering correction (delete all but the last version, then the image) was
therefore not exercised, but is not contradicted.

*Incidental:* one `ListMicrovmImages` call returned `502 Bad Gateway (reached max
retries: 2)` while the image was `DELETING`; it succeeded 30 s later. Worth
retrying rather than treating as a failure.

### 8.3 Live IAM workarounds — reverted

- Temporary unconditioned `iam:PassRole` inline policy
  (`abca645p2-verification-passrole`) **deleted** from the orchestrator role.
- The execution role's trust policy **restored** to its deployed form, i.e. with
  both `aws:SourceAccount` conditions back (verified by re-reading it). The
  defect is left exactly as the branch produces it.

### 8.4 Cognito user — deleted

`bgagent admin delete-user <email>` →
`✓ Deleted Cognito user`. `list-users` then returned **empty**. The local invite
file containing its password was `rm`'d. The GitHub-token secret was left to die
with the stack (it did).

### 8.5 Stack — DELETE_FAILED, 96/100 deleted, identical to P1's residual

Three delete attempts, and each failed differently — that progression is itself
the finding:

| Attempt | Duration | Outcome |
|---|---|---|
| 1 | 00:55:35Z → 01:04:28Z (8 min 53 s) | `DELETE_FAILED` — `AWS::BedrockAgentCore::Runtime`: `"Request timed out while deleting AWS::BedrockAgentCore::Runtime"`, `HandlerErrorCode: NotStabilized` |
| 2 (the briefed retry) | 01:04:55Z → 01:06:00Z (1 min) | `DELETE_FAILED` — same resource, **different error**: `"Access denied for operation 'AWS::BedrockAgentCore::Runtime'."`, `HandlerErrorCode: AccessDenied` |
| 3 (informed) | 01:07:02Z → 01:24:47Z (17 min 45 s) | `DELETE_FAILED` — but the Runtime, Memory and both IAM roles **did** delete; only the VPC set remains |

Attempt 3 was not a blind third retry: between attempts,
`bedrock-agentcore-control list-agent-runtimes` returned **empty**, proving the
runtime was already gone server-side and the failures were a handler
stabilization/authorization artifact rather than a real leftover. Acting on that
evidence took the residual from 7 resources to 4.

**Final residual — 4 resources, all zero-cost, exactly P1's set:**

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

Cause: the same two AgentCore-managed ENIs, still `in-use` —
`eni-04911e11e08d670f9` and `eni-04a1c5a27966ee08b`, both
`InterfaceType: agentic_ai`. **This is #702 / P1 F12 reproducing verbatim.**
Nothing was force-deleted past CloudFormation. P1's experience says these are
eventually released (its stack is gone now — see 0.1), so the retry command is:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev
aws cloudformation wait stack-delete-complete --stack-name backgroundagent-dev
```

### 8.6 Billing confirmed stopped

| Check | Result |
|---|---|
| NAT gateways in the ABCA VPC | **none** (the 2 `available` ones belong to pre-existing `vpc-01c9984d163d2965e` and were not touched — same as P1) |
| VPC endpoints in the ABCA VPC | **none** |
| ABCA S3 buckets | **none** |
| Unattached (billable) EIPs | **none** |
| MicroVM images / non-terminated VMs | **none** |
| AgentCore runtimes / memories | **none** |
| `/aws/lambda-microvms/*` log groups | **none** |

### 8.7 Environment restored — nothing global left modified

- `cdk/cdk.context.json` **restored** to the original six-AZ list (gitignored
  build artifact; `git status` shows only `docs/verification/` and the
  pre-existing `opencode.json`).
- `~/.finch/config.json` **restored** to `credsStore: osxkeychain` with **no
  stored credential**, and the Lima VM's `DOCKER_CONFIG` restored to
  `{"credsStore":"finchhost"}`; the `/root/.docker/config.json` written during
  the push investigation was removed. **The short-lived ECR token written during
  that investigation is no longer on disk anywhere.**
- The ECR tag this run added (`34fbc1d4…`) was removed with
  `batch-delete-image`, leaving the three pre-existing tags and the underlying
  manifest exactly as found.
- The finch VM was stopped, as P1 did.
- **No AWS global configuration was read or modified at any point**
  (`~/.aws/config`, `~/.aws/credentials` untouched); `~/.cdk.json` was never
  created. All credential and Region selection was via environment variables in
  the run's own shell.

### 8.8 Deliberately retained

1. **`CDKToolkit`** — `UPDATE_COMPLETE`, `ComputeTypes = agentcore,lambda-microvm`,
   `BootstrapVariant = ABCA: Least-Privilege Bootstrap`, five ABCA policies, no
   `AdministratorAccess`. Unchanged by this run. ⚠️ Still the shared-account
   caveat P1 raised: other CDK apps in `<account>` deploy through the
   ABCA-scoped execution role.
2. **`backgroundagent-dev` in `DELETE_FAILED`** — the 4 zero-cost resources in 8.5.
3. **Bootstrap S3/ECR assets** — normal bootstrap content, including the three
   pre-existing agent container images.
4. **Service-vended log groups** created outside CloudFormation
   (`/aws/bedrock-agentcore/runtimes/…`, `/aws/lambda/backgroundagent-dev-…`).
5. **`dreamorosi/batch-sync-triage`** — untouched (Phase 7).

### 8.9 Scratch repo — verified unchanged

Branches: `main` + the five pre-existing `dependabot/*`. Open PRs: #1–#5, all
dependabot. **No `bgagent/*` branch, no smoke PR.** There was nothing to close,
nothing to delete, and — because of P2-F5 — nothing to leave open for the
operator to look at.

---

## Findings summary

Live run 2026-08-06/07, account `<account>`, `us-east-1`, branch
`feat/645-lambda-microvm-p2` @ `3a4b61a9`. Evidence:
`/tmp/abca-645-p2-20260806`.

**Verdict on Stage D's primary objective: the smoke did NOT pass. No pull request
was created.** The run got to `clone ✓ → branch ✓ → implement ✗ (turn 0)`,
reproducibly, and it took four separate live workarounds to get even that far.
Every one of the five defects below is invisible to synth, unit tests and
`cdk-nag`; all five are live-service contract mismatches, which is precisely what
Stage D exists to surface.

### Items DISCHARGED (behaved as designed)

1. **`microvmImageHooks` spelling — both directions.** The API accepted
   `microvmImageHooks:{ready,validate}` + `microvmHooks:{run,terminate}` with
   timeouts, and CloudFormation resolved the identical property path
   (`…/Hooks/MicrovmImageHooks/Ready`). The open P2 item is closed.
2. **All four hooks are served and exercised.** `/ready` 200 and `/validate` 200
   (`python=3.13.13, platform_config_keys=13, warnings=0`) during the build, on
   both chipsets; `/run` 200 with the envelope; `/terminate` 200 at teardown.
   **P1 F1 — "a P1 image that declares `/run` is not creatable at all" — is
   fully fixed.**
3. **`NO_INGRESS` ARN.** Correct, accepted, and it suppresses P1 F7's default
   public `HTTP_INGRESS`. (Caveat: a public endpoint hostname is still returned.)
4. **`platform_config` delivery end to end.** 2,120-byte envelope inline under
   the real 4,096-byte cap; exactly the 11 available keys installed; names-only
   logging; pre-install logging correctly stdout-only.
5. **Image buildability.** 4 min 35 s, two builds per version, `ACTIVE`; 8192 MiB
   accepted; `apt-get`/Go egress over port 80 through the dedicated build
   connector. **P1 F4 (443-only SG) and F5 (32 GiB memory) are fixed.**
6. **`MICROVM_IMAGE_IDENTIFIER` is a full ARN — P1 F3 fixed**, and all six
   `MICROVM_*` vars appear together (all-or-nothing, both directions).
7. **`agentPlatformConfig` wiring.** 11 of 13 keys on the orchestrator; the two
   absent ones are optional per-workspace secrets, so the optional-key path is
   also verified.
8. **CLI end to end.** `admin invite-user` (permanent password — no first-login
   challenge to drive), `configure --stack-name`, `login`, `repo onboard
   --compute-type lambda-microvm` (ComputeSubstrate gate **and** live
   `ListManagedMicrovmImages` probe both pass), `platform doctor` 7/7,
   `submit`, `watch` streaming progress events.
9. **Finalization terminates the VM** (`TERMINATED`, `stateReason: Success.`).
10. **Suspend/resume on a hook-enabled image** with `/suspend` + `/resume`
    undeclared: ~2 s / ~3 s, `microvmId` **and** `endpoint` preserved.
11. **Time-to-RUNNING ≈ 6 s** — the backend's headline advantage, measured.
12. **P1 F12's stack half resolved**: the leaked AgentCore ENIs were eventually
    released and P1's `DELETE_FAILED` stack is gone.

### Items CONTRADICTING design assumptions — `feeds-back-to-design: YES`

**P2-F1 + P2-F3 (ONE root cause, two symptoms, both blocking). The
`aws:SourceAccount` confused-deputy condition makes ABCA's MicroVM-facing roles
unassumable by the Lambda MicroVMs service.**

*Symptom A — the substrate cannot deploy.* Both `AWS::Lambda::NetworkConnector`
resources `CREATE_FAILED`, deterministically, on a freshly deleted stack:

```
"The service is unable to assume the provided NetworkConnectorOperatorRole. Please verify the trust policy on the role. (Service: Lambda, Status Code: 400, Request ID: dbe1d2f4-dd0c-4319-8f5d-b4be4f076843)" HandlerErrorCode: InvalidRequest
```

Removing the condition from `ConnectorOperatorRole`'s trust → both connectors
create within a second. Note this is a **regression introduced by the P1 F2
fix**: P1's validated probe role trusted `lambda.amazonaws.com` with **no
conditions**, and the construct's comment says trust "mirrors the build/execution
roles (`lambda.amazonaws.com` + `aws:SourceAccount`)" — which is exactly what
breaks it.

*Symptom B — no task can start.* `RunMicrovm` fails with a misleading
`iam:PassRole` denial **on the caller**, even though the orchestrator's grant is
present and `simulate-principal-policy` returns `allowed` and there is no
permissions boundary. Proven by elimination (unconditioned `iam:PassRole` still
denied; 3-minute wait still denied); removing the **execution role's** trust
conditions made the very next submission reach `RUNNING` in 6 s.

Both the build role and the execution role carry the same pattern, so the fix is
one decision applied consistently: **drop `aws:SourceAccount` from every
MicroVM-facing role's trust policy, or find the condition key the service does
present** (`aws:SourceArn`/`aws:SourceAccount` are simply not populated on this
path). Note the *identity-side* `iam:PassedToService: lambda.amazonaws.com`
condition on the orchestrator was never shown to be wrong — it was exonerated by
step 1 and can stay.

**P2-F2. The `CfnMicrovmImage` L1 is rejected by CloudFormation on five values —
the CDK-managed image path does not work at all.** Verbatim early-validation
output is in 1.5. `arm64` must be `ARM_64`; all four hooks must be
`ENABLED`/`DISABLED`, not paths. This **refutes the construct's stated reasoning**
that the L1 could keep CloudFormation's "path/string shape" because the generated
types "document no architecture/hook allowed-value constraint" — the service
enforces the enum at change-set time. Consequences: (a) the documented
"CDK-managed (recommended)" bootstrap path in
`cdk/scripts/package-microvm-artifact.sh` is currently non-functional and the
"out-of-band alternative" is the *only* working path; (b) hook paths are not
configurable on either surface, so the `*_HOOK_PATH` constants are agent route
constants only and must never be sent as property values.

**P2-F4. The MicroVM execution role cannot write to the application log group
that `platform_config` tells the agent to use.** `logs:CreateLogStream` denied on
`/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev`
for both the `server_debug/<task_id>` and `metrics/<task_id>` streams, because
the role's logs grant is scoped to `/aws/lambda-microvms/*`. P2 delivered
`log_group_name` (so the agent *attempts* the write) without the matching grant —
the same omission class the P2 Bedrock/Secrets/Memory grants were added to fix.
Non-fatal (stdout fallback lands in the MicroVM log group) but the canonical
per-task observability streams are empty on this backend, including
`METRICS_REPORT`.

**P2-F5. `claude --version` times out after 10 s inside the MicroVM, failing
every task at turn 0. This is the blocker that prevented the PR.** Reproduced on
two consecutive submissions:

```
TimeoutExpired: Command '['claude', '--version']' timed out after 10 seconds
```

`agent/src/runner.py:476` uses `timeout=10`. The binary is fine: in the identical
image locally it answers `2.1.191 (Claude Code)` in **under 1 s**. It is a
**225 MiB (236,305,136-byte) statically-linked ELF** whose pages were never
touched before the snapshot was taken, exec'd on a guest restored ~50 s earlier —
consistent with lazy snapshot hydration. Two fixes: raise/make backend-aware the
timeout (a version-string probe gains nothing from a tight bound), and — more
interestingly — **warm `claude` in the `/ready` build hook**, which exists
precisely so "the snapshot is taken with a warm server" but currently warms only
uvicorn while leaving the 225 MiB binary that does all the work cold.

**P2-F6. P1 F9 is superseded, in the safe direction.** With `run: ENABLED`, a
run-hook 4xx makes the **service** terminate the VM
(`stateReason: "Run lifecycle hook returned HTTP status 400."`) within ~12 s. P1's
"hook-less MicroVMs run indefinitely and bill; nothing self-cleans" no longer
describes this image. Worth correcting in ADR-021, because it changes the
cost-risk argument for the failure path.

**P2-F7. Template size is at 98.4 % of the CloudFormation 1 MB limit**
(983,796/1,000,000) and 486/500 resources with the image configured. ~16 KB of
headroom — roughly one more construct before deploys start failing for reasons
unrelated to MicroVMs.

**P2-F8. Runbook/tooling corrections (lower severity, but each would corrupt a
future pass).**

- **P1 F14's `--no-paginate` remedy is wrong and silently truncating.** At 485
  resources it returns only the first page, resolved `ORCHESTRATOR_FN` to the
  literal `None`, and produced `Function not found: …:function:None`. Let the CLI
  paginate and filter client-side.
- **P1 F10's "recurs forever" half is wrong**: `BootstrapVariant` now reads
  `ABCA: Least-Privilege Bootstrap`, because P1's own
  `update-stack --use-previous-template` with only `ComputeTypes` supplied resets
  unspecified parameters to template defaults. The silent-`exit 0` half stands.
- **`--execution-role-arn` requires a full ARN** (regex in 6.1); a bare role name
  is rejected.
- **`zsh`**: `"$VAR:latest"` is the `${VAR:l}` lowercase modifier (cost one
  mis-diagnosed push); no `PIPESTATUS` (it is `$pipestatus`, 1-indexed), so P1's
  `test "${PIPESTATUS[0]}" -eq 0` silently evaluates empty; no `timeout(1)`.
- **Verify secrets on the raw value, never a `.strip()`ed copy** — a trailing
  newline from `gh auth token` produced a convincing false clone defect (3.2).
- **`finch` cannot push to ECR on this box**: `finch push` runs
  `limactl shell finch sudo -E nerdctl push` and the VM's `DOCKER_CONFIG` uses
  the `finchhost` creds helper, which cannot resolve an Isengard
  `credential_process`; a host-side `finch login` does not help. Both `push` and
  `pull` fail with `no basic auth credentials`.
- The `/terminate` hook body's **`microvmId` arrives empty** (`"microvm_id": ""`),
  defeating the hook's stated guest↔control-plane correlation purpose.
- **`ARTIFACTS_BUCKET_NAME` and `TRACE_ARTIFACTS_BUCKET_NAME` resolve to the same
  bucket**, making that separation notional.

### Items SKIPPED, BLOCKED, or INCONCLUSIVE

| Item | Verdict | Reason |
|---|---|---|
| **clone → change → PR (the point of Stage D)** | **FAILED — no PR** | P2-F5, reproduced twice. Stopped at two retries as briefed. |
| Dual-signal liveness / `agent_heartbeat_at` fresh during RUN | **BLOCKED behind P2-F5** | Heartbeat interval is 45 s; no task stayed `RUNNING` beyond ~13 s. `agent_heartbeat_at` was `None` on all six submissions. Not independently testable until F5 is fixed. |
| Suspend TTL beyond P1's ≥1 h floor | **SKIPPED (time-boxed)** | Would have added 2 h+ of wall clock for a marginal bound after ~2.5 h already spent on five blocking defects. P1's result stands unchanged: **survives ≥ 1 h 0 min 17 s with no `idlePolicy`**; a TTL between 1 h and the 8 h `maximumDurationInSeconds` bound remains **OPEN**. |
| SUSPENDED VM consumes account memory quota | **STILL NOT OBSERVABLE — undischarged** | Re-probed: `L-CD1C0CC4` = 1024 GB with `UsageMetric: null`; `AWS/Usage` has only `CallCount`; no memory metric in any namespace. Identical to P1 5.5. |
| CDK-managed `CfnMicrovmImage` deploy | **REFUTED (P2-F2)** | Fell back to the out-of-band script path, as the brief directed. |
| AgentCore container asset push | **WORKED AROUND** | finch/ECR auth (deviation 2). ECR manifest retagged; irrelevant to the MicroVM image under test. |
| P1 F11 (AgentCore-unsupported AZ) | **STILL UNFIXED** | `agent-vpc.ts` unchanged; worked around via the gitignored AZ context cache, restored at teardown. |
| P1 F12 Memory-delete half | **STILL UNFIXED** | `AWS::BedrockAgentCore::Memory` still undeletable while `CREATING`; still turns a rollback into `ROLLBACK_FAILED`; plain `delete-stack` still clears it. |
| Orchestrator-role IAM negatives | **NOT ATTEMPTED** | P1 5.0 established the Lambda trust does not allow operator assumption; trust was not modified for this purpose. |

### Elapsed and approximate cost

**Elapsed:** 22:38Z → 01:26Z ≈ **2 h 48 min**. Roughly: ~35 min on the finch/ECR
push dead end and the ECR-retag workaround; ~40 min on the five deploy attempts
plus two `ROLLBACK_FAILED`/`delete-stack` cycles; ~10 min on image create+build;
~35 min on the six submissions and the P2-F3 elimination sequence; ~10 min on
lifecycle extras; ~30 min on teardown (three delete attempts); the remainder on
evidence capture and this document.

**Approximate cost: well under US$5**, dominated as in P1 by NAT/VPC-endpoint
hours rather than MicroVMs.

| Item | Quantity | Est. |
|---|---|---|
| NAT gateway (1 × $0.045/h) | ~1.6 h across 3 stack lifetimes | ~$0.08 |
| Interface VPC endpoints (7 × $0.01/h × 2 AZ) | ~1.6 h | ~$0.22 |
| MicroVM runtime | 9 VMs, all short-lived (~12 s to ~3 min each); longest suspended window ~1 min | < $0.10 |
| MicroVM image builds | 2 builds (1 version × 2 chipsets), ~4.5 min each | low single-digit cents |
| Snapshot/image storage | ~3.6 GiB × ~1 h | negligible |
| AgentCore runtime + Memory | created 3×, **never invoked** | negligible |
| Bedrock | **zero model tokens** — every task died before turn 1 | $0 |
| S3 / DynamoDB / Lambda / API GW / Cognito / Secrets / logs | brief, mostly idle | < $1 |

The 8 h `maximumDurationInSeconds` was never approached; every VM was either
explicitly terminated or service-reaped.

### Recommended follow-up before P2 is called complete

Ordered by what unblocks what:

1. **P2-F1/F3** (`aws:SourceAccount` on MicroVM-facing role trust) — nothing
   deploys or runs without this. One decision, three roles.
2. **P2-F5** (`claude --version` timeout) — nothing *completes* without this. It
   is the only thing between this run and a PR, and the `/ready`-warming option
   is worth considering on its merits rather than just raising the timeout.
3. **P2-F2** (L1 enum values) — the documented recommended path is dead until
   fixed; five one-word changes plus the tests that assert the old strings.
4. **P2-F4** (application-log-group grant) — cheap, and it is what makes the next
   failure debuggable through the platform rather than through guest stdout.
5. **P2-F7** (template size) — unrelated to MicroVMs but it will bite soon.
6. Re-run Stage D after 1–2. The dual-signal-liveness item and the suspend-TTL
   extension both need a task that stays `RUNNING` for minutes, which only F5's
   fix provides.

---

## Stage D-redux (run 2)

Narrow re-run on branch `feat/645-lambda-microvm-p2` @
`b927d1d6a58e2b040c2ed4ce4e9f1dc9be9fc981` — the commit that fixed P2-F1..F5
against run 1's evidence. **Purpose: convert "fixed-against-evidence" into
"re-exercised live", and get the pull request.**

**Live run:** 2026-08-07 02:58Z → 04:55Z (≈1 h 57 min), account `<account>`,
`us-east-1`. Evidence directory: `/tmp/abca-645-p2r2-20260806`.

**Teardown: complete.** Live IAM workaround reverted, Cognito user deleted, image
+ version deleted, ECR retag removed, AZ context cache restored, 481/485 stack
resources deleted (4 zero-cost residual, #702), **all billable resources confirmed
gone**, and no global/host configuration touched. Both smoke PRs left open as
briefed. See 2.12.

> **Provenance note — HEAD moved mid-run, from outside this run.** Preflight
> confirmed `HEAD = b927d1d` with a clean tree at 02:58Z. At **03:04Z** an
> unrelated user commit landed on the branch — `045722c fix(deps): refresh
> js-yaml lock entry to 4.3.1`, **`yarn.lock` only, 3 insertions / 3 deletions**.
> No `git` write command was issued by this run, and `b927d1d` remains an
> ancestor of `HEAD`. **It cannot have affected any finding:** `mise run install`
> / `yarn install` was never re-run, so `cdk/node_modules` still reflected
> `b927d1d`'s lock for every synth and deploy; the MicroVM artifact is built from
> `agent/` + `contracts/` + `agent/Dockerfile` (Python/uv), which the commit does
> not touch. Every verdict below is therefore against `b927d1d`'s tree.

### 2.0 Headline

> **THE SMOKE PASSED. `https://github.com/dreamorosi/batch-sync-triage/pull/6`**
> — clone → change → commit → push → PR, `COMPLETED`, 12 turns, $0.279, 153 s.
> Run 1's single most important line ("no PR was created") is retired.

But the PR required **one live IAM workaround**, and establishing *why* produced
the run's most consequential result: **P2-F3 is NOT fixed, and run 1's
exoneration of its identity-side condition was a false negative.** Two of the
five P2 fixes are fully discharged, two are discharged, one is refuted, and one
brand-new blocking defect was found on the path run 1 never reached.

| Fix | Run-1 verdict | Run-2 live verdict |
|---|---|---|
| **P2-F1** (connector trust) | blocking | ✅ **DISCHARGED** — substrate deployed **first try**, zero workarounds, 0 `CREATE_FAILED` in 485 resources |
| **P2-F2** (`ARM_64`/`ENABLED` enums) | REFUTED at change-set validation | ✅ **DISCHARGED** — early validation **passed**, resource reached `CREATE_IN_PROGRESS` |
| **P2-F3** (`RunMicrovm` PassRole) | blocking; "trust was the sole cause" | ❌ **NOT FIXED (P2r2-F10)** — isolated to the *identity-side* `iam:PassedToService` condition run 1 explicitly exonerated |
| **P2-F4** (application-log grant) | blocking observability | ✅ **DISCHARGED** — `server_debug/`, `metrics/` **and** `trajectory/` streams exist, with content |
| **P2-F5** (`claude` warm-up) | **the blocker** — no PR | ✅ **DISCHARGED** — cold `claude` measured at **17–38 s**, warm **0.1 s**, `/ready` 200, no 503 |
| *(new)* **P2r2-F9** | not reachable in run 1 | ❌ CDK-managed image path blocked: bootstrap `IAMPassRole` denies the build role to CloudFormation |
| *(new)* **P2r2-F11** | mis-attributed in run 1 | ⚠️ `agent_heartbeat_at` is never projected into the API response |
| Dual-signal liveness | BLOCKED behind F5 | ✅ **DISCHARGED** — 45 s cadence observed live over a 181 s `RUNNING` window |

### 2.1 Deltas from run 1's setup

```bash
export SMOKE_USER="<email>"
export EVIDENCE_DIR=/tmp/abca-645-p2r2-20260806
export BGAGENT_CONFIG_DIR=/tmp/abca-645-p2r2-bgagent
```

Everything else — the zsh traps, `set -o pipefail`, explicit `AWS_REGION`,
newest-first version ordering — carried over unchanged and all of it still
applies. Two run-1 notes paid for themselves immediately: the **raw-secret
assertion** (2.6) and **client-side pagination** for `TaskOrchestrator` lookup.

`bgagent` was invoked as `node cli/lib/bin/bgagent.js` after
`mise //cli:compile` (there is no linked binary in this tree).

### 2.2 Preflight — run 1's residual had to be cleared first, and it did not clear itself

`backgroundagent-dev` was still `DELETE_FAILED` with run 1's exact 4-resource
residual, and **the two `agentic_ai` ENIs were still `in-use` 1 h 32 min later**
(`eni-04911e11e08d670f9`, `eni-04a1c5a27966ee08b`, both requester `amazon-aws`,
`InstanceOwnerId: amazon-aws`), while
`bedrock-agentcore-control list-agent-runtimes` and `list-memories` both returned
**empty**. So the ENIs outlive the resources that created them by a wide margin.

Run 1's documented retry command was executed verbatim and **failed again after
17 min 17 s** (02:58:41Z → 03:15:58Z):

```
The following resource(s) failed to delete: [AgentVpcRuntimeSG96507CD0, AgentVpcPrivateSubnet1Subnet8051BB57, AgentVpcPrivateSubnet2SubnetC66971D0].
```

**Correction to run 1's §8.5 advice.** Run 1 concluded from P1's experience that
"these are eventually released, so the retry command is `delete-stack`". That is
true on a multi-day horizon and **useless on a same-session horizon** — a
17-minute retry that fails identically is not a remedy. The remedy that works is
`--retain-resources`, which cleared the stack record in **33 seconds**:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev \
  --retain-resources AgentVpcA6796801 AgentVpcPrivateSubnet1Subnet8051BB57 \
                     AgentVpcPrivateSubnet2SubnetC66971D0 AgentVpcRuntimeSG96507CD0
```

Note the VPC (`CREATE_COMPLETE`, never attempted) must be listed alongside the
three `DELETE_FAILED` children or the delete fails on it. Cost: an orphaned
zero-cost VPC + 2 subnets + 1 SG, now outside CloudFormation's knowledge (2.12).

*Unchanged from run 1:* `CDKToolkit` `UPDATE_COMPLETE`, `ComputeTypes =
agentcore,lambda-microvm`, `BootstrapVariant = ABCA: Least-Privilege
Bootstrap`, bootstrap SSM version `32`, five ABCA policies, no
`AdministratorAccess` — so **no re-bootstrap was run**. That decision turns out
to matter; see P2r2-F9.

**Managed base image** — still exactly one in `us-east-1`,
`arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`, versions `1` (newest
first) and `0`. Selected `1`; the service echoed `baseImageVersion: "1.0"`.

**P1 F11 is still UNFIXED** (`agent-vpc.ts` is still `maxAzs: 2` with no AZ
constraint, `us-east-1a` is still `use1-az6`), so the gitignored
`cdk/cdk.context.json` AZ cache was trimmed to lead with `us-east-1b`/`us-east-1c`
again, saved to `$EVIDENCE_DIR/cdk.context.json.ORIGINAL`, and **restored at
teardown**. `git status` stayed clean throughout.

### 2.3 The AgentCore container asset — retag workaround reused, and the tag had moved

`finch` still cannot push to ECR (run 1 deviation 2 — the Lima VM's
`credsStore: finchhost` cannot resolve an Isengard `credential_process`). The
required asset tag was **`7a71005f…`, not run 1's `34fbc1d4…`**, because
`b927d1d` grew `agent/src/server.py`; run 1's tag had been correctly removed at
its teardown. The same `aws ecr put-image` retag was applied to the existing
manifest `sha256:cdf5436a…`:

```
{"imageDigest": "sha256:cdf5436ab8d9d17bcd5b555ad22c52b4e6d6622f1fc0373cdc97a73c3eb8e6a4",
 "imageTag": "7a71005fe6f520a2741cdd1fb2a47ffa919b13e63476226ec39bc66eb4c150c5"}
```

Same caveat, restated because it is easy to lose: **the deployed AgentCore
runtime therefore carries a stale agent image, and nothing in this run depends on
it** — the smoke runs on the MicroVM substrate built from the S3 zip. The finch VM
was never started this run, and `~/.finch/config.json` was never touched
(verified still `credsStore: osxkeychain` with no stored credential).

### 2.4 Substrate deploy — P2-F1 DISCHARGED, first try, zero workarounds

Synth: `abca:microvm-image-not-provisioned` emitted, `…-p1-smoke-unverified`
correctly absent. Deploy `03:19:25Z → 03:33:59Z = 14 min 34 s`, **`EXIT=0` on the
first attempt**, 485 resources.

**This is the whole of P2-F1's verification and it is unambiguous.** Run 1 needed
five attempts and a `/tmp` cloud-assembly trust-policy patch to get here. Run 2
needed none:

```
2026-08-07T03:21:47Z LambdaMicrovmComputeEgressConnector9C36AAC2      CREATE_IN_PROGRESS
2026-08-07T03:21:48Z LambdaMicrovmComputeBuildEgressConnector3B762F80 CREATE_IN_PROGRESS
2026-08-07T03:26:05Z LambdaMicrovmComputeEgressConnector9C36AAC2      CREATE_COMPLETE
2026-08-07T03:26:06Z LambdaMicrovmComputeBuildEgressConnector3B762F80 CREATE_COMPLETE
```

and a scan of every stack event for `*FAILED` returned **`NONE`**. The live trust
policies on both the execution and build roles read exactly as source intends —
`lambda.amazonaws.com`, `sts:AssumeRole` + `sts:TagSession`, **no conditions**.

All seven MicroVM outputs populated; `ComputeSubstrate = lambda-microvm`;
artifact key exactly `microvm-images/agent-artifact.zip`.

**P2-F7 reconfirmed and marginally worse:** 979,867 B / 485 resources (substrate),
**985,886 B / 486** with the image — **98.6 %** of the 1 MB limit, ~14 KB of
headroom. Down from run 1's ~16 KB.

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

**P2-F2 is DISCHARGED.** Change-set early validation **passed** — zero
`not a valid enum value` errors, no `Early validation failed` — and the resource
progressed to `CREATE_IN_PROGRESS`. Run 1's §1.5 refutation is fully answered and
the enum fix is correct on the CloudFormation surface.

It then failed on something run 1 could never have seen, because run 1 never got
past early validation:

```
LambdaMicrovmComputeImage16B48539  CREATE_FAILED
Resource handler returned message: "User: arn:aws:sts::<account>:assumed-role/cdk-hnb659fds-cfn-exec-role-<account>-us-east-1/AWSCloudFormation is not authorized to perform: iam:PassRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeBuildRoleF0-9FxjQbiJC3px because no identity-based policy allows the iam:PassRole action (Service: LambdaMicrovms, Status Code: 403, Request ID: f8c45ab5-49c4-42fd-ac61-a6a3ac00dc26) (SDK Attempt Count: 1)" HandlerErrorCode: AccessDenied
```

`UPDATE_ROLLBACK_COMPLETE`; the substrate survived intact (all seven outputs still
populated), so this cost one deploy cycle and nothing else.

**Diagnosis — and it is NOT a stale bootstrap.** The live
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
`iam:PassedToService=lambda.amazonaws.com` and **`implicitDeny`** with no context
— so the resource is right and the *condition* is the only remaining variable.

**The control that makes this airtight:** the out-of-band `--create-image` path
(2.6) passed **the same build role** to the same service successfully, using
operator credentials that carry no such condition. So the build role's trust is
fine and the service can assume it; the denial is genuinely caller-side.

This directly contradicts the construct's own accounting, which asserts
`buildRole` is passed "via the bootstrap `infrastructure` policy's `IAMPassRole`"
— live, it is not.

*Incidental:* **CloudTrail has no `lambda-microvms` events at all** for this run
(`lookup-events` across the window returns nothing for `CreateMicrovmImage` /
`RunMicrovm`). The service appears not to emit management events yet, which is why
the actual `iam:PassedToService` value cannot simply be read out of a log — every
determination in this section had to be made by elimination.

### 2.6 Image + build — P2-F5 DISCHARGED, with numbers

Artifact: **935,874 bytes**, SSE `AES256` (run 1: 922,056). `--create-image` exit
**0**; the service echoed `ARM_64`, `minimumMemoryInMiB: 8192`, all four hooks
`ENABLED`, and `readyTimeoutInSeconds: 300`.

Build `03:42:53Z → 03:47:23Z = 4 min 30 s`, both chipsets
(`GRAVITON` generation `3` and `4`) `SUCCESSFUL`, `state=SUCCESSFUL`,
`status=ACTIVE`. **The warm-up cost the build ~22 s** versus run 1's 4 min 35 s
hook-less-warm-up baseline — an outstanding trade for what it buys.

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

**Four independent things are proven here, and three of them are new:**

1. **The lazy-hydration diagnosis was correct, and now it is measured.** A cold
   `exec` of the 225 MiB `claude` binary takes **17.1–37.8 s**. Run 1 inferred
   this from a 10 s timeout; run 2 has the number. **`timeout=10` could never
   have passed** — it was 2–4× short.
2. **The warm-up works.** The same binary in the same guest answers in **0.1 s**
   once its pages are faulted in. That is the mechanism doing exactly what the
   `/ready` docstring claims.
3. **The service issues `/ready` three times per build, and the first two run
   concurrently.** Both concurrent calls warm `claude` simultaneously and contend
   (17.2 s and 37.8 s in the same stream). Worst-case single call ≈ 37.8 + 0.0 +
   6.4 ≈ **44 s**. So the 120 s required budget carries ~3.2× margin and the move
   from `readyTimeoutInSeconds` 60 → 300 was not merely defensive — a 60 s hook
   budget would have had ~16 s of slack against a contended cold start.
4. **No 503, ever.** The "required warm-up failed" path never fired, and
   `/validate` still reports `platform_config_keys=13, warnings=0`.

*Not re-captured:* the 2.3 size table (`codeInstallSizeInBytes` etc.) — the image
was deleted at teardown before those fields were read. Run 1's figures stand;
this run adds nothing to or against P1 F13.

**Wired deploy** with `--context microvm_image_identifier=<ARN>`:
`03:48:34Z → 03:53:37Z = 5 min 3 s`, `UPDATE_COMPLETE`.

**`MICROVM_*` is FIVE vars this run, not run 1's six**, and that is **correct by
design**: `MICROVM_IMAGE_VERSION` is emitted only when the optional
`microvm_image_version` context is supplied (`agent.ts:245` →
`task-orchestrator.ts:467`), and the construct documents its absent state as
"let the service pick". Run 1 recorded six because it supplied the version.
Not a regression — but worth stating, because "all-or-nothing" is asserted of the
`MICROVM_*` block and the version is the one member that legitimately opts out.

`platform_config` wiring reconfirmed at **11 of 13** keys, with
`LINEAR_OAUTH_SECRET_ARN` / `JIRA_OAUTH_SECRET_ARN` correctly absent.

**P2-F4's grant is present on the live execution role** — the second statement is
new versus run 1:

```json
{ "Action": ["logs:CreateLogStream","logs:PutLogEvents"],
  "Resource": "arn:aws:logs:us-east-1:<account>:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev:*",
  "Effect": "Allow" }
```

### 2.7 Platform user, secret, onboarding — all PASS

`admin invite-user` → `CONFIRMED` with a permanent password; `configure
--stack-name`; `login` → `Login successful.` Exactly run 1's two-command flow.

**The PAT was written correctly this time** — `gh auth token | tr -d '\n\r'` into
`--secret-string file:///dev/stdin`, then asserted on the **raw** value per run
1's §3.2 lesson:

```
len 40 differs_from_stripped False prefix gho_
```

Run 1's self-inflicted 41-byte defect did not recur. `repo onboard
--compute-type lambda-microvm` → `status: active`, both the ComputeSubstrate gate
and the live `ListManagedMicrovmImages` probe passing; `platform doctor` → **7/7**.

### 2.8 THE SMOKE — five submissions, and the last two are an experiment

| # | Task ID | Orchestrator `iam:PassRole` grant in force | Settle | Outcome |
|---|---|---|---|---|
| 1 | `01KZD5SZ55N707GMWY14P09JGR` | **source only** (exact ARN + `iam:PassedToService`) | ~2.5 min | `FAILED` — PassRole denial |
| 2 | `01KZD61FHYH3QT774PFETDNVKY` | + unconditioned, exact ARN | 20 s | `FAILED` — identical |
| 3 | `01KZD6D95P5VXJTJ06BFJXF8J6` | + unconditioned, `backgroundagent-dev-*` | 3.5 min | ✅ **`RUNNING` in 5 s → `COMPLETED` → PR #6** |
| 4 | `01KZD71DJSTGZK2A91MZJ8GFHJ` | **source only** (workaround removed) | **5 min** | `FAILED` — identical → **control** |
| 5 | `01KZD7D7HD3CT2APBT3DH12XFE` | + unconditioned, **exact ARN** (source's resource) | **5 min** | ✅ **`RUNNING` in 9 s → `COMPLETED` → PR #7** |

**Submissions 4 and 5 are the isolation experiment, and they are the most
important result in this document.** Same exact-ARN resource as source, same
5-minute settle, one variable — the `iam:PassedToService: lambda.amazonaws.com`
condition. With it: denied. Without it: `RUNNING` in 9 s. See P2r2-F10.

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

Final record: `status COMPLETED`, `duration_s 153.4`, `cost_usd 0.279`,
`turns_completed 12`, `build_passed true`, `lint_passed false`,
`session_id microvm-082ebde7-…`. **Time-to-`RUNNING` 5 s**, confirming run 1's
headline performance result on a task that actually finishes.

*Minor inconsistency worth a glance:* `watch` prints
`agent_execution_complete: turns=22` while the persisted record and
`METRICS_REPORT` both say `turns: 12`. Two different notions of "turn" (SDK
messages vs. counted iterations) surfaced under one word in the same stream.

*Incidental, both tasks:* `lint_passed: false` is scratch-repo noise
(`tsc: not found`, `biome` schema mismatch, `mise ERROR no tasks defined`), and
the agent correctly reasoned about it as pre-existing before proceeding.

#### 2.8.2 P2-F4 — DISCHARGED with content, not just stream existence

The brief's test was whether `server_debug/<task_id>` now *exists*. It does, and
so does more:

```
metrics/01KZD6D95P5VXJTJ06BFJXF8J6
server_debug/01KZD6D95P5VXJTJ06BFJXF8J6
server_debug/server
trajectory/01KZD6D95P5VXJTJ06BFJXF8J6
```

All three per-task streams were `AccessDenied` in run 1. `server_debug` carries
the `/run` breadcrumbs — including the **11-key** `platform_config` install line,
names only — and `metrics/<task_id>` carries the `METRICS_REPORT` that run 1 lost
entirely:

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

Polled **against DynamoDB** during submission 5's `RUNNING` window:

| Wall clock | Status | Running for | `agent_heartbeat_at` | Freshness |
|---|---|---|---|---|
| 04:25:11Z | `RUNNING` | 71 s | `2026-08-07T04:24:47Z` | 24 s |
| 04:25:38Z | `RUNNING` | 99 s | `2026-08-07T04:25:32Z` | **6 s** |
| 04:26:05Z | `RUNNING` | 126 s | `2026-08-07T04:25:32Z` | 34 s |
| 04:26:33Z | `RUNNING` | 153 s | `2026-08-07T04:26:17Z` | 16 s |
| 04:27:00Z | `COMPLETED` | 181 s | `2026-08-07T04:26:17Z` | 44 s |

Successive values are `04:24:47 → 04:25:32 → 04:26:17`: **exactly the 45 s
`_HEARTBEAT_INTERVAL_SECONDS` cadence**, freshness never worse than 34 s while
`RUNNING`. **The dual-signal liveness path is DISCHARGED on `lambda-microvm`** —
`heartbeatLivenessApplies` has a real, fresh signal to read. Progress events
streamed live in `watch` concurrently (2.8.1).

**But this only became visible by reading DynamoDB directly.** `bgagent status`
reported `agent_heartbeat_at = None` on every poll of *both* completed tasks —
including submission 3, whose stored value was `2026-08-07T04:09:39Z`, 12 s before
`completed_at`. Cause: `toTaskDetail` (`cdk/src/handlers/shared/types.ts:786`)
never maps the field, though `TaskRecord` declares it at line 95 and
`orchestrator.ts` consumes it for liveness. See P2r2-F11 — and note this makes
run 1's "heartbeats NOT observed" partly a measurement artifact rather than a
pure consequence of P2-F5.

### 2.9 Lifecycle — PASS

Both smoke MicroVMs finalized cleanly: `state TERMINATED`, `stateReason
Success.`, `maximumDurationInSeconds 28800` never approached. `NO_INGRESS`
reconfirmed on both, and **run 1's caveat holds** — a `NO_INGRESS` VM still
returns a public endpoint hostname
(`76cfed33-…lambda-microvm.us-east-1.on.aws`), so "an endpoint exists" remains no
evidence of reachability.

`list-microvms` showed **11** VMs, all `TERMINATED` — run 1's 9 plus this run's 2,
so the list is cumulative across runs and none of run 1's ever resurfaced.

### 2.10 Not attempted this run

Deliberately out of the narrow scope: suspend/resume and suspend-TTL (run 1 §6.2
covered a hook-enabled image), the SUSPENDED-vs-quota probe (still
`UsageMetric: null` territory), and run 1's §6.1 run-hook-4xx self-termination
(P2-F6 — already recorded, and `b927d1d` corrected the ADR for it).

### 2.11 Scratch repo — TWO PRs left open

```
#7 docs(contributors): add CONTRIBUTORS.md  | bgagent/01KZD7D7HD3CT2APBT3DH12XFE/…
#6 chore(github): add CODEOWNERS file       | bgagent/01KZD6D95P5VXJTJ06BFJXF8J6/…
#1–#5 pre-existing dependabot PRs
```

**#6 is the briefed smoke and is left open as instructed.** **#7 is a by-product
of the 2.8 isolation experiment** (submission 5 needed a task that would actually
run, and a second distinct file avoided colliding with #6) and is left open
alongside it rather than closed, so the evidence for the experiment survives.
Two `bgagent/*` branches were pushed; `main` is untouched.

### 2.12 Teardown (executed as a finally-block)

| Step | Result |
|---|---|
| **Live IAM workaround** | `abca645p2r2-verification-passrole` **deleted** from the orchestrator role; `list-role-policies` shows only the CDK-managed default policy. **No trust policy was modified at any point this run** (verified: execution role still `sts:AssumeRole` + `sts:TagSession`, conditionless, exactly as source produces). |
| **MicroVMs** | All 11 `TERMINATED` before teardown began; none needed chasing. |
| **Image + version** | Single version `1.0`; `delete-microvm-image` → `DELETING`, reaped it. |
| **Cognito user** | `admin delete-user` → `✓ Deleted`; `list-users` → `[]`; invite file `rm`'d. |
| **Secret** | Left to die with the stack. |
| **`cdk/cdk.context.json`** | **Restored** to the original six-AZ list; `git status` shows only `docs/verification/` + pre-existing `opencode.json`. |
| **ECR retag** | `7a71005f…` removed with `batch-delete-image`; pre-existing tags and the underlying manifest untouched. |
| **finch** | Never started this run; `~/.finch/config.json` never touched (still `credsStore: osxkeychain`, no stored credential). |
| **Global/host config** | **`~/.aws/*` never read or modified.** All credential and Region selection via environment variables in the run's own shell. `~/.cdk.json` never created. |

**Stack — two delete attempts, ending at run 1's exact residual:**

| Attempt | Window | Outcome |
|---|---|---|
| 1 | 04:29:02Z → 04:37:24Z (8 min 22 s) | `DELETE_FAILED` — `AWS::BedrockAgentCore::Runtime`: `"Request timed out while deleting AWS::BedrockAgentCore::Runtime"`, `HandlerErrorCode: NotStabilized`. **19** resources left. |
| 2 (informed) | 04:37:50Z → 04:55:17Z (17 min 27 s) | `DELETE_FAILED` — but the Runtime, Memory, all IAM roles, all DynamoDB tables, the S3 bucket and the secret **did** delete. **4** resources left. |

Attempt 2 was not a blind retry: `bedrock-agentcore-control list-agent-runtimes`
returned **empty** first, proving the runtime was already gone server-side and the
failure was a handler stabilization artifact. **Run 1's attempt-3 technique
reproduced exactly and is confirmed as the right procedure** — it took the
residual from 19 to 4.

**Final residual — 4 resources, all zero-cost, identical in shape to run 1 and P1:**

```
CREATE_COMPLETE  AWS::EC2::VPC            vpc-07dad8897791f477b
DELETE_FAILED    AWS::EC2::Subnet         subnet-09a1ff1f7568d05ef
DELETE_FAILED    AWS::EC2::Subnet         subnet-068397b48a25bf13f
DELETE_FAILED    AWS::EC2::SecurityGroup  sg-05e3f48665c47b358
```

Pinned by two fresh `agentic_ai` ENIs (`eni-0942f1b0b3b6553ea`,
`eni-07876963c2818da63`, both `in-use`). **#702 / P1 F12 reproducing for the third
consecutive run.** Nothing was force-deleted past CloudFormation.

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

**Deliberately retained:** `CDKToolkit` (unchanged — still the shared-account
caveat P1 raised); bootstrap S3/ECR assets; service-vended log groups created
outside CloudFormation; the two scratch-repo PRs (2.11); and **two** orphaned
zero-cost VPC sets — run 2's four resources above (still inside the
`DELETE_FAILED` stack) plus **run 1's**, which `--retain-resources` moved outside
CloudFormation entirely (`vpc-072fddf653ccdcfc4`, `subnet-0e6a6a0ed18100c8a`,
`subnet-02d91450e51cf72a0`, `sg-00997a58c1f4c5775`).

A best-effort hand cleanup of run 1's set was attempted and **refused** —
`DependencyViolation` on both subnets, the SG and the VPC, because
`eni-04911e11e08d670f9` and `eni-04a1c5a27966ee08b` were **still `in-use`
3 h 30 min after run 1's teardown**. Nothing was forced. Retry for both sets:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev   # run 2's set
# run 1's set is no longer CFN-managed:
aws ec2 delete-subnet --subnet-id subnet-0e6a6a0ed18100c8a
aws ec2 delete-subnet --subnet-id subnet-02d91450e51cf72a0
aws ec2 delete-security-group --group-id sg-00997a58c1f4c5775
aws ec2 delete-vpc --vpc-id vpc-072fddf653ccdcfc4
```

### 2.13 Findings summary

Live run 2026-08-07 02:58Z → 04:55Z, account `<account>`, `us-east-1`, branch
`feat/645-lambda-microvm-p2` @ `b927d1d6`. Evidence:
`/tmp/abca-645-p2r2-20260806`.

**Verdict on the primary objective: THE SMOKE PASSED.
`https://github.com/dreamorosi/batch-sync-triage/pull/6`.** Clone → change →
commit → push → PR, `COMPLETED` in 153 s for $0.28, with progress events and a
live heartbeat. That retires run 1's headline. **It required one live IAM
workaround, and pinning down why is the run's most valuable output.**

#### Fixes CONVERTED to "re-exercised live"

1. **P2-F1 — DISCHARGED.** Substrate deployed **first try**, `EXIT=0`,
   14 min 34 s, **zero workarounds**, both `AWS::Lambda::NetworkConnector`
   resources `CREATE_COMPLETE`, and **no `*FAILED` event anywhere** in 485
   resources. Run 1 needed five attempts and a cloud-assembly patch.
2. **P2-F2 — DISCHARGED.** Change-set **early validation passed** with `ARM_64`
   and four `ENABLED` hooks; the resource reached `CREATE_IN_PROGRESS`. Run 1's
   five-value refutation is answered on the CloudFormation surface. (The path is
   still blocked downstream — P2r2-F9 — but *not* on the enums.)
3. **P2-F4 — DISCHARGED with content.** `server_debug/<task_id>`,
   `metrics/<task_id>` **and** `trajectory/<task_id>` all exist; the
   `METRICS_REPORT` run 1 lost entirely now lands.
4. **P2-F5 — DISCHARGED, and now quantified.** Cold `claude` exec measured at
   **17.1–37.8 s** (so `timeout=10` was 2–4× short and could never have passed);
   **0.1 s once warm**; `/ready` 200, no 503; `/validate` still
   `platform_config_keys=13, warnings=0`; whole build 4 min 30 s, i.e. the
   warm-up cost ~22 s. **New empirical detail:** the service calls `/ready`
   **three times per build, the first two concurrently**, so two cold `claude`
   execs contend — worst single call ≈ 44 s. The 120 s required budget and the
   `readyTimeoutInSeconds` 60 → 300 move are both correctly sized; 60 s would
   have left ~16 s of slack.
5. **Dual-signal liveness — DISCHARGED** (run 1: BLOCKED). `agent_heartbeat_at`
   advanced `04:24:47 → 04:25:32 → 04:26:17` — exact 45 s cadence — across a
   181 s `RUNNING` window, freshness ≤ 34 s.

#### Items CONTRADICTING design assumptions — `feeds-back-to-design: YES`

**P2r2-F10 (BLOCKING). P2-F3 is NOT fixed. The orchestrator's *identity-side*
`iam:PassedToService: lambda.amazonaws.com` condition — the one run 1 explicitly
exonerated and `b927d1d` deliberately kept — is a second, independent blocker.**

Isolated by a clean two-arm experiment, same exact-ARN resource as source, same
5-minute settle, one variable:

| Orchestrator grant | Result |
|---|---|
| exact ARN **+ `iam:PassedToService: lambda.amazonaws.com`** (source as written) | **DENIED** — submissions 1 *and* 4 |
| exact ARN, **no condition** | **`RUNNING` in 9 s** — submission 5 |

```
Session start failed: Error: MicroVM RunMicrovm failed: AccessDeniedException: User: arn:aws:sts::<account>:assumed-role/backgroundagent-dev-TaskOrchestratorOrchestratorFnS-a7sP6rFzoIkU/backgroundagent-dev-TaskOrchestratorOrchestratorFn-p41lJqwFmxNG is not authorized to perform: iam:PassRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-pZQWXvKsITBa because no identity-based policy allows the iam:PassRole action
```

The trust half of run 1's fix was **necessary but not sufficient**. Run 1's
exoneration was a **false negative with an identifiable cause**: its temporary
unconditioned `iam:PassRole` was attached at §4.1 step 1 and, per its own §8.3,
**was still attached through submissions 4 and 5** — the ones that reached
`RUNNING`. So run 1 never tested the conditioned grant against a *working* trust,
and attributed the whole effect to the trust change.

Two source statements must therefore change, and the comment in
`task-orchestrator.ts` asserting the condition "was EXONERATED live … so it
stays" must be reversed:

- `cdk/src/constructs/task-orchestrator.ts`, sid `MicrovmPassExecutionRole`
- `cdk/bootstrap/policies/infrastructure.json`, sid `IAMPassRole` (P2r2-F9)

**P2r2-F9 (BLOCKING, same root cause). The CDK-managed image path is dead one
step later than run 1 thought: CloudFormation cannot pass the build role.**
Verbatim `CREATE_FAILED` in 2.5. **This is not a stale bootstrap** — the live
policy is byte-identical to this branch's
`cdk/bootstrap/policies/infrastructure.json`. `simulate-principal-policy` returns
`allowed` for `iam:PassedToService=lambda.amazonaws.com` and `implicitDeny`
without it, so the resource pattern is right and the condition is the variable;
and the out-of-band `--create-image` call **succeeded passing the same build
role**, proving the trust is fine and the denial is caller-side.

**P2r2-F9 and P2r2-F10 are ONE root cause with TWO symptoms** — precisely the
shape of run 1's P2-F1/F3, one layer in: **the Lambda MicroVMs service does not
present `iam:PassedToService: lambda.amazonaws.com` on either `PassRole` path**
(CloudFormation → build role at `CreateMicrovmImage`; orchestrator → execution
role at `RunMicrovm`). Consequence for the docs: the "CDK-managed (recommended)"
bootstrap path in `package-microvm-artifact.sh` is **still** non-functional and
`--create-image` is **still** the only working path — for a new reason.

**P2r2-F11. `agent_heartbeat_at` is written and consumed correctly but is
invisible through the API.** `toTaskDetail`
(`cdk/src/handlers/shared/types.ts:786`) does not map it, though `TaskRecord`
declares it (line 95) and `orchestrator.ts` reads it for liveness; `cli/src/types.ts`
has no such field at all. So `bgagent status` / `watch` report `None` even when
DynamoDB holds a 6-second-old value. Cheap to fix, and worth fixing because **it
already caused a wrong conclusion**: run 1 recorded "heartbeats NOT observed" and
attributed it wholly to P2-F5.

**P2r2-F12. Run 1's §8.5 stack-delete retry advice does not work on a
same-session horizon, and the ENI leak is worse than #702 records.** Run 1's
documented `delete-stack` retry failed **identically after 17 min 17 s**, with the
`agentic_ai` ENIs still `in-use` 1 h 32 min after run 1's teardown and *no*
AgentCore runtimes or memories in existence. At the end of *this* run those same
two ENIs were **still `in-use` 3 h 30 min on**, and a hand `delete-subnet` /
`delete-security-group` / `delete-vpc` sweep was refused with
`DependencyViolation` on all four. So the leak is not "slow" — it is **unbounded
relative to a developer's session**, and it now compounds: each run strands
another VPC set. The working escape hatch is `--retain-resources` (33 s), which
must list the `CREATE_COMPLETE` VPC alongside the three `DELETE_FAILED` children:

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev \
  --retain-resources AgentVpcA6796801 AgentVpcPrivateSubnet1Subnet8051BB57 \
                     AgentVpcPrivateSubnet2SubnetC66971D0 AgentVpcRuntimeSG96507CD0
```

#702 should carry both the unbounded-hold evidence and this escape hatch, rather
than have each run rediscover them. Run 1's attempt-3 technique (verify
`list-agent-runtimes` is empty, *then* retry) is separately **confirmed correct**
— it took this run's residual from 19 resources to 4.

**P2r2-F13. `MICROVM_IMAGE_VERSION` is legitimately optional** — five
`MICROVM_*` vars this run vs run 1's six, because the optional
`microvm_image_version` context was not supplied. Correct by design
(`task-orchestrator.ts:467`), but it qualifies the "all-or-nothing `MICROVM_*`"
claim, which should name the version as the one member that may be absent.

**P2r2-F14. `turns` is reported inconsistently in one stream.** `watch` prints
`agent_execution_complete: turns=22`; the persisted record and `METRICS_REPORT`
both say `12`.

**P2-F7 reconfirmed, worse.** 985,886 B / 486 resources = **98.6 %** of the 1 MB
limit, ~14 KB of headroom (run 1: ~16 KB).

**CloudTrail blind spot.** No `lambda-microvms` management events at all, so
`PassRole` context values cannot be read from logs — every determination in
2.5/2.8 had to be by elimination. Worth knowing before the next person tries.

**Still unfixed from earlier runs:** P1 F11 (AZ constraint — worked around again
via the gitignored AZ cache, restored at teardown); the finch→ECR push failure;
P1 F8 (`TERMINATED` is terminal, `ResourceNotFoundException` never arrives).

#### Recommended follow-up

1. **P2r2-F10 + P2r2-F9 together** — drop or correct `iam:PassedToService` on
   both the orchestrator statement and the bootstrap `IAMPassRole`. Nothing runs
   without the first; the recommended image path stays dead without the second.
   Determining the value the service *does* present needs either AWS
   confirmation or a bounded candidate sweep — `microvms.lambda.amazonaws.com`,
   `lambda-microvms.amazonaws.com` and `microvms.amazonaws.com` are all
   `implicitDeny` against the current policy, so any of them would work as the
   allow-list entry if it is the right one. Reverse the "EXONERATED … so it
   stays" comment while you are there.
2. **P2r2-F11** — one line in `toTaskDetail` plus the CLI type; it is what makes
   the liveness signal observable to the people who need it.
3. **P2r2-F12** — put the `--retain-resources` escape hatch in #702.
4. **P2-F7** — `suppressTemplateIndentation` or a stack split; ~14 KB left.
5. **A third Stage D is NOT needed for P2-F1/F2/F4/F5 or dual-signal liveness** —
   all five are now live-verified. The next run's scope is P2r2-F9/F10 plus the
   still-deferred empirical items (suspend TTL > 1 h, SUSPENDED-vs-quota).

### 2.14 Elapsed and cost

**Elapsed:** 02:58Z → 04:55Z ≈ **1 h 57 min**, of which ~18 min was the failed
delete retry, ~15 min the substrate deploy, ~6 min the refuted CDK-managed image
attempt, ~10 min image create+build, ~5 min the wired deploy, ~30 min the five
submissions and the isolation experiment (mostly IAM settle waits), ~26 min the
two teardown delete attempts, and the remainder evidence capture.

**Approximate cost: well under US$5**, dominated as always by NAT/VPC-endpoint
hours. Unlike run 1 this run actually spent Bedrock tokens: **$0.478 total across
two completed tasks** ($0.279 + $0.199). Two MicroVMs ran ~2.5 min each; two
image builds ~4.5 min each; one NAT gateway and 7×2 interface endpoints for
~1.6 h across a single stack lifetime.

The 8 h `maximumDurationInSeconds` was never approached; every VM was explicitly
terminated by the orchestrator's finalization.
