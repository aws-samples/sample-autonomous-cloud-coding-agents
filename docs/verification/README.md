# Lambda MicroVM verification

For maintainers reviewing/testing the MicroVM backend and operators deploying,
migrating or diagnosing it. [ADR-021](../decisions/ADR-021-lambda-microvms-compute-backend.md)
explains the design; the [user guide](../guides/USER_GUIDE.md#approval-gates-cedar-hitl)
explains approval and sleep options for people submitting tasks.
Detailed deployment transcripts, temporary worker identifiers and investigation
diaries are archived outside the repository. These documents are not test runners.

- [Task payload delivery](./645-payload-bootstrap.md): authorization, retries and coordinated upgrades.
- [Nested infrastructure](./645-p3-nested-stack.md): configuration and migration prerequisites.
- [Lifecycle diagnostics](./645-p3-lifecycle-diagnostics.md): locating and interpreting failed wakes.
- [Continuation design](../design/ORCHESTRATOR.md#retained-microvm-approvals): checkpoint ownership, retirement and replacement.

## Recorded acceptance

AWS checks on September 14–18, 2026 exercised the following behavior in the tested
deployments. They do not certify a different image, account, Region or upgrade.

| Area | Observed result |
|---|---|
| Task delivery | Signed payload downloads, invalid input rejection, expiry/revocation, immutable preparation and lost-reply recovery passed. |
| Approval lifecycle | Approve, deny, explicit expiry and cancellation passed; unanswered requests stayed available without a default deadline. |
| Sleep/wake | Repeated wakes, the 600-second default and the live sleep-off switch passed with compatible image/coordinator versions. |
| Credential renewal | A wait exceeding one hour was followed by successful AWS access with renewed task credentials. |
| Continuation | Conversation and Git/workspace recovery, replacement admission, usage limits and capacity release passed. |
| External integrations | Repository work and remote MCP access passed across sleep; an actual Linear submission exercised MicroVM compute with AgentCore Identity vault. |
| Linear decisions | Native threaded `approve` and `deny` replies passed on MicroVM and AgentCore. Both MicroVMs were suspended before the replies; exact decisions, tool results, thread acknowledgements and eventual capacity release were verified. |
| Infrastructure | Fresh nested deployment and a deployment-specific overlapping migration passed, including compatible rollback and old-resource cleanup. |
| Other backends | ECS and AgentCore approval/cancellation and scoped-access checks passed in their tested deployments. |

The wake correction sends `Connection: close` in lifecycle responses before
freeze. Local transport controls reproduced failure on an old connection;
long-sleep controls and the corrected live flows passed. Service-side traces
for the historical failures remain unavailable, so their exact transport error
is not established for every worker.

The full local build after the resource-budget fix passed: 5,560 CDK tests,
2,170 agent tests and 1,005 CLI tests, plus compile, lint, contracts, docs and
synthesis. The widest parent stacks use 489 resources for ECS and 488 for
MicroVM, including synth metadata, within the unchanged 490-resource budget.
Concurrency maintenance now has its own nested stack. Upgrading recreates that
stateless repair function and schedule; task and concurrency tables stay in the
parent stack.

## Open PR checks

- Finish reusable flat-to-nested migration commands and independently test an
  upgrade from current `main` on the same deployment. The earlier bespoke
  migration is not a substitute for that acceptance.

## Reproduce local checks

From the repository root, with dependencies installed:

```bash
mise run build
MISE_EXPERIMENTAL=1 mise //cdk:testf -- 'microvm|migration|payload-bootstrap'
```

For focused worker checks:

```bash
cd agent
uv run pytest tests/test_microvm_*.py tests/test_continuation_*.py \
  tests/test_approval_retention.py tests/test_payload_bootstrap.py --no-cov
ABCA_TEST_SDK_CONTINUATION=1 uv run pytest tests/test_continuation_sdk_probe.py --no-cov
```

The last command opts into the pinned real SDK/CLI probe with a deterministic
loopback model; it does not launch a cloud worker. Optional DynamoDB Local tests
require their documented local service. Mocks do not establish effective AWS IAM.
The standalone cloud acceptance harness and raw receipts remain outside this PR.

## Live acceptance for an installation

Record source commit, image ARN/version, coordinator version, configuration and
UTC test window. Use an owned test repository and identity. Enable suspension
only after verifying that image and coordinator together.

| Exercise | Required observation |
|---|---|
| Normal task | Repository tools run; terminal status, payload cleanup and capacity release agree. |
| Approval after sleep | The saved decision reaches the exact pending tool; verify guest recovery and tool output, not only the Resume API receipt. |
| Linear replies | Submit real issues on each backend. Reply `approve` or `deny` to the exact approval comment as its linked owner; verify the saved decision source, same-thread acknowledgement and allowed/blocked tool result. For MicroVM, observe suspension before replying. |
| Deny, expiry, cancellation | No denied/cancelled tool runs; expiry uses the original deadline; compute and capacity are cleaned up. |
| Default and disabled sleep | Omitted override uses 600 seconds; task-level off and deployment off prevent new suspension while wake/cleanup remain available. |
| Credential expiry | Sleep past the original credential lifetime, then perform actual task-scoped AWS operations. |
| Retirement/replacement | Confirm old-worker shutdown before capacity release; one replacement restores files/conversation and preserves approval identity and usage. |
| Upgrade/rollback | Preserve unrelated resource identities, old in-flight work and recoverable checkpoints; test compatible code/image/policy rollback. |

Include effective-role checks for own-task access and denial of cross-task data,
foreign bootstrap manifests and ambient payload reads. Keep credentials, signed
URLs, prompts and checkpoints out of diagnostic attachments. Clean up test
workers, executions, task data and owned infrastructure after the run.
