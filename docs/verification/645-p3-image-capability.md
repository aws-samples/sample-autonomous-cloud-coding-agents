# ADR-021 P3: per-worker image capability

Date: 2026-09-15. Local implementation on `fix/645-microvm-readiness`, following
the [guest hook milestone](./645-p3-lifecycle-hooks.md). This has not been deployed;
the last verified AWS image is still `2.0`. Automatic suspension remains disabled.

## What this adds

An image is the saved starting computer. Its version identifies which saved copy a
worker actually started from. Updating the image later does not update an existing
worker. The supervisor therefore needs the worker's own version, rather than the
deployment's newest image, before deciding whether it can safely sleep.

Managed images and the out-of-band packaging helper now declare all six served
hooks. Suspend/resume use the shared 30-second service timeout, leaving headroom
above the guest's 20-second handler budget. The image also stores the non-secret
`ABCA_MICROVM_LIFECYCLE_PROTOCOL=1` marker. `/validate` rejects a supplied
incompatible marker without contacting AWS. A missing marker remains acceptable
for ordinary legacy/AgentCore startup, but cannot establish sleep support.

After `RunMicrovm`, the coordinator:

1. Saves the known worker ID/endpoint and actual returned `imageArn`/`imageVersion`
   before any optional image query.
2. Calls `GetMicrovmImageVersion` for that exact ARN/version, with a three-second
   request budget. A foreign or missing image identity cannot borrow deployment
   configuration.
3. Checks the returned identity, shared marker and port, all six enabled hooks,
   and suspend/resume budgets.
4. Conditionally adds `lifecycleProtocol` to both the saved start handle and
   `compute_metadata`, only while both records still identify the same launch.
   This preserves task status, including cancellation.

Failed lookup, unsupported hooks/marker or a rejected capability write keeps the
saved worker available for ordinary tasks and cleanup, with new suspension
disabled. Error logs contain the error type, not returned image environment data
or exception text. Saved handles are replayed without reinterpreting them through
the current deployment configuration.

Both the policy and the lifecycle intent store require persisted capability for
new suspend requests. The transaction also compares image identity and protocol
with the original read, so a stale decision cannot admit sleep. Resume remains
available for legacy/unknown images that need recovery.

## AWS contract and permission scope

The pinned SDK exposes actual `imageArn`/`imageVersion` in `RunMicrovmResponse`.
`GetMicrovmImageVersionOutput` exposes that version's hooks and environment.
`UpdateMicrovmImageVersionRequest` accepts identity plus `status`, not replacement
hooks, environment or code. Changing a version to `INACTIVE` stops new launches;
it does not erase an existing worker's support.

The [official AWS Lambda service reference](https://servicereference.us-east-1.amazonaws.com/v1/lambda/lambda.json)
classifies `GetMicrovmImageVersion` as a read action on `microvmImage`.
The coordinator adds this action to its existing configured-image ARN scope.
It still has no Suspend/Resume grant or automatic suspension caller at this
milestone. Bootstrap policy files did not change.

## Verification

- Capability tests cover exact versus requested/current identity, missing and
  conflicting markers/hooks/budgets, failed lookups/writes and saved-handle replay.
- DynamoDB Local passes 39 lifecycle tests, including 16 new cases for conditional
  capability enrichment, concurrent cancellation, each changed identity field,
  lost committed replies, stale suspend admission and legacy wake recovery.
- Construct tests compare the helper's actual hook/environment JSON with the
  synthesized image and reject overrides of the reserved protocol marker.
- Contract mutation tests reject unsafe values and literal redeclarations.
- Guest validation tests cover absent, supported, empty and incompatible markers,
  with AWS calls forbidden during image validation.

Local evidence is under `/tmp/abca-645-p2-clean-20260913/p3-image-*20260915.log`.
The focused image suite passed **444 tests**, the orchestrator composition suite
passed **31**, and agent quality passed **1,940** with 11 opt-in database cases
skipped and **86.28%** branch-inclusive coverage.

The full root build completed compile, lint, synth, docs, contract checks,
928 CLI tests, 11 Forge tests and agent quality. Its CDK run passed **4,847**
tests and failed three old assertions in two suites: the prior action list and
two expectations that omitted image metadata. Those assertions were updated;
the affected stack grant and all six start-session composition tests then passed.
The full build command itself exited nonzero; the corrections were verified by
focused reruns. There was no production-code failure in that run.

## Remaining completion gates

Durable supervisor recovery and approval-triggered wake are now [connected locally](./645-p3-supervisor.md). Next deploy and
test the matching coordinator/image together. Verify effective image-read and
lifecycle permissions, actual service hooks, expired credentials, approval and
cancellation races, failures and cleanup in AWS. The
[implementation plan](./645-p3-implementation-plan.md) retains these gates and the
remaining P2 checks. Declared hooks and local tests alone do not complete P3.
