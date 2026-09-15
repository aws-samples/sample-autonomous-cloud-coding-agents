# ADR-021 P3: preserve the SDK approval callback

Date: 2026-09-15. This follows the
[real long-sleep failure](./645-p3-durable-live-20260915.md#expired-credentials-passed-long-approval-semantics-failed).
The change below is local and has not been deployed.

## Problem

The approval timer and the coding program's callback timer are separate.
The first controls how long a person may approve a tool. The second controls how
long Claude waits for our Python hook to answer. A suspended VM must preserve
that unanswered callback until its approval can be reconciled.

The live hour-long case renewed expired AWS credentials successfully, but
Claude abandoned its pending Read callback when the VM woke. It produced a
generic denial while the approval record remained `PENDING`. The task then
completed before the original approval deadline. This is a failed lifecycle
case even though the tool did not run and cleanup succeeded.

`build_hook_matchers` supplied no explicit `HookMatcher.timeout`. A local probe
with the actual pinned SDK `0.2.110` and Claude `2.1.191` reproduced the same
generic denial and Python `CancelledError` when a one-second callback budget
expired during a three-second wait. A ten-second budget allowed that wait and
one successful read. The SDK's documented 60-second default is not reliable for
this binary: an unset timeout allowed a 65-second wait. The longer default probe
then cancelled at 600.034 seconds and returned the same generic denial. The
actual default for this pinned binary is ten minutes.

## Local change

PreToolUse matchers now receive an explicit timeout:

| Worker | Callback budget |
|---|---|
| ECS / AgentCore | Maximum approval window, 3,600 seconds, plus 120 seconds |
| Registered MicroVM | Maximum VM lifetime, 28,800 seconds, plus 120 seconds |

The larger MicroVM budget covers a supervisor that recovers after the approval
deadline. The existing approval loop still uses its original deadline and denies
an expired gate. PostToolUse and Stop callback settings are unchanged.

The existing eight-hour `RunMicrovm` limit now comes from
`contracts/constants.json`, shared with the Python callback calculation. The
service duration is unchanged. The drift checker rejects invalid durations and
a new hardcoded strategy copy. An outdated exception comment was also corrected:
Python cancellation propagates through `finally`; it is not caught by
`except Exception`.

## Reproduction and validation

The opt-in [probe](../../agent/scripts/verify_approval_hook_timeout.py) runs the
actual pinned coding program against a loopback fake Bedrock stream, synthetic
AWS keys and one disposable marker file. It makes no paid model call or AWS
request. It takes production matcher settings and replaces only the callback
with a controlled wait.

```bash
agent/.venv/bin/python agent/scripts/verify_approval_hook_timeout.py --timeout 1 --delay 3
agent/.venv/bin/python agent/scripts/verify_approval_hook_timeout.py --configured microvm --delay 650
agent/.venv/bin/python agent/scripts/verify_approval_hook_timeout.py --configured standard --delay 650
```

The full root build passed in 364.12 seconds: 4,993 CDK tests passed with 56
optional DynamoDB Local tests skipped; 1,942 Python tests passed with 11 skipped;
all 928 CLI tests passed. Compilation, lint, drift checks, synthesis and docs
build also passed. The focused CDK run passed all 201 assertions, though its
partial coverage could not satisfy the global full-suite threshold; the later
full build passed that threshold.

Both production-configured comparisons passed a 650-second wait: MicroVM
callback budget 28,920 seconds, standard budget 3,720 seconds. Each produced
one successful marker read and one post-tool callback. The unset default
cancelled at 600.034 seconds; the explicit one-second failure control cancelled
without reading the marker. A final short configured probe also verified that
diagnostics go to stderr and stdout remains valid JSON.

This probe does not simulate a real VM snapshot. AWS acceptance still requires
an updated image and a fresh long-sleep run with the original approval deadline,
the expected tool result and coordinator cleanup. The separate service-reported
resume-hook connection refusal remains unresolved.
