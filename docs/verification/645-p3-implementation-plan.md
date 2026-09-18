# ADR-021 P3 implementation and completion plan

Updated September 18, 2026 UTC. The [original review](./645-p3-readiness-review.md)
explains P1 and P2 and introduces the service. This is the current checklist;
dated verification records describe what was true at each earlier milestone.

**Current status: P3 complete.** Implementation, cloud continuation, normal
activation, live off-switch/rollback checks, retirement of the old flat
infrastructure, final smoke and cleanup are verified. See the
[normal acceptance record](./645-p3-normal-closure-20260918.md).

## The behavior being delivered

When the agent needs permission, it saves a question for the person. After ten
minutes, its computer can sleep while the question stays available. A person can
approve or deny later. If the wait is long, ABCA saves the conversation and files,
confirms that the old computer has stopped, and releases its capacity. The answer
can then start a replacement computer with the saved work.

- Unanswered approvals have no deadline by default: `approval_timeout_s=0`.
- An explicit decision timeout remains available, from 30 to 3,600 seconds.
  A positive policy-rule deadline can also apply.
- The default sleep delay is 600 seconds. `--microvm-sleep-after off` keeps that
  task awake; a deployment switch can disable new suspensions globally.
- An expired explicit deadline denies the proposed tool call. Waking or replacing
  a worker does not restart the decision clock.
- Cancellation closes unanswered requests atomically. Already-recorded decisions
  remain part of task history.
- The platform checks authenticated ownership, task/request identity, exact
  approved tool inputs and cancellation. The agent decides whether the action
  still makes sense. A separate relevance/staleness rechecking system is excluded
  by the user's scope decision.

“Durable” means saved outside the worker. A checkpoint is the saved conversation,
files and task context. A capacity reservation is the worker's place in the
deployment's concurrency limit.

## Implementation progress

- [x] Finish P2 follow-ups for payload provenance, task-scoped permissions,
  bounded uncertain-start recovery, atomic capacity ownership, worker cleanup,
  error classification, thread isolation and logging. See the
  [clean deployment](./645-p2-clean-deployment-20260913.md),
  [payload checks](./645-p2-payload-live-20260914.md),
  [registration recovery](./645-p3-registration-20260916.md) and
  [effective permissions](./645-effective-iam-20260915.md).
- [x] Implement all six image/runtime hooks, guest activity barriers, original
  deadlines, credential renewal, exact image capability and Durable supervision.
  [Lifecycle hooks](./645-p3-lifecycle-hooks.md) and the
  [supervisor](./645-p3-supervisor.md) document the contract.
- [x] Reproduce and correct stale pooled hook connections. Lifecycle responses
  explicitly close their HTTP connections before freeze. The
  [transport comparison](./645-p3-wake-transport-20260916.md) includes the
  greater-than-90-second control and closure-before-freeze evidence.
- [x] Verify approval, denial, cancellation, deadline races, multiple sleeps,
  repository work, networking and actual AWS credential renewal after expiry.
  See [final-image/ECS checks](./645-p3-final-image-and-ecs-20260917.md),
  [repository acceptance](./645-p3-repository-path-20260917.md),
  [MCP/network checks](./645-p3-mcp-network-20260917.md) and
  [AgentCore permissions](./645-p3-agentcore-permissions-20260917.md).
- [x] Implement retained approvals, versioned conversation/workspace storage,
  budget accounting, attempt ownership, confirmed retirement, replacement
  admission and scheduled cleanup for repository and repository-free tasks.
  See the [continuation protocol](./645-p3-continuation-protocol-20260917.md).
- [x] Pass the real cloud continuation matrix: approve, deny and expiry after
  retirement; cancellation without replacement; approval and denial on the
  original sleeping worker. Verify real output/checksums and resource cleanup.
  See [cloud acceptance](./645-p3-cloud-continuation-20260917.md).
- [x] Verify normal signed-in CLI pending/decision feedback, a request answered
  after more than two hours, one replacement, exact Read execution and final
  capacity release. The [progress-race record](./645-p3-progress-race-20260918.md)
  distinguishes recovered cloud evidence from the interrupted local watcher.
- [x] Fix the normal-workflow progress/checkpoint race. Progress can finish
  during upload; capture drains acknowledgments before publication. General
  activity and actual suspension retain their barriers. Three regressions
  cover successful writes, in-flight writes and failed writes.
- [x] Implement the requested nested MicroVM stack, install bootstrap 1.9.0,
  verify fresh deployment and cleanup, and rehearse overlapping old/new
  resources with a live permission probe and consumer rollback.
- [x] Add the normal nested stack, build its image, preserve the shared
  execution-role identity, and switch compatible consumers while retaining old
  resources for drain. The [nested record](./645-p3-nested-stack.md) also retains
  the failed native-refactor attempt and verified automatic rollback.
- [x] Complete corrected-image normal default/expiry/off-switch acceptance,
  rollback to its compatible sleep-off coordinator and restore activation.
- [x] Verify the old worker/execution drain, remove the 16 obsolete flat
  resources, and check final resource identities, outputs and permissions.
- [x] Remove owned acceptance data/identity and temporary infrastructure; finish
  documentation sync/check/build and the final evidence manifest.

The full agent suite after the Linear vault follow-up passes **2,170 tests**, with
13 explicitly opt-in skips and **86.39%** coverage. Lint, formatting and types pass.
The CDK suite passed **5,223 tests**, 56 skips and its snapshot; the later
managed-image pin/dispatch checks passed **245 tests**. CLI compilation, lint and
**943 tests** passed. These are suite results, not additive independent counts.

The subsequent real Linear submission also passed with AgentCore Identity vault:
the guest obtained its token from the existing vault grant, opened a one-file
test PR, posted completion feedback to Linear, terminated and released capacity.
Its fallback secret contained metadata only. This check caught and fixed missing
vault fields in the shared guest configuration and a metadata-only fallback
crash. The test PR was closed unmerged and the owned Linear fixture removed.
The private reproducible harness and raw receipts are maintained outside Git.

## Unanswered approvals implementation order

The prerequisites are implemented in this order:

1. Persist exact task/request/tool identity and original decision deadlines.
2. Save and restore the actual SDK conversation, including the pending action.
3. Preserve Git commits, index, worktree, required ignored files and workflow
   context in bounded, checksum-verified, version-pinned storage.
4. Keep tool execution behind an ownership barrier while capturing or restoring.
5. Confirm retirement before releasing the old reservation. Admit one replacement
   through a conditional coordinator transaction.
6. Deliver the saved decision to the restored agent, preserve all approved input
   fields, and account for cost and turns across both worker runs.
7. Keep pending rows free of retention TTL; close them on task cancellation or
   completion. Clean terminal checkpoints, launch records and worker leases.
8. Deploy compatible producers, APIs, coordinator and image before activating
   automatic suspension; verify the normal submission/response path.

The implementation does not retain an old worker indefinitely. It also does not
claim recovery when a complete checkpoint could not be verified. Unsafe parallel
or detached work, failed storage and uncertain writes remain explicit failures
or prevent suspension.

## Approval UX and scope

The supported response path is the signed-in CLI. `bgagent pending` shows the
task, proposed tool, reason, creation time, deadline or “no automatic expiry,”
and exact approve/deny commands. `bgagent watch` displays the request and recorded
decision. Restarting the CLI does not remove the saved request.

Slack and Linear notification renderers carry the same response instructions.
Their deployed packages, event routing, retry receipts and closure messages
have been verified; see [approval UX](./645-p3-approval-ux-20260917.md).
No external Slack/Linear messages were sent during this acceptance run.
Native Slack decision buttons, approval-by-Linear-reply and notification
throttling remain separate product follow-ups.

Repository mise/build-command changes are excluded at the user's request.
The earlier CLI installer/configuration addition was withdrawn. The private
verification harness's `--mise` option only selects the local test runner tool.

## Acceptance matrix and completion gates

| Area | Evidence and required outcome |
|---|---|
| Ordinary coding and other substrates | Clean P2 repository flow, ECS approval/cancellation and AgentCore permission checks pass |
| Same-worker sleep/wake | Approve, deny, original-deadline expiry and cancellation pass; files and identity survive |
| Credential expiry | Real expired AWS session is renewed with unchanged task/user/repo tags; no ambient fallback |
| Hook transport | Old pooled-connection race reproduced; explicit close verified before freeze |
| Retained decision | Pending request survives retirement without TTL; a later answer remains actionable |
| Replacement | One admitted worker restores exact work/action context and cumulative usage |
| Cancellation and races | Task cannot become RUNNING after cancellation; competing decisions and lost replies preserve ownership |
| Failure feedback | Bounded recovery and stable task/API guidance; hook stage, identity and timing diagnostics |
| Storage and permissions | Corrupt/interrupted transfers rejected; wrong-task reads and forbidden payload access denied |
| Capacity | Task-owned reservations, exact-attempt leases and confirmed shutdown before release |
| Nested migration | Rehearsed overlap, one merged payload-deny exception list, explicit image/coordinator pins and drain before deletion |
| Normal activation | Corrected image, actual 600-second default, timed request, off switch, compatible rollback and restored activation |
| Cleanup | No owned test worker remains alive; temporary resources, test identity and private credentials removed |

Real AWS requests establish service behavior and effective permissions. Unit
tests cover deterministic races and clocks; the real SDK and private AWS suites
cover process loss, disk loss and transaction ownership. An accepted resume API
response alone is never counted as a successful wake.

## Reproducible tests and handoff

The independent harness and raw evidence live outside Git:

`~/.local/share/abca-verification/645-p3-integration/README.md`

Its local, real-SDK, S3, DynamoDB, coordinator and full-cloud suites record source
hashes and cleanup results. `all` runs the first five; `cloud` is an explicit
option because it builds images and uses real MicroVM/model capacity. Fresh
cloud runs use isolated tagged resources and the existing deployment's VPC.
The normal migration/CLI fixtures are installation-specific and are labelled
separately.

The [microvms-agentd reference](https://github.com/laithalsaadoon/microvms-agentd/tree/78304e361fbbe62e3a6b255b43c6f6c372b47510)
informed reproducible commands, output-file assertions, disk-reserve checks and
cleanup receipts. No source was copied and no third-party executable was run.
ABCA keeps its task-scoped credential broker and complete Git/workspace recovery.

## Service and later-phase follow-ups

The [service feedback tracker](./645-lambda-microvm-service-feedback.md) preserves
requests for internal hook-dispatch traces, precise transport-error wording,
fresh-connection/retry behavior and the reproduced CloudFormation refactor tag
schema limitation. Historical worker traces remain unavailable. The application
fixes and migration do not claim that those service questions were answered.

Unknown Run outcomes remain bounded: reuse the saved start token only within
the supported recovery window; do not blindly create a second worker. If no
unique worker can be recovered, preserve the diagnostic and the full service
lifetime bound. This is a documented operator limitation, not proof of an
unbounded AWS idempotency guarantee.

The legacy/current capacity migration passed its isolated upgrade/rollback
rehearsal and a 600-user scan check. This installation already used task-owned
reservations, so its normal rollout preserves that protocol. Arbitrary
production scale is not established by these checks. Linear-vault integration
(#857) has its own validation, separate from this P3 acceptance record.

ADR-021 defines P1, P2 and P3. It does not define an official P4. Native channel
approval controls, broader liveness detection (#491), operator shell access and
additional deployment combinations can be scoped as follow-up work.
