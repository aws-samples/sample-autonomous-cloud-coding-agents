# Lambda MicroVM verification

These documents are for maintainers who review or test the MicroVM backend and
for operators who deploy, migrate or diagnose it.
[ADR-021](../decisions/ADR-021-lambda-microvms-compute-backend.md) explains the
design. The [user guide](../guides/USER_GUIDE.md#approval-gates-cedar-hitl)
explains the approval and sleep options for people who submit tasks.
Detailed deployment transcripts, temporary worker identifiers and investigation
diaries are archived outside the repository.

- The [P1 runbook](./645-p1-lambda-microvm-runbook.md) and the [P2 smoke runbook](./645-p2-smoke-runbook.md) hold the recorded service facts and smoke parity.
- [Nested infrastructure](./645-p3-nested-stack.md) covers configuration and migration prerequisites.
- [Lifecycle diagnostics](./645-p3-lifecycle-diagnostics.md) covers how to locate and interpret failed wakes.

## P3 scope

P3 adds approval-wait sleep and wake for Lambda MicroVM tasks with bounded
approval windows. The default window is 300 s and the ceiling is 3,600 s. The
scope is suspend and resume on the `ComputeStrategy` interface, the orchestrator
suspend policy, inline wake from approve or deny, the original wall-clock
deadline across a freeze, declined unsafe suspends, credential renewal after
wake, image lifecycle-capability checks, the live suspend switch and the
per-task `microvm_sleep_after_s` delay, which defaults to 60 s.
Worker replacement after a lost suspended worker, approval waits without a
deadline, the trusted approval-writer API, Linear approve and deny replies and
the IAM-authenticated payload bootstrap are separate follow-ups.

## Open PR checks

- Maintainer acceptance of ADR-021 P3 and ADR-023.
- A live acceptance run of this P3 scope on a nested deployment, described
  below, including the `defaults` and `expiry` scenarios.

Reusable flat-to-nested migration commands are out of scope for this PR. Until
they exist, existing flat installations keep `microvm_nested_stack=false`. The
staged checklist in [nested infrastructure](./645-p3-nested-stack.md) is guidance,
not a tool.

## Reproduce local checks

Run these commands from the repository root, with dependencies installed:

```bash
mise run build
mise //cdk:testf -- 'microvm|lifecycle'
```

For focused worker checks, run these commands:

```bash
cd agent
uv run pytest tests/test_microvm_*.py tests/test_poll_for_decision.py --no-cov
```

The DynamoDB Local tests, `*-local.test.ts` and `test_microvm_checkpoint.py`,
need a loopback endpoint in `ABCA_DDB_LOCAL_ENDPOINT`. CI provides one. Mocks do
not establish effective AWS IAM.

## Live acceptance for an installation

`scripts/microvm-acceptance.sh` runs the core exercises below against a deployed
stack and records PASS or FAIL with evidence. The core exercises are a normal task,
approve and deny after sleep, the out-of-the-box `defaults`, gate `expiry` while
asleep, cancel while suspended, a declined suspend on a working guest and a
concurrent burst. Set `ABCA_ACCEPT_REPO` to an owned test repository that is
onboarded for `lambda-microvm`.

Record the source commit, the image ARN and version, the coordinator version,
the configuration and the UTC test window. Use an owned test repository and
identity. Enable suspension only after you verify that image and coordinator
together.

| Exercise | Required observation |
|---|---|
| Normal task | Repository tools run. Terminal status, payload cleanup and worker termination agree. |
| Approval after sleep | The decision reaches the exact pending tool. Verify guest recovery and tool output, not only the Resume API receipt. |
| Defaults | With no sleep override, a default 300 s gate sleeps after 60 s and the task completes on approval. |
| Expiry | An unanswered gate wakes before its deadline, ends `TIMED_OUT`, and the gated tool never runs. |
| Deny, cancellation | No denied or cancelled tool runs. Compute and capacity are cleaned up. |
| Declined suspend | An external suspend of a working guest is declined. The VM is not terminated and the task completes. |
| Disabled sleep | Task-level `off` and the deployment switch prevent new suspension while wake and cleanup remain available. |
| Credential expiry | Sleep past the original credential lifetime, then perform actual task-scoped AWS operations. |
| Upgrade and rollback | Preserve unrelated resource identities and in-flight work. Test compatible code, image and policy rollback. |

Include effective-role checks for own-task access and for the denial of
cross-task data. Keep credentials and prompts out of diagnostic attachments.
After the run, clean up the test workers, executions, task data and owned
infrastructure.
