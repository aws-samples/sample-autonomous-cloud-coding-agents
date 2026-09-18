# P3 normal deployment acceptance — September 18, 2026

The normal `backgroundagent-dev` deployment in account `<account-id>`,
`us-west-2`, now uses the nested MicroVM infrastructure. P3 implementation and
deployment acceptance are complete: all four corrected-image normal cases, the
final test after removing old resources, and owned test-data cleanup passed.

## Deployed configuration

| Setting | Verified value |
|---|---|
| Managed image | `backgroundagent-dev-p3-abca-agent:2.0`, `ACTIVE` / `SUCCESSFUL` |
| Guest artifact SHA-256 | `924a1b51fe6b9aa62f61191a6bde9b10df01d65873181a9385489191492cadbe` |
| Artifact size | 519,287 bytes, 116 files |
| Memory baseline | 8,192 MiB |
| Lifecycle hooks | All six image/runtime hooks enabled |
| Active coordinator | Published version **14**, alias `live` |
| Compatible sleep-off rollback | Published version **13**, also pinned to image **2.0** |
| Live sleep switch | `/backgroundagent-dev/microvm-approval-suspend-enabled=true` |
| Default sleep delay | 600 seconds; per-task `0` disables sleep |
| Default approval deadline | `0`, no automatic decision expiry |
| Optional finite deadline | 30–3,600 seconds; positive policy-rule deadlines can also apply |
| Bootstrap bundle | 1.9.0 |

The [progress/checkpoint correction](./645-p3-progress-race-20260918.md) is in
image 2.0. Reverting to image 1.0 would restore that known race; the tested
rollback therefore uses coordinator 13 with the corrected image.

Subsequent updates to this installation must preserve the recorded CDK context:

```json
{
  "microvm_nested_stack": true,
  "microvm_resource_name_prefix": "backgroundagent-dev-p3",
  "microvm_managed_image_version": "2.0",
  "microvm_approval_suspend_enabled": true
}
```

The prefix remains part of this installation's configuration after migration.
Removing it would change the image, connector and log names again. The private
`normal-nested-rollout/progress-race-image/active-deployment-context.json`
contains the full context, including the exact base image and artifact hash.
Review the next generated change set; the archived migration templates preserve
unrelated deployed assets and are not substitutes for future source builds.

## Actual signed-in CLI acceptance

These cases used an owned Cognito identity, the normal API, normal Durable
coordinator, and `isadeks/vercel-abca-linear`. The fixture required approval for
one `Read` of that task's `README.md`, then used the existing clarification
workflow to finish without editing the repository. No PR, issue comment, email,
Slack message or Linear message was sent.

The observer checked `bgagent pending`, `bgagent watch`, the actual CLI decision
receipt, stored approval identity, tool result, worker identity, terminal task
state and released capacity. A successful resume API response alone was
insufficient to pass.

| Case | Task | Observed result |
|---|---|---|
| Omitted sleep/deadline overrides | `01M2S55A38R7V4FM532FF298KC` | Request remained pending without TTL; worker suspended after about 602 seconds; real CLI approval woke the same worker and exactly one Read succeeded |
| Explicit 300-second deadline, 30-second sleep delay | `01M2S55B567E0CZ613410VB2CW` | Same worker slept, woke before the original deadline and received `TIMED_OUT`; Read was denied; task completed and released capacity |
| New task while sleep disabled | `01M2S5W2NRDEVJVTM5VTQAHHHX` | Coordinator 13, static/live sleep flags false; worker stayed running for more than 75 seconds despite a 30-second delay, then accepted approval |
| Existing coordinator 14 task while live switch disabled | `01M2S5TMJK9JXPFF6SV7SHA5AK` | Version 14 execution was verified in its Lambda log stream; pending worker stayed running for 195 seconds despite a 120-second delay, then accepted approval |

The default request was created at `02:24:19Z`; its worker first appeared
suspended at `02:34:21.491Z`. While it slept, the reviewed two-change rollback
switched the alias from 14 to 13 and the live SSM flag to false. The new-task
sleep-off case passed before the default request was approved at about
`02:37:49Z`. That same sleeping worker returned to `RUNNING` at `02:37:56Z`,
completed and terminated. Disabling new sleeps did not prevent an existing
sleeping worker from waking.

All four cases ended `COMPLETED`; all workers terminated and all task-owned
capacity reservations were released. The scheduled manager released the last
two terminal reservations at `02:42:48Z`. The reviewed two-change restore
returned the alias to 14 and the SSM flag to true at `02:44:41Z`.

An earlier normal request also survived more than two hours and retirement of
its original worker. Its later CLI approval admitted one replacement and
executed the exact Read. That evidence, including an interrupted local observer,
is described separately in the
[progress-race record](./645-p3-progress-race-20260918.md).

## Final nested migration

The [overlap rehearsal](./645-p3-nested-stack.md) established compatible
old/new permissions and rollback before normal migration. Native CloudFormation
image refactoring was rejected by the provider and was not used.

Before final removal, a consistent inventory at `02:43:56Z` found:

- No active tasks, held reservations, open worker leases or nonzero user counters.
- No live workers on the old image.
- No running Durable executions in retained coordinator versions 2–14.

Change set `p3-normal-retire-flat-v2-20260918` removed the 16 obsolete flat
resource declarations and pruned old image/payload references from five IAM
policies. There were no replacements or unrelated modifications. The exact
final parent template hash is:

`d497bcefaf81e217ce3b77b98cc36bc89bfcd7796c8714d2b4d63a2432848c04`

The parent reached `UPDATE_COMPLETE` with **471 resources** in a 702,583-byte
template; its MicroVM child has **18 resources**. All **459** original resources outside the removal set
preserved their physical IDs, including the shared MicroVM execution role.
Parent output names continue to refer to the new child resources.

Nine direct absence checks confirmed deletion of the old image, two buckets,
two connectors, two security groups and two roles. Their inline policies and
auto-delete resources completed removal. The old MicroVM log group was
intentionally retained with its 90-day retention for diagnosis; it is no longer
owned by the parent template. Seven old build-artifact versions were archived
before their bucket was removed.

The resulting IAM simulation allows the new bootstrap-object read and explicitly
denies both the new forbidden payload path and the old bootstrap path. The final
normal smoke test exercises the actual worker and approval APIs after these
permissions were narrowed.

## Final smoke and cleanup

Final task `01M2S6S0YQ296KA52HM7HM0RJK` passed after the old resources and their
permissions were removed. Worker
`microvm-59f7debe-131d-3a8b-bb20-977d780f6df6` suspended at `02:52:52Z`,
received the actual CLI approval, resumed at `02:53:00Z`, completed at
`02:53:05Z` and terminated at `02:53:32Z`. Its exact Read succeeded once.
The scheduled manager released its reservation at `02:57:47.823Z`;
the observer recorded the complete pass at `02:57:53.216Z`.

Normal test cleanup completed at `03:00:49.739Z`. All 11 synthetic-user tasks,
their closed leases, 341 approval/event/nudge rows, task object versions and
Memory episodes were removed. The zero counter, Cognito identity and private
CLI credentials were deleted and their absence verified. Repository settings
match their exact original values.

Temporary cloud suites and the overlap rehearsal have already been deleted:
the corrected-image portable run verified removal of 40 resources, and the
overlap rehearsal verified removal of 43 recorded resources. Both report no
leaks.

Normal fixture cleanup preserves real incurred-cost accounting and diagnostic
CloudWatch logs. It removes only the recorded synthetic user's task data,
approval/event rows, closed leases, task artifacts, conversation/workspace
objects, short-term Memory episodes, exact task memory namespaces, test identity
and private CLI credentials. Shared repository memory and shared bootstrap
configuration are outside that deletion boundary.

An initial cleanup check observed a deleted Memory event briefly remaining in
`ListEvents`. The cleanup verifier now waits for confirmed absence with a bounded
deadline. The initial attempt and successful retry are both archived; no task
rows were deleted before that first visibility check stopped.

## Evidence and reproduction

The harness stays outside Git and the PR:

`~/.local/share/abca-verification/645-p3-integration/README.md`

The portable suites cover local restoration, the real pinned SDK with a
deterministic model, real S3, DynamoDB, the production coordinator, and fresh
cloud MicroVMs. Each run records source hashes, assertions and cleanup results.
The normal deployment scripts are explicitly installation-specific records,
not generic smoke commands.

Key evidence directories:

- `normal-acceptance-v2`: CLI cases, rollback/restore, final smoke and cleanup.
- `normal-nested-rollout/progress-race-image`: reviewed phase templates, final
  resource identities, IAM simulation and old-resource absence.
- `runs/20260918-progress-race-cloud`: a fresh corrected image passing both
  replacement approval and same-worker wake, followed by complete deletion.
- `cloud-replacement/results`: the full approve/deny/cancel/expiry and same-worker
  approval/denial matrix.

Full agent validation after the latest correction passed 2,162 tests with 13
opt-in skips and 86.37% coverage, plus lint, formatting and types. CDK validation
passed 5,223 tests with 56 skips; the subsequent pin/dispatch checks passed 245.
CLI compilation, lint and 943 tests passed.
All 116 files in the deployed guest archive were compared with the final source
and matched exactly.

Native Slack/Linear decision controls are separate product follow-ups; this
acceptance did not send external channel messages. Historical service-side
transport traces remain unavailable and are tracked in the
[service feedback record](./645-lambda-microvm-service-feedback.md).
