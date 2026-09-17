# ADR-021 P3: normal repository workflow across sleep and wake

Verified September 17, 2026, in account `<account-id>`, `us-west-2`. This
extends the [final-image matrix](./645-p3-final-image-and-ecs-20260917.md)
from an explicit temporary clone to the platform's normal repository setup
and existing-PR resolution path.

## Test boundary

The test used normal image **6.0**, its original server as PID 1, and **8,192
MiB**. The packaged `coding/pr-review-v1` workflow cloned
`isadeks/vercel-abca-linear` and checked out existing
[PR #584](https://github.com/isadeks/vercel-abca-linear/pull/584).

A private coordinator ran the production Durable handler. Its temporary
configuration limited the worker to 900 seconds, the task to five turns/$1,
and the approval to 300 seconds. Automatic sleep was enabled only for this
fixture, with a 30-second delay. The shared deployment's switches stayed off.

The test deliberately excluded publication:

- A private event table had no DynamoDB stream or notification consumer.
- Private copies of the deployed worker/session roles substituted the session
  role and event-table ARNs. The session role trusted only the private worker
  role. Normal deployed roles were unchanged.
- The supported `system_prompt_overrides` setting restricted the agent to one
  README read and a final response. Every tool call required approval; the
  watcher approved only that exact Read.
- Normal post-hooks used the workflow's `resolve` strategy, which looks up the
  existing PR without pushing. Private build/lint settings selected
  `npm ci --no-audit --no-fund && npm test` and `npm run lint`; repository
  configuration was unchanged.

The normal approval handler supplied the decision using a synthetic trusted
user context. This verifies that handler and its AWS wake call, not API Gateway
authentication. Its approval/wake audit events used the normal event table;
the agent/coordinator progress and terminal events used the private table.

This isolation matters: the GitHub notification handler posts for a task with
a repository and PR number even when its source is `api`. Its entry point
currently ignores per-task notification overrides. Separately, the PR-review
system prompt tells the agent to post reviews and comments through Bash.
Neither the `read_only` flag nor `ensure_pr(strategy: resolve)` alone disables
those publication paths.

## Successful run

Task: `01M2PCJYY9Z0DK7Z0F4R4QFX0Y`.
Worker: `microvm-4e50cefb-66c7-34d5-8e28-32f1766c0c68`.
Private coordinator version: **3**, code SHA-256:
`DipaZN3h7+L0uJgyWSD9KIhhjX4XvVIshvxVItsvwnM=`.

| Event | UTC time |
|---|---|
| Task created | 00:36:00.258 |
| Worker observed running | 00:36:10.401 |
| Original approval created | 00:37:07 |
| Worker observed suspended | 00:37:38.708 |
| Normal approval API returned HTTP 202 | 00:37:51.476 |
| Worker observed running after wake | 00:37:52.616 |
| Task observed completed | 00:38:13.514 |
| Finalization verified without repair | 00:38:17.812 |

Approval `01M2PCQE38M9NB9ZJ3NXYP6TNP` retained its original 300-second
deadline, **00:42:07**. The actual normal-handler `ResumeMicrovm` request ID
was `96e85ab7-0936-499d-91f5-399bca675488`. PID 1 completed suspend and resume
with HTTP 200, in 91 ms and 141 ms respectively.

The independent audit passed at **00:39:09.507**. It verified:

- The normal clone/setup path and exactly one successful Read of
  `/workspace/01M2PCJYY9Z0DK7Z0F4R4QFX0Y/README.md`.
- The expected `# vercel-abca-linear` heading, passing build/test and lint
  results, and resolve-only post-hooks returning the existing PR URL.
- Task `COMPLETED`, Durable execution `SUCCEEDED`, worker `TERMINATED`,
  reservation released, counter zero and task payload absent.
- No watcher repair and no dropped trace events. Trace SHA-256:
  `537bb8894d8da3c34308456fa8c1753c1a1a0e9a5ae8bbfaa0eae27bceb8d66f`.
- Identical GitHub snapshots before and after: head
  `fd509fa63fa089df356574bdd654123c8621b12e`, branch, base, state, update
  timestamp, all six comments and zero reviews.

The reference README was 1,744 bytes with SHA-256
`dfa6bc9de7dc213fac31c35f6b4f22717f2df1371525eeb2fa195b6dbcc7649c`.
The reference hash identifies the expected remote file; the runtime audit
checks the recorded Read and heading, not a separate guest-side file hash.

## Excluded attempts and diagnostics

The initial infrastructure setup encountered IAM propagation: the newly
created worker role was not yet accepted as a trust-policy principal.
The exact error was retained, and a bounded retry for that specific error
completed setup. No worker existed during this failure.

Private coordinator version 1 was never invoked. Version 2 ran task
`01M2PC1VQ0N3X3KTY0HDC37HX1`, whose verbose test request was rejected during
PR context screening as `CONTENT/PROMPT_ATTACK (MEDIUM)`. It created no
worker and released its reservation before the watcher performed redundant
failure cleanup. Its failed Durable execution remains excluded.

A read-only hydration comparison with the same PR and the concise request
“Read the README and report its first heading” passed the unchanged filter.
The fresh version 3 task used that wording and passed its own normal screening.
This suggests the extra test instructions contributed to the rejection; it
does not identify an exact offending span or establish deterministic classifier
behavior. No guardrail setting was disabled or weakened.

## Evidence and remaining scope

Raw scripts, exact bundles for all three versions, role snapshots, events,
logs, traces and GitHub comparisons are retained under
`/tmp/abca-645-p2-clean-20260913/p3-repository-path-20260917`.

Cleanup completed at **00:40:40.868 UTC**. The private coordinator and all three
versions, three roles, switch, log group and event table were removed, along
with both owned zero counters. The archive retains 91 function log events and
24 private task events. Subsequent comparisons confirmed the normal worker
and session-role policies and repository configuration were unchanged.

The permanent private archive is
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/repository-path-evidence.tar.gz`.
It contains 60 files, is 43,934,346 bytes, and has mode `0600`. Every member
was verified against its manifest. SHA-256:
`75850ffb172f3ed5c15198dc0da1ee8c194a87a0edeb89b317ddb0b025c20a11`.

The accompanying source review corrected comment-only claims in
`agent/src/models.py` and the default/PR-review workflow YAML files:
SDK `allowed_tools` controls auto-approval, and `requires_repo: false` makes
the repository optional. Neither setting is the stronger restriction that
the old comments described. No executable Python or workflow values changed.

This verifies normal cloning and resolve-only delivery after wake. It does not
verify creating/pushing a new PR or publishing review comments on image 6.0.
Earlier P2 publication results retain their recorded scope. Remaining
permission/network, service-contract and deployment gates are tracked in the
[implementation plan](./645-p3-implementation-plan.md).
