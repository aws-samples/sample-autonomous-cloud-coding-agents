# #645 P3: scoped credentials across sleep

Date: 2026-09-14. Local implementation and actual pinned Claude process probes.
No AWS deployment or suspension was performed for this milestone. Deployed
image **2.0** remains unchanged; P3 is not complete.

## What changed

Think of AWS credentials as a visitor badge with an expiry time. A sleeping
worker may wake up holding an expired badge. Every part of the worker needs a
working replacement before continuing, with the same task permissions.

`microvm_credentials.py` now serves the task's scoped credentials through an
authenticated HTTP endpoint bound only to `127.0.0.1`, on a runtime-selected port.
The Claude child receives that endpoint as its AWS container credential provider.
Its alternate AWS key, profile, SSO/process, web-identity, metadata and bearer-token
sources are cleared; controlled empty configuration files suppress local profiles.
The parent environment is preserved.

The image's managed `awsCredentialExport` command stays in place. In this internal
MicroVM mode, `bedrock_creds_helper.py` emits `{"Credentials": {}}` without reading
attribution files or resolving AWS credentials. That leaves resolution to the
scoped container provider and keeps keys out of Claude's stale export cache.
AgentCore/ECS/local attribution retains its existing helper behavior.

`aws_session.py` exports a coherent key/expiry pair under botocore's refresh lock.
The production resume callback forces recorded ambient providers to refresh first,
then force the original tenant credential object to renew with the original STS
tags. Existing clients keep their references. Changing the configured identity
after session construction is rejected. Mandatory renewal propagates failure
even if an older cached key remains valid.

Normal deployments already launch a fresh AgentCore runtime session or ECS/MicroVM
worker per task. Manually reusing one Python process for a different identity after
credential construction now fails explicitly. MicroVM STS calls use short network
timeouts; the other backends retain their default timeout/retry behavior.

The broker participates in the guest activity drain. Paused, failed or closed
controllers reject credential requests before consulting AWS. SDK success, startup
failure, query failure, receive failure and cancellation close the client and broker.
The earlier runner did not disconnect its SDK client.

This is provider selection, not isolation from arbitrary code running as the same
OS user. The bearer token is created from OS entropy at runtime; it and the real
credential responses must never be logged or included in verification evidence.
The broker requires no ingress connector or additional AWS IAM permission.

## Actual CLI evidence

The opt-in verifier runs **claude-agent-sdk 0.2.110 / Claude 2.1.191** against a
loopback fake Bedrock server. It returns valid AWS event-stream frames containing
synthetic model text. All keys are synthetic. There are no paid model calls.

Each case requires a successful initial model query before a 12-second credential
expiry, waits past that actual wall-clock expiry, and checks both the next request's
signing key and the SDK result. The verifier rejects unreviewed version pins.
`CLAUDE_CODE_MAX_RETRIES=0` bounds this experiment's error result; production model
retry settings are unchanged.

| Case | First query after expiry | Result |
|---|---|---|
| Existing `awsCredentialExport` | Still signs with `SYNTHETIC_INITIAL` | Reproduces stale-key reuse |
| `credential_process` renewal | Signs with `SYNTHETIC_RENEWED` | Renewal itself works |
| Working ambient-only control | Signs with `SYNTHETIC_AMBIENT` | Calibrates fallback endpoint |
| Failed process renewal plus working ambient provider | Signs with `SYNTHETIC_AMBIENT` | Demonstrates unsafe fallback |
| Production scoped broker plus production helper | Signs with `SYNTHETIC_RENEWED` | Waits for replacement before signing |
| Failed production broker renewal | No second model request; SDK reports credential error | Fails closed |

The fake server accepts synthetic signatures. The export case deliberately proves
which key Claude sends; its successful fake response does not mean AWS would accept
an expired key. Non-streaming startup model-availability checks are recorded
separately from the two main queries.

Run from `agent/`:

```bash
.venv/bin/python scripts/verify_microvm_credentials.py --mode export
.venv/bin/python scripts/verify_microvm_credentials.py --mode process
.venv/bin/python scripts/verify_microvm_credentials.py --mode ambient --ambient-fallback
.venv/bin/python scripts/verify_microvm_credentials.py --mode process-failure --ambient-fallback
.venv/bin/python scripts/verify_microvm_credentials.py --mode broker
.venv/bin/python scripts/verify_microvm_credentials.py --mode broker-failure
```

Each successful verification prints `"verified": true`; failed expectations exit
nonzero. All temporary files, CLI processes and loopback servers are cleaned up.
Reports for these six runs were retained locally as
`/tmp/abca-645-p2-clean-20260913/p3-credentials-<mode>-20260914.json`.

## Regression coverage and remaining work

The agent quality gate passes **1,881 tests** (24 added), with **86.14%** total
branch coverage, plus Ruff lint/format and type checking. The configured Bandit
high-severity gate and Vulture dead-code gate pass.

The full monorepo build also passes: **4,797 CDK tests** (38 existing skips across
two suites), **928 CLI tests**, **11 Forge tests**, CDK compile/lint/synth,
documentation build/link checks and contract drift checks. The final agent quality
run includes the two additional backend-timeout tests added during that build.
Logs are retained as `p3-credentials-build-20260914.log` and
`p3-credentials-agent-quality-20260914.log` in the same private evidence directory.

Focused tests use real botocore refreshable credentials and retained S3/DynamoDB
clients. They verify ambient-before-tenant ordering, exact tag preservation,
signing with replaced keys, mandatory failure, identity mismatch, unknown/static
providers, expired replacements and UTC expiry formatting. Loopback tests verify
authentication, child-only environment changes, no secret error details, suspend
drain and continued denial after failed resume. Runner tests cover cleanup on
normal completion and failure/cancellation for MicroVM and other backends.

Before automatic suspension can ship:

1. **Implemented locally in the [HTTP hook milestone](./645-p3-lifecycle-hooks.md):**
   bounded `/resume` invokes refresh before atomic task/gate reconciliation;
   `/suspend` requires an acknowledged checkpoint.
2. Verify actual MicroVM runtime credential-provider type and renewal after sleep.
   Static or unknown providers currently reject resume; rereading an unchanged
   environment is not proof of renewal. Botocore's forced-refresh private API is
   isolated in one adapter and requires review when the SDK changes.
3. Verify the built image's managed-settings path, Gateway signing, detached
   subprocess behavior and long-expiry sleep in AWS. The local CLI probe uses an
   explicit settings file containing the production helper command; it does not
   install `/etc/claude-code/managed-settings.json` on the developer machine.
4. Finish image capability, durable supervisor recovery and approval-triggered wake,
   then complete the [P3 plan](./645-p3-implementation-plan.md), including its P2 gates.
