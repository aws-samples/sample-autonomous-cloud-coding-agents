# ADR-021 P1 Lambda MicroVM verification runbook

Working verification document for issue #645 / PR #689 on branch
`feat/645-lambda-microvm-p1`. This is for a **new, CDK-bootstrapped sandbox
account in which ABCA has never been deployed**. It is not a production deploy
guide.

`docs/scripts/sync-starlight.mjs` mirrors only selected guides, `docs/design/`,
`docs/decisions/`, `CONTRIBUTING.md`, and assets. It does **not** mirror
`docs/verification/`, so this file intentionally stays here.

## ⚠️ This runbook predates the Stage D fixes

The pass recorded under “Live execution results” below ran against the code as of
`0505f914`, and its findings (F1–F14) were then fixed. The **instructions** above
each step have been updated only where a fix renamed something an instruction
asserts on. The following instructions are known to still describe the pre-fix
world and must be adjusted by whoever runs this again:

| Step | Stale instruction | Post-fix reality |
|---|---|---|
| 1.2 | ~~unescaped `ParameterValue=agentcore,lambda-microvm`; bootstrap without `--force`~~ | **CORRECTED IN PLACE** — the comma is now escaped (`agentcore\,lambda-microvm`) and both bootstrap invocations carry `--force`. F14/F10 are the evidence; nothing is left to adjust here |
| 2.2 | "a 443-only security group" and one `AWS::Lambda::NetworkConnector` | **two** security groups (443-only runtime, 443 + 80 build) and **two** connectors, plus a connector operator role; a seventh output `MicrovmBuildEgressConnectorArns` |
| 2.3 | `list-stack-resources --query "…|[0]"` | needs `--no-paginate` (F14) |
| 4.3 | `export IMAGE_VERSION=1` | the service returns `1.0`; there are two builds per version (one per chipset) |
| 5.1 / 5.9 | `--image-identifier "$IMAGE_NAME"` | an **ARN** is required (F3); use the `imageArn` the script prints |
| 5.9 | 16 384 / 16 385-byte probes | the real boundary is **4 096 / 4 097** (F6) |
| Phase 5 | "the hook-less P1 image" framing | the image now declares AND serves `/ready` + `/run`, so hook behaviour is a different experiment |

## Important P1 and tooling limits

- P1 provisions and can start the substrate, and — **as of the Stage D fixes** —
  its image declares AND the agent serves `/ready` + `/run`, so the image is
  creatable, launchable and payload-deliverable. What P1 has no guarantee of is
  smoke parity (Memory grants, snapshot env parity, egress specifics from a
  running MicroVM, heartbeats). *Pre-fix, this bullet read "not runnable end to
  end" because the plan was to declare `/run` in P1 and serve it in P2; the live
  run proved that is not a reachable service state (F1).*
- P1's orchestrator role intentionally has only `RunMicrovm`, `GetMicrovm`,
  `TerminateMicrovm`, `PassNetworkConnector`, and the required `iam:PassRole`.
  It does **not** have `SuspendMicrovm`, `ResumeMicrovm`, or
  `CreateMicrovmAuthToken`. Therefore use the orchestrator role for the P1 IAM
  checks when it can be assumed, but use the sandbox administrator identity for
  the manual suspend/resume experiment. This is a deliberate P1/brief mismatch.
- The repository's AWS SDK model is
  `@aws-sdk/client-lambda-microvms@3.1098.0`. It verifies operation names,
  request keys, state enums, and `delete-microvm-image-version`. The local
  `aws-cli/2.35.8` does **not** recognize `aws lambda-microvms`; consequently all
  `aws lambda-microvms ...` commands below are **best-effort CLI spellings
  derived from that SDK model and the repository packaging script**, not locally
  CLI-validated. No minimum AWS CLI release containing this service could be
  established. The executor must install a CLI build for which
  `aws lambda-microvms help` succeeds. Do not proceed with image/lifecycle work
  merely because `aws --version` is newer than 2.35.8.
- The packaging-script model drift is resolved: its direct service request now
  uses SDK 3.1098.0's `ARM_64` architecture and `ENABLED|DISABLED` hook-state
  shape (with port and timeout), rather than CloudFormation's `arm64` and hook
  path strings. The CDK L1 remains intentionally unchanged because its generated
  CloudFormation types accept string values and document no architecture/hook
  allowed-value constraint. Step 4.2 still captures CLI help/input skeleton as
  a live check because the local CLI cannot validate this service offline.
- Commands are run from the repository root. `mise` is primary. Commands marked
  **raw fallback** are only for a machine without `mise`.
- **Run the whole thing under `set -o pipefail`.** Several steps pipe a command
  through `tee`; without `pipefail` the pipeline reports `tee`'s exit status and a
  failed command looks like a success. The 2026-07-31 pass recorded `EXIT=0` for a
  `package-microvm-artifact.sh` run that had actually failed service validation
  (F14). The script now also prints an explicit
  `!! package-microvm-artifact.sh FAILED (exit N) !!` marker on any failure, so
  the teed log carries the truth either way — but set the option anyway:

  ```bash
  set -o pipefail
  ```

## Variables and evidence directory

**Purpose:** make every subsequent command target one account, Region, and stack.

```bash
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_REGION="$AWS_REGION"
export STACK_NAME=backgroundagent-dev
export EXPECTED_BRANCH=feat/645-lambda-microvm-p1
export EVIDENCE_DIR="/tmp/abca-645-p1-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
```

If using a profile, also `export AWS_PROFILE=<sandbox-profile>`. Supported
Regions are `us-east-1`, `us-east-2`, `us-west-2`, `eu-west-1`, and
`ap-northeast-1`; this runbook defaults to `us-east-1`.

**Expected:** the directory exists and all variables print non-empty.

**Record:** variable values and evidence-directory path.

**ADR-021 item:** regional availability enforcement and reproducibility.

---

## Phase 0 — Preflight

### 0.1 Verify identity, branch, and virgin account

**Purpose:** prevent deploying to the wrong account/branch and fail fast if this
is not the assumed first ABCA deployment.

```bash
aws sts get-caller-identity | tee "$EVIDENCE_DIR/caller-identity.json"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
git status --short --branch | tee "$EVIDENCE_DIR/git-status.txt"

if aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  >"$EVIDENCE_DIR/unexpected-existing-stack.json" 2>"$EVIDENCE_DIR/stack-absence.txt"; then
  echo "STOP: $STACK_NAME already exists; this runbook requires a virgin account." >&2
  exit 1
fi
```

The expected CloudFormation error is `ValidationError: Stack ... does not
exist`. Any other error (especially `AccessDenied`) is not proof of absence;
stop and fix credentials.

**Expected:** account is the intended sandbox, branch test passes, only known
local files are shown, and `backgroundagent-dev` is absent. `CDKToolkit` may and
normally will exist.

**Record:** account ID, caller ARN, branch SHA (`git rev-parse HEAD`), status,
and the exact stack-absence response.

**ADR-021 item:** clean first-deploy/substrate bootstrap path.

### 0.2 Record tools and install dependencies

**Purpose:** capture the exact client/service models and prepare CDK and CLI.

```bash
aws --version 2>&1 | tee "$EVIDENCE_DIR/aws-version.txt"
node --version | tee "$EVIDENCE_DIR/node-version.txt"
npx cdk --version | tee "$EVIDENCE_DIR/cdk-version.txt"
mise --version | tee "$EVIDENCE_DIR/mise-version.txt"
python3 --version | tee "$EVIDENCE_DIR/python-version.txt"
zip -v | tee "$EVIDENCE_DIR/zip-version.txt"
rsync --version | tee "$EVIDENCE_DIR/rsync-version.txt"

MISE_EXPERIMENTAL=1 mise run install
```

**Raw fallback if `mise` is absent:**

```bash
yarn install --check-files
```

Then perform the mandatory service-client gate:

```bash
aws lambda-microvms help >"$EVIDENCE_DIR/lambda-microvms-help.txt"
node -p "require('./node_modules/@aws-sdk/client-lambda-microvms/package.json').version" \
  | tee "$EVIDENCE_DIR/lambda-microvms-sdk-version.txt"
```

**Expected:** install succeeds; SDK version is `3.1098.0`; the help command
lists at least `run-microvm`, `get-microvm`, `suspend-microvm`,
`resume-microvm`, `terminate-microvm`, `create-microvm-auth-token`, and
`delete-microvm-image-version`. If help fails, stop and update/install the AWS
CLI distribution that exposes the preview/new service.

**Record:** every version and whether service help was available.

**ADR-021 item:** empirical IAM/API action-name verification.

---

## Phase 1 — Least-privilege bootstrap

### 1.1 Inspect the existing bootstrap

**Purpose:** determine whether the standard bootstrap lacks ABCA's generated
template and custom compute policies.

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit \
  | tee "$EVIDENCE_DIR/cdktoolkit-before.json"
aws cloudformation get-template --stack-name CDKToolkit \
  --query TemplateBody --output text >"$EVIDENCE_DIR/cdktoolkit-template-before.txt"
python3 - "$EVIDENCE_DIR/cdktoolkit-template-before.txt" <<'PY'
import pathlib, sys
s = pathlib.Path(sys.argv[1]).read_text()
for needle in ("ComputeTypes", "IaCRoleABCAComputeLambdaMicrovms"):
    print(needle, "present" if needle in s else "ABSENT")
PY
```

**Expected:** a standard bootstrap may report both markers absent. That is the
reason for the next step, not a failure.

**Record:** template markers and current CDKToolkit parameters.

**ADR-021 item:** conditional bootstrap policy exists only with the custom
template.

### 1.2 Re-bootstrap, then set the CloudFormation parameter

**Purpose:** replace the standard administrator bootstrap with the repository's
generated least-privilege template, then enable both AgentCore and Lambda
MicroVM deployment permissions. `cdk bootstrap` has no `--parameters`; CDK
context is not a substitute for this CloudFormation parameter.

```bash
# `--force` is REQUIRED on an already-bootstrapped account: without it the CDK CLI
# refuses to replace the default template and exits 0 ("Bootstrap stack already
# exists, containing 'AWS CDK: Default Resources'. Not overwriting it…"), leaving
# AdministratorAccess attached while looking like a success (F10). Note also that
# BootstrapVariant stays 'AWS CDK: Default Resources' afterwards, so every future
# non-forced bootstrap refuses again.
MISE_EXPERIMENTAL=1 mise //cdk:bootstrap -- --force

# The comma MUST be backslash-escaped. The CLI's shorthand parser otherwise splits
# on it and rejects the call (F14):
#   "Invalid type for parameter Parameters[0].ParameterValue,
#    value: ['agentcore', 'lambda-microvm'], type: <class 'list'>,
#    valid types: <class 'str'>"
# The comment above `[tasks.bootstrap]` in cdk/mise.toml shows the same escaping.
aws cloudformation update-stack \
  --stack-name CDKToolkit \
  --use-previous-template \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters 'ParameterKey=ComputeTypes,ParameterValue=agentcore\,lambda-microvm'
aws cloudformation wait stack-update-complete --stack-name CDKToolkit
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query 'Stacks[0].Parameters' \
  | tee "$EVIDENCE_DIR/cdktoolkit-parameters-after.json"
```

**Raw fallback if `mise` is absent** (run from `cdk/`):

```bash
npx tsx scripts/generate-bootstrap-artifacts.ts
npx tsx scripts/generate-bootstrap-template.ts
# --force for the same reason as above (F10).
npx cdk bootstrap --template bootstrap/bootstrap-template.yaml --force
```

Then run the same `aws cloudformation update-stack` parameter dance above,
including the escaped comma.

**Expected:** `ComputeTypes` is exactly `agentcore,lambda-microvm`. The custom
template replaces default `AdministratorAccess` with generated ABCA policies.

**Record:** update stack ID/events and final parameters.

**ADR-021 item:** “where `ComputeTypes` includes `lambda-microvm`, attach
`IaCRole-ABCA-Compute-LambdaMicrovms`.”

### 1.3 Verify policy creation and attachment

**Purpose:** prove the MicroVM CloudFormation permissions are attached to the
actual execution role.

```bash
export CFN_EXEC_ROLE="$(aws cloudformation describe-stack-resource \
  --stack-name CDKToolkit \
  --logical-resource-id CloudFormationExecutionRole \
  --query StackResourceDetail.PhysicalResourceId --output text)"

aws iam list-policies --scope Local \
  --query "Policies[?contains(PolicyName, 'IaCRole-ABCA-Compute-LambdaMicrovms')].[PolicyName,Arn]" \
  --output table | tee "$EVIDENCE_DIR/microvm-bootstrap-policy.txt"
aws iam list-attached-role-policies --role-name "$CFN_EXEC_ROLE" \
  | tee "$EVIDENCE_DIR/cfn-exec-attached-policies.json"
```

**Expected:** one generated policy whose name contains
`IaCRole-ABCA-Compute-LambdaMicrovms` exists and its ARN is attached to
`$CFN_EXEC_ROLE`.

**Record:** execution role name, policy ARN, and attachments.

**ADR-021 item:** conditional bootstrap policy and verified IAM action names.

**Optional negative deliberately skipped:** a scratch-qualifier bootstrap with
only `agentcore` would create another bootstrap stack, buckets, ECR repository,
roles, and policies merely to prove a template condition already covered by CDK
tests. It is not cheap enough for the core pass and complicates teardown. Run it
only if specifically requested, and destroy every scratch bootstrap resource.

---

## Phase 2 — Substrate-only deploy (no image context)

### 2.1 Synthesize and deploy the bootstrap state

**Purpose:** verify the intended first-deploy state: connector, buckets, roles,
and logs exist while no image or orchestrator image configuration exists.

```bash
MISE_EXPERIMENTAL=1 mise //cdk:synth -- \
  "$STACK_NAME" --context compute_type=lambda-microvm \
  2>&1 | tee "$EVIDENCE_DIR/substrate-synth.txt"

MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \
  "$STACK_NAME" --require-approval never \
  --context compute_type=lambda-microvm \
  2>&1 | tee "$EVIDENCE_DIR/substrate-deploy.txt"
```

**Raw fallback if `mise` is absent** (run from `cdk/`):

```bash
npx cdk synth "$STACK_NAME" --context compute_type=lambda-microvm
npx cdk deploy "$STACK_NAME" --require-approval never --context compute_type=lambda-microvm
```

**Expected:** synth includes warning ID
`abca:microvm-image-not-provisioned`; deploy completes. This is intentionally
not `abca:microvm-image-p1-smoke-unverified` yet because no image is configured.
(The 2026-07-31 pass observed the pre-fix id `abca:microvm-image-p1-not-runnable`;
the warning was renamed when F1 was fixed.)

**Record:** warning, deployment duration, stack ID/status, and failures/retries.

**ADR-021 item:** conditional substrate and explicit no-image first-deploy
warning.

### 2.2 Resolve exact outputs and resources

**Purpose:** prove the script-facing substrate contract and capture physical IDs.

```bash
aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' | tee "$EVIDENCE_DIR/stack-outputs-substrate.json"
aws cloudformation list-stack-resources --stack-name "$STACK_NAME" \
  | tee "$EVIDENCE_DIR/stack-resources-substrate.json"

for key in ComputeSubstrate MicrovmArtifactBucketName MicrovmArtifactObjectKey \
  MicrovmBuildRoleArn MicrovmExecutionRoleArn MicrovmEgressConnectorArns \
  MicrovmLogGroupName; do
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" --output text
done | tee "$EVIDENCE_DIR/microvm-output-values.txt"
```

**Expected:** `ComputeSubstrate=lambda-microvm`; all six `Microvm...` outputs
are populated; artifact key is `microvm-images/agent-artifact.zip`. Stack
resources include two S3 buckets, build/execution roles, a 443-only security
group, `/aws/lambda-microvms/...` log group, and
`AWS::Lambda::NetworkConnector`; no `AWS::Lambda::MicrovmImage` exists.

**Record:** outputs and physical IDs.

**ADR-021 item:** construct resources, egress connector, build/execution roles,
artifact/payload buckets.

### 2.3 Verify no orchestrator `MICROVM_*` environment

**Purpose:** prove partial image configuration is not injected.

```bash
export ORCHESTRATOR_FN="$(aws cloudformation list-stack-resources \
  --stack-name "$STACK_NAME" \
  --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'TaskOrchestrator')].PhysicalResourceId | [0]" \
  --output text)"
aws lambda get-function-configuration --function-name "$ORCHESTRATOR_FN" \
  --query 'Environment.Variables' | tee "$EVIDENCE_DIR/orchestrator-env-no-image.json"
aws lambda get-function-configuration --function-name "$ORCHESTRATOR_FN" \
  --query 'Environment.Variables' --output json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print([k for k in d if k.startswith("MICROVM_")])'
```

**Expected:** the final line is `[]`.

**Record:** function name and environment-key list (do not publish environment
values if later deployments add sensitive configuration).

**ADR-021 item:** reject tasks when deployed without an image; all-or-nothing
strategy configuration.

### 2.4 Verify backend cost tags

**Purpose:** verify deployed, taggable construct resources carry
`abca:compute-backend=lambda-microvm`.

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=abca:compute-backend,Values=lambda-microvm \
  --query 'ResourceTagMappingList[].ResourceARN' --output text \
  | tee "$EVIDENCE_DIR/microvm-tagged-resource-arns.txt"

aws cloudformation get-template --stack-name "$STACK_NAME" \
  --query TemplateBody --output json >"$EVIDENCE_DIR/deployed-template.json"
python3 - "$EVIDENCE_DIR/deployed-template.json" <<'PY'
import json, pathlib, sys
t = json.loads(pathlib.Path(sys.argv[1]).read_text())
for logical_id, r in t["Resources"].items():
    if "LambdaMicrovmCompute" not in logical_id:
        continue
    tags = r.get("Properties", {}).get("Tags")
    print(logical_id, r["Type"], tags if tags is not None else "NOT-TAGGABLE/NO-TAGS")
PY
```

**Expected:** every taggable construct resource (buckets, roles, security group,
log group, and connector where supported) shows the backend tag. Generated
policies/bucket policies are not independently taggable resources. Save any
service that omits tags as a defect rather than silently accepting it.

**Record:** tagged ARNs and the per-logical-resource template report.

**ADR-021 item:** backend-identifying cost-allocation tags.

---

## Phase 3 — Region gate (synth only)

### 3.1 Reject an unsupported Region

**Purpose:** prove static fail-fast enforcement without deploying there.

```bash
env AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1 \
  CDK_DEFAULT_REGION=eu-central-1 CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" \
  MISE_EXPERIMENTAL=1 mise //cdk:synth -- \
  "$STACK_NAME" --context compute_type=lambda-microvm \
  >"$EVIDENCE_DIR/unsupported-region-synth.txt" 2>&1 && {
    echo "ERROR: unsupported-region synth unexpectedly succeeded" >&2; exit 1;
  }
```

**Raw fallback if `mise` is absent** (run from `cdk/`):

```bash
env AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1 \
  CDK_DEFAULT_REGION=eu-central-1 CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" \
  npx cdk synth "$STACK_NAME" --context compute_type=lambda-microvm
```

**Expected:** failure names `eu-central-1`, all five supported Regions, and
`--context microvm_region_override=true`.

**Record:** complete stderr.

**ADR-021 item:** static unsupported-Region synth failure.

### 3.2 Exercise the escape hatch

**Purpose:** prove newly launched Regions can bypass only the static list.

```bash
env AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1 \
  CDK_DEFAULT_REGION=eu-central-1 CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" \
  MISE_EXPERIMENTAL=1 mise //cdk:synth -- \
  "$STACK_NAME" --context compute_type=lambda-microvm \
  --context microvm_region_override=true \
  2>&1 | tee "$EVIDENCE_DIR/unsupported-region-override-synth.txt"
```

**Expected:** synth succeeds with warning `abca:microvm-region-override`.

**Record:** warning and exit status.

**ADR-021 item:** Region-list escape hatch.

**Gotcha:** `src/main.ts` reads `CDK_DEFAULT_REGION`, not merely `AWS_REGION`.
An unresolved/region-agnostic CDK token skips the static check by design. The
commands set both account and Region to force the real test. Synth makes no
MicroVM control-plane calls, but CDK context/asset bundling may still require
valid AWS credentials and the bootstrap version parameter.

---

## Phase 4 — Package and build an image

### 4.1 Select a managed base image

**Purpose:** pin a real regional base-image ARN/version rather than guessing.

```bash
aws lambda-microvms list-managed-microvm-images \
  | tee "$EVIDENCE_DIR/managed-images.json"
export BASE_IMAGE_ARN="$(aws lambda-microvms list-managed-microvm-images \
  --query 'items[0].imageArn' --output text)"
aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier "$BASE_IMAGE_ARN" \
  | tee "$EVIDENCE_DIR/managed-image-versions.json"
# NEWEST FIRST (measured 2026-07-31): items[0] is the latest version, items[-1]
# is the OLDEST. The original `items[-1]` here selected version 0 instead of 1.
export BASE_IMAGE_VERSION="$(aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier "$BASE_IMAGE_ARN" \
  --query 'items[0].imageVersion' --output text)"
test -n "$BASE_IMAGE_ARN" && test "$BASE_IMAGE_ARN" != None
test -n "$BASE_IMAGE_VERSION" && test "$BASE_IMAGE_VERSION" != None
```

**Expected:** the regional probe succeeds and returns at least one ARN/version.
Ordering is newest-to-oldest, so `items[0]` is correct; inspect the timestamps
and explicitly export the desired version if the installed CLI ever differs.

**Record:** complete catalogs and selected pair.

**ADR-021 item:** live regional availability probe and managed base-image API.

### 4.2 Package, upload, and start the out-of-band build

**Purpose:** exercise the actual script interface and avoid slow CloudFormation
iteration while still using CDK-created bucket, role, connector, and logs.

Before running it, capture the installed CLI's authoritative request shape:

```bash
aws lambda-microvms create-microvm-image help \
  >"$EVIDENCE_DIR/create-microvm-image-help.txt"
aws lambda-microvms create-microvm-image --generate-cli-skeleton input \
  >"$EVIDENCE_DIR/create-microvm-image-skeleton.json"
```

Confirm that `hooks.microvmHooks.run` is `ENABLED` and
`cpuConfigurations[].architecture` is `ARM_64`, matching SDK 3.1098.0. The CDK
L1 request is a separate CloudFormation surface and legitimately retains its
generated path/string shape. If the installed CLI skeleton differs from the SDK
model or rejects the script request, stop this phase, save the parser/service
error as a model-drift defect, and mark later image/runtime steps blocked.

```bash
export IMAGE_NAME="${STACK_NAME}-abca-agent"
export BUILD_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cdk/scripts/package-microvm-artifact.sh \
  --stack-name "$STACK_NAME" \
  --create-image \
  --base-image-arn "$BASE_IMAGE_ARN" \
  --base-image-version "$BASE_IMAGE_VERSION" \
  --image-name "$IMAGE_NAME" \
  2>&1 | tee "$EVIDENCE_DIR/package-and-create-image.txt"
# Explicit status check — `| tee` reports tee's status, so a bare `$?` here lies
# unless `set -o pipefail` is on (see "Important P1 and tooling limits").
test "${PIPESTATUS[0]}" -eq 0
```

The script requires `aws`, `zip`, `python3`, and `rsync`; reads outputs
`MicrovmArtifactBucketName`, `MicrovmArtifactObjectKey`,
`MicrovmBuildRoleArn`, `MicrovmBuildEgressConnectorArns`,
`MicrovmEgressConnectorArns`, and `MicrovmLogGroupName`; stages root
`Dockerfile`, `agent/`, and `contracts/`; uploads the zip; and calls
`create-microvm-image` with ARM64, 8,192 MiB, `/ready` **and** `/run` enabled on
port 8080, the **build-time** egress connector (443 + 80), and the backend tag.

**Expected:** upload succeeds, create returns/starts image version `1.0` in this
virgin image name, and the output contains the conspicuous “P1 image is runnable
but NOT smoke-verified” reminder — printed BOTH before and after the create call,
so a failing create cannot swallow it.

**Record:** artifact size printed by the script, S3 object size from the command
below, create response, and exact banner.

```bash
export ARTIFACT_BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmArtifactBucketName'].OutputValue | [0]" --output text)"
export ARTIFACT_KEY="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmArtifactObjectKey'].OutputValue | [0]" --output text)"
aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$ARTIFACT_KEY" \
  | tee "$EVIDENCE_DIR/artifact-head.json"
```

**ADR-021 item:** zip+Dockerfile packaging plane, no secret build inputs, build
role/connector/log wiring, and the `abca:microvm-image-p1-smoke-unverified`
warning (renamed from `…-p1-not-runnable` when F1 was fixed: the image IS
creatable, launchable and payload-deliverable now that `/ready` + `/run` are
declared AND served — what is unverified is smoke parity).

### 4.3 Poll build and image status to ACTIVE

**Purpose:** capture real snapshot build duration, state, and component sizes.

```bash
export IMAGE_VERSION=1
while :; do
  aws lambda-microvms list-microvm-image-builds \
    --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
    | tee "$EVIDENCE_DIR/image-builds-latest.json"
  STATE="$(aws lambda-microvms list-microvm-image-builds \
    --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
    --query 'items[0].buildState' --output text)"
  date -u '+%Y-%m-%dT%H:%M:%SZ buildState='"$STATE"
  case "$STATE" in SUCCESSFUL) break;; FAILED) exit 1;; esac
  sleep 30
done

export BUILD_ID="$(aws lambda-microvms list-microvm-image-builds \
  --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
  --query 'items[0].buildId' --output text)"
aws lambda-microvms get-microvm-image-build \
  --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
  --build-id "$BUILD_ID" | tee "$EVIDENCE_DIR/image-build-final.json"

while :; do
  aws lambda-microvms get-microvm-image-version \
    --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
    | tee "$EVIDENCE_DIR/image-version-latest.json"
  STATUS="$(aws lambda-microvms get-microvm-image-version \
    --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
    --query status --output text)"
  test "$STATUS" = ACTIVE && break
  sleep 30
done
export BUILD_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

**Expected:** build states may include `PENDING` and `IN_PROGRESS`, then
`SUCCESSFUL`; image-version `state` becomes `SUCCESSFUL` and `status` becomes
`ACTIVE`. On failure, save `stateReason` and tail the exact output log group:

```bash
export MICROVM_LOG_GROUP="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmLogGroupName'].OutputValue | [0]" --output text)"
aws logs tail "$MICROVM_LOG_GROUP" --since 2h
```

**Record:** start/finish timestamps, duration, all states/reasons, build ID, and
`snapshotBuild.memorySnapshotSizeInBytes`, `codeInstallSizeInBytes`, and
`diskSnapshotSizeInBytes`. Compare **code-install size** to AgentCore's 2 GB
container-image limit, while clearly noting that memory/disk snapshots are not
equivalent to an OCI image and must not be summed into a misleading comparison.
Also record the reported image resources/disk facts; the SDK exposes minimum
memory but no explicit disk-capacity field, so verify the 32 GB disk claim in
the service quota/console and report “not exposed” if that remains true.

**ADR-021 item:** buildability, final image size, 2 GB-limit narrative, and disk
quota external fact.

### 4.4 Redeploy against the built image and inspect IAM/env

**Purpose:** hand the out-of-band image to the orchestrator and prove exact-image
IAM scoping.

```bash
MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \
  "$STACK_NAME" --require-approval never \
  --context compute_type=lambda-microvm \
  --context microvm_image_identifier="$IMAGE_NAME" \
  --context microvm_image_version="$IMAGE_VERSION" \
  2>&1 | tee "$EVIDENCE_DIR/image-configured-deploy.txt"
```

**Expected:** synth/deploy emits `abca:microvm-image-p1-smoke-unverified` (the
2026-07-31 pass saw the pre-fix id `abca:microvm-image-p1-not-runnable`; the
warning was renamed when F1 was fixed). The orchestrator now has
`MICROVM_IMAGE_IDENTIFIER` — **a full image ARN**, not a bare name (F3) —
`MICROVM_IMAGE_VERSION`, `MICROVM_EXECUTION_ROLE_ARN`,
`MICROVM_EGRESS_CONNECTOR_ARNS`, `MICROVM_PAYLOAD_BUCKET`, and
`MICROVM_INGRESS_CONNECTOR_ARNS` carrying the Lambda-managed `NO_INGRESS`
connector (F7 — the pre-fix build had no ingress variable at all).

```bash
aws lambda get-function-configuration --function-name "$ORCHESTRATOR_FN" \
  --query 'Environment.Variables' --output json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d[k] for k in d if k.startswith("MICROVM_")})' \
  | tee "$EVIDENCE_DIR/orchestrator-microvm-env.txt"

export ORCHESTRATOR_ROLE_ARN="$(aws lambda get-function-configuration \
  --function-name "$ORCHESTRATOR_FN" --query Role --output text)"
export ORCHESTRATOR_ROLE="${ORCHESTRATOR_ROLE_ARN##*/}"
aws iam list-role-policies --role-name "$ORCHESTRATOR_ROLE" \
  | tee "$EVIDENCE_DIR/orchestrator-inline-policy-names.json"
export ORCH_POLICY_NAME="$(aws iam list-role-policies --role-name "$ORCHESTRATOR_ROLE" \
  --query 'PolicyNames[0]' --output text)"
aws iam get-role-policy --role-name "$ORCHESTRATOR_ROLE" \
  --policy-name "$ORCH_POLICY_NAME" \
  | tee "$EVIDENCE_DIR/orchestrator-inline-policy.json"
```

The inline policy's physical name is CDK-generated and therefore cannot be
hard-coded; the actual name to fetch is `$ORCH_POLICY_NAME` returned by
`list-role-policies` (normally the role's `DefaultPolicy`). If more than one is
listed, fetch each and select the document containing `Sid=MicrovmLifecycle`.

**Expected:** `MicrovmLifecycle` grants exactly `lambda:RunMicrovm`,
`lambda:GetMicrovm`, and `lambda:TerminateMicrovm` against exactly
`arn:...:microvm-image:$IMAGE_NAME` and its `:<version>` suffix sibling;
`MicrovmPassNetworkConnector` has `lambda:PassNetworkConnector` on `*`; no
`SuspendMicrovm`, `ResumeMicrovm`, or `CreateMicrovmAuthToken` exists.

**Record:** warning, environment-key/value map, role/policy names, statements,
and exact image ARN format observed.

**ADR-021 item:** the `abca:microvm-image-p1-smoke-unverified` warning (formerly
`…-p1-not-runnable`), exact-ARN lifecycle IAM, no-JWE grant, and all-or-nothing
environment wiring — which now includes `MICROVM_INGRESS_CONNECTOR_ARNS`, always
injected, carrying the `NO_INGRESS` control.

---

## Phase 5 — Manual lifecycle and empirical checklist

### 5.0 Resolve launch inputs and IAM identity mode

**Purpose:** use deployed values and distinguish true role-policy evidence from
admin-only lifecycle evidence.

```bash
export EXECUTION_ROLE_ARN="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmExecutionRoleArn'].OutputValue | [0]" --output text)"
export EGRESS_CONNECTORS="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmEgressConnectorArns'].OutputValue | [0]" --output text)"

aws sts assume-role --role-arn "$ORCHESTRATOR_ROLE_ARN" \
  --role-session-name abca-645-verification \
  >"$EVIDENCE_DIR/orchestrator-assume-role.json" \
  2>"$EVIDENCE_DIR/orchestrator-assume-role-error.txt" || true
```

Lambda execution-role trust normally allows only `lambda.amazonaws.com`, so
operator assumption is expected to fail unless the sandbox has an explicit
test trust path. **Do not modify production-like trust just for this run.** If
assumption succeeds, open a subshell with those temporary credentials for steps
5.1, 5.2, 5.7, and 5.8(a/b), and mark evidence `ORCHESTRATOR_ROLE`. Otherwise
run as sandbox admin and mark scoping observations `ADMIN — advisory`; the
static inline-policy inspection in 4.4 remains authoritative.

Example temporary-credential subshell setup:

```bash
read AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<EOF
$(aws sts assume-role --role-arn "$ORCHESTRATOR_ROLE_ARN" \
  --role-session-name abca-645-verification \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
EOF
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
aws sts get-caller-identity
```

**Expected:** either a clearly recorded assume-role identity or a clearly
recorded trust denial and admin fallback.

**Record:** identity mode. Never paste temporary secret values into evidence.

**ADR-021 item:** runtime-role least privilege and verification confidence.

### 5.1 Launch the P1 image

**Purpose (SUPERSEDED — see below):** answer what a P1 image that declares but
does not serve `/run` actually does.

> **Stale premise.** This step was written against the pre-fix world, where the
> plan was to declare `/run` in P1 and serve it in P2. F1 proved that is not a
> reachable service state, and the agent now serves `/ready` + `/run`. Two
> consequences for a re-run: (i) the image is no longer hook-less, so
> `--run-hook-payload` is ACCEPTED rather than rejected — the interesting
> observation becomes whether the payload reaches the pipeline, not what a
> hook-less VM does; and (ii) `--image-identifier` needs the image **ARN**, not
> `$IMAGE_NAME` (F3). What still holds unchanged, and is worth re-confirming, is
> everything below about the state enum, the 28,800-second bound, the
> omit-`idlePolicy` invariant, and the default public ingress.

```bash
export RUN_STARTED_EPOCH="$(date +%s)"
aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_NAME" \
  --image-version "$IMAGE_VERSION" \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --egress-network-connectors "$EGRESS_CONNECTORS" \
  --run-hook-payload '{"verification":"issue-645-p1"}' \
  --maximum-duration-in-seconds 28800 \
  | tee "$EVIDENCE_DIR/run-microvm.json"
export MICROVM_ID="$(python3 -c 'import json,os; print(json.load(open(os.environ["EVIDENCE_DIR"] + "/run-microvm.json"))["microvmId"])')"
export MICROVM_ENDPOINT="$(python3 -c 'import json,os; print(json.load(open(os.environ["EVIDENCE_DIR"] + "/run-microvm.json"))["endpoint"])')"
```

Do **not** pass `--idle-policy`. Immediately poll:

```bash
for delay in 0 2 5 10 20 30 60; do
  sleep "$delay"
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  aws lambda-microvms get-microvm --microvm-identifier "$MICROVM_ID" || true
done | tee "$EVIDENCE_DIR/hookless-state-timeline.txt"
```

**Expected:** `run-microvm` should return a `microvmId`, endpoint, image ARN,
version, and initial state if `/run` is asynchronous at control-plane return.
The eventual state is deliberately **not prescribed**: record whether it reaches
`RUNNING`, remains `PENDING`, becomes `TERMINATING/TERMINATED`, or disappears,
plus `stateReason` and elapsed time. If `run-microvm` itself rejects because the
hook returns 404/times out, record that exact exception and timing. This result
feeds the P2 hook/startup design.

**Record:** full response, endpoint (not an auth token), all states/reasons,
time-to-first-state/time-to-terminal, and relevant log lines.

**ADR-021 item:** real state enum, 28,800-second bound, and omit-`idlePolicy`
invariant. (The original "P1-not-runnable premise" this step was written to probe
no longer exists — see the Phase 5 row of the stale-instruction table.)

### 5.2 Explicit `get-microvm` state mapping

**Purpose:** validate the six SDK states used by strategy mapping.

```bash
aws lambda-microvms get-microvm --microvm-identifier "$MICROVM_ID" \
  | tee "$EVIDENCE_DIR/get-microvm.json"
```

**Expected:** observed values come from `PENDING`, `RUNNING`, `SUSPENDING`,
`SUSPENDED`, `TERMINATING`, `TERMINATED`; a reaped ID returns
`ResourceNotFoundException`.

**Record:** every distinct state actually observed and any unknown state.

**ADR-021 item:** mechanical state mapping and future-enum safety premise.

### 5.3 Manual suspend without `idlePolicy`

**Purpose:** determine whether explicit suspend works independently of traffic
idle policy and whether a hook-less image survives long enough to suspend.

Use the sandbox admin identity because P1's orchestrator correctly lacks this
permission:

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ suspend-request'
aws lambda-microvms suspend-microvm --microvm-identifier "$MICROVM_ID" \
  | tee "$EVIDENCE_DIR/suspend-microvm.json"
for i in 1 2 3 4 5 6; do
  aws lambda-microvms get-microvm --microvm-identifier "$MICROVM_ID" || true
  sleep 10
done | tee "$EVIDENCE_DIR/suspend-state-timeline.txt"
```

**Expected:** if the VM reached a suspendible state, observe
`SUSPENDING → SUSPENDED`. A conflict/not-found caused by the failed `/run` hook
is a valid P1 result but means 5.4–5.6 cannot discharge TTL/resume empirically;
mark those **BLOCKED-BY-P1-HOOKLESS-IMAGE**, do not invent an answer.

**Record:** identity, response/exception, states, and suspend latency.

**ADR-021 item:** manual suspend without idle policy.

### 5.4 Suspended TTL experiment

**Purpose:** determine the default lifetime of a manually suspended VM when
`idlePolicy` (and therefore `suspendedDurationSeconds`) is omitted.

Only run after observing `SUSPENDED`:

```bash
for seconds in 0 900 3600 14400; do
  sleep "$seconds"
  printf '\ncheckpoint_after_sleep_seconds=%s at %s\n' "$seconds" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  aws lambda-microvms get-microvm --microvm-identifier "$MICROVM_ID" || true
done | tee "$EVIDENCE_DIR/suspended-ttl-checkpoints.txt"
```

The sleeps are incremental (0, then 15 min, then +1 h, then +4 h). A time-boxed
executor may truncate after 15 min or 1 h, but must say so. Never leave the VM
past the 28,800-second maximum; Phase 8 terminates it.

**Expected:** unknown by design. Record whether it stays `SUSPENDED`, terminates,
or becomes NotFound and at what wall-clock age. `maximumDurationInSeconds=28800`
bounds the worst case even if no separate suspended TTL exists.

**Record:** complete checkpoints, truncation, start age, and terminal time.

**ADR-021 item:** P1 external fact — manual-suspend default TTL without
`idlePolicy`.

### 5.5 Quota treatment while suspended

**Purpose:** test the rationale that a suspended VM still holds account memory
quota.

```bash
aws service-quotas list-services \
  --query "Services[?contains(ServiceName, 'Lambda')].[ServiceCode,ServiceName]" \
  --output table | tee "$EVIDENCE_DIR/lambda-service-codes.txt"
aws service-quotas list-service-quotas --service-code lambda \
  --query "Quotas[?contains(QuotaName, 'MicroVM') || contains(QuotaName, 'microVM') || contains(QuotaName, 'memory')]" \
  | tee "$EVIDENCE_DIR/microvm-service-quotas.json"
aws lambda-microvms list-microvms --image-identifier "$IMAGE_NAME" \
  | tee "$EVIDENCE_DIR/microvms-while-suspended.json"
```

Also open the Lambda MicroVM **account quota / memory utilization view** in the
AWS console before launch, while RUNNING, while SUSPENDED, and after termination;
capture values/timestamps. The SDK 3.1098 model has no “get account memory
usage” operation, and `service-quotas` normally reports limits rather than live
consumption. If the console has no utilization view and quota is too high to
safely saturate with a second 32 GiB VM, record **NOT OBSERVABLE SAFELY** rather
than launching VMs until failure.

**Expected:** the suspended VM remains in `list-microvms`; the load-bearing
claim is discharged only if the account quota view continues counting its
32,768 MiB after `SUSPENDED`.

**Record:** quota names/codes/limits, list response, and four utilization
snapshots. Distinguish “listed” from “proven to consume quota.”

**ADR-021 item:** account-memory quota treatment of suspended VMs / concurrency
slot-held rationale.

### 5.6 Resume and state transition

**Purpose:** verify manual resume and preserved lifecycle identity.

```bash
aws lambda-microvms resume-microvm --microvm-identifier "$MICROVM_ID" \
  | tee "$EVIDENCE_DIR/resume-microvm.json"
for i in 1 2 3 4 5 6; do
  aws lambda-microvms get-microvm --microvm-identifier "$MICROVM_ID" || true
  sleep 10
done | tee "$EVIDENCE_DIR/resume-state-timeline.txt"
```

**Expected:** unknown for P1 because no `/resume` hook is declared and `/run`
may already have failed. Record whether resume succeeds and transitions to
`RUNNING`, conflicts, terminates, or disappears, and whether ID/endpoint remain
stable.

**Record:** response, transitions, latency, ID/endpoint stability.

**ADR-021 item:** empirical resume lifecycle input for P3 design.

### 5.7 Terminate and observe reaping

**Purpose:** validate active cleanup and the `NotFound → completed` strategy
mapping premise.

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ terminate-request'
aws lambda-microvms terminate-microvm --microvm-identifier "$MICROVM_ID" \
  | tee "$EVIDENCE_DIR/terminate-microvm.json"
for delay in 0 2 5 10 20 30 60 120; do
  sleep "$delay"
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  aws lambda-microvms get-microvm --microvm-identifier "$MICROVM_ID" || true
done | tee "$EVIDENCE_DIR/terminate-reap-timeline.txt"
```

**Expected:** `TERMINATING`/`TERMINATED` may be visible, followed by
`ResourceNotFoundException`. Exact reaping time is empirical.

**Record:** transition and seconds from terminate request to NotFound, including
exception name/message/status code.

**ADR-021 item:** explicit terminate path and `ResourceNotFoundException →
completed` mapping.

### 5.8 IAM negative tests (only under assumed orchestrator role)

**Purpose:** prove the deployed role cannot escape its exact image or mint JWE
tokens.

Run only if step 5.0 successfully assumed the orchestrator role. Otherwise mark
**SKIPPED — LAMBDA ROLE TRUST DOES NOT ALLOW OPERATOR ASSUMPTION** and rely on
4.4's policy document.

```bash
aws lambda-microvms run-microvm \
  --image-identifier "${IMAGE_NAME}-different" \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --egress-network-connectors "$EGRESS_CONNECTORS" \
  --maximum-duration-in-seconds 60 \
  2>&1 | tee "$EVIDENCE_DIR/iam-negative-different-image.txt"

aws lambda-microvms create-microvm-auth-token \
  --microvm-identifier "$MICROVM_ID" \
  --expiration-in-minutes 5 \
  --allowed-ports '[{"port":8080}]' \
  2>&1 | tee "$EVIDENCE_DIR/iam-negative-auth-token.txt"
```

**Expected:** both return `AccessDeniedException`. If the different-name test
returns `ResourceNotFoundException`, it does not prove exact-ARN denial; create
or use a real second sandbox image only if already available, otherwise mark
that sub-check inconclusive. The `allowed-ports` CLI union syntax is
best-effort; the verified SDK request is
`{microvmIdentifier, expirationInMinutes, allowedPorts:[{port:8080}]}`. A local
argument-parser error is not an IAM result.

**Record:** assumed caller ARN and full errors.

**ADR-021 item:** exact-image ARN scoping and no
`CreateMicrovmAuthToken`/no-JWE posture.

### 5.9 Direct service boundary: 16,384 vs 16,385 bytes

**Purpose:** independently verify the documented `runHookPayload` service cap.
This is direct-service validation; the ABCA strategy already routes envelopes
larger than 16,384 bytes to S3.

```bash
python3 - <<'PY'
from pathlib import Path
Path('/tmp/abca-payload-16384.txt').write_bytes(b'x' * 16384)
Path('/tmp/abca-payload-16385.txt').write_bytes(b'x' * 16385)
PY
wc -c /tmp/abca-payload-16384.txt /tmp/abca-payload-16385.txt

aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --egress-network-connectors "$EGRESS_CONNECTORS" \
  --run-hook-payload file:///tmp/abca-payload-16384.txt \
  --maximum-duration-in-seconds 60 \
  | tee "$EVIDENCE_DIR/run-payload-16384.json"

aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_NAME" --image-version "$IMAGE_VERSION" \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --egress-network-connectors "$EGRESS_CONNECTORS" \
  --run-hook-payload file:///tmp/abca-payload-16385.txt \
  --maximum-duration-in-seconds 60 \
  2>&1 | tee "$EVIDENCE_DIR/run-payload-16385.txt"
```

Immediately terminate the MicroVM returned by the accepted request (if any).

**Expected:** 16,384 bytes is accepted; 16,385 bytes is rejected, likely with
`ValidationException`. Record the actual exception rather than treating the
predicted name as normative. Confirm the installed CLI expands `file://` to file
contents; if it passes the literal URI, repeat with command substitution and
record the client behavior.

**Record:** byte counts, both complete responses, exception name/message/status,
and cleanup ID.

**ADR-021 item:** exact 16 KB `runHookPayload` boundary.

---

## Phase 6 — CLI behavior

### 6.1 Build and point the CLI at the stack

**Purpose:** use the repository CLI's real resolution rules: operator commands
take `--region`/`--stack-name`; configured Region is a fallback; API commands
also need Cognito configuration/login.

```bash
MISE_EXPERIMENTAL=1 mise //cli:build
bgagent() { node cli/lib/bin/bgagent.js "$@"; }
bgagent configure --stack-name "$STACK_NAME" --region "$AWS_REGION"
bgagent platform outputs --stack-name "$STACK_NAME" --region "$AWS_REGION"
```

**Expected:** config is written under `${BGAGENT_CONFIG_DIR:-$HOME/.bgagent}`;
stack outputs resolve. No Cognito login is needed for operator AWS commands.

**Record:** CLI build result and redacted outputs.

**ADR-021 item:** deploy/CLI substrate discovery contract.

### 6.2 Onboard, probe, inspect, and clean up a dummy row

**Purpose:** exercise the live managed-image probe, doctor check, and runtime
grouping without submitting a task.

```bash
export DUMMY_REPO=verification-only/issue-645
bgagent repo onboard "$DUMMY_REPO" \
  --compute-type lambda-microvm \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --output json | tee "$EVIDENCE_DIR/cli-onboard.json"

bgagent platform doctor --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --output json | tee "$EVIDENCE_DIR/cli-doctor.json" || true
bgagent runtime status --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --output json | tee "$EVIDENCE_DIR/cli-runtime-status.json"

bgagent repo offboard "$DUMMY_REPO" \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --output json | tee "$EVIDENCE_DIR/cli-offboard.json"
```

**Expected:** onboarding's `ListManagedMicrovmImages` probe passes and the row
has `compute_type=lambda-microvm`; doctor contains
`lambda_microvm_availability`; runtime status groups it under
`lambda_microvm_substrates`; offboard marks it removed. Doctor may still exit
non-zero in a virgin sandbox because its GitHub secret is an unpopulated
placeholder or no real repo/token/model access exists—record those independent
failures.

**SKIP-IF-UNCONFIGURED:** if the sandbox principal lacks DDB or MicroVM catalog
read permission, record the IAM gap and skip the write. Onboarding itself does
not require a valid GitHub token, but a meaningful doctor pass and any task do.

**Record:** probe result, row, doctor checks, grouping, and cleanup row status.

**ADR-021 item:** onboarding region probe and doctor availability check.

---

## Phase 7 — OPTIONAL negative task path

### 7.1 Submit only in a fully configured sandbox

**Purpose:** observe orchestrator classification and terminate-on-finalize, not
to claim P2 smoke parity.

This is **OPTIONAL / usually DEFERRED-TO-P2-ENV**. A virgin account is missing a
Cognito user/login, populated GitHub token secret, and a genuinely accessible
onboarded repository unless the executor configures all three. Do not create
those merely for this P1 substrate pass.

If they already exist:

```bash
bgagent login
bgagent repo onboard <owner/repo> --compute-type lambda-microvm \
  --stack-name "$STACK_NAME" --region "$AWS_REGION"
bgagent submit --repo <owner/repo> --task "P1 negative: observe hook-less MicroVM failure"
# Use the returned task ID:
bgagent watch <task-id>
```

**Expected:** the backend does not complete agent work. Capture the task's
failure classification/remedy, persisted `compute_metadata` (`microvmId` and
endpoint), orchestrator logs, and whether finalization calls
`TerminateMicrovm`. If no complete setup exists, write
`DEFERRED-TO-P2-ENV — missing Cognito user/login, GitHub token, and/or real repo
onboarding`.

**Record:** task ID/evidence or exact deferral reason.

**ADR-021 item:** defense-in-depth failure classification, handle persistence,
and terminate fire; this is not P2 clone→change→PR smoke parity.

---

## Phase 8 — Teardown

### 8.1 Terminate every MicroVM

**Purpose:** stop compute billing before image/stack deletion.

```bash
aws lambda-microvms list-microvms --image-identifier "$IMAGE_NAME" \
  | tee "$EVIDENCE_DIR/microvms-before-teardown.json"
for id in $(aws lambda-microvms list-microvms --image-identifier "$IMAGE_NAME" \
  --query 'items[].microvmId' --output text); do
  aws lambda-microvms terminate-microvm --microvm-identifier "$id" || true
done
sleep 30
aws lambda-microvms list-microvms --image-identifier "$IMAGE_NAME" \
  | tee "$EVIDENCE_DIR/microvms-after-terminate.json"
```

**Expected:** no nonterminal VM remains; wait/retry if necessary.

**Record:** IDs and final states.

**ADR-021 item:** explicit cleanup rather than relying on the eight-hour bound.

### 8.2 Delete out-of-band image versions and image

**Purpose:** stop snapshot storage charges. The verified operation/CLI command
name is `delete-microvm-image-version` with `imageIdentifier` and
`imageVersion`.

```bash
aws lambda-microvms list-microvm-image-versions --image-identifier "$IMAGE_NAME" \
  | tee "$EVIDENCE_DIR/image-versions-before-delete.json"
for version in $(aws lambda-microvms list-microvm-image-versions \
  --image-identifier "$IMAGE_NAME" --query 'items[].imageVersion' --output text); do
  aws lambda-microvms delete-microvm-image-version \
    --image-identifier "$IMAGE_NAME" --image-version "$version"
done
aws lambda-microvms delete-microvm-image --image-identifier "$IMAGE_NAME"
```

**Expected:** all versions enter deletion and the image is deleted. If the
service requires deleting the parent first/last or waiting between operations,
follow the returned conflict remedy and record actual order.

**Record:** versions, responses, final NotFound/list absence.

**ADR-021 item:** versioned image lifecycle cleanup.

### 8.3 Destroy ABCA; retain bootstrap

**Purpose:** remove the platform and recurring network costs while preserving
the account's reusable CDK bootstrap.

```bash
MISE_EXPERIMENTAL=1 mise //cdk:destroy -- \
  "$STACK_NAME" --force \
  --context compute_type=lambda-microvm \
  --context microvm_image_identifier="$IMAGE_NAME" \
  --context microvm_image_version="$IMAGE_VERSION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query 'Stacks[0].[StackStatus,Parameters]' \
  | tee "$EVIDENCE_DIR/bootstrap-left-in-place.json"
```

**Raw fallback if `mise` is absent** (run from `cdk/`):

```bash
npx cdk destroy "$STACK_NAME" --force \
  --context compute_type=lambda-microvm \
  --context microvm_image_identifier="$IMAGE_NAME" \
  --context microvm_image_version="$IMAGE_VERSION"
```

**Expected:** `backgroundagent-dev` is absent; `CDKToolkit` remains
`CREATE_COMPLETE`/`UPDATE_COMPLETE` with the custom policies. VPC teardown can
lag while service-managed ENIs are reclaimed; wait and retry rather than
force-deleting resources past CloudFormation.

**Record:** destroy duration/events, leftovers, and final bootstrap status.

**ADR-021 item:** clean substrate/resource lifecycle.

**Cost note:** this pass can accrue MicroVM running minutes, snapshot/image
storage, S3 artifact storage, NAT gateway hourly/data charges, VPC endpoint
hourly charges, CloudWatch logs, and brief Lambda/DynamoDB/API usage. Suspended
VMs should stop compute charges but may retain billed snapshot storage and
account memory quota; the experiment determines the latter. NAT gateways and
endpoints continue charging until stack deletion.

---

## Live execution results — 2026-07-31, account <account>, us-east-1

Executed against real AWS. Evidence directory:
`/tmp/abca-645-p1-20260731T184822Z`. Wall clock 18:48Z → 23:07Z (4 h 19 min).

**Execution deviations from the runbook as written** (each is itself a result):

1. `mise` is **not installed** on the executor; every **raw fallback** was used.
2. The account is **not virgin overall** — `serverless-api-powertools`,
   `BuildingServerlessAPIs`, `aws-sam-cli-managed-default`, and `CDKToolkit`
   pre-existed. `backgroundagent-dev` was absent, so the ABCA-specific
   first-deploy premise held.
3. `docker` is absent; `finch` 1.x (`CDK_DOCKER=finch`) built the AgentCore
   container asset.
4. Phase 2 could not deploy from unmodified sources. The stack was deployed from
   a **hand-patched cloud assembly** (`/tmp/cdkout-p1*`, a build artifact — no
   repository source file was modified). Two patches, both forced by live-service
   rejections recorded below: a MicroVM connector **operator role**, and moving
   subnets off `us-east-1a`.
5. A temporary **port-80 egress rule** (`sgr-07ed1fa48ef38467a`) was added to the
   construct's security group to get any image to build at all (see 4.3).
6. Suspend-TTL observation was **truncated at ~1 h** (runbook allows this).

### Phase 0

**0.1** — Account `<account>`, caller
`arn:aws:sts::<account>:assumed-role/AdminConsoleAccess/aamorosi-Isengard`
(administrator). Branch `feat/645-lambda-microvm-p1`, SHA
`0505f914fd7093cccd067b6346a24e1c40e50643`. Untracked: `docs/verification/`,
`opencode.json`. Stack absence returned exactly the expected error:

```
An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id backgroundagent-dev does not exist
```

**0.2** — `aws-cli/2.36.13 Python/3.14.6 Darwin/25.5.0 source/arm64`;
`node v24.16.0`; `cdk 2.1129.0`; `mise NOT INSTALLED`; `Python 3.9.6`;
`Zip 3.0`; **`openrsync` (protocol 29, "rsync 2.6.9 compatible")** — the
packaging script's `rsync -a --exclude` usage worked unmodified on macOS.
`@aws-sdk/client-lambda-microvms` = **3.1098.0**.

`aws lambda-microvms help` **succeeded (exit 0)** and lists **24** commands
including all seven the runbook requires. The CLI command list is an **exact
match** to the SDK 3.1098.0 command list (24 vs 24), including
`create-microvm-shell-auth-token`. **No CLI/SDK operation-name drift.**

`create-microvm-image --generate-cli-skeleton input` **confirms the packaging
script's shape and refutes the CDK L1 shape**:

- `cpuConfigurations[].architecture` — help documents exactly one allowed value:
  `ARM_64`. The L1's `'arm64'` is not a documented value.
- `hooks` — `{"port": integer, "microvmHooks": {"run": "DISABLED"|"ENABLED",
  "runTimeoutInSeconds": integer, ...}}`. There is **no hook-path field at all**;
  the L1's `run: '/run'` path string has no counterpart in the service model.
- `run-microvm` skeleton confirms `idlePolicy`
  `{maxIdleDurationSeconds, suspendedDurationSeconds, autoResumeEnabled}` and
  `runHookPayload` as a plain string.

The CFN-vs-API question is therefore **half-adjudicated**: the API side is
settled, but the `AWS::Lambda::MicrovmImage` CFN path was never exercised,
because the construct only synthesizes it when `microvm_base_image_arn` +
`microvm_base_image_version` context is supplied, and the runbook's Phase 4 uses
the out-of-band script path. **The CFN value shapes remain untested** — and 4.2
below shows the request would be rejected on hook semantics regardless of shape.

### Phase 1

**1.1** — `CDKToolkit` `CREATE_COMPLETE`, created 2025-11-24, `BootstrapVariant`
= `AWS CDK: Default Resources`. Markers: `ComputeTypes` **ABSENT**,
`IaCRoleABCAComputeLambdaMicrovms` **ABSENT**, `AdministratorAccess`
**present** — exactly the standard-bootstrap starting state the step predicts.

**1.2 — DEFECT (runbook + `mise //cdk:bootstrap`): the re-bootstrap is a silent
no-op on an already-bootstrapped account.** Verbatim:

```
Bootstrap stack already exists, containing 'AWS CDK: Default Resources'. Not overwriting it with a template containing 'ABCA: Least-Privilege Bootstrap' (use --force if you intend to overwrite)
✅  Environment aws://<account>/us-east-1 bootstrapped (no changes).
```

Exit status **0**. A pass that trusts this would proceed to 1.3 with
`AdministratorAccess` still attached. `--force` was required. A **durable**
consequence: after the forced bootstrap, `BootstrapVariant` **remains**
`AWS CDK: Default Resources` (the CDK CLI re-sends the previous value rather than
the template default `ABCA: Least-Privilege Bootstrap`), so **every future
non-forced `mise //cdk:bootstrap` will refuse again**.

**1.2 — DEFECT (runbook): the `ComputeTypes` parameter command as written is
rejected.** Verbatim:

```
An error occurred (ParamValidation): Parameter validation failed:
Invalid type for parameter Parameters[0].ParameterValue, value: ['agentcore', 'lambda-microvm'], type: <class 'list'>, valid types: <class 'str'>
```

The CLI shorthand parser splits on the comma. The escaped form
`ParameterValue=agentcore\,lambda-microvm` works — which is exactly what the
comment above `[tasks.bootstrap]` in `cdk/mise.toml` already shows; the runbook
dropped the escapes. Final state: `UPDATE_COMPLETE`, `ComputeTypes` =
`agentcore,lambda-microvm`.

**1.3 — PASS.** `CFN_EXEC_ROLE` =
`cdk-hnb659fds-cfn-exec-role-<account>-us-east-1`. Exactly one local policy
matched: `cdk-hnb659fds-IaCRole-ABCA-Compute-LambdaMicrovms-<account>-us-east-1`,
and it is attached. Attachments are the five ABCA policies (Application,
Infrastructure, Observability, Compute-Agentcore, Compute-LambdaMicrovms) and
**no `AdministratorAccess`** — the template's replacement works. The
`LambdaMicrovms` statement grants 19 actions, all image/version/build/
managed-catalog/network-connector, including `lambda:PassNetworkConnector`.
The optional scratch-qualifier negative was deliberately skipped as the runbook
directs.

### Phase 2

**2.1 — synth PASS, deploy BLOCKED THREE TIMES.** Synth emitted
`abca:microvm-image-not-provisioned` and **not**
`abca:microvm-image-p1-not-runnable`, exactly as specified. Incidental synth
warnings worth noting: `Template size is approaching limit: 893273/1000000` and
`Number of resources: 463 is approaching allowed maximum of 500`.

*Blocker A (environmental, not an ABCA defect).* The stack carries one Docker
image asset (`agent/Dockerfile`) and no container builder was installed. With
`finch`, the `gh-builder` stage failed twice on upstream flakiness:

```
pkg/mod/github.com/cli/go-gh/v2@v2.13.0/internal/yamlmap/yaml_map.go:8:2: unrecognized import path "gopkg.in/yaml.v3": reading https://gopkg.in/yaml.v3?go-get=1: 502 Proxy Error
```

`gopkg.in` alternated 200/502 from the host too. A direct `finch build` then
succeeded. **Data point for 4.3's size narrative:** the AgentCore container
image is **1.799 GB uncompressed / 629.7 MB compressed**.

*Blocker B — **the P1 substrate cannot deploy from unmodified sources**.*
`AWS::Lambda::NetworkConnector` `CREATE_FAILED`, verbatim:

```
Resource handler returned message: "NetworkConnectorOperatorRole is required for VPC_EGRESS connector type (Service: Lambda, Status Code: 400, Request ID: 04726267-6c61-4ff5-bb1d-302122e9f955) (SDK Attempt Count: 1)" (RequestToken: 1a1652c3-2166-e865-c49d-6cdb5927bbfe, HandlerErrorCode: InvalidRequest)
```

This **directly refutes an explicit design assumption** stated in
`cdk/src/constructs/lambda-microvm-compute.ts` (~line 467):

> `operatorRole` is left unset so Lambda manages the ENIs with its own
> service-linked role rather than a role we would have to trust.

The generated L1 also marks `operatorRole` optional
(`readonly operatorRole?: string`) with no note that `VPC_EGRESS` requires it.
An independent probe stack (`abca645-connector-probe`) confirmed the minimal
working recipe: a role trusting `lambda.amazonaws.com` with
`AWSLambdaVPCAccessExecutionRole` plus `ec2:CreateNetworkInterface` /
`DeleteNetworkInterface` / `DescribeNetworkInterfaces` / `DescribeSubnets` /
`DescribeVpcs` / `DescribeSecurityGroups` / `CreateTags` /
`AssignPrivateIpAddresses` / `UnassignPrivateIpAddresses` /
`Describe|ModifyNetworkInterfaceAttribute` → connector `CREATE_COMPLETE`.

*Blocker C (AgentCore, account-AZ-specific, blocks any ABCA deploy here).*

```
Resource handler returned message: "Agent runtime creation failed with status: CREATE_FAILED for runtime: backgroundagentdevRuntimeCC6E3A5A-yiKm9OEVPo. Reason: The following subnets are in unsupported availability zones in region us-east-1: subnet-02b0221802f3fee10 in us-east-1a (ID: use1-az6). Supported availability zones are: use1-az4, use1-az1, use1-az2"
```

This account maps `us-east-1a` → `use1-az6`. `AgentVpc` does not constrain AZ
selection, so CDK's default two-AZ pick lands on an AZ AgentCore rejects.
Patched `us-east-1a` → `us-east-1c` (`use1-az2`).

*Two further teardown/iteration gotchas.* (i) Rollback itself failed once:
`Validation failed during DeleteMemory: Memory is in transitional state
CREATING. Cannot delete memory.` — `AWS::BedrockAgentCore::Memory` cannot be
deleted while creating, leaving `ROLLBACK_FAILED`; a plain `delete-stack`
cleared it. (ii) Post-synth template edits are **silently ignored** if the
template's S3 asset object already exists: the object key is the pre-edit content
hash recorded in `*.assets.json`, so `cdk-assets` skips the upload and CFN
re-uses the stale template. The stale object must be deleted.

Successful deploy: `CREATE_COMPLETE`, 19:41:53Z → 19:55:35Z = **13 min 42 s**,
464 resources.

**2.2 — PASS.** `ComputeSubstrate=lambda-microvm`; all six `Microvm…` outputs
populated; artifact key exactly `microvm-images/agent-artifact.zip`. The 13
`LambdaMicrovmCompute` resources are: artifact + payload buckets (each with a
bucket policy and an auto-delete custom resource), build role + policy, execution
role + policy, `AWS::EC2::SecurityGroup sg-0e662dc0d6f6e9ade`,
`AWS::Logs::LogGroup /aws/lambda-microvms/backgroundagent-dev-abca-agent`, and
`AWS::Lambda::NetworkConnector nc-132ede11-cb63-4dfa-b75b-6a4713023c1a`.
**No `AWS::Lambda::MicrovmImage`** — correct for this state. The security group
has exactly one rule: egress `tcp/443 → 0.0.0.0/0`, *"Allow HTTPS egress (GitHub
API, AWS services)"*. (That single rule is what breaks the image build — 4.3.)

**2.3 — PASS.** `MICROVM_*` keys = `[]` (14 env keys total).
**DEFECT (runbook): the `ORCHESTRATOR_FN` command is broken by pagination.**
With 464 resources, `list-stack-resources --query "…|[0]"` applies the query
**per page** and printed five lines (`None None None None <name>`), which then
failed `get-function-configuration` on the multi-line value. Needs
`--no-paginate` (or local parsing). Resolved value:
`backgroundagent-dev-TaskOrchestratorOrchestratorFn-gM2sydgNVf1V`.

**2.4 — PASS.** All **six** taggable construct resources carry
`abca:compute-backend=lambda-microvm`: security group, network connector, log
group, both buckets, and — verified via `iam list-role-tags` — both roles.
`resourcegroupstaggingapi` returned only **5** ARNs; **IAM roles are simply not
returned by that API**, which is an API coverage gap, not a missing tag.
Bucket policies and auto-delete custom resources are not independently taggable,
as the step anticipates.

### Phase 3

**3.1 — PASS** (exit 1). Verbatim:

```
Error: AWS Lambda MicroVMs are not available in eu-central-1. The lambda-microvm compute backend is enabled (--context compute_type=lambda-microvm) but the stack Region is not one of: us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1. Either deploy the stack into a supported Region, drop the backend (--context compute_type=agentcore or ecs), or — if AWS has since launched Lambda MicroVMs in eu-central-1 — bypass this static check with --context microvm_region_override=true and add eu-central-1 to LAMBDA_MICROVM_SUPPORTED_REGIONS in cdk/src/handlers/shared/microvm-regions.ts.
```

Names the Region, all five supported Regions, and the override flag.

**3.2 — PASS** (exit 0) with `abca:microvm-region-override` (and, correctly, the
`abca:microvm-image-not-provisioned` warning still present).

### Phase 4

**4.1 — PASS, with a runbook selector bug.** Exactly **one** managed base image
exists in us-east-1: `arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`, with
versions `1` (created 2026-07-21) and `0` (2026-06-17). **Ordering is
newest-first**, so the runbook's `items[-1].imageVersion` returns **`0`** (the
older version); `items[0]` returns `1`. The runbook's own warning about ordering
is therefore *load-bearing here*. Selected `1`; the service echoes it back as
`baseImageVersion: "1.0"`.

**4.2 — Artifact plane PASS; image creation FAILED TWICE on service
validation.** The script read all five outputs, staged `Dockerfile` + `agent/` +
`contracts/`, printed **`584K artifact`**, and uploaded successfully (S3
`ContentLength` **597305**, SSE `AES256`).

Then, on the exact request the script builds, verbatim:

```
An error occurred (ValidationException) when calling the CreateMicrovmImage operation: The ready (/ready) MicroVM image hook must be enabled when any MicroVM lifecycle hook (run, resume, suspend, or terminate) is enabled. The ready hook signals when the application has finished initializing so the snapshot is taken in a ready state.
```

This **refutes the P1 hook-phasing plan directly**. The construct comments state
`/ready` and `/validate` are *"omitted in P1 because the agent does not implement
them yet: configuring a `/validate` endpoint that 404s would fail every image
build"* — but the service **will not accept `run: ENABLED` without
`ready: ENABLED`**. "Declare `/run` in P1, serve it in P2" is not a reachable
state.

Consequences of that failure: **the conspicuous "P1 image is NOT runnable end to
end" banner was never printed**, because the script's banner heredoc comes after
the `create-microvm-image` call. Also, the runbook's `2>&1 | tee` pipeline
reported `EXIT=0` while the script had failed — the tee status masks it.

Retrying with `/ready` enabled surfaced the **second** rejection:

```
An error occurred (ValidationException) when calling the CreateMicrovmImage operation: The requested memory size of 32768 MiB is not supported by base MicroVM image arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1. Supported memory sizes in MiB are: [512, 1024, 2048, 4096, 8192].
```

The script's and construct's `32768` MiB (`DEFAULT_MINIMUM_MEMORY_MIB`,
documented as *"the service ceiling"*) is **not accepted**. The ceiling for this
base image is **8192 MiB (8 GiB)**, a quarter of what ADR-021 claims.

**4.3 — Image ACTIVE only after two more corrections; the P1 hook shape is
UNBUILDABLE.**

*Attempt 1* (hooks omitted, 8192 MiB): create succeeded, returning
`imageVersion: "1.0"` — **not `1`**, contradicting the runbook's
`IMAGE_VERSION=1` and the script's `--image-version 1` guidance. Both builds then
**FAILED** with `stateReason: "The container image build failed."` The exact
root cause, from `/aws/lambda-microvms/backgroundagent-dev-abca-agent`:

```
Could not connect to deb.debian.org:80 (146.75.38.132), connection timed out
E: Unable to locate package curl
E: Unable to locate package git
E: Unable to locate package build-essential
E: Package 'gnupg' has no installation candidate
ERROR: process "/bin/sh -c apt-get update && ... apt-get install -y --no-install-recommends curl git build-essential ca-certificates gnupg ..." did not complete successfully: exit code: 100
```

**The construct's 443-only security group makes the agent image unbuildable.**
`agent/Dockerfile` runs `apt-get`, which uses HTTP on **port 80**; DNS resolution
worked, so only the port is the problem. Adding a temporary port-80 egress rule
(`sgr-07ed1fa48ef38467a`) fixed it immediately.

*Attempt 2* (`update-microvm-image`, port 80 open) produced version **`2.0`**,
both builds `SUCCESSFUL`, `state=SUCCESSFUL`, `status=ACTIVE` in
20:11:18Z → 20:17:09Z = **5 min 51 s**.

Further API-shape observations:

- **Two builds per image version**, one per `chipsetGeneration` (`3` and `4`,
  `chipset: GRAVITON`). The runbook's `items[0].buildState` inspects only one.
- `list-microvm-image-builds --image-identifier <bare name>` →
  `ValidationException: Invalid ARN format: backgroundagent-dev-abca-agent`.
  **An ARN is required.** `--image-version` accepts either `1` or `1.0`.
- `snapshotBuild` is returned by **`get-microvm-image-build`**, not by
  `get-microvm-image-version` (which returned `snapshotBuild: null`).

Sizes (`buildId 2033b7d8-1aa2-44a4-b174-3fc4bffebcea`, GRAVITON gen 4):

| Field | Bytes | Human |
|---|---|---|
| `codeInstallSizeInBytes` | 2,334,748,672 | **2.17 GiB** |
| `memorySnapshotSizeInBytes` | 1,216,577,536 | 1.13 GiB |
| `diskSnapshotSizeInBytes` | 37,089,280 | 35.4 MiB |

**Code-install size (2.17 GiB) exceeds AgentCore's 2 GB container-image limit**,
while the equivalent OCI image built locally was 1.799 GB (629.7 MB compressed).
So the same agent tree is *over* the AgentCore ceiling when measured as MicroVM
code-install and *under* it as an OCI image — the two are not interchangeable
measures, and the ADR narrative should say which one it means. Memory and disk
snapshots are deliberately **not** summed into that comparison.

**Disk capacity: NOT EXPOSED.** No disk quota appears in `service-quotas`
(full list under 5.5) and no image/version field reports disk capacity. The
32 GB disk claim remains unverified; the 32 GB *memory* claim is refuted (8 GiB).

*The decisive experiment.* A second image (`…-abca-agent-hooks`) was created with
the **exact P1 hook shape plus the service-mandated `/ready`**, and rebuilt after
port 80 was open. Both builds **FAILED**:

```
Ready hook check failed: the application returned a client error (HTTP 4xx) response
```

The agent **does** answer on port 8080 (an HTTP 4xx, not a connection failure),
but does not implement `/ready`. Combined with 4.2: **a P1 image that declares
`/run` cannot be built at all**, and an image that omits hooks cannot receive a
`runHookPayload` (5.1). P1 as specified is not merely "not runnable end to end" —
its image is **not creatable**.

**4.4 — PASS, exactly as designed.** `UPDATE_COMPLETE`. Synth emitted
`abca:microvm-image-p1-not-runnable` with the full expected text. Orchestrator
env is exactly the five variables and **no ingress variable**:

```
MICROVM_EGRESS_CONNECTOR_ARNS = arn:aws:lambda:us-east-1:<account>:network-connector:nc-132ede11-cb63-4dfa-b75b-6a4713023c1a
MICROVM_EXECUTION_ROLE_ARN    = arn:aws:iam::<account>:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-ZJu8Y1ybJt1N
MICROVM_IMAGE_IDENTIFIER      = backgroundagent-dev-abca-agent
MICROVM_IMAGE_VERSION         = 1.0
MICROVM_PAYLOAD_BUCKET        = backgroundagent-dev-lambdamicrovmcomputepayloadbuc-en08fimmvu6h
```

Inline policy `TaskOrchestratorOrchestratorFnServiceRoleDefaultPolicyDECF0D43`:

- `Sid: MicrovmLifecycle` — exactly `lambda:RunMicrovm`, `lambda:GetMicrovm`,
  `lambda:TerminateMicrovm` on exactly
  `arn:aws:lambda:us-east-1:<account>:microvm-image:backgroundagent-dev-abca-agent`
  and `…:backgroundagent-dev-abca-agent:*`. **Observed image ARN format matches**
  the Service Authorization Reference pattern the construct derives.
- `Sid: MicrovmPassNetworkConnector` — `lambda:PassNetworkConnector` on `*`.
- `Sid: MicrovmPassExecutionRole` — `iam:PassRole` scoped to the execution role
  with `iam:PassedToService = lambda.amazonaws.com`.
- **Zero** `SuspendMicrovm` / `ResumeMicrovm` / `CreateMicrovmAuthToken` actions
  anywhere in the role (only attached managed policy is
  `AWSLambdaBasicDurableExecutionRolePolicy`).

**Critical mismatch:** `MICROVM_IMAGE_IDENTIFIER` is a **bare name**, and
`RunMicrovm` rejects bare names (5.1). The construct's comment asserts the
opposite — *"`imageIdentifier` may legitimately be a bare image NAME (that is
what `create-microvm-image --name` returns and what `run-microvm
--image-identifier` accepts)"*. `lambda-microvm-strategy.ts:236` passes that env
var straight through, so the P1 orchestrator would fail at `RunMicrovm`.

### Phase 5

**5.0 — ADMIN — advisory.** AssumeRole denied, verbatim:

```
An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:sts::<account>:assumed-role/AdminConsoleAccess/aamorosi-Isengard is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::<account>:role/backgroundagent-dev-TaskOrchestratorOrchestratorFnS-Bd7rBa2V6Jwf
```

Trust policy allows only `Service: lambda.amazonaws.com`. Trust was **not**
modified. All Phase 5 lifecycle evidence is therefore **admin-identity**;
4.4's static policy inspection remains the authoritative scoping evidence.

**5.1 — Hook-less behaviour MEASURED: the VM runs and stays running.**
Three requests, in order:

1. Bare name → `ValidationException: Malformed ARN - doesn't start with 'arn:'`
2. ARN + `--run-hook-payload` on the hook-less image →
   `ValidationException: The run hook must be enabled in the MicroVM image to pass the run hook payload`
3. ARN, no payload → **success**:

```json
{ "microvmId": "microvm-b44b69d9-f23b-30d1-97d1-a4ac558cfb5c",
  "state": "PENDING",
  "endpoint": "<vm-id>.lambda-microvm.us-east-1.on.aws",
  "imageArn": "arn:aws:lambda:us-east-1:<account>:microvm-image:backgroundagent-dev-abca-agent",
  "imageVersion": "2.0",
  "maximumDurationInSeconds": 28800,
  "ingressNetworkConnectors": ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS"],
  "egressNetworkConnectors": ["arn:aws:lambda:us-east-1:<account>:network-connector:nc-132ede11-cb63-4dfa-b75b-6a4713023c1a"] }
```

`maximumDurationInSeconds=28800` accepted; `idlePolicy` omitted as required.
Timeline: `RUNNING` at **+12 s**, and still `RUNNING` at +15/+21/+32/+53/+84/
**+145 s**, `stateReason` always `None`. It did **not** terminate, stall in
`PENDING`, or disappear. A hook-less MicroVM is a healthy idle VM that bills.

**Security finding — unrequested public ingress.** The service **auto-attached**
`arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS`
even though `--ingress-network-connectors` was never passed, and returned a
public `*.lambda-microvm.us-east-1.on.aws` endpoint. ADR-021's "no ingress"
posture is not what the service defaults to; it is a *default-on* public HTTP
ingress that P1 neither requests nor suppresses.

**5.2 — five of six states observed.** `PENDING`, `RUNNING`, `SUSPENDED`,
`TERMINATING`, `TERMINATED`. **`SUSPENDING` was never observable** — suspend
reached `SUSPENDED` in under 1 s. No unknown/unmapped state appeared.
`ResourceNotFoundException` for a reaped ID was **not** reached (5.7).

**5.3 — PASS.** Admin `suspend-microvm` on a hook-less image with no
`idlePolicy`: **empty response body**, `SUSPENDED` at **+1 s**, stable across
+12/+23/+34/+44/+55 s. Explicit suspend works independently of any idle policy,
and a hook-less image is perfectly suspendible.

**5.4 — Suspended TTL: survived the full observation window; TRUNCATED at ~1 h.**
Suspended at 20:21:12Z. `maximumDurationInSeconds` was 28800 and `startedAt`
stayed 20:18:05Z throughout.

| Checkpoint | Wall clock | Suspended age | `get-microvm` state | `list-microvms` | Account quota view |
|---|---|---|---|---|---|
| start | 20:21:13Z | 1 s | `SUSPENDED` | present | `L-CD1C0CC4` = 1024 GB (limit only) |
| +15 min | 20:36:27Z | 915 s | `SUSPENDED` | present | 1024 GB (unchanged) |
| +45 min | 21:06:12Z | 2700 s | `SUSPENDED` | present | 1024 GB (unchanged) |
| ~+1 h (cap) | 21:21:29Z | 3617 s | `SUSPENDED` | present | 1024 GB (unchanged) |

**No suspended TTL was observed within 1 h.** The runbook's 4-hour checkpoint was
**not** run (time-boxed, as the runbook permits). So the answer is bounded, not
final: *a manually suspended MicroVM with no `idlePolicy` survives at least
1 h 0 min 17 s (3617 s)*; whether a TTL exists between 1 h and the 8 h
`maximumDurationInSeconds` bound is **still open**. The VM was terminated in
Phase 8 rather than left to expire.

**5.5 — Suspended VM stays listed; quota consumption NOT PROVABLE.**
`service-quotas list-service-quotas --service-code lambda` returned 24 MicroVM
quotas. The load-bearing ones:

| Code | Name | Value |
|---|---|---|
| `L-CD1C0CC4` | Max allocated memory | **1024 Gigabytes** |
| `L-B430C318` | Max Execution Duration of a MicroVM (in Hours) | **8** |
| `L-942E56BE` | Number of MicroVM images | 100 |
| `L-F8BECE9C` | Versions per MicroVM Image | 50 |
| `L-72E0D058` | Number of concurrent MicroVM image builds | 10 |
| `L-535CA9B6` / `L-91B95582` | Rate / burst of `RunMicrovm` | 5 / 5 |
| `L-90045317` / `L-139F9A48` | Rate / burst of `SuspendMicrovm` | 2 / 2 |
| `L-118C44B3` / `L-25EEC0A4` | Rate / burst of `ResumeMicrovm` | 5 / 5 |
| `L-74787B8A` / `L-2CCA0501` | Rate / burst of `TerminateMicrovm` | 10 / 10 |
| `L-7712260B` / `L-D65D9F16` | Rate / burst of `CreateMicrovmAuthToken` | 50 / 50 |
| `L-772D8D8F` … `L-19741F6D` | Concurrent connections per 1/2/4/8/16 vCPU MicroVM | 8 / 16 / 32 / 64 / 128 |

`L-B430C318 = 8 hours` independently confirms the 28,800-second bound. There is
**no disk quota at all**, corroborating "disk capacity not exposed".
`L-CD1C0CC4` is `QuotaAppliedAtLevel: ACCOUNT`, described as *"The maximum amount
of memory that can be allocated across all MicroVMs per account per region.
Customers can burst up to 4x this limit."*

**Utilization is not observable.** `get-service-quota` returns **no
`UsageMetric`** for `L-CD1C0CC4`; `AWS/Usage` exposes only `CallCount` per API
name (`RunMicrovm`, `GetMicrovm`, `CreateMicrovmImage`, …) and **no memory
metric**; there is no MicroVM metric in `AWS/Lambda` and no MicroVM CloudWatch
namespace. Saturating the quota would require ~128 × 8 GiB VMs.

**Verdict: LISTED, NOT PROVEN.** The suspended VM remained in `list-microvms` at
every checkpoint, but the claim *"a suspended VM still holds account memory
quota"* is **NOT OBSERVABLE SAFELY** in this account and remains undischarged.
Note also that the rationale was written for 32,768 MiB per VM against this
1024 GB quota; at the real 8192 MiB ceiling the arithmetic changes by 4×.

**5.6 — Resume PASSES with no `/resume` hook declared.** Run on a second VM
(`microvm-d4992cba-92a5-328b-b534-d40ef8715ab3`) so the TTL observation was not
disturbed. `resume-microvm` returned an empty body; state `RUNNING` at **+1 s**
and stable through +55 s. **`microvmId` and `endpoint` were byte-identical before
and after** suspend/resume — lifecycle identity is preserved, so a stored
`SessionHandle` survives a suspend/resume cycle.

**5.7 — Terminate is fast; `NotFound` did NOT arrive.** Terminate requested
20:26:09Z: `TERMINATING` at **+1 s**, `TERMINATED` at **+3 s**, then still
`TERMINATED` at +9/+20/+41/+72/+133/**+254 s**, and still `TERMINATED` at the
+15-min checkpoint (~10 min after termination) and in `list-microvms` at every
later checkpoint. **`ResourceNotFoundException` was never observed.** The
strategy's `NotFound → completed` mapping is not wrong, but it is **not the
near-term signal**: for at least ~10 minutes the observable terminal state is
`TERMINATED`, so `TERMINATED` must map to completed on its own.

**5.8 — SKIPPED as a role-scoped test** (Lambda role trust does not allow
operator assumption — 5.0). Advisory admin-identity results:

- Different image ARN → `ResourceNotFoundException: No active version found for
  MicroVM image arn:aws:lambda:us-east-1:<account>:microvm-image:backgroundagent-dev-abca-agent-different`.
  **Inconclusive** for exact-ARN denial, exactly as the runbook predicts. Note
  the message is about *no active version*, not a missing image.
- `create-microvm-auth-token --expiration-in-minutes 5 --allowed-ports
  '[{"port":8080}]'` → **SUCCEEDED**. The CLI union syntax is valid, and the
  request shape matches the SDK. It returned a genuine JWE under key
  `X-aws-proxy-auth` (header `{"kid":"9e81880a-…","alg":"dir","enc":"A256GCM"}`),
  **minted against a `SUSPENDED` MicroVM**. So tokens are mintable at will by any
  principal holding the action, including for suspended VMs; the no-JWE posture
  rests entirely on the orchestrator role omitting the action, which 4.4 verified
  statically.

**5.9 — The 16 KB boundary is WRONG: the real cap is 4096.** Both runbook
payloads were rejected identically:

```
An error occurred (ValidationException) when calling the RunMicrovm operation: 1 validation error detected: Value at 'runHookPayload' failed to satisfy constraint: Member must have length less than or equal to 4096
```

Re-measured at the real boundary: **4096 bytes passes length validation** (and
then fails only the hook-enabled check), **4097 bytes is rejected** with the
message above. The CLI **does** expand `file://` (a literal URI would have been
33 bytes and passed). Length validation runs **before** the hook-enabled check,
which is why the boundary was measurable on a hook-less image at all.

`lambda-microvm-strategy.ts:84` sets `RUN_HOOK_PAYLOAD_LIMIT_BYTES = 16_384` and
inlines anything `<= 16384`; ADR-021 states `≤ 16 KB` in four places. Any
envelope between 4,097 and 16,384 bytes would be inlined by the strategy and
**rejected by the service**. No MicroVM was created by these calls, so no
cleanup was needed.

### Phase 6

**6.1 — PASS.** `npx tsc -p cli/tsconfig.json` built cleanly (mise fallback).
`bgagent configure` wrote config (`BGAGENT_CONFIG_DIR=/tmp/abca-645-bgagent`);
`platform outputs` resolved all seven MicroVM outputs. No Cognito login was
needed for operator AWS commands, as documented.

**6.2 — PASS.** `repo onboard verification-only/issue-645 --compute-type
lambda-microvm` succeeded (the live `ListManagedMicrovmImages` probe passed) with
`status: active`, `compute_type: lambda-microvm`.
`platform doctor` returned `passed: true` with **all six** checks passing,
including `lambda_microvm_availability` — *"Managed MicroVM images are available
in us-east-1"*. (`github_token` also passed: the CFN-generated secret holds a
32-character generated placeholder, which the check cannot distinguish from a
real PAT — worth noting, since the runbook expected doctor to fail here.)
`runtime status` grouped the row under `lambda_microvm_substrates` with
`used_by_repos: ["verification-only/issue-645"]`.
`repo offboard` set `status: removed` with a TTL. Nothing was skipped.

### Phase 7

**7.1 — DEFERRED-TO-P2-ENV — missing Cognito user/login and real repo
onboarding.** The user pool `us-east-1_sYU3Rftw6` has **zero users**, so
`bgagent login` is impossible, and no genuinely accessible repository is
onboarded; the platform GitHub secret is a 32-character generated placeholder.
None of these were created, per the step's instruction. Independently, the task
path could not have produced meaningful classification evidence: `RunMicrovm`
rejects the bare-name identifier the orchestrator injects (4.4 / 5.1), so every
task would fail with a `ValidationException` at launch rather than at
"session start" as the P1 narrative predicts.

### Phase 8 — teardown (executed)

**8.1** — `list-microvms` before teardown showed
`microvm-b44b69d9-…` `SUSPENDED` and `microvm-d4992cba-…` `TERMINATED`.
`terminate-microvm` on the suspended VM (a `SUSPENDED` VM terminates directly,
no resume required) → both `TERMINATED`; no non-terminal VM remained.

**8.2** — Both out-of-band images deleted (`list-microvm-images` now returns
**empty**). **Correction to the runbook's loop:** the *last remaining* version
cannot be deleted individually —
`ValidationException: This is the last version. Please delete the entire image` —
so the correct order is *delete every version except the last, then delete the
image*, which reaps the final version. A version delete in flight also puts the
image in `UPDATING` and makes concurrent calls fail with
`ConflictException: MicroVM Image is already in state: UPDATING` and
`ValidationException: Cannot delete MicroVM image in its current state: <arn>`;
both cleared on retry after ~40 s. Versions reaped: `1.0` + `2.0` on
`…-abca-agent` and `1.0` + `2.0` on `…-abca-agent-hooks` — note that **failed
builds still create versions that must be reaped**. `get-microvm-image` on the
first image now returns
`ResourceNotFoundException: MicroVMImage not found for MicroVMImageID: <arn>`.

**8.3 — Stack deletion is INCOMPLETE: `DELETE_FAILED`, blocked by leaked
AgentCore ENIs. All billable resources are confirmed gone.**

`cdk destroy` ran 21:24:34Z and deleted 460 of 464 resources. It then failed:

```
The following resource(s) failed to delete: [AgentVpcRuntimeSG96507CD0, AgentVpcPrivateSubnet1Subnet8051BB57, AgentVpcPrivateSubnet2SubnetC66971D0].
resource sg-05f50b9950d41572e has a dependent object (Service: Ec2, Status Code: 400 …)
Resource handler returned message: "The subnet 'subnet-0befbffccbb83b718' has dependencies and cannot be deleted. (Service: Ec2, Status Code: 400 …)"
```

Cause: two ENIs of `InterfaceType: agentic_ai` (AgentCore-managed, requester
`AROA…[redacted]:[redacted]`) — `eni-080353b2356328ed7` and
`eni-04500acbfed377f4a` — remained `in-use` in the private subnets. The runbook's
own gotcha ("VPC teardown can lag while service-managed ENIs are reclaimed; wait
and retry rather than force-deleting resources past CloudFormation") was
followed: **three** `delete-stack` retries spread over ~1 h 40 min (21:48Z,
22:37Z, 23:05Z) all returned `DELETE_FAILED`, and the ENIs were still `in-use`
each time. A direct `delete-network-interface` was attempted once for diagnosis
and correctly refused (`InvalidParameterValue: Network interface … is currently
in use.`); nothing was force-deleted past CloudFormation.

Final residual state of `backgroundagent-dev` — **4 resources, all zero-cost**:
`AWS::EC2::VPC AgentVpcA6796801` (`vpc-0a12c1a64cc960c6a`), two private subnets,
and one security group, plus the two AgentCore ENIs holding them.

**Billing is stopped.** Verified after teardown:

- MicroVMs: both `TERMINATED`; `list-microvm-images` empty (no snapshot storage).
- **NAT gateways: none in the ABCA VPC** (`nat-0c6cdbee97699f4e8` deleted
  21:24:43Z). The two `available` NAT gateways in the account belong to
  pre-existing `vpc-01c9984d163d2965e` and were **not** created or touched by
  this run.
- **VPC endpoints in the ABCA VPC: none.**
- ABCA S3 buckets: none (auto-delete custom resources emptied them).
- Elastic IPs: no unattached (billable) addresses.
- `/aws/lambda-microvms/backgroundagent-dev-abca-agent`: deleted.

Retry command for whoever picks this up (should succeed once AgentCore releases
the ENIs):

```bash
aws cloudformation delete-stack --stack-name backgroundagent-dev
aws cloudformation wait stack-delete-complete --stack-name backgroundagent-dev
```

**Verification-only resources created and removed:** the
`abca645-connector-probe` stack (deleted — `Stack with id
abca645-connector-probe does not exist`) and the temporary port-80 egress rule
`sgr-07ed1fa48ef38467a` (removed with its security group when the stack deleted
it). The local `finch` VM was stopped.

**Bootstrap retained as instructed:** `CDKToolkit` `UPDATE_COMPLETE`,
`ComputeTypes = agentcore,lambda-microvm`, with all five ABCA policies attached
to `cdk-hnb659fds-cfn-exec-role-<account>-us-east-1` and **no
`AdministratorAccess`**.

---

## Results table (fill this in)

Use one row per material observation; add rows as needed.

| Step | Expected | Observed | ADR item discharged | Feeds back to design? |
|---|---|---|---|---|
| Setup | Vars + evidence dir | `us-east-1`, `backgroundagent-dev`, evidence `/tmp/abca-645-p1-20260731T184822Z`. `mise` absent → all **raw fallbacks** used | Reproducibility | No |
| 0.1 | Virgin account, correct branch | Account `<account>`, admin `AdminConsoleAccess/aamorosi-Isengard`, branch OK, SHA `0505f914`. `backgroundagent-dev` absent (`ValidationError … does not exist`). **Account not virgin overall** — 3 unrelated stacks + `CDKToolkit` pre-existed; ABCA itself never deployed, so the premise holds | Clean first-deploy path | No |
| 0.2 | CLI exposes Lambda MicroVMs; SDK 3.1098.0 | `aws lambda-microvms help` **exit 0**, 24 commands, all 7 required present. CLI command list is an **exact match** to SDK 3.1098.0 (24 vs 24). CLI 2.36.13, cdk 2.1129.0, node 24.16.0, python 3.9.6, **openrsync** (worked). Skeleton confirms `ARM_64`-only and `ENABLED\|DISABLED` hooks with a single `hooks.port` and **no hook-path field** | API/action-name verification | **Yes — CFN L1 shapes (`arm64`, `run:'/run'`) have no counterpart in the service model** |
| 1.2 | Custom template replaces admin bootstrap | **DEFECT: `cdk bootstrap --template …` is a silent no-op** on an already-bootstrapped account (`Not overwriting it with a template containing 'ABCA: Least-Privilege Bootstrap' (use --force …)`, **exit 0**). `--force` required. `BootstrapVariant` then *stays* `AWS CDK: Default Resources`, so every future non-forced bootstrap refuses again. **DEFECT: the runbook's `--parameters` shorthand is rejected** (`Invalid type for parameter Parameters[0].ParameterValue, value: ['agentcore', 'lambda-microvm'] … valid types: <class 'str'>`); the escaped `agentcore\,lambda-microvm` works | Conditional bootstrap IAM | **Yes — `mise //cdk:bootstrap` + runbook/docs** |
| 1.3 | Custom policy attached for `agentcore,lambda-microvm` | `ComputeTypes=agentcore,lambda-microvm`; exactly one `IaCRole-ABCA-Compute-LambdaMicrovms` policy, attached to `cdk-hnb659fds-cfn-exec-role-…`; 5 ABCA policies, **no `AdministratorAccess`**; 19 MicroVM/connector actions incl. `PassNetworkConnector` | Conditional bootstrap IAM | No |
| 2.1 (synth) | No-image warning | `abca:microvm-image-not-provisioned` present, `…p1-not-runnable` correctly absent. Incidental: template 893273/1000000, 463/500 resources | First-deploy bootstrap state | No |
| 2.1 (deploy) | Substrate deploys | **BLOCKED — cannot deploy from unmodified sources.** `AWS::Lambda::NetworkConnector` CREATE_FAILED: `"NetworkConnectorOperatorRole is required for VPC_EGRESS connector type (… Status Code: 400 …)" HandlerErrorCode: InvalidRequest`. Refutes the construct's stated *"`operatorRole` is left unset so Lambda manages the ENIs with its own service-linked role"*. Deployed only after patching in an operator role (+ moving off `us-east-1a`): `CREATE_COMPLETE` in **13 min 42 s** | Conditional substrate — **only with a code fix** | **YES — construct must create + pass an operator role; L1 marks it optional** |
| 2.1 (deploy, 2nd) | — | **AgentCore blocker:** `The following subnets are in unsupported availability zones in region us-east-1: subnet-… in us-east-1a (ID: use1-az6). Supported availability zones are: use1-az4, use1-az1, use1-az2`. This account maps `us-east-1a`→`use1-az6`; `AgentVpc` does not constrain AZs | — | **YES — `AgentVpc` should pin AgentCore-supported AZs** |
| 2.1 (rollback) | — | Rollback itself failed: `Validation failed during DeleteMemory: Memory is in transitional state CREATING. Cannot delete memory.` → `ROLLBACK_FAILED`; plain `delete-stack` cleared it | — | Minor — yes (`AgentMemory` delete retry) |
| 2.2 | Outputs/resources present | `ComputeSubstrate=lambda-microvm`; all six `Microvm…` outputs populated; key `microvm-images/agent-artifact.zip`; 2 buckets, build+execution roles, **443-only SG** (`sg-0e662dc0d6f6e9ade`, one rule tcp/443), `/aws/lambda-microvms/…` log group, `AWS::Lambda::NetworkConnector`; **no `AWS::Lambda::MicrovmImage`** | Conditional substrate/config | No |
| 2.3 | No `MICROVM_*` env | `[]` ✓ (14 env keys). **DEFECT: the runbook's `ORCHESTRATOR_FN` query is broken by pagination** — 464 resources → the query ran per page and returned 5 values (`None None None None <name>`), breaking the next call. Needs `--no-paginate` | Reject-without-image config | Yes — runbook |
| 2.4 | Construct resources have backend tag | All **6** taggable resources tagged `abca:compute-backend=lambda-microvm` (SG, connector, log group, 2 buckets, 2 roles). `resourcegroupstaggingapi` returned only 5 — **IAM roles are not returned by that API** (coverage gap, not a missing tag); confirmed via `iam list-role-tags` | Cost attribution | No |
| 3.1–3.2 | Unsupported failure; override warning | 3.1 exit 1 naming `eu-central-1`, all five Regions, and `--context microvm_region_override=true`. 3.2 exit 0 with `abca:microvm-region-override` (plus the not-provisioned warning) | Region gate/escape hatch | No |
| 4.1 | Live regional probe | Exactly **one** base image: `…:aws:microvm-image:al2023-1`, versions `1` and `0`. **Ordering is newest-first, so the runbook's `items[-1]` selects the OLDER version `0`**; `items[0]`=`1` is correct. Service echoes `baseImageVersion: "1.0"` | Regional availability probe | Yes — runbook selector |
| 4.2 (artifact) | Script uploads | Staged + zipped + uploaded fine on macOS/openrsync: script printed `584K artifact`, S3 `ContentLength 597305`, SSE `AES256` | Packaging plane | No |
| 4.2 (create) | Image created; P1 banner shown | **FAILED:** `The ready (/ready) MicroVM image hook must be enabled when any MicroVM lifecycle hook (run, resume, suspend, or terminate) is enabled.` → **the P1 banner was never printed** (it comes after the failing call), and the runbook's `2>&1 \| tee` reported `EXIT=0`, masking the failure | **NOT discharged** — packaging + operator warning | **YES — "declare `/run` in P1, serve it in P2" is not a reachable state** |
| 4.2 (memory) | 32,768 MiB accepted | **FAILED:** `The requested memory size of 32768 MiB is not supported by base MicroVM image …al2023-1. Supported memory sizes in MiB are: [512, 1024, 2048, 4096, 8192].` Real ceiling **8192 MiB (8 GiB)**, ¼ of the documented figure | Refutes sizing premise | **YES — `DEFAULT_MINIMUM_MEMORY_MIB` and ADR-021's "32 GB RAM"** |
| 4.3 (build 1) | Build successful | **FAILED** (`The container image build failed.`). Root cause in the log group: `Could not connect to deb.debian.org:80 (146.75.38.132), connection timed out` → `E: Unable to locate package curl/git/build-essential` → `exit code: 100`. **The construct's 443-only SG makes the agent image unbuildable** (`apt-get` needs port 80; DNS was fine) | **NOT discharged** without a fix | **YES — SG must allow 80, or the Dockerfile must not use HTTP apt** |
| 4.3 (build 2) | Image ACTIVE | After adding a temporary port-80 egress rule: version **`2.0`** `state=SUCCESSFUL`, `status=ACTIVE` in **5 min 51 s**, both builds `SUCCESSFUL` | Buildability (with fixes) | No |
| 4.3 (shapes) | `IMAGE_VERSION=1` | **Version is `1.0`, not `1`.** **Two builds per version** (`chipsetGeneration` 3 and 4, GRAVITON) — the runbook's `items[0]` checks only one. `list-microvm-image-builds --image-identifier <bare name>` → `ValidationException: Invalid ARN format: …` (**ARN required**). `snapshotBuild` lives on `get-microvm-image-build`, **not** on the version (which returns `null`) | State/shape mapping | Yes — runbook + script |
| 4.3 (sizes) | Size vs 2 GB narrative | `codeInstallSizeInBytes` **2,334,748,672 (2.17 GiB) — exceeds AgentCore's 2 GB container-image limit**; `memorySnapshotSizeInBytes` 1,216,577,536 (1.13 GiB); `diskSnapshotSizeInBytes` 37,089,280 (35.4 MiB). Same tree as an OCI image = 1.799 GB (629.7 MB compressed). Snapshots deliberately not summed | Sizing narrative | **Yes — state which measure the 2 GB comparison uses** |
| 4.3 (disk) | Verify 32 GB disk | **NOT EXPOSED** — no disk quota in `service-quotas`, no disk field on image/version. 32 GB disk unverified; 32 GB *memory* refuted | Disk external fact | Yes |
| 4.3 (P1 shape) | — | **Decisive:** the exact P1 hook shape + service-mandated `/ready` **FAILED both builds**: `Ready hook check failed: the application returned a client error (HTTP 4xx) response`. The agent *does* answer on 8080 but not `/ready`. **A P1 image declaring `/run` is not creatable at all** | Refutes P1 premise | **YES — P1/P2 hook phasing** |
| 4.4 | Env present; exact image IAM; no JWE grant | **PASS exactly as designed.** `abca:microvm-image-p1-not-runnable` emitted. Exactly 5 `MICROVM_*` vars, no ingress var. `MicrovmLifecycle` = exactly `RunMicrovm`/`GetMicrovm`/`TerminateMicrovm` on `…:microvm-image:backgroundagent-dev-abca-agent` + `:*`; `MicrovmPassNetworkConnector` on `*`; `MicrovmPassExecutionRole` with `iam:PassedToService=lambda.amazonaws.com`; **zero** Suspend/Resume/AuthToken actions | Least privilege | No |
| 4.4 (identifier) | Bare name accepted by RunMicrovm | **REFUTED.** `MICROVM_IMAGE_IDENTIFIER` is the bare name `backgroundagent-dev-abca-agent`; `run-microvm` with a bare name → `ValidationException: Malformed ARN - doesn't start with 'arn:'`. `lambda-microvm-strategy.ts:236` passes it straight through, so P1 would fail at launch | Refutes construct comment | **YES — inject the image ARN, not the name** |
| 5.0 | Assume-role identity or trust denial | **ADMIN — advisory.** `AccessDenied … not authorized to perform: sts:AssumeRole on resource: …TaskOrchestratorOrchestratorFnS-Bd7rBa2V6Jwf`; trust = `lambda.amazonaws.com` only. Trust not modified | Verification confidence | No |
| 5.1 | Hook-less behavior measured, not assumed | **Measured: it runs and keeps running.** `RUNNING` at **+12 s**, still `RUNNING` at +145 s, `stateReason` always `None` — no terminate, no stall, no disappearance. `maximumDurationInSeconds=28800` accepted, `idlePolicy` omitted. A payload on a hook-less image is rejected: `The run hook must be enabled in the MicroVM image to pass the run hook payload` | P1/P2 phase boundary | **Yes — P2 startup/hooks** |
| 5.1 (ingress) | No ingress | **Service auto-attached `…:aws:network-connector:aws-network-connector:HTTP_INGRESS`** with a public `*.lambda-microvm.us-east-1.on.aws` endpoint, though none was requested. "No ingress" is not the service default | Security posture | **YES — P1 must suppress or accept default public ingress** |
| 5.2 | Actual state enum values recorded | Observed 5 of 6: `PENDING`, `RUNNING`, `SUSPENDED`, `TERMINATING`, `TERMINATED`. **`SUSPENDING` never observable** (<1 s). No unknown state. `ResourceNotFoundException` not reached | State mapping | Yes (see 5.7) |
| 5.3 | Manual suspend without idle policy | **PASS.** Admin suspend on a hook-less image, no `idlePolicy`: **empty response body**, `SUSPENDED` at **+1 s**, stable | Explicit suspend external fact | **Yes — P3 lifecycle** |
| 5.4 | Suspended TTL/checkpoint result | **No TTL within 1 h.** `SUSPENDED` at start / +15 min / +45 min / +1 h (3617 s); `startedAt` and `maximumDurationInSeconds=28800` unchanged. **TRUNCATED at ~1 h**; the 4 h checkpoint was NOT run, so a TTL between 1 h and the 8 h bound is **still open** | Partially — bounded below only | **Yes — timeout policy** |
| 5.5 | Suspended quota consumption proven/inconclusive | **LISTED, NOT PROVEN — NOT OBSERVABLE SAFELY.** Suspended VM present in `list-microvms` at every checkpoint. `L-CD1C0CC4 Max allocated memory = 1024 GB` (ACCOUNT, "burst up to 4x"), **no `UsageMetric`**; `AWS/Usage` has only `CallCount`; no MicroVM memory metric anywhere. Proving it needs ~128 × 8 GiB VMs. `L-B430C318 = 8 hours` independently confirms the 28,800 s bound; **no disk quota exists** | **NOT discharged** | **Yes — concurrency policy; rationale was sized on 32 GiB/VM, real is 8 GiB** |
| 5.6 | Resume transitions/result | **PASS with no `/resume` hook declared.** `RUNNING` at **+1 s**, empty response body; **`microvmId` and `endpoint` byte-identical** across suspend→resume, so a stored `SessionHandle` survives | Resume external fact | **Yes — P3 hooks/reconciliation** |
| 5.7 | Terminate→NotFound timing | `TERMINATING` **+1 s** → `TERMINATED` **+3 s**, then `TERMINATED` at +254 s and still `TERMINATED` ~10 min later and at every later checkpoint. **`ResourceNotFoundException` never observed** | Partially — terminate path yes, `NotFound` mapping no | **YES — `TERMINATED` must map to completed; `NotFound` is not the near-term signal** |
| 5.8 | Different image/JWE denied under role | **SKIPPED — LAMBDA ROLE TRUST DOES NOT ALLOW OPERATOR ASSUMPTION.** Advisory (admin): different image ARN → `ResourceNotFoundException: No active version found for MicroVM image …-different` (**inconclusive**, as predicted). `create-microvm-auth-token … --allowed-ports '[{"port":8080}]'` **SUCCEEDED** as admin, returning a real JWE under `X-aws-proxy-auth` (`{"alg":"dir","enc":"A256GCM"}`) **against a SUSPENDED VM**; CLI union syntax valid. No-JWE posture rests solely on 4.4's role omission | Static only (4.4) | Yes — tokens are mintable for suspended VMs |
| 5.9 | 16,384 accepted; 16,385 rejected | **REFUTED — the cap is 4096, not 16,384.** Both 16,384 and 16,385 → `Value at 'runHookPayload' failed to satisfy constraint: Member must have length less than or equal to 4096`. Re-measured: **4096 passes, 4097 rejected**. CLI does expand `file://`. Length validation precedes the hook check. `RUN_HOOK_PAYLOAD_LIMIT_BYTES = 16_384` would inline 4,097–16,384-byte envelopes that the service rejects | **Refutes the documented boundary** | **YES — strategy threshold + ADR-021 (4 places)** |
| 6.1–6.2 | Onboard probe, doctor, grouping, cleanup | **PASS, nothing skipped.** `npx tsc` build clean; `platform outputs` resolved all 7 MicroVM outputs; onboard probe passed with `compute_type=lambda-microvm`, `status=active`; doctor `passed: true` with all 6 checks including `lambda_microvm_availability` ("Managed MicroVM images are available in us-east-1"); `runtime status` grouped under `lambda_microvm_substrates`; offboard `status=removed` + TTL. Note `github_token` **passed** on a 32-char generated placeholder | CLI regional enforcement | Minor — yes (`github_token` can't detect a placeholder) |
| 7.1 | Negative task evidence or explicit deferral | **DEFERRED-TO-P2-ENV — missing Cognito user/login, real GitHub token, and real repo onboarding.** User pool `us-east-1_sYU3Rftw6` has **zero users**; secret is a 32-char placeholder. Not created, per the step. Independently moot: `RunMicrovm` rejects the bare-name identifier, so tasks would fail at launch, not at session start | Not discharged (by design) | **Yes — P2 env** |
| 8.1–8.2 | VMs/images gone | **PASS.** Both MicroVMs `TERMINATED` (a `SUSPENDED` VM terminates directly, no resume needed). `list-microvm-images` **empty**. **Correction:** the last remaining version cannot be deleted alone (`This is the last version. Please delete the entire image`) — delete all but the last, then the image. Concurrent calls during a version delete give `ConflictException: MicroVM Image is already in state: UPDATING`. **Failed builds still create versions that must be reaped** (`1.0`+`2.0` on both images) | Versioned image lifecycle | Yes — runbook loop order |
| 8.3 | Stack gone; bootstrap retained | **PARTIAL — `DELETE_FAILED`.** 460/464 resources deleted; VPC + 2 private subnets + 1 SG remain, blocked by two leaked AgentCore ENIs (`InterfaceType: agentic_ai`) still `in-use` after 3 retries over ~1 h 40 min. **All billable resources confirmed gone** (no ABCA NAT gateway, no VPC endpoints, no buckets, no images/VMs, no unattached EIPs); residual 4 resources are zero-cost. Nothing force-deleted past CFN. `CDKToolkit` retained `UPDATE_COMPLETE`, `ComputeTypes=agentcore,lambda-microvm`, 5 ABCA policies, no `AdministratorAccess`. Verification-only extras (`abca645-connector-probe`, temp rule `sgr-07ed1fa48ef38467a`) removed | Partially — cleanup blocked by AgentCore | **YES — AgentCore ENI reclaim blocks clean `cdk destroy`** |

## Findings summary

Live run, 2026-07-31, account `<account>`, `us-east-1`, branch
`feat/645-lambda-microvm-p1` @ `0505f914`. Evidence:
`/tmp/abca-645-p1-20260731T184822Z`.

**Headline:** the *P1 substrate* is broadly correct — conditional bootstrap IAM,
outputs, tags, region gate, warnings, exact-ARN least privilege, and the CLI
surface all behave as designed. But **P1 cannot deploy, cannot build its image,
and cannot launch a MicroVM from unmodified sources**: five independent
live-service rejections had to be worked around to get any empirical result, and
three documented ADR-021 constants (32 GB memory, 16 KB payload, bare-name image
identifier) are **wrong**.

### Items discharged (behaved exactly as designed)

1. **0.2** — CLI/SDK operation names: `aws lambda-microvms` exposes 24 commands,
   an exact match to SDK 3.1098.0. No action-name drift; the packaging script's
   `ARM_64` / `ENABLED` shapes are confirmed correct against the live model.
2. **1.3** — Conditional bootstrap IAM: `IaCRole-ABCA-Compute-LambdaMicrovms` is
   created and attached only with `ComputeTypes` including `lambda-microvm`, and
   `AdministratorAccess` really is replaced.
3. **2.2** — Substrate contract: `ComputeSubstrate=lambda-microvm`, all six
   `Microvm…` outputs, both buckets, both roles, 443-only SG, `/aws/lambda-microvms/`
   log group, network connector, and **no** `AWS::Lambda::MicrovmImage`.
4. **2.3** — All-or-nothing config: zero `MICROVM_*` env vars without an image.
5. **2.4** — Cost tags: all six taggable construct resources carry
   `abca:compute-backend=lambda-microvm`.
6. **3.1 / 3.2** — Region gate and escape hatch, verbatim as specified.
7. **4.1** — Live regional availability probe works.
8. **4.2 (artifact half)** — Packaging plane: zip+Dockerfile staging, no secret
   build inputs, correct bucket/key, works on macOS with `openrsync`.
9. **4.4** — Least privilege: exactly `RunMicrovm`/`GetMicrovm`/`TerminateMicrovm`
   on exactly the image ARN + `:*`; `PassNetworkConnector`; scoped `iam:PassRole`;
   **zero** `SuspendMicrovm`/`ResumeMicrovm`/`CreateMicrovmAuthToken`. Both
   no-image and image-configured warnings fire correctly.
10. **5.3** — Manual suspend works without any `idlePolicy` (`SUSPENDED` in ~1 s).
11. **5.6** — Manual resume works with no `/resume` hook declared; `microvmId`
    **and** `endpoint` are preserved, so `SessionHandle` survives a cycle.
12. **5.7 (terminate half)** — Explicit terminate is near-instant
    (`TERMINATING` +1 s → `TERMINATED` +3 s).
13. **6.1 / 6.2** — CLI: outputs discovery, live `ListManagedMicrovmImages`
    onboarding probe, `lambda_microvm_availability` doctor check,
    `lambda_microvm_substrates` grouping, and offboard all pass.
14. **8.1 / 8.2** — MicroVM and image cleanup paths work (with the version-order
    correction below).

### Items contradicting design assumptions — `feeds-back-to-design: YES`

Ordered by severity.

**F1. The P1 image is not creatable at all** (blocks the entire P1 premise).
`create-microvm-image` with the script's/construct's hook shape:

```
ValidationException: The ready (/ready) MicroVM image hook must be enabled when any MicroVM lifecycle hook (run, resume, suspend, or terminate) is enabled. The ready hook signals when the application has finished initializing so the snapshot is taken in a ready state.
```

And with `/ready` added as demanded, both builds fail:

```
Ready hook check failed: the application returned a client error (HTTP 4xx) response
```

ADR-021's hook-phasing plan ("declare `/run` in P1, serve it in P2; omit `/ready`
and `/validate` because the agent does not implement them") is **not a reachable
service state**. The only creatable P1 image is one with **no hooks at all**, and
such an image **cannot accept a `runHookPayload`**
(`The run hook must be enabled in the MicroVM image to pass the run hook
payload`) — so P1's payload-delivery path cannot function either. The agent does
answer on port 8080 (HTTP 4xx, not a connection refusal), so serving `/ready`
is the unblocking change.

**F2. The substrate cannot deploy: the network connector requires an operator
role.**

```
"NetworkConnectorOperatorRole is required for VPC_EGRESS connector type (Service: Lambda, Status Code: 400, Request ID: 04726267-6c61-4ff5-bb1d-302122e9f955)" HandlerErrorCode: InvalidRequest
```

This refutes the explicit comment in `lambda-microvm-compute.ts` (~L467):
*"`operatorRole` is left unset so Lambda manages the ENIs with its own
service-linked role rather than a role we would have to trust."* The generated L1
also mis-signals it as optional (`readonly operatorRole?: string`). Proven fix
(validated standalone): a role trusting `lambda.amazonaws.com` with
`AWSLambdaVPCAccessExecutionRole` + `ec2:CreateNetworkInterface` /
`DeleteNetworkInterface` / `DescribeNetworkInterfaces` / `DescribeSubnets` /
`DescribeVpcs` / `DescribeSecurityGroups` / `CreateTags` /
`AssignPrivateIpAddresses` / `UnassignPrivateIpAddresses` /
`Describe|ModifyNetworkInterfaceAttribute`.

**F3. `RunMicrovm` requires an image ARN; the orchestrator injects a bare name.**

```
ValidationException: Malformed ARN - doesn't start with 'arn:'
```

`MICROVM_IMAGE_IDENTIFIER` is set to `backgroundagent-dev-abca-agent` and
`lambda-microvm-strategy.ts:236` passes it straight to `RunMicrovm`. The
construct's comment claims *"`run-microvm --image-identifier` accepts"* bare
names — it does not. Every P1 task would fail at launch. The same applies to
`list-microvm-image-builds` (`ValidationException: Invalid ARN format: …`), which
the packaging script's operator instructions also get wrong. Note the construct
already derives the correct ARN for IAM, so the fix is to inject that ARN.

**F4. The 443-only security group makes the agent image unbuildable.**

```
Could not connect to deb.debian.org:80 (146.75.38.132), connection timed out
E: Unable to locate package curl / git / build-essential
… did not complete successfully: exit code: 100
```

`agent/Dockerfile` runs `apt-get`, which uses **HTTP/80**; the construct's SG
allows only 443 (DNS resolution succeeded, so the port is the sole cause). Either
the SG must allow 80 for build-time egress, or the Dockerfile must use an
HTTPS apt transport/mirror. Opening port 80 made the build succeed immediately.

**F5. Memory: 32,768 MiB is rejected; the real ceiling is 8,192 MiB.**

```
ValidationException: The requested memory size of 32768 MiB is not supported by base MicroVM image arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1. Supported memory sizes in MiB are: [512, 1024, 2048, 4096, 8192].
```

`DEFAULT_MINIMUM_MEMORY_MIB = 32768` is documented in the construct as *"the
service ceiling"*, and ADR-021 states **32 GB RAM** in at least three places
(comparison table, constraint paragraph, consequences). The real ceiling for the
only available base image (`al2023-1`) is **8 GiB — one quarter**. This
materially changes the "MicroVMs target the default-sized workload" positioning
*and* the 5.5 concurrency arithmetic (which was sized on 32 GiB/VM).

**F6. `runHookPayload` cap is 4096 bytes, not 16,384.**

```
ValidationException: 1 validation error detected: Value at 'runHookPayload' failed to satisfy constraint: Member must have length less than or equal to 4096
```

Boundary measured exactly: **4096 passes, 4097 fails**. Both of the runbook's
16 KB probes failed. `RUN_HOOK_PAYLOAD_LIMIT_BYTES = 16_384`
(`lambda-microvm-strategy.ts:84`) would inline every envelope from 4,097 to
16,384 bytes and the service would reject all of them; ADR-021 repeats `≤ 16 KB`
in four places, including the P1 requirement statement.

**F7. `RunMicrovm` attaches a default public HTTP ingress connector.**
Without `--ingress-network-connectors`, the response contained:

```
"ingressNetworkConnectors": ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS"]
```

plus a public `*.lambda-microvm.us-east-1.on.aws` endpoint. ADR-021's "no
orchestrator→agent HTTP path / no ingress in P1–P3" posture is **not the service
default**; P1 either has to suppress it explicitly or document that a public
ingress endpoint exists on every agent MicroVM.

**F8. `NotFound` is not the near-term terminal signal.** After terminate, the VM
was `TERMINATED` at +3 s and **still `TERMINATED` ~10 min later** and at every
subsequent checkpoint; `ResourceNotFoundException` was **never observed**. The
strategy's `NotFound → completed` mapping is fine as a fallback, but `TERMINATED`
must map to completed in its own right or the orchestrator will poll a terminal
VM indefinitely. Relatedly, **`SUSPENDING` is not observable** (suspend reaches
`SUSPENDED` in <1 s), so any state machine that waits for `SUSPENDING` will hang.

**F9. Hook-less MicroVMs run indefinitely and bill.** A P1-style hook-less image
reaches `RUNNING` in **12 s** and stays `RUNNING` (no `stateReason`, no
self-termination) up to its 8 h `maximumDurationInSeconds`. The P1 narrative
("a launch may return an ID and endpoint and then fail its hook or terminate")
is wrong in the safe direction for correctness and wrong in the *expensive*
direction for cost: nothing fails, so nothing cleans up. Active
`TerminateMicrovm` is mandatory, not belt-and-braces.

**F10. `mise //cdk:bootstrap` silently no-ops on an already-bootstrapped
account** — `Not overwriting it with a template containing 'ABCA: Least-Privilege
Bootstrap' (use --force if you intend to overwrite)` with **exit 0**. Worse, after
a forced bootstrap `BootstrapVariant` remains `AWS CDK: Default Resources`, so
the refusal recurs forever. Any operator following ADR-002's documented flow on an
existing account keeps `AdministratorAccess`.

**F11. `AgentVpc` picks AZs AgentCore rejects.**
`The following subnets are in unsupported availability zones in region us-east-1:
subnet-… in us-east-1a (ID: use1-az6). Supported availability zones are:
use1-az4, use1-az1, use1-az2`. AZ *names* are account-scoped, so this is a
latent first-deploy failure for any account whose `us-east-1a` maps to `use1-az6`.

**F12. AgentCore leaks ENIs and blocks `cdk destroy`.** Two
`InterfaceType: agentic_ai` ENIs stayed `in-use` for >1 h 40 min after runtime
deletion, leaving the stack `DELETE_FAILED` with VPC/subnets/SG undeletable.
Also `AWS::BedrockAgentCore::Memory` cannot be deleted while `CREATING`
(`Validation failed during DeleteMemory: Memory is in transitional state
CREATING`), which turned one rollback into `ROLLBACK_FAILED`.

**F13. `codeInstallSizeInBytes` = 2.17 GiB exceeds AgentCore's 2 GB image
limit**, while the same tree as an OCI image is 1.799 GB (629.7 MB compressed).
The ADR's "compare to AgentCore's 2 GB limit" narrative must say *which* measure
it means, because the two straddle the limit.

**F14. Runbook/tooling defects found in execution** (lower severity, but they
would silently corrupt a future pass):

- The `--parameters 'ParameterKey=ComputeTypes,ParameterValue=agentcore,lambda-microvm'`
  form is rejected (`Invalid type for parameter … valid types: <class 'str'>`);
  needs `agentcore\,lambda-microvm`, as `cdk/mise.toml` already shows.
- `list-stack-resources --query "…|[0]"` is **paginated** at 464 resources and
  returned five values, breaking `ORCHESTRATOR_FN`. Needs `--no-paginate`.
- `list-managed-microvm-image-versions` is **newest-first**, so `items[-1]`
  selects the *older* version.
- Image version is **`1.0`**, not `1`, so `IMAGE_VERSION=1` is wrong.
- There are **two builds per version** (GRAVITON gen 3 and 4); `items[0]` checks
  only one.
- `snapshotBuild` comes from `get-microvm-image-build`, not
  `get-microvm-image-version` (which returns `null`).
- The script's failure is masked by `2>&1 | tee` (reported `EXIT=0`), and its
  "P1 image is NOT runnable" banner never prints because it sits *after* the
  `create-microvm-image` call that fails.
- Teardown: the **last** image version cannot be deleted individually
  (`This is the last version. Please delete the entire image`).
- Post-synth cloud-assembly template edits are ignored if the template's S3
  asset object already exists (key = pre-edit content hash).

### Items skipped, blocked, or inconclusive

| Item | Verdict | Reason |
|---|---|---|
| 1.3 optional negative (scratch-qualifier bootstrap) | **SKIPPED** | The runbook directs skipping it; not cheap enough and complicates teardown. |
| CFN `AWS::Lambda::MicrovmImage` value shapes (`arm64`, `run:'/run'`) | **NOT TESTED** | The construct only synthesizes the L1 with `microvm_base_image_arn`/`_version` context, which the runbook's Phase 4 does not use. The API side is settled (0.2) and the request would be rejected on hook semantics anyway (F1), so the CFN-vs-API shape question stays **open**. |
| 5.4 suspended TTL beyond 1 h | **TRUNCATED / OPEN** | Time-boxed at ~1 h as the runbook permits. `SUSPENDED` held at start/+15/+45/+60 min (3617 s). The 4 h checkpoint was not run; a TTL between 1 h and the 8 h bound remains unknown. Bounded result: **survives ≥ 1 h with no `idlePolicy`**. |
| 5.5 suspended VM consumes account memory quota | **NOT OBSERVABLE SAFELY / UNDISCHARGED** | The VM stays in `list-microvms`, but that only proves *listed*. `L-CD1C0CC4` (1024 GB, ACCOUNT) exposes **no `UsageMetric`**; `AWS/Usage` has only `CallCount`; no MicroVM memory metric exists in any namespace; no console utilization view is reachable from a CLI-only session. Proving it would need ~128 × 8 GiB VMs. |
| 5.8 IAM negatives under the orchestrator role | **SKIPPED — LAMBDA ROLE TRUST DOES NOT ALLOW OPERATOR ASSUMPTION** | `AccessDenied … sts:AssumeRole`; trust is `lambda.amazonaws.com` only and was deliberately not modified. 4.4's static policy inspection is authoritative. |
| 5.8 exact-ARN denial sub-check | **INCONCLUSIVE** | As the runbook predicts, a different image name returns `ResourceNotFoundException: No active version found for MicroVM image …-different`, not `AccessDenied`. Advisory only (admin identity). |
| 5.8 no-JWE posture | **STATIC ONLY** | As admin, `create-microvm-auth-token` **succeeded**, returning a real JWE (`{"alg":"dir","enc":"A256GCM"}`, key `X-aws-proxy-auth`) — **against a `SUSPENDED` VM**. The posture depends entirely on the role omitting the action. |
| 7.1 negative task path | **DEFERRED-TO-P2-ENV** | Cognito pool `us-east-1_sYU3Rftw6` has **zero users**, no real repo onboarded, GitHub secret is a 32-char generated placeholder. Not created, per the step. Independently moot given F3. |
| 8.3 stack deletion | **DELETE_FAILED (billing stopped)** | Leaked AgentCore ENIs (F12). 4 zero-cost resources remain; all billable resources verified gone. Retry command recorded in 8.3. |
| Disk capacity / 32 GB disk claim | **NOT EXPOSED** | No disk quota in `service-quotas`, no disk field on image or version. Unverified. |

### Elapsed and approximate cost

**Elapsed:** 18:48Z → 23:07Z = **4 h 19 min** wall clock. Of that, ~1 h was the
suspend-TTL observation (run concurrently with the CLI phase, IAM checks, the
16 KB probes, and the second image build, per instructions — no idle waiting);
~1 h 15 min was consumed by the three blocked deploys plus rollbacks/redeploys;
~1 h 40 min was teardown retries.

**Approximate cost: well under US$10, dominated by NAT gateways and VPC
endpoints, not by MicroVMs.**

| Item | Quantity | Est. |
|---|---|---|
| NAT gateways (2 × $0.045/h) | ~2.3 h summed across 4 stack lifetimes | ~$0.21 + trivial data |
| Interface VPC endpoints (7 × $0.01/h × 2 AZ) | ~1.6 h | ~$0.22 |
| MicroVM runtime | VM1 ~3 min `RUNNING` + ~2 h 45 min `SUSPENDED`; VM2 ~3 min | < $0.50 (suspended compute is not billed; snapshot storage was < 3 h) |
| MicroVM image builds | 6 builds (2 versions × 2 chipsets × 2 images), ~6 min each | low single-digit $ at most |
| Snapshot/image storage | ~3.5 GiB × 2 images × < 3 h | negligible |
| AgentCore runtime | created 4×, never invoked | negligible |
| S3 / DynamoDB / Lambda / API GW / Cognito / Secrets / logs | brief, mostly idle | < $1 |
| ECR container asset (retained in bootstrap) | 630 MB stored | ~$0.06/month ongoing |

The 8 h `maximumDurationInSeconds` worst case was never approached; both VMs were
explicitly terminated.

### Deliberately left in place

1. **`CDKToolkit`** — retained as the runbook instructs, now carrying
   `ComputeTypes=agentcore,lambda-microvm` and the five ABCA least-privilege
   policies **instead of `AdministratorAccess`**. ⚠️ This is a change to a
   *shared* account: other CDK apps in `<account>` now deploy through the
   ABCA-scoped execution role. The original standard-bootstrap template is
   captured at `$EVIDENCE_DIR/cdktoolkit-template-before.txt` if it needs
   restoring.
2. **`backgroundagent-dev` in `DELETE_FAILED`** — VPC `vpc-0a12c1a64cc960c6a`,
   two private subnets, one security group, and two leaked AgentCore ENIs. Zero
   cost; retry `delete-stack` once AgentCore releases the ENIs.
3. **Bootstrap S3/ECR assets** — including the 630 MB agent container image,
   normal bootstrap content.
4. **Service-vended log groups** — `/aws/bedrock-agentcore/runtimes/…` and
   `/aws/lambda/backgroundagent-dev-…` created outside CloudFormation.

Untouched and **not** created by this run: the pre-existing stacks
(`serverless-api-powertools`, `BuildingServerlessAPIs`,
`aws-sam-cli-managed-default`) and the two `available` NAT gateways in
`vpc-01c9984d163d2965e`.

### Recommended follow-up before P1 merges

F1, F2, F3, F4, F5, and F6 are each independently sufficient to make the
`lambda-microvm` backend non-functional. F1 (the `/ready` requirement) is the one
that changes the *shape* of the phase plan rather than a constant, so it should be
adjudicated first: either P1 grows a minimal `/ready` (and `/run`) responder, or
P1 ships a hook-less image and explicitly defers all payload delivery to P2.

## Report back

Attach or summarize the evidence paths, then provide the filled results table to
the orchestrator. Draft it as a comment for issue #645; **do not post it until
the orchestrator reviews it**. Highlight every `BLOCKED`, `INCONCLUSIVE`,
`SKIPPED`, and `DEFERRED-TO-P2-ENV` result and explicitly separate observed AWS
behavior from expectations inferred from the SDK model.
